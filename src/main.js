const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, shell, screen, webContents, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const history = require('./history');
// 适配器清单仅用于校验 /ask 的 sites 参数（纯配置，无 Electron 依赖，可安全 require）
const { ADAPTERS } = require('./adapters');
const VALID_SITE_IDS = new Set(ADAPTERS.map((a) => a.id));

// 10 个 webview 面板的加载事件都经 Electron 在宿主 WebContents 上挂转发监听，
// 基数大，Node 默认上限 10 容易在重建总结者面板（切换总结模型）的瞬时重叠下
// 触发 MaxListenersExceededWarning（生产日志实测 11 个 did-stop-loading）。
// 提高默认上限消除误报警告；真实泄漏仍会表现为监听数持续增长，不会被掩盖。
require('events').EventEmitter.defaultMaxListeners = 25;

// 去掉 File/Edit/View 原生菜单栏，界面只保留自己的按钮
Menu.setApplicationMenu(null);

// 单实例锁：防止重复启动导致两个实例争抢同一份登录数据（LOCK 错误）
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ===== 托盘常驻 =====
let tray = null;
let isQuitting = false; // 仅当真正退出（关窗退出模式 / 托盘「退出」/系统退出）时才关闭
// 关窗行为：exit=关窗即退出程序（默认，HTTP/微信服务随之停止）；
// tray=关窗隐藏到系统托盘常驻（托盘仅在常驻模式下存在，由渲染层按存储设置同步）
let closeMode = 'exit';

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) icon = icon.resize({ height: 16 });
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('AI 圆桌');
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

// dock 里的 webview 被内容层遮挡、隐藏到托盘时整窗后台化，曾致部分站点（豆包/MiniMax）
// 流式渲染停摆。v1.4.1 起改为动态控制：保留进程级与原生遮挡保护（这两项不致停摆），
// 仅移除全局的定时器节流禁用——参与轮次的面板经 setBackgroundThrottling(false) 精确豁免
// （engine.applyPanelThrottling），空闲面板恢复节流，降低 CPU 与内存占用
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// GPU 禁用与 X11 ozone 仅 Linux：本机（统信 UOS arm64）实测 GPU 进程反复崩溃
// （2026-08-18 曾 FATAL 退出），且 Wayland 会话下 webview 渲染异常，统一禁用硬件
// 加速并固定 X11。macOS 上不能设 ozone-platform=x11（无 X11 后端会崩）、GPU 也无需禁用。
if (process.platform === 'linux') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}
// Windows：Chromium 的原生窗口遮挡检测会把隐藏到托盘的窗口判定为"遮挡"并暂停
// 渲染，托盘常驻期间 HTTP 触发的轮次会停摆（Electron on Windows 已知问题）。
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

// ===== 服务编排：本地 HTTP 接口（供 Hermes skill 等 agent 调用）=====
const http = require('http');
const ROUNDTABLE_PORT = Number(process.env.ROUNDTABLE_PORT || 8765); // 仅监听 127.0.0.1

let mainWindow = null;
// requestId -> { source:'http', httpRes?, question, watchdog? }，结果回来时按来源路由
const pendingRounds = new Map();
// HTTP 排队（改进2）：单轮串行下并发 /ask 不再直接 429，最多排 3 个 FIFO 等待
const askQueue = [];
const ASK_QUEUE_MAX = 3;
// 关窗保护（改进1）：有进行中的轮次/总结时，退出前需用户确认
let roundActive = false;

// 看门狗（#1）：一轮从下发到 renderer 回报 service:result 的正常上限约 20 分钟
// （轮次等待 900s + 网页总结 300s + 发送/抓取余量）。超过 25 分钟仍无回报，
// 基本可判定 renderer 崩溃/卡死——若不主动释放，pendingRounds 永久非空，
// HTTP 接口会一直 busy/429，整个服务卡死到重启。这里兜底清理并回报超时。
const ROUND_WATCHDOG_MS = 25 * 60 * 1000;
function armRoundWatchdog(requestId) {
  const pending = pendingRounds.get(requestId);
  if (!pending) return;
  pending.watchdog = setTimeout(() => {
    if (!pendingRounds.has(requestId)) return; // 已被正常回报清掉
    pendingRounds.delete(requestId);
    console.error(`[watchdog] 轮次 ${requestId} 超过 ${ROUND_WATCHDOG_MS / 60000} 分钟未回报，强制释放 busy`);
    if (pending.source === 'http' && pending.httpRes) {
      try {
        jsonResponse(pending.httpRes, 504, { ok: false, error: 'round-timeout', message: '本轮处理超时（25 分钟未回报），请重试' });
      } catch {}
    }
  }, ROUND_WATCHDOG_MS);
}
function clearRoundWatchdog(requestId) {
  const pending = pendingRounds.get(requestId);
  if (pending && pending.watchdog) clearTimeout(pending.watchdog);
}

// 触发一轮圆桌：向 renderer 下发 service:ask；sites 为可选子集（改进2），缺省全部
function startRound(requestId, question, sites) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('service:ask', { requestId, question, sites });
    return true;
  }
  return false;
}

// 总结落成 docx（pandoc 转换），HTTP/微信等渠道以文件形式发送；失败返回 null 由调用方回退纯文本
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

// ----- 本地 HTTP 接口 -----
// 防跨站触发/DNS rebinding：
//  - Host 校验：rebinding 攻击把攻击域名解析到 127.0.0.1，Host 头仍是攻击域名 → 拒绝；
//  - Origin 校验：浏览器发起的跨站 POST（fetch text/plain 可绕过预检）必带 Origin，
//    非 127.0.0.1/localhost 白名单 → 拒绝；curl/Hermes skill 等脚本工具不带 Origin，不受影响；
//  - 可选 token：设 ROUNDTABLE_TOKEN 环境变量后，POST /ask 须带 X-RT-Token 头
//    （默认不启用，零配置摩擦；仅当端口需要暴露给非本机场景时才需要。
//    只约束 /ask，不拦 /health——watchdog 探活不带 token）
const EXPECTED_HOSTS = new Set([
  `127.0.0.1:${ROUNDTABLE_PORT}`,
  `localhost:${ROUNDTABLE_PORT}`,
  `[::1]:${ROUNDTABLE_PORT}`,
]);
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${ROUNDTABLE_PORT}`,
  `http://localhost:${ROUNDTABLE_PORT}`,
]);
const REQ_TOKEN = process.env.ROUNDTABLE_TOKEN || '';

function crossOriginBlocked(req) {
  if (!EXPECTED_HOSTS.has(String(req.headers.host || '').toLowerCase())) return true;
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(String(origin).toLowerCase())) return true;
  return false;
}

// 超大 body 专用错误：调用方据此回 413。
// 注意：超限只 reject、不毁连接——先让调用方把 413 写回去再关（2026-08-24 实测
// 先 destroy 时客户端只收到 100-continue，看不到任何状态码）。
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    let overflow = false;
    req.on('data', (c) => {
      if (overflow) return;
      d += c;
      if (d.length > 1e6) {
        overflow = true;
        const e = new Error('body-too-large');
        e.code = 'BODY_TOO_LARGE';
        reject(e);
      }
    });
    req.on('end', () => {
      if (!overflow) resolve(d);
    });
    req.on('error', (e) => {
      if (!overflow) reject(e);
    });
  });
}

function jsonResponse(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const httpServer = http.createServer(async (req, res) => {
  try {
    // 统一入口防护（含 /health：恶意页面探测本服务存在与否无收益，一并收紧）
    if (crossOriginBlocked(req)) {
      return jsonResponse(res, 403, { ok: false, error: 'forbidden', message: '跨站/来源校验未通过' });
    }
    if (req.method === 'GET' && req.url === '/health') {
      return jsonResponse(res, 200, { ok: true, ready: !!(mainWindow && !mainWindow.isDestroyed()) });
    }
    if (req.method === 'POST' && req.url === '/ask') {
      // 可选 token（ROUNDTABLE_TOKEN 环境变量启用；默认不设不校验）
      if (REQ_TOKEN && req.headers['x-rt-token'] !== REQ_TOKEN) {
        return jsonResponse(res, 403, { ok: false, error: 'forbidden', message: '缺少或错误的 X-RT-Token' });
      }
      let question = '';
      let sites;
      let async = false;
      let raw;
      try {
        raw = await readBody(req);
      } catch (e) {
        if (e && e.code === 'BODY_TOO_LARGE') {
          // Connection: close：上传流已被截断，此连接不可复用
          res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' });
          res.end(JSON.stringify({ ok: false, error: 'body-too-large', message: '请求体过大（上限 1MB）' }));
          return;
        }
        return jsonResponse(res, 400, { ok: false, error: 'bad-request', message: String((e && e.message) || e) });
      }
      try {
        const body = JSON.parse(raw || '{}');
        question = (body.question || '').trim();
        async = body.async === true;
        if (Array.isArray(body.sites) && body.sites.length) {
          // 未知站点 id 显式拒绝（此前静默过滤，全部未知时会空跑一轮还消耗总结）；
          // 部分有效则取交集并告警，容忍 skill 侧笔误
          const wanted = body.sites.map(String);
          sites = wanted.filter((id) => VALID_SITE_IDS.has(id));
          if (!sites.length) {
            return jsonResponse(res, 400, {
              ok: false,
              error: 'invalid-sites',
              message: 'sites 中没有有效的站点 id',
              valid: [...VALID_SITE_IDS],
            });
          }
          const dropped = wanted.filter((id) => !VALID_SITE_IDS.has(id));
          if (dropped.length) console.warn(`[http] 忽略未知站点: ${dropped.join(',')}`);
        }
      } catch {}
      if (!question) return jsonResponse(res, 400, { ok: false, error: 'missing-question' });
      if (pendingRounds.size > 0 || askQueue.length > 0) {
        // 改进2：不再直接 429——最多排 3 个 FIFO，当前轮结束后自动开始
        if (askQueue.length >= ASK_QUEUE_MAX) {
          return jsonResponse(res, 429, { ok: false, error: 'busy', message: '正在处理另一轮，且排队已满（最多 3 个），请稍候再试' });
        }
        const requestId = 'queue-' + Date.now();
        askQueue.push({ requestId, question, sites, httpRes: async ? null : res, source: async ? 'http-async' : 'http' });
        console.log(`[http] 排队受理（第 ${askQueue.length} 位）: ${question}`);
        return jsonResponse(res, 202, {
          ok: true,
          queued: true,
          requestId,
          position: askQueue.length,
          poll: `/ask/status?id=${requestId}`,
          message: `已排队（第 ${askQueue.length} 位），当前轮结束后自动开始`,
        });
      }
      const requestId = (async ? 'async-' : 'http-') + Date.now();
      pendingRounds.set(requestId, { source: async ? 'http-async' : 'http', httpRes: async ? null : res, question, sites });
      if (!startRound(requestId, question, sites)) {
        pendingRounds.delete(requestId);
        return jsonResponse(res, 503, { ok: false, error: 'not-ready', message: '服务窗口尚未就绪' });
      }
      armRoundWatchdog(requestId);
      console.log(`[http] 收到问题${async ? '（异步）' : ''}: ${question}${sites ? '（子集:' + sites.join(',') + '）' : ''}`);
      // 异步模式：受理即返回 requestId，结果经 /ask/status 或 /history/item 轮询。
      // 最坏总时长（420s 轮次 + 300s 总结）远超同步 curl 的合理超时，长轮询必丢结果。
      if (async) {
        return jsonResponse(res, 202, { ok: true, accepted: true, requestId, poll: `/ask/status?id=${requestId}` });
      }
      return; // 同步模式：响应挂起，待 service:result 写回（看门狗兜底超时释放）
    }
    // 异步轮次状态查询：running=还在跑；done=已完成（item 为完整结果）；404=不存在
    if (req.method === 'GET' && req.url.startsWith('/ask/status')) {
      const u = new URL('http://x' + req.url);
      const id = u.searchParams.get('id') || '';
      if (pendingRounds.has(id)) return jsonResponse(res, 200, { ok: true, state: 'running' });
      if (askQueue.some((q) => q.requestId === id)) return jsonResponse(res, 200, { ok: true, state: 'queued' });
      const found = history.query('', 10000).find((e) => e.id === id);
      if (found) return jsonResponse(res, 200, { ok: true, state: 'done', item: found });
      return jsonResponse(res, 404, { ok: false, state: 'not-found', error: 'not-found' });
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

// 排队调度（改进2）：当前轮结束后取队首开跑；一次只启动一轮
function processAskQueue() {
  while (askQueue.length) {
    const item = askQueue.shift();
    pendingRounds.set(item.requestId, { source: item.source, httpRes: item.httpRes, question: item.question, sites: item.sites });
    if (!startRound(item.requestId, item.question, item.sites)) {
      try { jsonResponse(item.httpRes, 503, { ok: false, error: 'not-ready', message: '服务窗口尚未就绪' }); } catch {}
      pendingRounds.delete(item.requestId);
      continue;
    }
    armRoundWatchdog(item.requestId);
    console.log(`[http] 排队轮次开始: ${item.question}${item.sites ? '（子集:' + item.sites.join(',') + '）' : ''}`);
    break;
  }
}

// renderer 回报最终结果 → HTTP 渠道回写 JSON（带 summaryFile 附件路径）
ipcMain.on('service:result', async (_event, data) => {
  const pending = pendingRounds.get(data.requestId);
  if (!pending) return;
  clearRoundWatchdog(data.requestId); // 正常回报，撤掉超时兜底
  pendingRounds.delete(data.requestId);

  // 有总结时落成 docx：附录含各家原文，正文可能数万字，文件形式体验远好于长文本。
  // 先建 docx 再落库：历史记录携带 summaryFile，异步轮次经 /ask/status 取结果时
  // 同样能拿到附件路径（同步响应字段与之一致）
  let docxPath = null;
  if (!data.error && data.summary) {
    docxPath = await buildSummaryDocx(pending.question, data.summary);
  }

  // 改进1：落库历史记录（跳过 busy/无数据轮次）
  if (!data.error && Array.isArray(data.replies)) {
    history.saveRound({
      id: data.requestId,
      ts: new Date().toISOString(),
      question: pending.question,
      source: pending.source,
      summary: data.summary || '',
      summaryError: data.summaryError || '',
      summaryFile: docxPath || '',
      replies: data.replies || [],
    });
  }

  if (pending.source === 'http') {
    try {
      if (data.error) {
        // 渲染层拒绝/失败（如桌面端圆桌占用 busy、round-failed）：如实回错误码，
        // 不伪装成 ok:true 的空成功——调用方（Hermes skill）需要靠状态码决定重试
        jsonResponse(pending.httpRes, data.error === 'busy' ? 429 : 500, {
          ok: false,
          error: data.error,
          message: data.message || data.summaryError || '',
          question: pending.question,
        });
      } else {
        jsonResponse(pending.httpRes, 200, {
          ok: true,
          question: pending.question,
          summary: data.summary || '',
          summaryError: data.summaryError || '',
          replies: data.replies || [],
          // 微信（Hermes skill）等渠道：有此字段时把该 docx 作为附件发给用户
          summaryFile: docxPath || '',
        });
      }
    } catch (e) {
      console.error('[http] 回写失败:', e && e.message);
    }
    processAskQueue(); // 同步轮次收尾同样要调度排队
    return;
  }
  // 本轮收尾（正常/失败/busy 均算）：调度下一个排队轮次
  processAskQueue();
});

// renderer 上报进度（Phase 2 仅记录；Phase 3 用于增量更新卡片）。
// 3s 轮询期间进度几乎总是不变，内容相同不重复打印（曾一日 1200+ 行重复进度）
let lastProgressLine = '';
ipcMain.on('service:progress', (_event, data) => {
  const line = `进度 done=${data.done}/${data.total} 生成中=${data.generating} 失败=${data.error}`;
  if (line === lastProgressLine) return;
  lastProgressLine = line;
  console.log(`[service] ${line}`);
});

// ===== 历史记录（改进1，桌面端同步）=====
// 桌面端手动轮次总结后落库
ipcMain.on('save-history', (_event, entry) => {
  history.saveRound(entry);
});
// 桌面端历史弹窗查询
ipcMain.handle('get-history', (_event, q, limit) => history.query(q || '', limit || 20));
// 删除单条历史记录；记录若带总结 docx 附件一并清理（仅限 summaries 目录内，防误删）
ipcMain.handle('delete-history', (_event, id) => {
  const entry = history.query('', 10000).find((e) => e.id === id);
  const ok = history.remove(id);
  if (ok && entry && entry.summaryFile) {
    try {
      const p = path.resolve(entry.summaryFile);
      const dir = path.resolve(app.getPath('userData'), 'summaries');
      if (p.startsWith(dir + path.sep)) fs.unlink(p, () => {});
    } catch {}
  }
  return ok;
});

// 总结导出：md 直接写盘；pdf 以调用方拼好的自包含 HTML 为中转——写入临时文件、
// 离屏窗口加载后 printToPDF（A4 带背景），临时 html 无论成败都清理。
// pandoc 转 PDF 需 LaTeX 引擎（本机不具备），printToPDF 走 Chromium 自身排版，零依赖。
const os = require('os');

async function htmlToPdf(html) {
  const tmpPath = path.join(os.tmpdir(), `ai-roundtable-export-${Date.now()}.html`);
  fs.writeFileSync(tmpPath, html, 'utf8');
  // 本机（UOS arm64）已实测：隐藏窗口 loadFile 后 printToPDF 稳定出 A4；
  // webPreferences 保持默认（沙箱+contextIsolation 即默认开启）
  const win = new BrowserWindow({ show: false });
  try {
    await win.loadFile(tmpPath);
    return await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
  } finally {
    win.destroy();
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

ipcMain.handle('export-summary', async (_event, opts) => {
  if (!mainWindow) return { ok: false, error: 'no-window' };
  const format = opts && opts.format === 'pdf' ? 'pdf' : 'md';
  const ext = format === 'pdf' ? 'pdf' : 'md';
  const base = String((opts && opts.defaultName) || '圆桌总结').replace(/\.(md|pdf)$/i, '');
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: format === 'pdf' ? '导出总结为 PDF' : '导出总结为 Markdown',
    defaultPath: path.join(app.getPath('documents'), `${base}.${ext}`),
    filters:
      format === 'pdf'
        ? [{ name: 'PDF', extensions: ['pdf'] }]
        : [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  // 选择器没带对扩展名时补上（Linux GTK 个别场景选了过滤器仍返回裸文件名）
  const target = filePath.toLowerCase().endsWith(`.${ext}`) ? filePath : `${filePath}.${ext}`;
  try {
    if (format === 'md') {
      fs.writeFileSync(target, String(opts.markdown || ''), 'utf8');
    } else {
      const buf = await htmlToPdf(String(opts.html || ''));
      fs.writeFileSync(target, buf);
    }
    console.log(`[export] 已导出 ${format.toUpperCase()}: ${target}`);
    return { ok: true, filePath: target };
  } catch (e) {
    console.error('[export] 导出失败:', e && e.message);
    return { ok: false, error: String((e && e.message) || e) };
  }
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
    if (fs.existsSync(docxPath)) {
      // docx 已成：中间产物 md 即时清理（上传用的是 docx；md 仅在转换失败时作回退附件）
      try { fs.unlinkSync(mdPath); } catch {}
      return { ok: true, path: docxPath };
    }
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

// 渲染层同步关窗行为（设置弹窗切换；localStorage 持久化，窗口加载时回传）。
// 托盘只在「最小化到托盘」模式下存在，切回退出模式时托盘随之移除
ipcMain.on('set-close-mode', (_event, mode) => {
  if (mode !== 'exit' && mode !== 'tray') return;
  if (mode === closeMode) return;
  closeMode = mode;
  if (closeMode === 'tray' && !tray) createTray();
  else if (closeMode === 'exit' && tray) {
    tray.destroy();
    tray = null;
  }
  console.log(`[close] 关窗行为已切换为: ${closeMode === 'exit' ? '退出程序' : '最小化到托盘'}`);
});

// 关窗保护（改进1）：渲染层在本轮有面板发送/生成或总结进行中时上报 true，
// 退出模式下关窗先弹确认，防止误关丢整轮
ipcMain.on('set-round-active', (_event, active) => {
  roundActive = !!active;
});

// 动态节流（改进A）：参与轮次的面板关闭节流（隐藏窗口下流式渲染不停摆），
// 空闲面板恢复节流（Chromium 可回收后台页面资源）
ipcMain.handle('set-throttling', (_event, webContentsId, allowed) => {
  const wc = webContents.fromId(webContentsId);
  if (!wc) return false;
  wc.setBackgroundThrottling(!!allowed);
  return true;
});

// ===== 输入框附件（随问题分发给各家）=====
// 选文件：系统对话框，返回磁盘路径（CDP setFileInputFiles 需要真实路径）
ipcMain.handle('choose-attachment', async () => {
  if (!mainWindow) return { canceled: true };
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: '选择随问题发送的附件',
    filters: [{ name: '文档', extensions: ['doc', 'docx', 'md', 'markdown', 'txt', 'pdf'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { canceled: true };
  return { canceled: false, path: filePaths[0], name: path.basename(filePaths[0]) };
});

// 逐家上传附件（2026-09-06 全量探索标定的各家路径，配置见 adapters.js attach 字段）：
//   input:'resident' —— 常驻 input[type=file] 直接 setFileInputFiles
//   entry —— 先可信点击入口（可能弹菜单）；menuText 命中则再可信点菜单项
//   input:'afterEntry' —— 入口/菜单之后 DOM 查询 input[type=file]；'chooser' —— 拦截
//   Page.fileChooserOpened 用 backendNodeId 直塞
// 上传后校验页面出现文件名词干（chip），失败返回 {ok:false} 由调用方降级纯文本
ipcMain.handle('attach-file', async (_event, webContentsId, filePath, fileName, profile) => {
  const wc = webContents.fromId(webContentsId);
  if (!wc) return { ok: false, error: 'webview 未就绪' };
  if (!profile || !profile.input) return { ok: false, error: 'unsupported' };
  const dbg = wc.debugger;
  let attached = false;
  const chooserEvents = [];
  const onMessage = (_e, method, params) => {
    if (method === 'Page.fileChooserOpened') chooserEvents.push(params);
  };
  try {
    await dbg.attach('1.3');
    attached = true;
    dbg.on('message', onMessage);
    await dbg.sendCommand('Page.enable');
    await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });

    const evalJs = async (expr) => {
      const r = await dbg.sendCommand('Runtime.evaluate', { expression: expr, returnByValue: true });
      if (r.exceptionDetails) throw new Error('evaluate 失败');
      return r.result ? r.result.value : undefined;
    };
    const sleep = (ms) => new Promise((r2) => setTimeout(r2, ms));
    const trustedClick = (x, y) => {
      wc.sendInputEvent({ type: 'mouseMoved', x, y });
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    };
    // chip 校验词：文件名词干（≥4 字）优先，否则完整文件名
    const stem = String(fileName || '').replace(/\.[^.]+$/, '');
    const chipProbe = `document.body.innerText.indexOf(${JSON.stringify(stem.length >= 4 ? stem : fileName)}) !== -1`;

    const pickInputAndUpload = async () => {
      const doc = await dbg.sendCommand('DOM.getDocument', { depth: -1 });
      const res = await dbg.sendCommand('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
      if (!res.nodeIds.length) return false;
      const accepts = JSON.parse(await evalJs(`(function () {
        var out = []; var els = document.querySelectorAll('input[type=file]');
        for (var i = 0; i < els.length; i++) out.push(els[i].getAttribute('accept') || '');
        return JSON.stringify(out);
      })()`));
      let pick = 0;
      for (let i = 0; i < accepts.length; i++) if (/doc|md|text/i.test(accepts[i] || '')) { pick = i; break; }
      for (let i = 0; i < accepts.length; i++) if (!(accepts[i] || '')) { pick = i; break; }
      await dbg.sendCommand('DOM.setFileInputFiles', { files: [filePath], nodeId: res.nodeIds[pick] });
      await sleep(2500);
      return !!(await evalJs(chipProbe));
    };

    if (profile.input === 'resident') {
      let nodes = null;
      for (let i = 0; i < 6 && !nodes; i++) {
        const doc = await dbg.sendCommand('DOM.getDocument', { depth: -1 });
        const res = await dbg.sendCommand('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
        if (res.nodeIds.length) { nodes = res; break; }
        await sleep(800);
      }
      if (!nodes) return { ok: false, error: '未找到文件框' };
      const accepts = JSON.parse(await evalJs(`(function () {
        var out = []; var els = document.querySelectorAll('input[type=file]');
        for (var i = 0; i < els.length; i++) out.push(els[i].getAttribute('accept') || '');
        return JSON.stringify(out);
      })()`));
      let pick = 0;
      for (let i = 0; i < accepts.length; i++) if (/doc|md|text/i.test(accepts[i] || '')) { pick = i; break; }
      for (let i = 0; i < accepts.length; i++) if (!(accepts[i] || '')) { pick = i; break; }
      await dbg.sendCommand('DOM.setFileInputFiles', { files: [filePath], nodeId: nodes.nodeIds[pick] });
      await sleep(2500);
      return { ok: !!(await evalJs(chipProbe)) };
    }

    // entry 流：逐个候选可信点击 → 菜单 → 文件框/chooser
    const entries = Array.isArray(profile.entry) ? profile.entry : [profile.entry];
    const minX = profile.entryMinX || 0;
    for (const sel of entries) {
      const rects = JSON.parse(await evalJs(`(function () {
        var out = [];
        var els = document.querySelectorAll(${JSON.stringify(sel)});
        for (var i = 0; i < els.length && out.length < 4; i++) {
          var r = els[i].getBoundingClientRect();
          if (!(r.width > 2 && r.height > 2)) continue;
          if (${minX} && (r.x + r.width / 2) < ${minX}) continue;
          out.push({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
        }
        return JSON.stringify(out);
      })()`));
      for (const rect of rects) {
        trustedClick(rect.x, rect.y);
        await sleep(1300);

        if (profile.menuText) {
          const menuRect = await evalJs(`(function () {
            var re = new RegExp(${JSON.stringify(profile.menuText)});
            var els = document.querySelectorAll('li, div[role="menuitem"], div, span, p, a');
            for (var i = 0; i < els.length; i++) {
              var t = (els[i].textContent || '').trim();
              if (t.length > 0 && t.length <= 14 && re.test(t) && !/图片|拍照|截图/.test(t)) {
                var r = els[i].getBoundingClientRect();
                if (r.width > 0 && r.height > 0) return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
              }
            }
            return null;
          })()`);
          if (!menuRect) continue; // 该候选没弹菜单 → 下一个
          const m = JSON.parse(menuRect);
          trustedClick(m.x, m.y);
          await sleep(1500);
        }

        // 文件框：DOM 查询直塞
        if (await pickInputAndUpload()) return { ok: true };
        // chooser 事件路径：backendNodeId 直塞
        if (chooserEvents.length) {
          const evp = chooserEvents[chooserEvents.length - 1];
          if (evp.backendNodeId) {
            await dbg.sendCommand('DOM.setFileInputFiles', { files: [filePath], backendNodeId: evp.backendNodeId });
            await sleep(2500);
            if (await evalJs(chipProbe)) return { ok: true };
          }
        }
      }
    }
    return { ok: false, error: '入口未响应' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    if (attached) {
      try { dbg.off('message', onMessage); } catch {}
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
  // 关窗行为：exit 模式下关窗即退出（真正结束进程，HTTP 服务随之停止）；
  // tray 模式下隐藏到托盘常驻（仅 isQuitting 时才真正销毁）
  win.on('close', (e) => {
    if (closeMode === 'exit') {
      // 关窗保护：本轮有面板在发送/生成或总结进行中，先确认再退
      if (roundActive) {
        const choice = dialog.showMessageBoxSync(win, {
          type: 'warning',
          message: '本轮圆桌或总结仍在进行中，现在退出将丢弃未完成的结果。',
          detail: '只有本轮结束后结果才会自动存入历史记录。',
          buttons: ['取消', '仍然退出'],
          defaultId: 0,
          cancelId: 0,
        });
        if (choice !== 1) {
          e.preventDefault();
          return;
        }
      }
      isQuitting = true;
      app.quit();
      return;
    }
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
  // 托盘不在启动时创建：默认为「关窗即退出」模式，托盘无意义；
  // 渲染层加载后会按存储的设置同步（tray 模式下经 set-close-mode 创建）
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
  // 故意留空：保持后台常驻，HTTP 服务继续运行
});

app.on('before-quit', () => {
  isQuitting = true;
  try {
    httpServer.close();
  } catch {}
});

// SIGTERM/SIGINT 显式退出：Electron 默认收到 SIGTERM 不会及时退出（2026-08 实测
// `systemctl stop/restart` 挂满 90s TimeoutStopSec 才被 SIGKILL，journal 两次
// 'stop-sigterm timed out'）；挂起期间若再撞上 GPU 崩溃，unit 以 failed 收场且
// 不再触发 Restart（2026-08-22 宕机 44 小时未自愈的诱因链）。显式 quit 让
// systemd 治理（TimeoutStopSec/Restart）真正可靠。
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    isQuitting = true;
    app.quit();
  });
}
