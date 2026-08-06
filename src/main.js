const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, shell, screen, webContents } = require('electron');
const path = require('path');
// 先加载 .env（FEISHU_APP_ID / FEISHU_APP_SECRET），再引入飞书桥接
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
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

// ===== 服务编排：飞书桥接 + 本地 HTTP 接口（供 Hermes skill 调用）=====
const http = require('http');
const ROUNDTABLE_PORT = Number(process.env.ROUNDTABLE_PORT || 8765); // 仅监听 127.0.0.1

let mainWindow = null;
// requestId -> { source:'feishu'|'http', chatId?, httpRes?, question }，结果回来时按来源路由
const pendingRounds = new Map();

// 纯文本格式化：总结 + 8 家回复（单家截断到 1200 字）——飞书用
function formatResultText(data) {
  if (data.error === 'busy') return data.message || '正在处理上一条，请稍候';
  if (data.error) return `出错了：${data.message || data.error}`;
  let out = '';
  if (data.summary) {
    out += `【总结】\n${data.summary}\n`;
  } else if (data.summaryError) {
    out += `【总结失败】${data.summaryError}\n`;
  }
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
      console.log(`[http] 收到问题: ${question}${sites ? '（子集:' + sites.join(',') + '）' : ''}`);
      return; // 响应挂起，待 service:result 写回
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

// renderer 回报最终结果 → 按来源路由（飞书文本 or HTTP JSON）
ipcMain.on('service:result', (_event, data) => {
  const pending = pendingRounds.get(data.requestId);
  if (!pending) return;
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

  if (pending.source === 'http') {
    try {
      jsonResponse(pending.httpRes, 200, {
        ok: true,
        question: pending.question,
        summary: data.summary || '',
        summaryError: data.summaryError || '',
        replies: data.replies || [],
      });
    } catch (e) {
      console.error('[http] 回写失败:', e && e.message);
    }
    return;
  }

  if (!bridge) return;
  bridge.sendText(pending.chatId, formatResultText(data)).catch((e) => {
    console.error('[feishu] 发送结果失败:', e && e.message);
  });
});

// renderer 上报进度（Phase 2 仅记录；Phase 3 用于增量更新卡片）
ipcMain.on('service:progress', (_event, data) => {
  console.log(`[feishu] 进度 done=${data.done}/${data.total} 生成中=${data.generating} 失败=${data.error}`);
});

// ===== 历史记录（改进1，桌面端同步）=====
// 桌面端手动轮次总结后落库
ipcMain.on('save-history', (_event, entry) => {
  history.saveRound(entry);
});
// 桌面端历史弹窗查询
ipcMain.handle('get-history', (_event, q, limit) => history.query(q || '', limit || 20));

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
  const timer = setTimeout(() => ac.abort(), 90000); // 服务商繁忙时避免无限挂起
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
    if (e.name === 'AbortError') throw new Error('调用超时（90 秒无响应，服务商可能繁忙，请稍后重试）');
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
