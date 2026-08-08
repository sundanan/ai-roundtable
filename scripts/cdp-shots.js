/**
 * 公众号五连图自动截取（新版应用验证 + 素材更新）：
 *   01-待命.png          输入框 + 8 家就绪
 *   02-八家齐发.png       广播后全员发送中/生成中
 *   03-回复陆续到达.png   部分已交卷、部分仍在生成
 *   04-完成与总结.png     8 家终态 + LLM 总结渲染完成
 *   05-单家全文.png       展开回复最长的一家的完整回复
 *
 * 前置：应用以 --remote-debugging-port=9222 启动。
 * 运行：node scripts/cdp-shots.js   （一轮约 1~8 分钟，取决于最慢的一家）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = 9222;
const OUT_DIR = path.join(__dirname, '..', 'docs', 'wechat-article');
const QUESTION = '在厦门待两天，除了鼓浪屿和植物园，还有哪些地方值得玩';

function httpJson(p) {
  return new Promise((res, rej) => {
    http.get({ host: 'localhost', port: PORT, path: p }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 持久 CDP 连接（页面目标），支持 Runtime.evaluate 与 Page.captureScreenshot
class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.seq = 0; this.pending = new Map(); }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw); } catch { return; }
        if (m.id && this.pending.has(m.id)) {
          const { resolve: ok, reject: bad } = this.pending.get(m.id);
          this.pending.delete(m.id);
          if (m.error) bad(new Error(m.error.message)); else ok(m.result);
        }
      });
    });
  }
  call(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); }
      }, 60000);
    });
  }
  async eval(expression, awaitPromise) {
    const r = await this.call('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: !!awaitPromise,
    });
    if (r.exceptionDetails) throw new Error('eval exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 200));
    return r.result ? r.result.value : undefined;
  }
  async shot(file) {
    const r = await this.call('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('  📸 已保存', path.basename(file), (fs.statSync(file).size / 1024).toFixed(0) + 'KB');
  }
}

const GET_PANELS = `JSON.stringify([...panels.values()].map(p=>({id:p.adapter.id,name:p.adapter.name,state:p.state,len:(p.reply||'').length})))`;
const SUMMARY_STATE = `JSON.stringify({status:document.getElementById('summary-status').textContent,toc:!document.getElementById('summary-toc').hidden,cls:document.getElementById('summary-body').className})`;

async function getStates(cdp) {
  try { return JSON.parse(await cdp.eval(GET_PANELS)); } catch { return null; }
}

async function main() {
  // 等主页面 + 8 个 webview 就绪
  let host = null;
  let wv = [];
  for (let i = 0; i < 30; i++) {
    let list = [];
    try { list = await httpJson('/json/list'); } catch { await sleep(2000); continue; }
    host = list.find((t) => t.type === 'page');
    wv = list.filter((t) => t.type === 'webview');
    if (host && wv.length >= 8) break;
    console.log(`等待应用就绪… (webview ${wv.length}/8)`);
    await sleep(2000);
  }
  if (!host) throw new Error('找不到主页面目标（应用是否带 --remote-debugging-port=9222 启动？）');
  console.log('webview 数:', wv.length, '，再等 10 秒让各家页面初始化…');
  await sleep(10000);

  const cdp = new Cdp(host.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.call('Page.enable');

  // 重截前先刷新渲染页，回到干净的待命态（webview 登录态在 persist 分区里，不受影响）
  await cdp.call('Page.reload');
  await sleep(12000);
  for (let i = 0; i < 20; i++) {
    const n = await cdp.eval(`(typeof panels!=='undefined') ? panels.size : 0`).catch(() => 0);
    if (n >= 8) break;
    await sleep(2000);
  }

  // ---- 01 待命 ----
  await cdp.shot(path.join(OUT_DIR, '01-待命.png'));

  // ---- 广播问题 ----
  console.log('广播问题:', QUESTION);
  await cdp.eval(`broadcast(${JSON.stringify(QUESTION)})`, false);

  // ---- 02 八家齐发：多数处于发送中/生成中 ----
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const st = await getStates(cdp);
    if (!st) continue;
    const busy = st.filter((s) => s.state === 'sending' || s.state === 'generating').length;
    console.log(`  [02 等待] 发送/生成中=${busy}`);
    if (busy >= 6 || i >= 4) break;
  }
  await cdp.shot(path.join(OUT_DIR, '02-八家齐发.png'));

  // ---- 03 回复陆续到达：已有交卷、仍有人在写 ----
  let shot03 = false;
  for (let i = 0; i < 240 && !shot03; i++) {
    await sleep(2000);
    const st = await getStates(cdp);
    if (!st) continue;
    const done = st.filter((s) => s.state === 'done').length;
    const busy = st.filter((s) => s.state === 'sending' || s.state === 'generating').length;
    const err = st.filter((s) => s.state === 'error').length;
    console.log(`  [03 等待] done=${done} 生成中=${busy} 失败=${err}`);
    if (done >= 2 && busy >= 2) {
      await cdp.shot(path.join(OUT_DIR, '03-回复陆续到达.png'));
      shot03 = true;
    }
    if (done + err >= st.length) break; // 全部终态，错过时机就跳过 03
  }
  if (!shot03) console.log('  ⚠️ 未捕捉到 03 的中间态（各家几乎同时完成）');

  // ---- 等全部终态（最长 8 分钟） ----
  for (let i = 0; i < 240; i++) {
    await sleep(2000);
    const st = await getStates(cdp);
    if (!st) continue;
    const settled = st.filter((s) => s.state === 'done' || s.state === 'error').length;
    if (settled >= st.length) break;
  }
  const finalStates = await getStates(cdp);
  console.log('=== 终态 ===');
  finalStates.forEach((s) => {
    const bad = s.state === 'done' && s.len < 200 ? ' ⚠️回复过短，可能是误判' : '';
    console.log(`  ${s.state === 'done' ? '✅' : s.state === 'error' ? '❌' : '⏳'} ${s.name} state=${s.state} len=${s.len}${bad}`);
  });

  // ---- 触发总结并等待渲染完成（带附录的长提示词，LLM 可能要 2~4 分钟） ----
  console.log('触发总结…');
  await cdp.eval(`document.getElementById('summarize-btn').click()`);
  let summaryOk = false;
  for (let i = 0; i < 150; i++) {
    await sleep(2000);
    let s;
    try { s = JSON.parse(await cdp.eval(SUMMARY_STATE)); } catch { continue; }
    if (/生成时间/.test(s.status) && s.toc) { summaryOk = true; break; }
    if (/失败/.test(s.status)) break;
  }
  console.log(summaryOk ? '总结已渲染（含目录标签）' : '⚠️ 总结未正常完成');
  await cdp.eval(`document.getElementById('summary-body').scrollTop = 0`);
  await sleep(500);
  await cdp.shot(path.join(OUT_DIR, '04-完成与总结.png'));

  // ---- 05 单家全文：展开回复最长的一家 ----
  const idx = await cdp.eval(`(function(){
    var best=-1,bestLen=0,i=0;
    for (const p of panels.values()) {
      if (p.state==='done' && (p.reply||'').length>bestLen) { bestLen=p.reply.length; best=i; }
      i++;
    }
    return best;
  })()`);
  console.log('展开第', idx, '行（回复最长的一家）');
  await cdp.eval(`document.querySelectorAll('#rows .row')[${idx}].click()`);
  await sleep(800);
  await cdp.shot(path.join(OUT_DIR, '05-单家全文.png'));

  console.log('全部完成');
  process.exit(0);
}

main().catch((e) => { console.error('fatal', e.message); process.exit(1); });
