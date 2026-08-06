/* global ADAPTERS, roundtable */

// ================= 状态 =================
// id -> { adapter, webview, dot(面板内), barBtn(第二层按钮), statusEl, rowStateEl, rowBodyEl,
//         row, state: idle|sending|generating|done|error, lastText, stableCount, reply }
const panels = new Map();

const dock = document.getElementById('dock');
const modelGrid = document.getElementById('model-grid');
const rowsEl = document.getElementById('rows');
const progressText = document.getElementById('progress-text');
const progressFill = document.getElementById('progress-fill');
const subsetCountEl = document.getElementById('subset-count');

// ================= webview 面板（dock 隐藏层 + 全屏浮层） =================
function focusPanel(id) {
  const p = panels.get(id);
  if (!p) return;
  p.panelEl.classList.add('focused');
  dock.classList.add('active');
}

function unfocusPanel() {
  const focused = document.querySelector('.webview-panel.focused');
  if (focused) focused.classList.remove('focused');
  dock.classList.remove('active');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') unfocusPanel();
});

// 模型按钮栅格按适配器数量 N 等分（7→8 家时无需改 CSS）
modelGrid.style.gridTemplateColumns = `repeat(${ADAPTERS.length}, 1fr)`;

for (const adapter of ADAPTERS) {
  // 面板（webview 容器）
  const panelEl = document.createElement('div');
  panelEl.className = 'webview-panel';
  panelEl.innerHTML = `
    <div class="panel-header">
      <span class="dot"></span>
      <span class="panel-name">${adapter.name}</span>
      <span class="panel-status"></span>
      <button class="mini reload" title="刷新该面板">⟳</button>
      <button class="mini close-focus">✕ 关闭（Esc）</button>
    </div>
  `;
  const webview = document.createElement('webview');
  webview.setAttribute('src', adapter.url);
  webview.setAttribute('partition', `persist:${adapter.id}`);
  webview.setAttribute('allowpopups', '');
  panelEl.appendChild(webview);
  dock.appendChild(panelEl);

  // 第二层按钮：只有名称文字。点文字=切换是否参与本轮；点按钮空白处=全屏打开该网页
  const barBtn = document.createElement('div');
  barBtn.className = 'model-btn checked';
  barBtn.innerHTML = `<span class="model-name" data-id="${adapter.id}">${adapter.name}</span>`;
  barBtn.querySelector('.model-name').addEventListener('click', (e) => {
    e.stopPropagation();
    barBtn.classList.toggle('checked');
    barBtn.classList.toggle('unchecked', !barBtn.classList.contains('checked'));
    updateSubsetCount();
  });
  barBtn.addEventListener('click', () => focusPanel(adapter.id));
  modelGrid.appendChild(barBtn);

  // 第三层回复行（点击展开/收起）
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `
    <div class="row-head">
      <span class="row-name">${adapter.name}</span>
      <span class="row-state">待发送</span>
      <span class="row-caret">▼</span>
    </div>
    <div class="row-body placeholder">尚未发送</div>
  `;
  row.addEventListener('click', () => row.classList.toggle('expanded'));
  rowsEl.appendChild(row);

  const entry = {
    adapter,
    panelEl,
    webview,
    row,
    barBtn,
    dot: panelEl.querySelector('.dot'),
    statusEl: panelEl.querySelector('.panel-status'),
    rowStateEl: row.querySelector('.row-state'),
    rowBodyEl: row.querySelector('.row-body'),
    state: 'idle',
    lastText: '',
    stableCount: 0,
    reply: '',
  };

  panelEl.querySelector('.reload').addEventListener('click', () => webview.reload());
  panelEl.querySelector('.close-focus').addEventListener('click', unfocusPanel);

  webview.addEventListener('did-start-loading', () => setDots(entry, 'loading'));
  webview.addEventListener('did-finish-load', () => setDots(entry, 'ready'));
  webview.addEventListener('dom-ready', () => setDots(entry, 'ready'));
  webview.addEventListener('did-fail-load', (e) => {
    setDots(entry, 'error');
    setStatus(entry.statusEl, `加载失败：${e.errorDescription || e.errorCode}`);
  });

  panels.set(adapter.id, entry);
}

const DOT_LABELS = {
  '': '未加载',
  loading: '加载中',
  ready: '就绪',
  error: '加载失败',
};

function setDots(p, state) {
  p.dot.className = 'dot' + (state ? ` ${state}` : '');
  // 按状态给整个按钮描边/底色（按钮上已只剩文字，状态靠边框传达）
  p.barBtn.classList.remove('st-ready', 'st-loading', 'st-error');
  if (state === 'ready') p.barBtn.classList.add('st-ready');
  else if (state === 'loading') p.barBtn.classList.add('st-loading');
  else if (state === 'error') p.barBtn.classList.add('st-error');
  // 悬停提示：网页状态 + 两种点击作用
  const label = DOT_LABELS[state] || state || '';
  p.barBtn.title =
    `${p.adapter.name}${label ? `：${label}` : ''} · 点文字切换选中，点空白全屏打开`;
}

// 已选 N/总数 计数
function updateSubsetCount() {
  const btns = modelGrid.querySelectorAll('.model-btn');
  const n = [...btns].filter((b) => b.classList.contains('checked')).length;
  subsetCountEl.textContent = `已选 ${n}/${btns.length}`;
}

function setStatus(el, text) {
  el.textContent = text || '';
  el.title = text || '';
}

function setCardState(p, text, cls) {
  p.rowStateEl.textContent = text;
  p.rowStateEl.className = 'row-state' + (cls ? ` ${cls}` : '');
}

// ================= 注入脚本（在 webview 内执行） =================
// 第一步：找输入框并准备接收文本。
// textarea/input 用 JS 填值；contenteditable（Slate/Lexical 只认可信输入）只聚焦，
// 文本由主进程 insertText 可信注入。
function buildPrepareScript(adapter) {
  const cfg = JSON.stringify({ inputSelectors: adapter.inputSelectors });
  return `(function () {
    var cfg = ${cfg};
    function visible(el) {
      if (!el) return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    function find(list) {
      for (var i = 0; i < list.length; i++) {
        try {
          var els = Array.prototype.slice.call(document.querySelectorAll(list[i]));
          for (var j = 0; j < els.length; j++) if (visible(els[j])) return els[j];
        } catch (e) {}
      }
      return null;
    }
    var input = find(cfg.inputSelectors) || find(['textarea', '[contenteditable="true"]']);
    if (!input) return { ok: false, error: '找不到输入框（可能未登录或选择器失效）' };
    var tag = input.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      input.focus();
      return { ok: true, mode: 'value' };
    }
    input.click();
    input.focus();
    var sel = window.getSelection();
    var range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    return { ok: true, mode: 'trusted' };
  })()`;
}

// 第二步（textarea/input 模式）：JS 填值
function buildFillScript(text) {
  const cfg = JSON.stringify({ text });
  return `(function () {
    var cfg = ${cfg};
    var input = document.activeElement;
    if (!input || (input.tagName !== 'TEXTAREA' && input.tagName !== 'INPUT')) {
      input = document.querySelector('textarea') || document.querySelector('input[type="text"]');
    }
    if (!input) return { ok: false, error: '填值时找不到输入框' };
    var tag = input.tagName;
    var proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, cfg.text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  })()`;
}

// 第三步：轮询等待发送按钮激活并点击（输入后按钮常是异步激活）
function buildClickSendScript(adapter) {
  const cfg = JSON.stringify({ sendSelectors: adapter.sendSelectors });
  return `(async function () {
    var cfg = ${cfg};
    function visible(el) {
      if (!el) return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    function find(list) {
      for (var i = 0; i < list.length; i++) {
        try {
          var els = Array.prototype.slice.call(document.querySelectorAll(list[i]));
          for (var j = 0; j < els.length; j++) if (visible(els[j])) return els[j];
        } catch (e) {}
      }
      return null;
    }
    function enabled(btn) {
      return btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
    }
    var sendList = cfg.sendSelectors.concat([
      'button[aria-label*="发送"]', 'button[aria-label*="Send"]',
      'button[data-testid*="send"]',
      'button[class*="send" i]:not([disabled])',
      '[role="button"][class*="send" i]',
      'a[class*="send" i]', '[class*="send-btn" i]', '[class*="sendBtn" i]'
    ]);
    var btn = null;
    for (var t = 0; t < 12; t++) {
      btn = find(sendList);
      if (enabled(btn)) { btn.click(); return { ok: true, via: 'button' }; }
      await new Promise(function (r) { setTimeout(r, 200); });
    }
    return { ok: false, error: 'no-button' };
  })()`;
}

// 发送按钮定位（供可信鼠标点击）：返回按钮中心坐标
function buildSendRectScript(adapter) {
  const cfg = JSON.stringify({ sendSelectors: adapter.sendSelectors });
  return `(function () {
    var cfg = ${cfg};
    function visible(el) {
      if (!el) return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    function find(list) {
      for (var i = 0; i < list.length; i++) {
        try {
          var els = Array.prototype.slice.call(document.querySelectorAll(list[i]));
          for (var j = 0; j < els.length; j++) if (visible(els[j])) return els[j];
        } catch (e) {}
      }
      return null;
    }
    function enabled(btn) {
      return btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
    }
    var sendList = cfg.sendSelectors.concat([
      'button[aria-label*="发送"]', 'button[aria-label*="Send"]',
      'button[data-testid*="send"]',
      'button[class*="send" i]:not([disabled])',
      '[role="button"][class*="send" i]',
      'a[class*="send" i]', '[class*="send-btn" i]', '[class*="sendBtn" i]'
    ]);
    var btn = find(sendList);
    if (!enabled(btn)) return { ok: false };
    var r = btn.getBoundingClientRect();
    return { ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`;
}

// 发送是否生效的判据：输入框被清空（各站发送后都会清空输入框）
function buildVerifySentScript(adapter) {
  const cfg = JSON.stringify({ inputSelectors: adapter.inputSelectors });
  return `(function () {
    var cfg = ${cfg};
    function find(list) {
      for (var i = 0; i < list.length; i++) {
        try {
          var els = Array.prototype.slice.call(document.querySelectorAll(list[i]));
          if (els.length) return els[0];
        } catch (e) {}
      }
      return null;
    }
    var input = find(cfg.inputSelectors) || find(['textarea', '[contenteditable="true"]']);
    if (!input) return { sent: false };
    var tag = input.tagName;
    var text = (tag === 'TEXTAREA' || tag === 'INPUT') ? input.value : input.innerText;
    return { sent: !text || !text.trim() };
  })()`;
}

// 抓取最后一条回复。防误判：
//  - 排除用户气泡（class/testid 含 user/human/question/request 的容器内节点）
//  - 排除与问题原文相同、或主要内容就是问题原文的节点（任务卡片/回音）
//  - 命中「正在搜索/思考中」等占位文本时返回 pending，由轮询继续等待
function buildScrapeScript(adapter, question) {
  const cfg = JSON.stringify({
    responseSelectors: adapter.responseSelectors,
    question: (question || '').trim(),
    watchStop: !!adapter.watchStop,
    pruneSelectors: adapter.pruneSelectors || [],
  });
  return `(function () {
    var cfg = ${cfg};
    var USER_BOX = '[class*="user" i], [class*="human" i], [class*="question" i], ' +
      '[class*="request" i], [data-testid*="user" i]';
    var PENDING = /^(正在|搜索中|思考中|生成中|加载中)|正在(搜索|思考|生成|联网|整理|执行)|请稍候|searching|thinking/i;
    // 归一化：去空白与标点，用于"问题回音"的模糊排除
    // （豆包会把问题重新排版渲染，逐字比较会漏判，2026-08 曾把回音当答案）
    function norm(s) {
      return String(s).replace(/[\\s\\u00a0\\u200b]+/g, '').replace(/[\\p{P}\\p{S}]/gu, '');
    }
    var nq = cfg.question ? norm(cfg.question) : '';
    // watchStop 家专用：短文本且"停止生成"按钮仍可见 → 还在思考/搜索，继续等待
    function stopVisible() {
      if (!cfg.watchStop) return false;
      var els = document.querySelectorAll(
        'button[aria-label*="停止"], button[aria-label*="stop" i], [data-testid*="stop" i], ' +
        '[class*="stop-btn" i], [class*="stop_btn" i], [class*="stopBtn" i], ' +
        '[class*="stop-generat" i], [class*="stopGenerat" i]');
      for (var k = 0; k < els.length; k++) {
        var r = els[k].getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
      }
      return false;
    }
    var sels = cfg.responseSelectors.concat(['[class*="markdown"]', '[class*="message"]']);
    function collect(sel, skipUserBox) {
      var out = [];
      try {
        var nodes = document.querySelectorAll(sel);
        for (var j = 0; j < nodes.length; j++) {
          var el = nodes[j];
          if (!el.innerText) continue;
          var t = el.innerText.trim();
          // 阈值放宽到 2：精准选择器命中的短回复（如"2 啊 😄"）也是有效答案；
          // 噪音由 用户气泡排除/问题排除/最外层节点/取最后一条 等逻辑兜底
          if (t.length < 2) continue;
          if (skipUserBox && el.closest(USER_BOX)) continue;
          // 适配器级排除：思考块/工具调用块等不算答案（如 Kimi thinking-container）
          if (cfg.pruneSelectors.length) {
            var excluded = false;
            for (var ps = 0; ps < cfg.pruneSelectors.length; ps++) {
              try { if (el.closest(cfg.pruneSelectors[ps])) { excluded = true; break; } } catch (e) {}
            }
            if (excluded) continue;
          }
          if (nq) {
            var nt = norm(t);
            if (nt === nq) continue;
            if (nt.indexOf(nq) !== -1 && nt.length < nq.length + 100) continue;
          }
          out.push(el);
        }
      } catch (e) {}
      // 只保留最外层节点：嵌套命中（如 ds-markdown 与 ds-markdown-paragraph）时，
      // 取最后一个才不会只抓到末段一小节
      return out.filter(function (el) {
        return !out.some(function (other) { return other !== el && other.contains(el); });
      });
    }
    for (var i = 0; i < sels.length; i++) {
      var nodes = collect(sels[i], true);
      if (!nodes.length) nodes = collect(sels[i], false); // 用户气泡启发式误伤时回退
      if (nodes.length) {
        // 克隆后剔除推荐追问/建议等子树再取文本（如豆包的 suggest-message 列表）
        var clone = nodes[nodes.length - 1].cloneNode(true);
        try {
          var junk = clone.querySelectorAll(
            '[class*="suggest" i], [class*="recommend" i], [data-testid*="suggest" i], ' +
            '[class*="video-card" i], [class*="carousel" i]');
          for (var k = 0; k < junk.length; k++) junk[k].remove();
          // 适配器级剪枝：兜住外层容器命中但内容全是思考/工具块的情况
          for (var pp = 0; pp < cfg.pruneSelectors.length; pp++) {
            var pe = clone.querySelectorAll(cfg.pruneSelectors[pp]);
            for (var qq = 0; qq < pe.length; qq++) pe[qq].remove();
          }
        } catch (e) {}
        var text = clone.innerText.trim();
        if (text.length < 2) continue; // 剪完没有答案内容 → 换下一个选择器/继续等待
        if (text.length < 300 && PENDING.test(text)) return { ok: true, pending: true, text: '' };
        if (text.length < 200 && stopVisible()) return { ok: true, pending: true, text: '' };
        return { ok: true, text: text.slice(0, 8000) };
      }
    }
    return { ok: false, error: '未抓取到回复内容' };
  })()`;
}

// 清洗抓到的回复：截断「猜你想问」类推荐区块，去掉尾部按钮文字（编辑/复制/分享…）
function cleanReply(text) {
  const CUT_MARKERS = /^(你可能想问|猜你想问|相关问题|相关视频|为你推荐|推荐问题|推荐追问|继续提问|继续追问)/;
  const TRAIL = /^(编辑|复制|分享|重新生成|收藏|朗读|听全文|点赞|点踩|举报|转发|反馈|引用|追问|换个话题)$/;
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (CUT_MARKERS.test(lines[i].trim())) { lines.length = i; break; }
  }
  while (lines.length && (lines[lines.length - 1].trim() === '' || TRAIL.test(lines[lines.length - 1].trim()))) {
    lines.pop();
  }
  return lines.join('\n').trim();
}

// ================= 执行通道 =================
const EXEC_TIMEOUT = 15000;

// 经主进程在 webview 内执行脚本（带超时），比 webview.executeJavaScript 可靠
function execInPanel(webview, script) {
  let id;
  try {
    id = webview.getWebContentsId();
  } catch {
    return Promise.reject(new Error('webview 尚未加载完成'));
  }
  return Promise.race([
    roundtable.execInWebview(id, script),
    new Promise((_, reject) => setTimeout(() => reject(new Error('执行超时')), EXEC_TIMEOUT)),
  ]);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 单家发送：准备输入框 → 注入文本 → JS点发送 → 验证；不行则可信鼠标点击 → 验证；
// 再不行可信回车 → 验证。部分站点（如豆包）程序化 click 无效，必须可信事件。
async function sendToPanel(adapter, webview, text) {
  const prep = await execInPanel(webview, buildPrepareScript(adapter));
  if (!prep || !prep.ok) return prep || { ok: false, error: '准备失败' };

  const wcId = webview.getWebContentsId();
  if (prep.mode === 'value') {
    const fill = await execInPanel(webview, buildFillScript(text));
    if (!fill || !fill.ok) return fill || { ok: false, error: '填值失败' };
  } else {
    await roundtable.insertText(wcId, text);
  }

  const verify = () => execInPanel(webview, buildVerifySentScript(adapter)).catch(() => null);

  // 1) 程序化点击
  const click = await execInPanel(webview, buildClickSendScript(adapter));
  if (click && click.ok) {
    await sleep(2000);
    const v = await verify();
    if (v && v.sent) return { ok: true, via: 'button' };
  }

  // 2) 可信鼠标点击发送按钮
  const rect = await execInPanel(webview, buildSendRectScript(adapter)).catch(() => null);
  if (rect && rect.ok) {
    await roundtable.clickAt(wcId, rect.x, rect.y);
    await sleep(2000);
    const v = await verify();
    if (v && v.sent) return { ok: true, via: 'trusted-click' };
  }

  // 3) 可信回车
  await roundtable.sendEnter(wcId);
  await sleep(1500);
  const v = await verify();
  if (v && v.sent) return { ok: true, via: 'enter' };
  return { ok: true, via: 'unverified' };
}

// ================= 广播 =================
const promptEl = document.getElementById('prompt');
const sendBtn = document.getElementById('send-btn');
const summarizeBtn = document.getElementById('summarize-btn');

let currentQuestion = ''; // 本轮问题原文，抓取时用于排除"把问题当答案"
let activeRoundIds = null; // 本轮参与面板 id 集合；null=全部（改进2 可选子集）
let desktopRoundSaved = false; // 改进1：桌面端本轮是否已落库（防重复总结时重复落库）

async function broadcast(text, siteIds) {
  sendBtn.disabled = true;
  currentQuestion = text;
  desktopRoundSaved = false;
  // 计算本轮参与面板（改进2：可选子集；缺省全部）
  const scope =
    siteIds && siteIds.length
      ? [...panels.values()].filter((p) => siteIds.includes(p.adapter.id))
      : [...panels.values()];
  activeRoundIds = new Set(scope.map((p) => p.adapter.id));

  for (const p of panels.values()) {
    p.reply = '';
    p.lastText = '';
    p.stableCount = 0;
    p.staleCount = 0; // 连续抓到陈旧回复的次数
    p.baselineText = ''; // 发送前的上一条回复（陈旧检测基线）
    if (activeRoundIds.has(p.adapter.id)) {
      p.state = 'sending';
      p.row.style.display = ''; // 优化4：参与的家显示
      setStatus(p.statusEl, '发送中…');
      setCardState(p, '发送中…', 'warn');
      p.rowBodyEl.className = 'row-body placeholder';
      p.rowBodyEl.textContent = '正在发送…';
    } else {
      p.state = 'idle';
      p.row.style.display = 'none'; // 优化4：未参与的家隐藏，回复区更聚焦
      setStatus(p.statusEl, '本轮未参与');
      setCardState(p, '本轮未参与', '');
      p.rowBodyEl.className = 'row-body placeholder';
      p.rowBodyEl.textContent = '本轮未参与';
    }
  }
  updateProgress();
  startPoller();

  const tasks = scope.map(async (p) => {
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
      if (res && res.ok) {
        if (p.state === 'sending') {
          p.state = 'generating';
          setCardState(p, '生成中…', 'warn');
          p.rowBodyEl.className = 'row-body placeholder';
          p.rowBodyEl.textContent = '等待回复…';
        }
        setStatus(p.statusEl, '已发送');
      } else {
        p.state = 'error';
        setStatus(p.statusEl, (res && res.error) || '注入失败');
        setCardState(p, '发送失败', 'err');
        p.rowBodyEl.className = 'row-body error';
        p.rowBodyEl.textContent =
          ((res && res.error) || '注入失败') + '。可点上方按钮全屏手动发送，总结时会自动纳入。';
      }
    } catch (e) {
      p.state = 'error';
      const msg = String(e.message || e).slice(0, 60);
      setStatus(p.statusEl, `失败：${msg}`);
      setCardState(p, '发送失败', 'err');
      p.rowBodyEl.className = 'row-body error';
      p.rowBodyEl.textContent = `${msg}。可点上方按钮全屏手动发送，总结时会自动纳入。`;
    }
    updateProgress();
  });
  await Promise.allSettled(tasks);
  sendBtn.disabled = false;
}

function submit() {
  const text = promptEl.value.trim();
  if (!text) return;
  promptEl.value = '';
  autoGrow();
  // 只发选中的子集；全未选中则视为全发
  const selected = [...modelGrid.querySelectorAll('.model-btn.checked .model-name')]
    .map((t) => t.dataset.id);
  broadcast(text, selected.length ? selected : undefined);
}

sendBtn.addEventListener('click', submit);
// Enter 换行，Ctrl+Enter 发送
promptEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});

function autoGrow() {
  promptEl.style.height = 'auto';
  promptEl.style.height = Math.min(promptEl.scrollHeight, 180) + 'px';
}
promptEl.addEventListener('input', autoGrow);

// ================= 轮询抓取回复 =================
const POLL_INTERVAL = 3000;
let poller = null;

function startPoller() {
  if (poller) return;
  poller = setInterval(pollOnce, POLL_INTERVAL);
}

async function pollOnce() {
  const tasks = [...panels.values()].map(async (p) => {
    if (p.state === 'done' || p.state === 'idle') return;
    let res;
    try {
      res = await execInPanel(p.webview, buildScrapeScript(p.adapter, currentQuestion));
    } catch {
      return; // 超时下轮再试
    }
    if (!res || !res.ok) return;
    // 页面还在「搜索中/思考中」等占位状态：保持生成中，不计稳定、不判完成
    if (res.pending) {
      p.stableCount = 0;
      p.staleCount = 0; // pending 说明页面有动静，陈旧计数清零，避免误杀慢思考/研究
      if (p.state !== 'generating') {
        p.state = 'generating';
        setStatus(p.statusEl, '生成中…');
        setCardState(p, '生成中…', 'warn');
      }
      updateProgress();
      return;
    }
    const text = cleanReply(res.text);
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
        setStatus(p.statusEl, '未取到本轮回复');
        setCardState(p, '未取到本轮回复（可手动补发）', 'err');
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
        setStatus(p.statusEl, '生成中…');
      }
      setCardState(p, '生成中…', 'warn');
      p.rowBodyEl.className = 'row-body';
      p.rowBodyEl.textContent = text;
    }
    // 连续多轮（约 12s）抓到相同文本才判完成：思考/搜索中的短暂停顿不该掐断输出
    // （此前 2 轮即判完成，曾把智谱思考前奏、MiniMax 搜索前奏当完整答案）
    if (p.stableCount >= 3) {
      p.state = 'done';
      p.reply = text;
      setStatus(p.statusEl, '已完成');
      setCardState(p, '已完成 ✓（点击查看全文）', 'ok');
      p.rowBodyEl.className = 'row-body';
      p.rowBodyEl.textContent = text;
    }
    updateProgress();
  });
  await Promise.allSettled(tasks);
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
  summarizeBtn.disabled = counts.done === 0;
  summarizeBtn.textContent = '总结';
  summarizeBtn.title = counts.done ? `提交 LLM 总结（${counts.done} 家已完成）` : '提交 LLM 总结';

  // 优化3：进度条（done + error 视为已到终态）
  const settled = counts.done + counts.error;
  progressFill.style.width = total ? `${Math.round((settled / total) * 100)}%` : '0%';
  progressFill.className = counts.error ? 'err' : '';

  // 服务编排：若正有飞书触发的轮次在跑，顺带上报进度
  if (activeServiceRequestId) {
    roundtable.reportServiceProgress({ requestId: activeServiceRequestId, total, ...counts });
  }
}

// ================= 总结 =================
const summaryBody = document.getElementById('summary-body');
const summaryStatus = document.getElementById('summary-status');

// 轻量 Markdown 渲染（先转义 HTML，只支持标题/列表/加粗/行内代码/段落）
function renderMarkdown(md) {
  const esc = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) =>
    s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const lines = esc.split('\n');
  let html = '';
  let list = null; // 'ul' | 'ol' | null
  const closeList = () => {
    if (list) { html += `</${list}>`; list = null; }
  };
  for (const line of lines) {
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)/))) {
      closeList();
      html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`;
    } else if ((m = line.match(/^[-*]\s+(.*)/))) {
      if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^\d+\.\s+(.*)/))) {
      if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
      html += `<li>${inline(m[1])}</li>`;
    } else if (line.trim() === '') {
      closeList();
    } else {
      closeList();
      html += `<p>${inline(line)}</p>`;
    }
  }
  closeList();
  return html;
}

function getSettings() {
  return {
    baseURL: localStorage.getItem('rt_baseURL') || '',
    apiKey: localStorage.getItem('rt_apiKey') || '',
    model: localStorage.getItem('rt_model') || '',
  };
}

// 核心总结逻辑：按钮与飞书服务共用。成功返回总结文本；失败抛出错误（同时已更新 DOM）。
async function doSummarize() {
  const settings = getSettings();
  if (!settings.baseURL || !settings.apiKey || !settings.model) {
    throw new Error('总结 LLM 未配置（baseURL/apiKey/model）');
  }
  // 只纳入已完成的回复，失败/未完成的跳过
  const usable = [...panels.values()].filter((p) => p.state === 'done' && p.reply);
  if (usable.length === 0) throw new Error('没有已完成的回复可供总结');
  const skipped = [...panels.values()]
    .filter((p) => p.state !== 'done')
    .map((p) => p.adapter.name);

  summarizeBtn.disabled = true;
  summaryBody.className = 'summary-body placeholder';
  summaryBody.textContent = `正在调用 ${settings.model} 总结…`;
  summaryStatus.textContent = '总结中…';
  summaryStatus.className = 'card-state warn';

  const blocks = usable.map((p) => `【${p.adapter.name}】\n${p.reply}`).join('\n\n');
  const messages = [
    {
      role: 'system',
      content:
        '你是一位中立的圆桌主持人。下面是同一个问题下多家 AI 的回答。' +
        '请输出一份结构化总结，包含五部分：一、各家共识；二、主要分歧及各自理由；' +
        '三、各家独有的亮点或补充；四、综合结论；' +
        '五、各家立场速览（结构化对比）：逐家一行，格式为「家名：一句话概括其核心观点或立场」，' +
        '按回答质量或信息量点评，便于横向对照。用简洁的中文。' +
        '排版要求（必须严格遵守）：输出纯文本，严禁使用任何 Markdown 符号，' +
        '包括 #、*、-、>、` 等；不要用星号表示加粗或列表。' +
        '结构层次用中文序号体现：一级标题（五个部分）用「一、二、三、四、五、」，' +
        '二级标题（部分内的各小节）必须用「（一）（二）（三）」；' +
        '小节内的具体条目用「1. 2. 3.」，再细分用「（1）（2）」。' +
        '注意：二级标题一律用带括号的中文数字，不要用「1.」充当小节标题；' +
        '标题和条目各自独占一行，部分之间空一行，直接以标题开头，不要任何开场白。',
    },
    {
      role: 'user',
      content: `共 ${usable.length} 家回答${skipped.length ? `（${skipped.join('、')} 未纳入）` : ''}：\n\n${blocks}`,
    },
  ];

  try {
    const content = await roundtable.callLLM({ ...settings, messages });
    summaryBody.className = 'summary-body';
    summaryBody.innerHTML = renderMarkdown(content);
    summaryStatus.textContent = `生成时间 ${new Date().toLocaleTimeString()}`;
    summaryStatus.className = 'card-state ok';
    return content;
  } catch (e) {
    summaryBody.className = 'summary-body error';
    summaryBody.textContent = `总结调用失败：${e.message || e}`;
    summaryStatus.textContent = '总结失败';
    summaryStatus.className = 'card-state err';
    throw e;
  } finally {
    summarizeBtn.disabled = false;
  }
}

summarizeBtn.addEventListener('click', async () => {
  const settings = getSettings();
  if (!settings.baseURL || !settings.apiKey || !settings.model) {
    openSettings();
    return;
  }
  try {
    const summary = await doSummarize();
    // 改进1：桌面端轮次落库（同一轮防重复）
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
  } catch {
    /* 错误信息已在 doSummarize 内渲染到总结面板 */
  }
});

// ================= 飞书服务编排（Phase 2） =================
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

// 汇总本轮各家回复（含状态），供回报飞书/HTTP
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
  serviceBusy = true;
  activeServiceRequestId = requestId;
  try {
    broadcast(question, sites); // 内部会设置 currentQuestion 并启动轮询（sites 为可选子集）
    await waitForRoundComplete();
    let summary = '';
    let summaryError = '';
    try {
      summary = await doSummarize();
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

// ================= 设置弹窗 =================
const modal = document.getElementById('settings-modal');
const cfgBaseURL = document.getElementById('cfg-baseurl');
const cfgApiKey = document.getElementById('cfg-apikey');
const cfgModel = document.getElementById('cfg-model');

function openSettings() {
  const s = getSettings();
  cfgBaseURL.value = s.baseURL;
  cfgApiKey.value = s.apiKey;
  cfgModel.value = s.model;
  modal.hidden = false;
}

document.getElementById('settings-btn').addEventListener('click', openSettings);
document.getElementById('cfg-cancel').addEventListener('click', () => (modal.hidden = true));
document.getElementById('cfg-save').addEventListener('click', () => {
  localStorage.setItem('rt_baseURL', cfgBaseURL.value.trim());
  localStorage.setItem('rt_apiKey', cfgApiKey.value.trim());
  localStorage.setItem('rt_model', cfgModel.value.trim());
  modal.hidden = true;
});
modal.addEventListener('click', (e) => {
  if (e.target === modal) modal.hidden = true;
});

// ================= 历史记录弹窗 =================
const historyModal = document.getElementById('history-modal');
const historyList = document.getElementById('history-list');
const historyDetail = document.getElementById('history-detail');
const historySearch = document.getElementById('history-search');
const historyBackBtn = document.getElementById('history-back');

function fmtTs(ts) {
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return ts;
  }
}

async function loadHistoryList() {
  historyList.hidden = false;
  historyDetail.hidden = true;
  historyBackBtn.hidden = true;
  historyList.innerHTML = '<div class="history-empty">加载中…</div>';
  let items = [];
  try {
    items = await roundtable.getHistory(historySearch.value.trim(), 50);
  } catch (e) {
    historyList.innerHTML = `<div class="history-empty">读取失败：${e.message || e}</div>`;
    return;
  }
  if (!items.length) {
    historyList.innerHTML = '<div class="history-empty">暂无历史记录</div>';
    return;
  }
  historyList.innerHTML = '';
  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'history-item';
    const doneCount = (it.replies || []).filter((r) => r.state === 'done').length;
    el.innerHTML = `
      <div class="history-q"></div>
      <div class="history-meta">${fmtTs(it.ts)} · ${doneCount}/${(it.replies || []).length} 家成功 · ${it.source || ''}</div>
    `;
    el.querySelector('.history-q').textContent = it.question;
    el.addEventListener('click', () => showHistoryDetail(it));
    historyList.appendChild(el);
  }
}

function showHistoryDetail(it) {
  historyList.hidden = true;
  historyDetail.hidden = false;
  historyBackBtn.hidden = false;
  let html = `<div class="hd-q"></div><div class="history-meta">${fmtTs(it.ts)}</div>`;
  html += `<div class="hd-section">📋 总结</div><div class="hd-summary"></div>`;
  html += `<div class="hd-section">各家回复</div>`;
  for (const r of it.replies || []) {
    html += `<div class="hd-reply"><div class="hd-reply-name"></div><div class="hd-reply-text"></div></div>`;
  }
  historyDetail.innerHTML = html;
  historyDetail.querySelector('.hd-q').textContent = it.question;
  const sumEl = historyDetail.querySelector('.hd-summary');
  sumEl.textContent = it.summary || (it.summaryError ? `总结失败：${it.summaryError}` : '（无总结）');
  const replyEls = historyDetail.querySelectorAll('.hd-reply');
  (it.replies || []).forEach((r, i) => {
    const tag = r.state === 'done' ? '' : `（${r.state}）`;
    replyEls[i].querySelector('.hd-reply-name').textContent = `${r.name}${tag}`;
    replyEls[i].querySelector('.hd-reply-text').textContent = r.text || '（无回复）';
  });
}

function openHistory() {
  historyModal.hidden = false;
  loadHistoryList();
}

document.getElementById('history-btn').addEventListener('click', openHistory);
document.getElementById('history-close').addEventListener('click', () => (historyModal.hidden = true));
historyBackBtn.addEventListener('click', loadHistoryList);
document.getElementById('history-refresh').addEventListener('click', loadHistoryList);
historySearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadHistoryList();
});
historyModal.addEventListener('click', (e) => {
  if (e.target === historyModal) historyModal.hidden = true;
});

// ================= 输出区左右可拖拽分隔条 =================
const divider = document.getElementById('divider');
const outputCols = document.querySelector('.output-cols');
let dividerDragging = false;
let dividerPct = 0;

// 默认位置以上次拖到的位置为准（localStorage 持久化；首次为 CSS 默认）
try {
  const saved = parseFloat(localStorage.getItem('rt_divider_pct'));
  if (saved >= 20 && saved <= 78) rowsEl.style.flex = `0 0 ${saved}%`;
} catch {}

divider.addEventListener('mousedown', (e) => {
  dividerDragging = true;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  e.preventDefault();
});
document.addEventListener('mousemove', (e) => {
  if (!dividerDragging) return;
  const rect = outputCols.getBoundingClientRect();
  let pct = ((e.clientX - rect.left) / rect.width) * 100;
  pct = Math.max(20, Math.min(78, pct));
  dividerPct = pct;
  rowsEl.style.flex = `0 0 ${pct}%`;
});
document.addEventListener('mouseup', () => {
  if (dividerDragging) {
    dividerDragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (dividerPct) {
      try { localStorage.setItem('rt_divider_pct', String(dividerPct)); } catch {}
    }
  }
});
