/* global roundtable */
/**
 * 轮次生命周期层（引擎宿主侧）。
 * 职责：广播、轮询抓取与判稳、单家补发、停止、进度汇总、发送/停止一体按钮、
 * 服务编排（HTTP/agent 经 IPC 触发轮次）与桌面总结落库薄封装。
 * 依赖：js/core.js（注入脚本/发送/清洗/错误分类）、js/panels.js（面板与视觉状态）、
 * js/summary.js（总结，调用期引用）。
 */

// ================= 广播 =================
const promptEl = document.getElementById('prompt');
const sendBtn = document.getElementById('send-btn');
const summarizeBtn = document.getElementById('summarize-btn');
const progressText = document.getElementById('progress-text');
const progressFill = document.getElementById('progress-fill');

// 发送/停止一体按钮：同一元素双形态——空闲为蓝色「发送」；本轮任一家处于
// sending/generating 时原地变红色「⏹ 停止」。只切文案与配色类，不增删节点，
// 右上按钮组布局恒定（旧独立停止按钮插入网格会把「总结」挤列，整排按钮抖动）。
// 形态由 updateProgress 依面板计数统一驱动，广播/单家补发/停止三条路径都覆盖。
function syncSendStopButton(stopping) {
  const mode = stopping ? 'stop' : 'send';
  if (sendBtn.dataset.mode === mode) return;
  sendBtn.dataset.mode = mode;
  sendBtn.classList.toggle('stopping', stopping);
  sendBtn.textContent = stopping ? '⏹ 停止' : '发送';
  sendBtn.disabled = false;
  sendBtn.title = stopping
    ? '停止本轮：中断等待与轮询，已交卷的回复保留'
    : '发送到勾选各家（Ctrl+Enter）';
}

let currentQuestion = ''; // 本轮问题原文，抓取时用于排除"把问题当答案"
let activeRoundIds = null; // 本轮参与面板 id 集合；null=全部（改进2 可选子集）
let desktopRoundSaved = false; // 改进1：桌面端本轮是否已落库（防重复总结时重复落库）
let roundSettleHandled = false; // 本轮"全部到终态"收尾是否已做（完成通知/自动总结只触发一次）

// V5：失败态文案（视觉分级见 panels.setCardState；分类逻辑在 core.detectErrorCategory）
const ERR_LABELS = { risk: '🛡 需人工验证', timeout: '⏱ 超时可重试', sendfail: '⚠ 发送失败' };

// 单家发送任务：重置会话 → 抓基线 → 发送（失败重试一次 → 标记的家刷新重发）→ 更新状态。
// 广播与单家补发共用。
async function runSendTask(p, text) {
  p.lastActivityAt = Date.now(); // 活动看门狗起点：广播与 ↻ 单家补发共用此路径
  // 每轮开新会话：先回站点入口页再提问，避免上一轮问答留在模型上下文里
  // （2026-08-18 实测 deepseek 面板连续三轮进同一会话，回答互相污染、
  // 交叉验证失真；总结者面板一直是同样做法）。适配器可设 resetBeforeSend:false 退出。
  if (p.adapter.resetBeforeSend !== false) {
    try { p.webview.loadURL(p.adapter.url).catch(() => {}); } catch {}
    await waitWebviewReady(p.webview);
    await sleep(4000); // 等 SPA 初始化出输入框
  }
  // 发送前先抓当前"上一条回复"作基线：本轮若始终抓到同样的内容，说明是新回复没到，
  // 不能把上一轮遗留当成本轮答案（曾导致 4 家回陈旧内容）。
  try {
    const pre = await execInPanel(p.webview, buildScrapeScript(p.adapter, ''));
    if (pre && pre.ok && !pre.pending) p.baselineText = cleanReply(pre.text);
  } catch {}
  try {
    let res = await sendToPanel(p.adapter, p.webview, text);
    // 改进4：发送失败自动重试一次（间隔 1.5s），治偶发的注入/发送失败
    if (!res || !res.ok) {
      setStatus(p.statusEl, '重试中…');
      await sleep(1500);
      res = await sendToPanel(p.adapter, p.webview, text);
    }
    // 刷新重发恢复（仅 reloadOnSendFail 标记的家，如 Kimi）：页面会话状态损坏时
    // 内容填进输入框也提交报错，手动「刷新+重贴」可恢复——自动化做同样的事
    if ((!res || !res.ok) && p.adapter.reloadOnSendFail) {
      setStatus(p.statusEl, '刷新页面重发中…');
      setCardState(p, '发送异常，刷新页面重发中…', 'warn');
      p.webview.reload();
      await waitWebviewReady(p.webview);
      await sleep(4000); // 等 SPA 初始化出输入框
      res = await sendToPanel(p.adapter, p.webview, text);
      if (!res || !res.ok) {
        await sleep(1500);
        res = await sendToPanel(p.adapter, p.webview, text);
      }
    }
    if (res && res.ok) {
      if (p.state === 'sending') {
        p.state = 'generating';
        p.genStart = Date.now();
        setCardState(p, '生成中…', 'warn');
        p.rowBodyEl.className = 'row-body placeholder';
        p.rowBodyEl.textContent = '等待回复…';
      }
      if (!roundAborted) setStatus(p.statusEl, '已发送'); // 停止后不改写「已停止」
    } else {
      p.state = 'error';
      const msg = (res && res.error) || '注入失败';
      setStatus(p.statusEl, msg);
      const cat = await detectErrorCategory(p, msg);
      setCardState(p, ERR_LABELS[cat], 'err', cat);
      p.rowBodyEl.className = 'row-body error';
      p.rowBodyEl.textContent =
        msg + (cat === 'risk'
          ? '。页面可能需要登录/验证：点「🛡 去验证」全屏处理，回来后自动补发。'
          : '。可点行尾 ↻ 仅重发该家，或全屏手动发送。');
    }
  } catch (e) {
    p.state = 'error';
    const msg = String(e.message || e).slice(0, 60);
    setStatus(p.statusEl, `失败：${msg}`);
    const cat = await detectErrorCategory(p, msg);
    setCardState(p, ERR_LABELS[cat], 'err', cat);
    p.rowBodyEl.className = 'row-body error';
    p.rowBodyEl.textContent =
      msg + (cat === 'risk'
        ? '。页面可能需要登录/验证：点「🛡 去验证」全屏处理，回来后自动补发。'
        : '。可点行尾 ↻ 仅重发该家，或全屏手动发送。');
  }
  updateProgress();
}

async function broadcast(text, siteIds) {
  roundAborted = false; // 新一轮开始，清除上一轮的停止标记
  // 按钮切「⏹ 停止」不在这里手工改写：下方标记面板 sending 后由 updateProgress 统一驱动
  currentQuestion = text;
  desktopRoundSaved = false;
  roundSettleHandled = false;
  // 计算本轮参与面板（改进2：可选子集；缺省全部）
  const scope =
    siteIds && siteIds.length
      ? [...panels.values()].filter((p) => siteIds.includes(p.adapter.id))
      : [...panels.values()];
  activeRoundIds = new Set(scope.map((p) => p.adapter.id));

  for (const p of panels.values()) {
    collapseRow(p); // I2：新一轮开始，收起上一轮展开的行
    if (activeRoundIds.has(p.adapter.id)) {
      p.reply = '';
      p.lastText = '';
      p.stableCount = 0;
      p.staleCount = 0; // 连续抓到陈旧回复的次数
      p.baselineText = ''; // 发送前的上一条回复（陈旧检测基线）
      p.genStart = null;
      p.state = 'sending';
      p.row.style.display = ''; // 优化4：参与的家显示
      setStatus(p.statusEl, '发送中…');
      setCardState(p, '发送中…', 'info');
      p.rowBodyEl.className = 'row-body placeholder';
      p.rowBodyEl.textContent = '正在发送…';
    } else {
      // 未参与的家只隐藏行、标"本轮未参与"，保留其 reply（子集广播不该清空别家成果）
      p.state = 'idle';
      p.row.style.display = 'none'; // 优化4：未参与的家隐藏，回复区更聚焦
      setStatus(p.statusEl, '本轮未参与');
      setCardState(p, '本轮未参与', '');
    }
  }
  updateProgress();
  startPoller();

  const tasks = scope.map((p) => runSendTask(p, text));
  await Promise.allSettled(tasks);
  updateProgress(); // 发送阶段结束：是否仍有家在生成，由面板计数统一决定按钮形态
}

// I3：「去验证」返回后自动补发（等页面稳定再发，避免刚收起就打字失败）。
// 多家同时待补发时依次排队；该家已在发送/生成中则跳过。
function scheduleVerifyResends() {
  for (const p of panels.values()) {
    if (!p.pendingVerifyResend) continue;
    p.pendingVerifyResend = false;
    if (p.rowVerifyBtn) p.rowVerifyBtn.hidden = true;
    const target = p;
    setTimeout(() => {
      if (target.state === 'sending' || target.state === 'generating') return;
      if (!currentQuestion) return; // 没有本轮问题无从补发
      setCardState(target, '验证后补发…', 'info');
      resendPanel(target.adapter.id);
    }, 1500);
  }
}

// 单家补发（行尾 ↻ 按钮）：只重发该家，不清空其他家回复，不影响本轮总结范围
async function resendPanel(id) {
  const p = panels.get(id);
  if (!p || !currentQuestion) return;
  if (p.state === 'sending' || p.state === 'generating') return; // 正在发送/生成，不重复发
  if (!activeRoundIds) activeRoundIds = new Set([...panels.keys()]);
  activeRoundIds.add(id); // 之前未参与的家补发后也纳入本轮
  roundSettleHandled = false; // 补发后重新允许"全部到终态"收尾（通知/自动总结）
  p.row.style.display = '';
  p.reply = '';
  p.lastText = '';
  p.stableCount = 0;
  p.staleCount = 0;
  p.baselineText = '';
  p.genStart = null;
  p.state = 'sending';
  setStatus(p.statusEl, '发送中…');
  setCardState(p, '补发中…', 'info');
  p.rowBodyEl.className = 'row-body placeholder';
  p.rowBodyEl.textContent = '正在补发…';
  updateProgress();
  startPoller();
  await runSendTask(p, currentQuestion);
}

function submit() {
  const text = promptEl.value.trim();
  if (!text) return;
  // 本轮仍在进行时不受理新广播（快捷键入口同样拦住；界面此时按钮已是「停止」）
  if ([...panels.values()].some((p) => p.state === 'sending' || p.state === 'generating')) {
    progressText.textContent = '本轮仍在进行，可点「⏹ 停止」结束后再提问';
    return;
  }
  // HTTP/agent 服务轮次进行中（含其总结阶段）同样不受理：此时广播会覆写
  // currentQuestion/roundScope，让在途服务轮拿到错题错答、总结拼上空附录
  if (serviceBusy || activeServiceRequestId) {
    progressText.textContent = '服务轮次处理中（HTTP/agent 触发），结束后再提问';
    return;
  }
  // 发送后保留输入文本（便于对照/改问再发）；清空请用「新问题」按钮
  const selected = getSelectedIds();
  if (!selected.length) {
    progressText.textContent = '未选择参与家，请在「设置」里勾选';
    return;
  }
  broadcast(text, selected);
}

sendBtn.addEventListener('click', () => {
  if (sendBtn.dataset.mode === 'stop') stopRound();
  else submit();
});

// ================= 轮询抓取回复 =================
const POLL_INTERVAL = 3000;
// 面板级活动看门狗：发送后持续这么久抓取毫无进展（既非 pending 也抓不到文本，
// 如执行异常/返回空）→ 判错误。兜底"静默卡死"盲区——陈旧检测只覆盖"抓到与基线
// 相同的旧文本"，抓空/异常会无限空转到轮次上限（2026-08-24 实测千问改版后
// 420s 零回复且不判错，白白吃满整轮）。适配器可用 stallTimeout 覆盖。
const PANEL_STALL_MS = 180000;
let poller = null;

function startPoller() {
  if (poller) return;
  poller = setInterval(pollOnce, POLL_INTERVAL);
}

function stopPoller() {
  if (poller) {
    clearInterval(poller);
    poller = null;
  }
}

// ================= 停止本轮（右上角 ⏹ 按钮） =================
// 语义：中断等待与轮询；已交卷的回复原样保留，未完的家标记「已停止」（可 ↻ 重发）。
// 发送管线（runSendTask）不强行中断--网页里可能已实际发出，只是不再等它的回复。
let roundAborted = false;

function stopRound() {
  if (sendBtn.dataset.mode !== 'stop') return;
  roundAborted = true;
  stopPoller();
  for (const p of roundScope()) {
    if (p.state === 'sending' || p.state === 'generating') {
      p.state = 'error';
      p.genStart = null;
      setCardState(p, '⏹ 已停止', 'warn');
      p.rowBodyEl.className = 'row-body placeholder';
      p.rowBodyEl.textContent = '已手动停止，可点 ↻ 重发';
      setStatus(p.statusEl, '已停止');
    }
  }
  updateProgress(); // 面板到终态后由 syncSendStopButton 自动复原「发送」
}

async function pollOnce() {
  const tasks = [...panels.values()].map(async (p) => {
    if (p.state === 'done' || p.state === 'idle') return;
    // 活动看门狗：发送后长时间抓取毫无进展（执行超时/返回空，既非 pending 也无文本）
    // → 判错误，不再静默空转到轮次上限。error 面板不查（保留"迟到回复复活"机会）。
    if ((p.state === 'sending' || p.state === 'generating') && p.lastActivityAt) {
      const stallMs = (p.adapter && p.adapter.stallTimeout) || PANEL_STALL_MS;
      if (Date.now() - p.lastActivityAt > stallMs) {
        p.state = 'error';
        p.genStart = null;
        setStatus(p.statusEl, '抓取超时（页面无进展）');
        setCardState(p, '抓取超时', 'err');
        p.rowBodyEl.className = 'row-body error';
        p.rowBodyEl.textContent = '长时间未取到回复进展。可点行尾 ↻ 仅重发该家，或双击全屏手动查看。';
        updateProgress();
        return;
      }
    }
    let res;
    try {
      res = await execInPanel(p.webview, buildScrapeScript(p.adapter, currentQuestion));
    } catch {
      return; // 超时下轮再试（不计活动，累计无进展由看门狗兜底）
    }
    if (!res || !res.ok) return; // 抓空不计活动，同上
    p.lastActivityAt = Date.now(); // 有进展（pending 或抓到内容）：刷新看门狗
    // 站点风控/人机验证拦截：立即判错并提示人工处理，不再空等
    if (res.blocked) {
      p.state = 'error';
      p.genStart = null;
      setStatus(p.statusEl, res.blocked + '（需人工）');
      setCardState(p, res.blocked, 'err');
      p.rowBodyEl.className = 'row-body error';
      p.rowBodyEl.textContent = '该站点触发了人机验证，双击按钮全屏完成验证后，点行尾 ↻ 重发该家。';
      updateProgress();
      return;
    }
    // 页面还在「搜索中/思考中」等占位状态：保持生成中，不计稳定、不判完成
    if (res.pending) {
      p.stableCount = 0;
      p.staleCount = 0; // pending 说明页面有动静，陈旧计数清零，避免误杀慢思考/研究
      if (p.state !== 'generating') {
        p.state = 'generating';
        p.genStart = Date.now();
        setStatus(p.statusEl, '生成中…');
        setCardState(p, '生成中…', 'warn');
      }
      updateProgress();
      return;
    }
    const text = cleanReply(res.text, currentQuestion);
    if (!text) return;
    // 陈旧检测：抓到的仍是发送前的旧回复 → 本轮新回复还没到，绝不能判完成
    if (p.baselineText && text === p.baselineText) {
      p.stableCount = 0;
      p.staleCount += 1;
      // 持续陈旧超过容忍轮数：判定本轮未取到新答案，标记失败，避免拿旧回复充数/一直空等。
      // 默认 8 轮（约 24s）；适配器可用 staleMax 放宽（如 Kimi 联网研究要几分钟）
      const staleMax = (p.adapter && p.adapter.staleMax) || 8;
      if (p.staleCount >= staleMax && p.state !== 'error') {
        p.state = 'error';
        // V5：抓取超时先探页面是否停在登录/验证（风控高发期的典型表现），
        // 是则归为「需人工验证」并给「去验证」入口（I3），否则按超时可重试
        const cat = await detectErrorCategory(p, '未取到本轮回复');
        setCardState(p, ERR_LABELS[cat], 'err', cat);
        setStatus(p.statusEl, cat === 'risk' ? '页面停在登录/验证（风控）' : '未取到本轮回复（超时）');
        p.rowStateEl.title = cat === 'risk'
          ? '页面停在登录/验证，点「🛡 去验证」全屏处理，回来后自动补发'
          : '未取到本轮回复，可点右侧「↻ 重发」';
      }
      updateProgress();
      return;
    }
    p.staleCount = 0;
    if (text === p.lastText) {
      p.stableCount += 1;
    } else {
      p.lastText = text;
      p.stableCount = 0;
      if (p.state !== 'generating') {
        p.state = 'generating';
        p.genStart = Date.now();
        setStatus(p.statusEl, '生成中…');
        setCardState(p, '生成中…', 'warn');
      }
      // 已进入生成中后，状态文字交给 1s 计时器维护（生成中… Ns），这里不再覆盖
      p.rowBodyEl.className = 'row-body';
      p.rowBodyEl.textContent = text;
      if (!p.rowFullEl.hidden) renderRowFull(p); // I2：展开态下同步刷新全文
    }
    // 连续多轮（约 12s）抓到相同文本才判完成：思考/搜索中的短暂停顿不该掐断输出
    // （此前 2 轮即判完成，曾把智谱思考前奏、MiniMax 搜索前奏当完整答案）。
    // 超短回复（<10 字）可能是页面噪声（文心曾抓到"通知"二字），要求 8 轮稳定才交卷
    const needStable = text.length < 10 ? 8 : 3;
    if (p.stableCount >= needStable) {
      p.state = 'done';
      p.reply = text;
      p.genStart = null;
      setStatus(p.statusEl, '已完成');
      setCardState(p, '已完成 ✓', 'ok');
      p.rowStateEl.title = '点击跳转总结原文';
      // 预览固定多行纯文本（超出裁剪）；全文点行就地展开（I2）
      p.rowBodyEl.className = 'row-body';
      p.rowBodyEl.textContent = text;
      if (!p.rowFullEl.hidden) renderRowFull(p);
    }
    updateProgress();
  });
  await Promise.allSettled(tasks);
}

// 生成等待计时（问题3）：让"慢"可见——生成中每秒刷新已等待秒数；
// 超过 90s 提示"仍在生成"（tooltip 给出全屏查看入口），避免用户误判卡死
setInterval(() => {
  for (const p of panels.values()) {
    if (p.state !== 'generating' || !p.genStart) continue;
    const s = Math.floor((Date.now() - p.genStart) / 1000);
    if (s >= 90) {
      setCardState(p, `仍在生成 ${s}s`, 'warn');
      p.rowStateEl.title = '生成较慢，可单击上方模型按钮全屏查看';
    } else {
      setCardState(p, `生成中… ${s}s`, 'warn');
      p.rowStateEl.title = '正在生成回复';
    }
  }
}, 1000);

// 系统通知：仅窗口不在焦点时发（盯著界面时不打扰）
function notify(title, body) {
  try {
    if (!document.hasFocus()) new Notification(title, { body });
  } catch {}
}

// 本轮全部到终态后的收尾（每轮只触发一次）：完成通知 + 可选自动总结。
// 服务轮次（HTTP/agent 触发）本身固定会总结，不在这里重复触发
function checkRoundSettled() {
  if (roundSettleHandled) return;
  const scope = roundScope();
  if (!scope.length) return;
  if (!scope.every((p) => p.state === 'done' || p.state === 'error')) return;
  const doneCount = scope.filter((p) => p.state === 'done').length;
  if (!doneCount) return;
  roundSettleHandled = true;
  notify('AI 圆桌', `本轮 ${doneCount}/${scope.length} 家已交卷`);
  if (getAutoSummary() && !activeServiceRequestId) summarizeDesktop().catch(() => {});
}

function updateProgress() {
  const scope = roundScope();
  const counts = { idle: 0, sending: 0, generating: 0, done: 0, error: 0 };
  for (const p of scope) counts[p.state] += 1;
  const total = scope.length;
  if (counts.idle === total) {
    progressText.textContent = '尚未开始';
  } else {
    progressText.textContent =
      `已完成 ${counts.done}/${total}` +
      (counts.generating ? ` · 生成中 ${counts.generating}` : '') +
      (counts.sending ? ` · 发送中 ${counts.sending}` : '') +
      (counts.error ? ` · 失败 ${counts.error}（可跳过）` : '');
  }
  // >3 家交卷即可提前总结；整轮全部到终态后，有 1 家交卷也可总结（兼容只选少数几家）
  const roundSettled = counts.idle + counts.sending + counts.generating === 0;
  const canSummary = counts.done >= 4 || (roundSettled && counts.done >= 1);
  summarizeBtn.disabled = !canSummary;
  summarizeBtn.textContent = '总结';
  summarizeBtn.title = canSummary
    ? `生成总结（${counts.done} 家已完成${roundSettled ? '' : '，提前总结'}）`
    : '4 家交卷后可提前总结';

  // 优化3：进度条（done + error 视为已到终态）
  const settled = counts.done + counts.error;
  progressFill.style.width = total ? `${Math.round((settled / total) * 100)}%` : '0%';
  progressFill.className = counts.error ? 'err' : '';

  // 发送/停止一体按钮：有家在发送/生成中→红色「⏹ 停止」，全到终态→复原「发送」
  syncSendStopButton(counts.sending > 0 || counts.generating > 0);

  // 服务编排：若正有 HTTP/agent 触发的轮次在跑，顺带上报进度
  if (activeServiceRequestId) {
    roundtable.reportServiceProgress({ requestId: activeServiceRequestId, total, ...counts });
  }

  checkRoundSettled();
}

// 桌面端总结 + 落库（按钮与自动总结共用；同一轮防重复落库）
async function summarizeDesktop() {
  const summary = await doSummarize();
  if (!desktopRoundSaved && currentQuestion) {
    desktopRoundSaved = true;
    roundtable.saveHistory({
      id: 'desktop-' + Date.now(),
      ts: new Date().toISOString(),
      question: currentQuestion,
      source: 'desktop',
      summary: summary || '',
      summaryError: '',
      replies: collectReplies(),
    });
  }
  return summary;
}

// ================= 服务编排（本地 HTTP / agent 触发轮次） =================
// main 进程经 IPC 触发一轮圆桌：广播 → 等回复 → 总结 → 回报结果。
let activeServiceRequestId = null; // 正在跑的服务轮次 id（供 updateProgress 上报进度）
let serviceBusy = false;

// 本轮参与面板（改进2：子集；无则全部）
function roundScope() {
  return activeRoundIds
    ? [...panels.values()].filter((p) => activeRoundIds.has(p.adapter.id))
    : [...panels.values()];
}

// 等待本轮面板到达终态（done/error），或整体超时。
// 上限放宽到 7 分钟：Kimi 等深度研究常需 5~7 分钟，240s 会在其仍生成时截断丢答案。
// 所有面板到终态会提前返回，简单轮次不受影响。
function waitForRoundComplete(timeoutMs = 420000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const terminal = roundScope().every((p) => p.state === 'done' || p.state === 'error');
      if (terminal || Date.now() - start > timeoutMs) {
        clearInterval(timer);
        resolve();
      }
    }, 1000);
  });
}

// 汇总本轮各家回复（含状态），供回报 HTTP 调用方
function collectReplies() {
  return roundScope().map((p) => ({
    id: p.adapter.id,
    name: p.adapter.name,
    state: p.state,
    text: p.reply || '',
  }));
}

roundtable.onServiceAsk(async ({ requestId, question, sites }) => {
  if (serviceBusy) {
    roundtable.reportServiceResult({ requestId, error: 'busy', message: '正在处理上一条，请稍候' });
    return;
  }
  // 桌面端圆轮次或总结进行中：拒绝本轮，避免覆写 currentQuestion/roundScope
  // 造成服务轮拿到错题错答、桌面轮被中途重置（互斥锁，与 submit() 的守卫互补）
  if (
    summarizeBusy ||
    [...panels.values()].some((p) => p.state === 'sending' || p.state === 'generating')
  ) {
    roundtable.reportServiceResult({
      requestId,
      error: 'busy',
      message: '桌面端圆桌/总结进行中，请稍后再试',
    });
    return;
  }
  serviceBusy = true;
  activeServiceRequestId = requestId;
  try {
    broadcast(question, sites); // 内部会设置 currentQuestion 并启动轮询（sites 为可选子集）
    await waitForRoundComplete();
    let summary = '';
    let summaryError = '';
    try {
      summary = await summarizeWhenIdle(); // 等可能正在进行的自动总结收尾，避免忙锁拒掉
    } catch (e) {
      summaryError = String(e.message || e);
    }
    roundtable.reportServiceResult({ requestId, summary, summaryError, replies: collectReplies() });
  } catch (e) {
    roundtable.reportServiceResult({ requestId, error: 'round-failed', message: String(e.message || e) });
  } finally {
    serviceBusy = false;
    activeServiceRequestId = null;
  }
});
