#!/usr/bin/env node
/**
 * 选择器每日自检（只读探测，不发消息、不点击、不消耗各家额度）。
 *
 * 目的：网站改版导致选择器失效时当天告警，而不是等用户提问失败才发现。
 * 原理：连 127.0.0.1:9222 的 CDP，在每个 webview 里评估一段只读脚本——
 *   ①输入框能否命中（专属选择器 / 仅通用兜底 / 完全没有）
 *   ②发送键能否命中（同上；部分站发送键懒加载，缺失只记 info）
 *   ③页面是否停在登录/验证（URL/标题特征）
 * 分级：ok < info（发送键未出现，多为懒加载）< warn（专属选择器失效、仅兜底命中
 * ——改版前兆，通知）< risk（登录/验证页）/ error（输入框都没有，通知 + 退出码 1）。
 *
 * 由 ai-roundtable-check.timer 每日调用；也可手动运行：scripts/selector-check.js
 * 依赖 Node 22+（内置 WebSocket），无外部包。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { ADAPTERS } = require('../src/adapters');

const CDP_PORT = 9222;
const APP_PORT = 8765;
const LOG = path.join(os.homedir(), 'ai-roundtable-selector-check.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(pathUrl, port = APP_PORT) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: pathUrl }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

// CDP Runtime.evaluate（一次性连接，带超时）
function evaluate(wsUrl, expression, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('timeout')); }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      if (m.id === 1) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        if (m.error || m.result.exceptionDetails) reject(new Error('evaluate-failed'));
        else resolve(m.result.result ? m.result.result.value : undefined);
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
  });
}

function logLine(s) {
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 1048576) {
      fs.writeFileSync(LOG, fs.readFileSync(LOG, 'utf8').split('\n').slice(-1000).join('\n'));
    }
    fs.appendFileSync(LOG, s + '\n');
  } catch {}
  console.log(s);
}

function notify(title, body) {
  try {
    spawnSync('notify-send', ['-a', 'AI 圆桌', title, body], { stdio: 'ignore' });
  } catch {}
}

// 只读探测：不点击/不填值/不导航，仅查询 DOM 与可见性
function probeExpr(adapter) {
  // 通用兜底与 js/core.js 的发送兜底口径一致
  const genericSend = [
    'button[aria-label*="发送"]', 'button[data-testid*="send"]',
    '[role="button"][class*="send" i]', '[data-testid*="send" i]', '[aria-label*="发送" i]',
  ];
  return `(function () {
    function vis(el) { if (!el) return false; var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
    function find(list) {
      for (var i = 0; i < list.length; i++) {
        try {
          var els = document.querySelectorAll(list[i]);
          for (var j = 0; j < els.length; j++) if (vis(els[j])) return els[j];
        } catch (e) {}
      }
      return null;
    }
    var ownInput = find(${JSON.stringify(adapter.inputSelectors)});
    var input = ownInput || find(['textarea', '[contenteditable="true"]']);
    var ownSend = find(${JSON.stringify(adapter.sendSelectors)});
    var send = ownSend || find(${JSON.stringify(genericSend)});
    var title = (document.title || '').slice(0, 50);
    var loginLike = /login|passport|verify|captcha|account\\./.test(location.href.toLowerCase()) ||
      /登录|登入|安全验证/.test(title);
    return JSON.stringify({ ownInput: !!ownInput, input: !!input, ownSend: !!ownSend, send: !!send, title: title, loginLike: loginLike });
  })()`;
}

async function main() {
  // 1) 等服务就绪（服务可能刚被 watchdog 拉起）
  let ready = false;
  for (let i = 0; i < 36; i++) {
    try {
      const h = await httpJson(`/health`);
      if (h && h.ok && h.ready) { ready = true; break; }
    } catch {}
    await sleep(5000);
  }
  if (!ready) {
    logLine(`${new Date().toLocaleString('zh-CN', { hour12: false })} 自检未执行：服务未就绪（8765）`);
    return 1;
  }

  // 2) 等 webview 全部出现（应用冷启动时页面逐个加载）
  let targets = [];
  for (let i = 0; i < 36; i++) {
    try {
      const list = await httpJson(`/json/list`, CDP_PORT);
      targets = list.filter((t) => t.type === 'webview');
      if (targets.length >= ADAPTERS.length) break;
    } catch {}
    await sleep(5000);
  }
  await sleep(8000); // 等 SPA 初始化出输入框

  // 3) 逐家探测
  // 适配器 URL 与实际落点域可能不同（如千问 tongyi.com → 302 到 qianwen.com），
  // 按别名表匹配；其余按 host 精确匹配。
  const HOST_ALIASES = { qwen: ['tongyi.com', 'qianwen.com', 'www.tongyi.com', 'www.qianwen.com'] };
  const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; } };
  const results = [];
  for (const adapter of ADAPTERS) {
    const own = hostOf(adapter.url);
    const hosts = HOST_ALIASES[adapter.id] || [own];
    const target = targets.find((t) => hosts.includes(hostOf(t.url)));
    if (!target) {
      results.push({ id: adapter.id, name: adapter.name, status: 'error', detail: 'webview 未加载' });
      continue;
    }
    try {
      const r = JSON.parse(await evaluate(target.webSocketDebuggerUrl, probeExpr(adapter)));
      let status = 'ok';
      let detail = '';
      if (r.loginLike) { status = 'risk'; detail = `页面停在登录/验证（${r.title}）`; }
      else if (!r.input) { status = 'error'; detail = '输入框未命中（含通用兜底）'; }
      else if (!r.send) { status = 'info'; detail = '发送键未出现（多为点击后懒加载，仅记录）'; }
      else if (!r.ownInput || !r.ownSend) {
        status = 'warn';
        detail = `专属选择器失效，仅兜底命中（${!r.ownInput ? '输入框' : ''}${!r.ownInput && !r.ownSend ? '+' : ''}${!r.ownSend ? '发送键' : ''}）——改版前兆`;
      }
      results.push({ id: adapter.id, name: adapter.name, status, detail });
    } catch (e) {
      results.push({ id: adapter.id, name: adapter.name, status: 'error', detail: '探测失败：' + e.message });
    }
  }

  // 4) 汇总 + 记录 + 通知
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
  const icon = { ok: '✓', info: '·', warn: '⚠', risk: '🛡', error: '✗' };
  for (const r of results) logLine(`${stamp} [${icon[r.status]}] ${r.name}(${r.id}): ${r.status}${r.detail ? ' — ' + r.detail : ''}`);
  const bad = results.filter((r) => r.status === 'error' || r.status === 'risk');
  const warns = results.filter((r) => r.status === 'warn');
  if (bad.length) {
    const msg = `${bad.map((r) => r.name).join('、')}（${[...bad, ...warns].length}/${results.length} 项异常）`;
    logLine(`${stamp} 自检结论：异常 — ${msg}`);
    notify('AI 圆桌 · 选择器自检异常', `${msg}，详见 ~/ai-roundtable-selector-check.log`);
    return 1;
  }
  if (warns.length) {
    const msg = `${warns.map((r) => r.name).join('、')} 专属选择器仅兜底命中，建议核对`;
    logLine(`${stamp} 自检结论：告警 — ${msg}`);
    notify('AI 圆桌 · 选择器自检告警', msg);
    return 0;
  }
  logLine(`${stamp} 自检结论：全部正常（${results.length} 家）`);
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  logLine(`${new Date().toLocaleString('zh-CN', { hour12: false })} 自检脚本异常：${e.message}`);
  process.exit(1);
});
