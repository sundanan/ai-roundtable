/**
 * 修复验证：触发一轮广播，轮询 panels 状态，报告 8 家各自的 state + 回复长度。
 * 运行：node scripts/cdp-verify.js   （约 110 秒）
 */
const http = require('http');
const WebSocket = require('ws');
const PORT = 9222;
function httpJson(p){return new Promise((res,rej)=>{http.get({host:'localhost',port:PORT,path:p},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}})}).on('error',rej)});}
function evaluate(wsUrl,expression,opts){opts=opts||{};return new Promise((resolve,reject)=>{const ws=new WebSocket(wsUrl);const id=1;const t=setTimeout(()=>{try{ws.close()}catch{};reject(new Error('timeout'))},opts.timeout||20000);ws.on('open',()=>ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:!!opts.await}})));ws.on('message',raw=>{let m;try{m=JSON.parse(raw)}catch{return}if(m.id===id){clearTimeout(t);try{ws.close()}catch{};if(m.error)reject(new Error(m.error.message));else resolve(m.result&&m.result.result?m.result.result.value:undefined)}});ws.on('error',e=>{clearTimeout(t);reject(e)});});}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

const GET_PANELS = `JSON.stringify([...panels.values()].map(p=>({id:p.adapter.id,name:p.adapter.name,state:p.state,len:(p.reply||'').length})))`;

async function main(){
  // 等 8 个 webview 出现
  let wv=[];
  for(let i=0;i<20;i++){
    const list=await httpJson('/json/list');
    wv=list.filter(t=>t.type==='webview');
    if(wv.length>=8) break;
    console.log(`等待 webview 加载… (${wv.length}/8)`);
    await sleep(3000);
  }
  console.log('webview 数:', wv.length);
  console.log('再等 8 秒让页面完成初始化…');
  await sleep(8000);

  const host=(await httpJson('/json/list')).find(t=>t.type==='page');
  console.log('触发广播…');
  await evaluate(host.webSocketDebuggerUrl, "broadcast('测试：请用一句话回答 1+1 等于几')", {await:false});

  // 轮询状态最多 90 秒
  for(let i=0;i<30;i++){
    await sleep(3000);
    let states;
    try{ states=JSON.parse(await evaluate(host.webSocketDebuggerUrl, GET_PANELS)); }catch(e){ continue; }
    const done=states.filter(s=>s.state==='done').length;
    const err=states.filter(s=>s.state==='error').length;
    const busy=states.filter(s=>s.state==='sending'||s.state==='generating').length;
    console.log(`  [${(i+1)*3}s] done=${done} 生成中=${busy} 失败=${err}`);
    if(done+err>=states.length) break; // 全部到终态
  }

  const final=JSON.parse(await evaluate(host.webSocketDebuggerUrl, GET_PANELS));
  console.log('\n=== 最终结果 ===');
  final.forEach(s=>{
    const mark = s.state==='done' ? (s.len>0?'✅':'⚠️空回复') : (s.state==='error'?'❌':'⏳'+s.state);
    console.log(`  ${mark}  ${s.name}(${s.id})  state=${s.state}  回复长度=${s.len}`);
  });
  process.exit(0);
}
main().catch(e=>{console.error('fatal',e.message);process.exit(1)});
