const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, shell, screen, webContents, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
// 加载 .env（FEISHU_APP_ID / FEISHU_APP_SECRET，再引入飞书桥接）：
// 开发版用仓库根目录的 .env；安装版（deb）应用目录不可写，改用用户数据目录
// ~/.config/ai-roundtable/.env，首次运行不存在时自动生成模板供用户填写
(function loadEnv() {
  const devEnv = path.join(__dirname, '..', '.env');
  if (fs.existsSync(devEnv)) {
    require('dotenv').config({ path: devEnv });
    return;
  }
  const userEnv = path.join(app.getPath('userData'), '.env');
  if (!fs.existsSync(userEnv)) {
    try {
      fs.mkdirSync(path.dirname(userEnv), { recursive: true });
      fs.writeFileSync(
        userEnv,
        [
          '# AI 圆桌配置（安装版）',
          '# 飞书机器人凭证（可选）：不填则飞书入口不可用，桌面端与本地 HTTP 接口照常',
          '# FEISHU_APP_ID=cli_xxxxxxxx',
          '# FEISHU_APP_SECRET=xxxxxxxx',
          '# 会话白名单（可选，逗号分隔 chat_id；群消息还需 @机器人）',
          '# FEISHU_ALLOW_CHAT_IDS=',
          '',
        ].join('\n'),
        'utf8'
      );
    } catch {}
  }
  require('dotenv').config({ path: userEnv });
})();
const { createFeishuBridge } = require('./feishu');
const history = require('./history');

// 去掉 File/Edit/View 原生菜单栏，界面只保留自己的按钮
Menu.setApplicationMenu(null);

// 单实例锁：防止重复启动导致两个实例争抢同一份登录数据（LOCK 错误）
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ===== 托盘常驻 =====
let tray = null;
let isQuitting = false; // 仅当从托盘「退出」或系统退出时才真正关闭

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) icon = icon.resize({ height: 16 });
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('AI 圆桌（飞书机器人服务运行中）');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// dock 里的 webview 被内容层遮挡，需关掉后台节流，否则部分站点（豆包/MiniMax）流式渲染停摆
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// GPU 禁用与 X11 ozone 在代码里固定（不依赖启动参数）：菜单图标、systemd 服务、
// 命令行任何方式启动行为一致。本机（统信 UOS arm64）实测 GPU 进程反复崩溃
// （2026-08-18 曾 FATAL 退出），且 Wayland 会话下 webview 渲染异常。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('ozone-platform', 'x11');

// ===== 服务编排：飞书桥接 + 本地 HTTP 接口（供 Hermes skill 调用）=====
const http = require('http');
const ROUNDTABLE_PORT = Number(process.env.ROUNDTABLE_PORT || 8765); // 仅监听 127.0.0.1

let mainWindow = null;
// requestId -> { source:'feishu'|'http', chatId?, httpRes?, question, watchdog? }，结果回来时按来源路由
const pendingRounds = new Map();

// 看门狗（#1）：一轮从下发到 renderer 回报 service:result 的正常上限约 12 分钟
// （轮次等待 420s + 网页总结 300s + 发送/抓取余量）。超过 15 分钟仍无回报，
// 基本可判定 renderer 崩溃/卡死——若不主动释放，pendingRounds 永久非空，
// 飞书/HTTP 会一直 busy/429，整个服务卡死到重启。这里兜底清理并回报超时。
const ROUND_WATCHDOG_MS = 15 * 60 * 1000;
function armRoundWatchdog(requestId) {
  const pending = pendingRounds.get(requestId);
  if (!pending) return;
  pending.watchdog = setTimeout(() => {
    if (!pendingRounds.has(requestId)) return; // 已被正常回报清掉
    pendingRounds.delete(requestId);
    console.error(`[watchdog] 轮次 ${requestId} 超过 ${ROUND_WATCHDOG_MS / 60000} 分钟未回报，强制释放 busy`);
    if (pending.source === 'http' && pending.httpRes) {
      try {
        jsonResponse(pending.httpRes, 504, { ok: false, error: 'round-timeout', message: '本轮处理超时（15 分钟未回报），请重试' });
      } catch {}
    } else if (bridge && pending.chatId) {
      bridge.sendText(pending.chatId, '本轮处理超时（15 分钟未回报），请重新发送问题').catch(() => {});
    }
  }, ROUND_WATCHDOG_MS);
}
function clearRoundWatchdog(requestId) {
  const pending = pendingRounds.get(requestId);
  if (pending && pending.watchdog) clearTimeout(pending.watchdog);
}

// 纯文本格式化：总结（内含附录各家原文，由 renderer 拼接）——飞书用
function formatResultText(data) {
  if (data.error === 'busy') return data.message || '正在处理上一条，请稍候';
  if (data.error) return `出错了：${data.message || data.error}`;
  if (data.summary) return data.summary;
  // 总结失败时才退化为逐家摘录（单家截断到 1200 字），避免与附录重复
  let out = '';
  if (data.summaryError) out += `【总结失败】${data.summaryError}\n`;
  out += '\n【各家回复】';
  for (const r of data.replies) {
    const tag = r.state === 'done' ? '' : `（${r.state}）`;
    const body = r.text ? r.text.slice(0, 1200) + (r.text.length > 1200 ? '…(截断)' : '') : '（无回复）';
    out += `\n◆ ${r.name}${tag}\n${body}`;
  }
  return out;
}

// 触发一轮圆桌：向 renderer 下发 service:ask；sites 为可选子集（改进2），缺省全部
function startRound(requestId, question, sites) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('service:ask', { requestId, question, sites });
    return true;
  }
  return false;
}

// 总结落成 docx（pandoc 转换），飞书/微信渠道以文件形式发送；失败返回 null 由调用方回退纯文本
function buildSummaryDocx(question, summary) {
  return new Promise((resolve) => {
    try {
      const dir = path.join(app.getPath('userData'), 'summaries');
      fs.mkdirSync(dir, { recursive: true });
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      // 时间戳精确到秒：同分钟两轮不再互相覆盖
      const stamp =
        `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      const docxPath = path.join(dir, `圆桌总结-${stamp}.docx`);
      const mdPath = path.join(dir, `圆桌总结-${stamp}.md`);
      const doc =
        `# ${question || 'AI 圆桌总结'}\n\n` +
        `> 生成时间：${d.toLocaleString('zh-CN', { hour12: false })}\n\n` +
        `${summary}\n`;
      fs.writeFileSync(mdPath, doc, 'utf8');
      // hard_line_breaks：总结是纯文本单换行，不加此参数 pandoc 会把单换行折叠成空格，
      // Word 里标题和条目全部粘成一行（2026-08 实测首份生产 docx 即此问题）
      execFile('pandoc', ['-f', 'markdown+hard_line_breaks', mdPath, '-o', docxPath], { timeout: 30000 }, (err) => {
        // 中间产物 md 无论成败都清掉
        try { fs.unlinkSync(mdPath); } catch {}
        if (err) {
          console.error('[docx] pandoc 转换失败:', err.message);
          return resolve(null);
        }
        resolve(docxPath);
        // 保留最近 50 份总结 docx（文件名含时间戳、字典序即时序），防止目录无限增长
        try {
          const olds = fs.readdirSync(dir)
            .filter((f) => /^圆桌总结-\d{8}-\d{4,6}\.docx$/.test(f))
            .sort()
            .reverse();
          for (const f of olds.slice(50)) fs.unlinkSync(path.join(dir, f));
        } catch {}
      });
    } catch (e) {
      console.error('[docx] 生成失败:', e && e.message);
      resolve(null);
    }
  });
}

// 飞书桥接为可选：未配置 FEISHU_APP_ID/SECRET 时跳过，桌面端与本地 HTTP 入口照常可用
let bridge = null;
try {
  bridge = createFeishuBridge({
    onState: (state, err) => {
      if (state === 'ready') console.log('[feishu] 长连接就绪');
      if (state === 'error') console.error('[feishu] 连接错误:', err && err.message);
      if (state === 'reconnecting') console.log('[feishu] 断线重连中…');
      if (state === 'reconnected') console.log('[feishu] 已重连');
    },
    onQuestion: ({ requestId, question, chatId }) => {
      console.log(`[feishu] 收到问题: ${question}`);
      if (pendingRounds.size > 0) {
        bridge.sendText(chatId, '正在处理上一条，请稍候').catch(() => {});
        return;
      }
      pendingRounds.set(requestId, { source: 'feishu', chatId, question });
      if (startRound(requestId, question)) {
        armRoundWatchdog(requestId);
        bridge.sendText(chatId, `收到：${question}\n正在问 8 家，请稍候…`).catch(() => {});
      } else {
        pendingRounds.delete(requestId);
        bridge.sendText(chatId, '服务窗口尚未就绪，请稍后再试').catch(() => {});
      }
    },
  });
} catch (e) {
  console.warn(`[feishu] 桥接未启用：${e.message}（仅影响飞书入口，桌面端/本地 HTTP 不受影响）`);
}

// ----- 本地 HTTP 接口 -----
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > 1e6) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

function jsonResponse(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const httpServer = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return jsonResponse(res, 200, { ok: true, ready: !!(mainWindow && !mainWindow.isDestroyed()) });
    }
    if (req.method === 'POST' && req.url === '/ask') {
      let question = '';
      let sites;
      try {
        const body = JSON.parse((await readBody(req)) || '{}');
        question = (body.question || '').trim();
        if (Array.isArray(body.sites) && body.sites.length) sites = body.sites.map(String);
      } catch {}
      if (!question) return jsonResponse(res, 400, { ok: false, error: 'missing-question' });
      if (pendingRounds.size > 0) {
        return jsonResponse(res, 429, { ok: false, error: 'busy', message: '正在处理另一轮，请稍候' });
      }
      const requestId = 'http-' + Date.now();
      pendingRounds.set(requestId, { source: 'http', httpRes: res, question, sites });
      if (!startRound(requestId, question, sites)) {
        pendingRounds.delete(requestId);
        return jsonResponse(res, 503, { ok: false, error: 'not-ready', message: '服务窗口尚未就绪' });
      }
      armRoundWatchdog(requestId);
      console.log(`[http] 收到问题: ${question}${sites ? '（子集:' + sites.join(',') + '）' : ''}`);
      return; // 响应挂起，待 service:result 写回（看门狗兜底超时释放）
    }
    // 改进1：单条历史详情 GET /history/item?id=xxx（须放在 /history 列表之前判断）
    if (req.method === 'GET' && req.url.startsWith('/history/item')) {
      const u = new URL('http://x' + req.url);
      const id = u.searchParams.get('id') || '';
      const found = history.query('', 10000).find((e) => e.id === id);
      if (!found) return jsonResponse(res, 404, { ok: false, error: 'not-found' });
      return jsonResponse(res, 200, { ok: true, item: found });
    }
    // 改进1：查询历史记录 GET /history?q=关键词&limit=N
    if (req.method === 'GET' && (req.url === '/history' || req.url.startsWith('/history?'))) {
      const u = new URL('http://x' + req.url);
      const q = u.searchParams.get('q') || '';
      const limit = parseInt(u.searchParams.get('limit') || '10', 10) || 10;
      const items = history.query(q, limit).map((e) => ({
        id: e.id,
        ts: e.ts,
        question: e.question,
        summary: e.summary || '',
        summaryError: e.summaryError || '',
        count: (e.replies || []).filter((r) => r.state === 'done').length,
      }));
      return jsonResponse(res, 200, { ok: true, items });
    }
    return jsonResponse(res, 404, { ok: false, error: 'not-found' });
  } catch (e) {
    try {
      jsonResponse(res, 500, { ok: false, error: String((e && e.message) || e) });
    } catch {}
  }
});

// renderer 回报最终结果 → 按来源路由（飞书：摘要文本 + docx 附件；HTTP：JSON 带 summaryFile）
ipcMain.on('service:result', async (_event, data) => {
  const pending = pendingRounds.get(data.requestId);
  if (!pending) return;
  clearRoundWatchdog(data.requestId); // 正常回报，撤掉超时兜底
  pendingRounds.delete(data.requestId);

  // 改进1：落库历史记录（跳过 busy/无数据轮次）
  if (!data.error && Array.isArray(data.replies)) {
    history.saveRound({
      id: data.requestId,
      ts: new Date().toISOString(),
      question: pending.question,
      source: pending.source,
      summary: data.summary || '',
      summaryError: data.summaryError || '',
      replies: data.replies || [],
    });
  }

  // 有总结时落成 docx：附录含各家原文，正文可能数万字，文件形式体验远好于长文本
  let docxPath = null;
  if (!data.error && data.summary) {
    docxPath = await buildSummaryDocx(pending.question, data.summary);
  }

  if (pending.source === 'http') {
    try {
      jsonResponse(pending.httpRes, 200, {
        ok: true,
        question: pending.question,
        summary: data.summary || '',
        summaryError: data.summaryError || '',
        replies: data.replies || [],
        // 微信（Hermes skill）等渠道：有此字段时把该 docx 作为附件发给用户
        summaryFile: docxPath || '',
      });
    } catch (e) {
      console.error('[http] 回写失败:', e && e.message);
    }
    return;
  }

  if (!bridge) return;
  if (docxPath) {
    const doneCount = (data.replies || []).filter((r) => r.state === 'done').length;
    try {
      await bridge.sendText(
        pending.chatId,
        `圆桌完成：${pending.question}\n${doneCount}/${(data.replies || []).length} 家成功，总结（五段结构 + 各家原文附录）见附件 docx。`
      );
      await bridge.sendFile(pending.chatId, docxPath);
      return;
    } catch (e) {
      console.error('[feishu] docx 发送失败，回退纯文本:', e && e.message);
    }
  }
  bridge.sendText(pending.chatId, formatResultText(data)).catch((e) => {
    console.error('[feishu] 发送结果失败:', e && e.message);
  });
});

// renderer 上报进度（Phase 2 仅记录；Phase 3 用于增量更新卡片）。
// 3s 轮询期间进度几乎总是不变，内容相同不重复打印（曾一日 1200+ 行重复进度）
let lastProgressLine = '';
ipcMain.on('service:progress', (_event, data) => {
  const line = `进度 done=${data.done}/${data.total} 生成中=${data.generating} 失败=${data.error}`;
  if (line === lastProgressLine) return;
  lastProgressLine = line;
  console.log(`[feishu] ${line}`);
});

// ===== 历史记录（改进1，桌面端同步）=====
// 桌面端手动轮次总结后落库
ipcMain.on('save-history', (_event, entry) => {
  history.saveRound(entry);
});
// 桌面端历史弹窗查询
ipcMain.handle('get-history', (_event, q, limit) => history.query(q || '', limit || 20));

// 总结导出为 Markdown：系统保存对话框，默认落到文档目录
ipcMain.handle('save-markdown', async (_event, defaultName, content) => {
  if (!mainWindow) return { ok: false, error: 'no-window' };
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: '保存总结为 Markdown',
    defaultPath: path.join(app.getPath('documents'), defaultName || '圆桌总结.md'),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  fs.writeFileSync(filePath, content, 'utf8');
  return { ok: true, filePath };
});

// ===== 网页总结附件（DeepSeek 第二账号）：生成 docx + CDP 直传文件输入框 =====
// 生成「模板 + 各家无删减原文」的 docx（pandoc 复用；失败回退 md）供总结者上传，
// 解除网页输入框字数限制。固定文件名、每轮覆盖，避免临时文件堆积；
// 文件须保留在磁盘上直到 DeepSeek 把附件上传走（站点在发送时读取磁盘文件）。
ipcMain.handle('build-upload-file', async (_event, markdown) => {
  try {
    const dir = path.join(app.getPath('userData'), 'summaries');
    fs.mkdirSync(dir, { recursive: true });
    const mdPath = path.join(dir, '圆桌总结任务.md');
    const docxPath = path.join(dir, '圆桌总结任务.docx');
    fs.writeFileSync(mdPath, markdown, 'utf8');
    try { fs.unlinkSync(docxPath); } catch {}
    await new Promise((resolve) => {
      // hard_line_breaks：模板与原文是单换行纯文本，缺此参数 pandoc 会把换行折叠成空格
      execFile('pandoc', ['-f', 'markdown+hard_line_breaks', mdPath, '-o', docxPath], { timeout: 30000 }, () => resolve());
    });
    if (fs.existsSync(docxPath)) return { ok: true, path: docxPath };
    return { ok: true, path: mdPath }; // pandoc 不可用时直接上传 md 原文
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// 经 CDP 把磁盘文件直接塞进 webview 的 <input type="file">（同 Playwright setInputFiles）：
// 不弹原生文件对话框，页面 change 事件正常触发，站点能识别到附件
ipcMain.handle('set-file-input', async (_event, webContentsId, filePath) => {
  const wc = webContents.fromId(webContentsId);
  if (!wc) throw new Error('webview 尚未就绪');
  const dbg = wc.debugger;
  let attached = false;
  try {
    dbg.attach('1.3');
    attached = true;
    const doc = await dbg.sendCommand('DOM.getDocument', { depth: -1 });
    const found = await dbg.sendCommand('DOM.querySelectorAll', {
      nodeId: doc.root.nodeId,
      selector: 'input[type="file"]',
    });
    const nodeIds = (found && found.nodeIds) || [];
    if (!nodeIds.length) throw new Error('未找到 input[type=file]（尝试点击附件按钮展开）');
    await dbg.sendCommand('DOM.setFileInputFiles', { files: [filePath], nodeId: nodeIds[0] });
    return { ok: true, inputs: nodeIds.length };
  } finally {
    if (attached) {
      try { dbg.detach(); } catch {}
    }
  }
});

async function createWindow() {
  // 直接使用工作区（不含任务栏的区域）作为窗口边界，避免底部被任务栏遮挡
  const area = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    minWidth: 1000,
    minHeight: 600,
    title: 'AI 圆桌',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // file:// 子资源会被 Chromium 磁盘缓存并沿用旧版本，启动时清掉
  await win.webContents.session.clearCache();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow = win;
  // 关窗不退出：隐藏到托盘常驻（仅 isQuitting 时才真正销毁）
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    mainWindow = null;
  });
}

// webview 里的外链（target=_blank 等）交给系统浏览器打开
app.on('web-contents-created', (event, contents) => {
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
  }
});

// 在指定 webview 里执行脚本。走 webContents.fromId 而不是 webview 标签的
// executeJavaScript——后者在个别页面（如 chat.z.ai 加载事件不结束）会无限排队。
ipcMain.handle('exec-in-webview', async (event, webContentsId, script) => {
  const wc = webContents.fromId(webContentsId);
  if (!wc) throw new Error('webview 尚未就绪');
  return wc.executeJavaScript(script);
});

// 可信输入：Slate/Lexical 等编辑器只认真实输入事件，合成事件填进去也不激活发送按钮
ipcMain.handle('insert-text', (event, webContentsId, text) => {
  const wc = webContents.fromId(webContentsId);
  if (!wc) throw new Error('webview 尚未就绪');
  wc.focus();
  wc.insertText(text);
});

ipcMain.handle('send-enter', (event, webContentsId) => {
  const wc = webContents.fromId(webContentsId);
  if (!wc) throw new Error('webview 尚未就绪');
  wc.focus();
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  wc.sendInputEvent({ type: 'char', text: '\r', keyCode: 'Return' });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
});

// 可信鼠标点击（页面坐标）：部分站点忽略程序化 click
ipcMain.handle('click-at', (event, webContentsId, x, y) => {
  const wc = webContents.fromId(webContentsId);
  if (!wc) throw new Error('webview 尚未就绪');
  wc.focus();
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
});

// 总结 LLM 调用放在主进程，避开渲染进程的 CORS 限制
ipcMain.handle('call-llm', async (event, { baseURL, apiKey, model, messages }) => {
  const url = baseURL.replace(/\/+$/, '') + '/chat/completions';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 180000); // 带 8 家全文的总结提示词较长，放宽到 180s
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: ac.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('调用超时（180 秒无响应，服务商可能繁忙，请稍后重试）');
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`API 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    throw new Error(`API 错误（HTTP ${res.status}）：${data.error?.message || text.slice(0, 300)}`);
  }
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('API 返回中缺少 choices[0].message.content');
  return content;
});

app.whenReady().then(() => {
  createWindow();
  createTray();
  // 启动飞书长连接桥接（可选）
  if (bridge) {
    bridge
      .start()
      .then(() => console.log('[feishu] 桥接已启动'))
      .catch((e) => console.error('[feishu] 桥接启动失败:', e && e.message));
  }
  // 启动本地 HTTP 接口（仅 127.0.0.1，供 Hermes skill 调用）
  httpServer.on('error', (e) => console.error('[http] 服务启动失败:', e && e.message));
  httpServer.listen(ROUNDTABLE_PORT, '127.0.0.1', () => {
    console.log(`[http] 本地接口已启动: http://127.0.0.1:${ROUNDTABLE_PORT} (POST /ask, GET /health)`);
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) mainWindow.show();
  });
});

// 再次启动时（单实例锁生效）：把已常驻的窗口唤到前台
app.on('second-instance', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

// 常驻托盘：关掉所有窗口也不退出（窗口是隐藏而非销毁）
app.on('window-all-closed', () => {
  // 故意留空：保持后台常驻，飞书服务继续运行
});

app.on('before-quit', () => {
  isQuitting = true;
  if (bridge) bridge.stop();
  try {
    httpServer.close();
  } catch {}
});
