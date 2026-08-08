/** 补拍 04/05：等文心交卷后重新总结（8 家全纳入），重截「完成与总结」「单家全文」。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const OUT_DIR = path.join(__dirname, '..', 'docs', 'wechat-article');

function httpJson(p) {
  return new Promise((res, rej) => {
    http.get({ host: 'localhost', port: 9222, path: p }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
  async eval(expression) {
    const r = await this.call('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval exception');
    return r.result ? r.result.value : undefined;
  }
  async shot(file) {
    const r = await this.call('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('  📸 已保存', path.basename(file), (fs.statSync(file).size / 1024).toFixed(0) + 'KB');
  }
}

async function main() {
  const list = await httpJson('/json/list');
  const host = list.find((t) => t.type === 'page');
  const cdp = new Cdp(host.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.call('Page.enable');

  // 等文心交卷（最多 3 分钟）
  for (let i = 0; i < 90; i++) {
    const st = JSON.parse(await cdp.eval(
      `JSON.stringify([...panels.values()].map(p=>({id:p.adapter.id,state:p.state,len:(p.reply||'').length})))`));
    const wx = st.find((s) => s.id === 'wenxin');
    if (wx.state === 'done' && wx.len > 200) { console.log('文心已交卷，len=' + wx.len); break; }
    if (i === 89) console.log('⚠️ 文心仍未交卷，按现状总结');
    await sleep(2000);
  }

  // 收起可能展开的行，重触发总结
  await cdp.eval(`document.querySelectorAll('#rows .row.expanded').forEach(r=>r.classList.remove('expanded'))`);
  console.log('重新触发总结（8 家）…');
  await cdp.eval(`document.getElementById('summarize-btn').click()`);
  let ok = false;
  for (let i = 0; i < 150; i++) {
    await sleep(2000);
    let s;
    try {
      s = JSON.parse(await cdp.eval(`JSON.stringify({
        status: document.getElementById('summary-status').textContent,
        toc: document.getElementById('summary-toc').textContent,
        tocHidden: document.getElementById('summary-toc').hidden
      })`));
    } catch { continue; }
    if (/生成时间/.test(s.status) && !s.tocHidden) {
      ok = true;
      console.log('总结完成，目录包含文心:', s.toc.includes('文心'));
      break;
    }
    if (/失败/.test(s.status)) { console.log('⚠️ 总结失败:', s.status); break; }
  }
  if (!ok) throw new Error('总结未在预期时间内完成');
  await cdp.eval(`document.getElementById('summary-body').scrollTop = 0`);
  await sleep(500);
  await cdp.shot(path.join(OUT_DIR, '04-完成与总结.png'));

  // 05：展开回复最长的一家
  const idx = await cdp.eval(`(function(){
    var best=-1,bestLen=0,i=0;
    for (const p of panels.values()) {
      if (p.state==='done' && (p.reply||'').length>bestLen) { bestLen=p.reply.length; best=i; }
      i++;
    }
    return best;
  })()`);
  await cdp.eval(`document.querySelectorAll('#rows .row')[${idx}].classList.add('expanded')`);
  await sleep(800);
  await cdp.shot(path.join(OUT_DIR, '05-单家全文.png'));
  console.log('补拍完成');
  process.exit(0);
}
main().catch((e) => { console.error('fatal', e.message); process.exit(1); });
