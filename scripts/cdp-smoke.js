/**
 * 新版功能冒烟测试（不改数据，2 家子集快问快答）：
 *  ① 行尾 ↻ 补发按钮存在且触发单家补发（不清空别家）
 *  ② 设置弹窗含自动总结开关；开启后全部交卷自动触发总结
 *  ③ 目录标签 + scroll-spy 高亮
 *  ④ HTTP /ask 服务轮次返回 summaryFile 且 docx 落盘（#8 HTTP/微信路径）
 * 运行：node scripts/cdp-smoke.js
 */
const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');

function httpJson(p, opts) {
  return new Promise((res, rej) => {
    const req = http.request(
      { host: 'localhost', port: 9222, path: p, method: (opts && opts.method) || 'GET' },
      (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
      }
    );
    req.on('error', rej);
    req.end();
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

async function main() {
  let host = null;
  for (let i = 0; i < 30; i++) {
    let list = [];
    try { list = await httpJson('/json/list'); } catch { await sleep(2000); continue; }
    host = list.find((t) => t.type === 'page');
    if (host) break;
    await sleep(2000);
  }
  if (!host) throw new Error('找不到主页面');
  const ws = new WebSocket(host.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const call = (method, params) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => rej(new Error('timeout ' + method)), 30000);
    });
  const evaljs = async (expression, awaitP) => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: !!awaitP });
    if (r.result && r.result.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await new Promise((r) => ws.on('open', r));

  // 等 panels 就绪
  for (let i = 0; i < 20; i++) {
    const n = await evaljs(`(typeof panels!=='undefined')?panels.size:0`).catch(() => 0);
    if (n >= 8) break;
    await sleep(2000);
  }

  console.log('— 静态结构 —');
  check('8 个行尾补发按钮', (await evaljs(`document.querySelectorAll('.row-resend').length`)) === 8);
  check('设置弹窗含自动总结开关', await evaljs(`!!document.getElementById('cfg-autosummary')`));

  console.log('— 子集轮次（千问+DeepSeek，快问题） —');
  await evaljs(`localStorage.setItem('rt_autoSummary','1')`);
  await evaljs(`broadcast('请用一句话回答：1+1 等于几？', ['qwen','deepseek'])`, false);
  await sleep(3000);
  const mid = JSON.parse(await evaljs(`JSON.stringify({
    scope: [...panels.values()].filter(p=>p.state!=='idle').map(p=>p.adapter.id),
    hidden: [...panels.values()].filter(p=>p.row.style.display==='none').length
  })`));
  check('子集范围仅 qwen/deepseek', JSON.stringify(mid.scope.sort()) === '["deepseek","qwen"]', JSON.stringify(mid));
  check('未参与的 6 家行隐藏', mid.hidden === 6, `hidden=${mid.hidden}`);

  // 等两家交卷 + 自动总结渲染
  let summaryDone = false;
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const s = JSON.parse(await evaljs(`JSON.stringify({
      states: [...panels.values()].map(p=>p.adapter.id+':'+p.state),
      sumStatus: document.getElementById('summary-status').textContent,
      tocHidden: document.getElementById('summary-toc').hidden
    })`));
    if (/生成时间/.test(s.sumStatus) && !s.tocHidden) { summaryDone = true; break; }
  }
  check('全部交卷后自动总结渲染（含目录）', summaryDone);
  const tocInfo = JSON.parse(await evaljs(`JSON.stringify({
    chips: document.querySelectorAll('#summary-toc .toc-chip').length,
    anchors: tocAnchors.length,
    summaryHead: document.getElementById('summary-body').textContent.slice(0, 60)
  })`));
  console.log('  目录标签数:', tocInfo.chips, '锚点数:', tocInfo.anchors, '| 总结开头:', tocInfo.summaryHead.replace(/\n/g, ' '));
  check('scroll-spy 锚点已登记', tocInfo.anchors >= 3);

  // scroll-spy：滚到底部，最后一个标签应变 active
  const spy = await evaljs(`(async()=>{
    const body=document.getElementById('summary-body');
    body.scrollTop = body.scrollHeight;
    await new Promise(r=>setTimeout(r,400));
    const act=[...document.querySelectorAll('#summary-toc .toc-chip.active')].map(c=>c.textContent);
    body.scrollTop = 0;
    await new Promise(r=>setTimeout(r,400));
    const top=[...document.querySelectorAll('#summary-toc .toc-chip.active')].map(c=>c.textContent);
    return {act, top};
  })()`, true);
  console.log('  spy 滚到底:', JSON.stringify(spy.act), '滚回顶:', JSON.stringify(spy.top));
  check('scroll-spy 底部高亮最后一个标签', spy.act.length === 1);
  check('scroll-spy 顶部高亮第一个标签', spy.top.length === 1 && spy.act[0] !== spy.top[0]);

  // 单家补发：点千问行尾 ↻，应进入发送中/生成中，且 DeepSeek 回复不被清空
  const resend = await evaljs(`(async()=>{
    const ds=[...panels.values()].find(p=>p.adapter.id==='deepseek');
    const dsReplyBefore = ds.reply.length;
    const btn=document.querySelectorAll('#rows .row')[0].querySelector('.row-resend');
    btn.click();
    await new Promise(r=>setTimeout(r,1000));
    const qw=[...panels.values()].find(p=>p.adapter.id==='qwen');
    return { dsReplyBefore, dsReplyAfter: ds.reply.length, qwState: qw.state };
  })()`, true);
  console.log('  补发后:', JSON.stringify(resend));
  check('补发触发（千问进入发送/生成中）', resend.qwState === 'sending' || resend.qwState === 'generating');
  check('补发不清空别家回复', resend.dsReplyAfter === resend.dsReplyBefore && resend.dsReplyBefore > 0);

  // 等补发完成（千问重新交卷）
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const st = await evaljs(`[...panels.values()].find(p=>p.adapter.id==='qwen').state`);
    if (st === 'done' || st === 'error') { console.log('  千问补发终态:', st); break; }
  }

  console.log('— HTTP 服务轮次（验证 docx 落盘） —');
  const askRes = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ question: '用一句话回答：厦门的市花是什么？', sites: ['qwen', 'deepseek'] });
    const req = http.request(
      { host: '127.0.0.1', port: 8765, path: '/ask', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }
    );
    req.on('error', reject);
    req.setTimeout(460000, () => { req.destroy(); reject(new Error('ask timeout')); });
    req.end(body);
  });
  console.log('  /ask ok:', askRes.ok, 'summaryFile:', askRes.summaryFile || '(空)');
  check('/ask 返回 summaryFile', !!askRes.summaryFile);
  check('docx 文件落盘且非空', !!askRes.summaryFile && fs.existsSync(askRes.summaryFile) && fs.statSync(askRes.summaryFile).size > 3000);

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('fatal', e.message); process.exit(1); });
