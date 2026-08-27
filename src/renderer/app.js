/* global ADAPTERS, roundtable */

// ================= 状态 =================
// id -> { adapter, webview, dot(面板内), barBtn(第二层按钮), statusEl, rowStateEl, rowBodyEl,
//         row, state: idle|sending|generating|done|error, lastText, stableCount, reply }
const panels = new Map();

// 总结模型白名单：仅「网页对话框可直接上传文件」的模型（附件 docx/md 可突破
// 输入框字数限制，完整输入 9 家原文）。2026-08-25 实测：DeepSeek/MiMo 接受
// docx/doc/md；其余家无现成文件框（回退文本模式每家截断 2000 字）或仅接受图片。
// 注意必须声明在使用之前：rebuildSummarizerPanel() 在文件头部即会取该名单。
const SUM_MODEL_ALLOWED = ['deepseek', 'mimo'];

const dock = document.getElementById('dock');
const modelGrid = document.getElementById('model-grid');
const rowsEl = document.getElementById('rows');
const progressText = document.getElementById('progress-text');
const progressFill = document.getElementById('progress-fill');
const subsetCountEl = document.getElementById('subset-count');

// ================= webview 面板（dock 隐藏层 + 全屏浮层） =================
function focusPanel(id) {
  const p = panels.get(id) || (id === 'summarizer' ? summarizerPanel : null);
  if (!p) return;
  p.panelEl.classList.add('focused');
  dock.classList.add('active');
}

function unfocusPanel() {
  const focused = document.querySelector('.webview-panel.focused');
  if (focused) focused.classList.remove('focused');
  dock.classList.remove('active');
  scheduleVerifyResends(); // I3：从「去验证」全屏返回 -> 自动补发该家
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') unfocusPanel();
});

// 模型按钮栅格按适配器数量 N 等分（7→8 家时无需改 CSS）
modelGrid.style.gridTemplateColumns = `repeat(${ADAPTERS.length}, 1fr)`; // 9 列均分，窄屏由容器查询缩字号/只留 logo

// 各家品牌色（徽章底色，近似值；未列出的用主色兜底）
const BRAND_COLORS = {
  qwen: '#615ced',
  doubao: '#3b5bfd',
  yuanbao: '#00a870',
  zhipu: '#3859ff',
  kimi: '#2b2f36',
  deepseek: '#4d6bfe',
  minimax: '#f0564f',
  wenxin: '#2932e1',
  mimo: '#ff6900',
};

// V3：徽章内嵌官方 logo（assets/logos/<id>.png，64px）；加载成功后隐藏首字母
// 兜底方案（素材缺失/文件损坏）自动回退到「品牌色方块 + 首字母」，不影响使用
function attachBadgeLogo(badgeEl, id) {
  const img = document.createElement('img');
  img.className = 'badge-logo';
  img.alt = '';
  img.src = `../../assets/logos/${id}.png`;
  img.onload = () => badgeEl.classList.add('has-logo');
  img.onerror = () => img.remove();
  badgeEl.appendChild(img);
}

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

  // 第二层按钮：品牌徽章 + 名称。单击=全屏打开该网页（手动登录/查看/补发）；
  // 是否参与本轮提问在「设置」里勾选，按钮明暗仅作参与状态展示
  const barBtn = document.createElement('div');
  barBtn.className = 'model-btn checked';
  barBtn.innerHTML =
    `<span class="model-badge" data-id="${adapter.id}">${adapter.name[0]}</span>` +
    `<span class="model-name" data-id="${adapter.id}">${adapter.name}</span>` +
    `<span class="model-status"></span>`;
  barBtn.querySelector('.model-badge').style.background =
    BRAND_COLORS[adapter.id] || 'var(--accent)';
  attachBadgeLogo(barBtn.querySelector('.model-badge'), adapter.id);
  barBtn.addEventListener('click', () => focusPanel(adapter.id));
  modelGrid.appendChild(barBtn);

  // 第三层回复行（行内始终显示回复预览；点击就地展开全文，I2）
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `
    <div class="row-head">
      <span class="row-name">${adapter.name}</span>
      <span class="row-state">待发送</span>
      <button class="mini row-verify" hidden title="全屏打开该家完成登录/验证，回来后自动补发">🛡 去验证</button>
      <button class="mini row-resend" title="仅重发该家（不影响其他家）">↻</button>
      <span class="row-caret">›</span>
    </div>
    <div class="row-body placeholder">尚未发送</div>
    <div class="row-full" hidden></div>
  `;
  row.addEventListener('click', () => toggleRowExpand(entry));
  // 单家补发：只重发该家，阻止冒泡避免触发行点击跳转
  row.querySelector('.row-resend').addEventListener('click', (e) => {
    e.stopPropagation();
    resendPanel(adapter.id);
  });
  // I3：风控行「去验证」--全屏该家完成登录/验证，收起面板后自动补发一次
  row.querySelector('.row-verify').addEventListener('click', (e) => {
    e.stopPropagation();
    entry.pendingVerifyResend = true;
    setCardState(entry, '🛡 去验证中…', 'warn');
    focusPanel(adapter.id);
  });
  rowsEl.appendChild(row);

  const entry = {
    adapter,
    panelEl,
    webview,
    row,
    barBtn,
    dot: panelEl.querySelector('.dot'),
    statusDot: barBtn.querySelector('.model-status'),
    statusEl: panelEl.querySelector('.panel-status'),
    rowStateEl: row.querySelector('.row-state'),
    rowResendBtn: row.querySelector('.row-resend'),
    rowVerifyBtn: row.querySelector('.row-verify'),
    rowBodyEl: row.querySelector('.row-body'),
    rowFullEl: row.querySelector('.row-full'),
    rowCaretEl: row.querySelector('.row-caret'),
    state: 'idle',
    lastText: '',
    stableCount: 0,
    reply: '',
    genStart: null, // 进入 generating 的时间戳（等待计时用）
  };

  panelEl.querySelector('.reload').addEventListener('click', () => webview.reload());
  panelEl.querySelector('.close-focus').addEventListener('click', unfocusPanel);

  webview.addEventListener('did-start-loading', () => setDots(entry, 'loading'));
  webview.addEventListener('did-finish-load', () => setDots(entry, 'ready'));
  webview.addEventListener('dom-ready', () => setDots(entry, 'ready'));
  // 任何加载序列结束都会触发 did-stop-loading：SPA 站内路由/子帧活动会反复触发
  // did-start-loading 却不一定伴随 did-finish-load/dom-ready，曾导致橙点常挂不灭
  webview.addEventListener('did-stop-loading', () => {
    if (entry.dot.className !== 'dot error') setDots(entry, 'ready');
  });
  webview.addEventListener('did-fail-load', (e) => {
    setDots(entry, 'error');
    setStatus(entry.statusEl, `加载失败：${e.errorDescription || e.errorCode}`);
  });

  panels.set(adapter.id, entry);
}

// ================= 总结者面板（总结专用账号；仅驻留 dock，不参与广播） =================
// 总结模型可在「设置」里选择（默认 DeepSeek）：每家独立分区 persist:<id>-sum，
// 与同站参与回答的面板会话完全隔离（可登录两个账号）。点「总结」走网页总结时被
// 全屏展开（focusPanel('summarizer')），首次使用需用户手动登录总结专用账号。
function getSummarizerSiteId() {
  const saved = localStorage.getItem('rt_summarizer');
  return SUM_MODEL_ALLOWED.includes(saved) ? saved : 'deepseek'; // 非白名单回退 DeepSeek
}

// 总结模型配置：DeepSeek 用 SUMMARIZER 的增强配置（附件上传候选/思考块剪枝），
// 其余家直接沿用各自回答条目的选择器配置
function getSummarizerAdapter() {
  const siteId = getSummarizerSiteId();
  return siteId === 'deepseek' ? SUMMARIZER : ADAPTERS.find((a) => a.id === siteId);
}

const summarizerPanel = (() => {
  const panelEl = document.createElement('div');
  panelEl.className = 'webview-panel';
  panelEl.innerHTML = `
    <div class="panel-header">
      <span class="dot"></span>
      <span class="panel-name"></span>
      <span class="panel-status"></span>
      <button class="mini reload" title="刷新该面板">⟳</button>
      <button class="mini close-focus">✕ 关闭（Esc）</button>
    </div>
  `;
  dock.appendChild(panelEl);
  const entry = {
    adapter: null,
    panelEl,
    webview: null,
    dot: panelEl.querySelector('.dot'),
    statusEl: panelEl.querySelector('.panel-status'),
  };
  panelEl.querySelector('.reload').addEventListener('click', () => {
    if (entry.webview) entry.webview.reload();
  });
  panelEl.querySelector('.close-focus').addEventListener('click', unfocusPanel);
  return entry;
})();

// 按当前设置（重）建总结者 webview：切换总结模型时调用（旧 webview 直接移除，
// 各家分区独立持久化，切回不丢登录态）
function rebuildSummarizerPanel() {
  const ad = getSummarizerAdapter();
  const siteId = getSummarizerSiteId();
  // 面板名用基础站点名（SUMMARIZER.name 已含「·总结」后缀，直接拼会重复）
  const baseAd = ADAPTERS.find((a) => a.id === siteId) || ad;
  summarizerPanel.adapter = ad;
  summarizerPanel.panelEl.querySelector('.panel-name').textContent = `${baseAd.name}·总结`;
  setStatus(summarizerPanel.statusEl, '首次使用：请在此手动登录总结专用账号（可与回答用同一家的不同账号）');
  if (summarizerPanel.webview) summarizerPanel.webview.remove();
  const webview = document.createElement('webview');
  webview.setAttribute('src', ad.url);
  webview.setAttribute('partition', `persist:${siteId}-sum`);
  webview.setAttribute('allowpopups', '');
  summarizerPanel.panelEl.appendChild(webview);
  webview.addEventListener('did-start-loading', () => (summarizerPanel.dot.className = 'dot loading'));
  webview.addEventListener('did-finish-load', () => (summarizerPanel.dot.className = 'dot ready'));
  webview.addEventListener('dom-ready', () => (summarizerPanel.dot.className = 'dot ready'));
  webview.addEventListener('did-stop-loading', () => {
    if (summarizerPanel.dot.className !== 'dot error') summarizerPanel.dot.className = 'dot ready';
  });
  webview.addEventListener('did-fail-load', (e) => {
    summarizerPanel.dot.className = 'dot error';
    setStatus(summarizerPanel.statusEl, `加载失败：${e.errorDescription || e.errorCode}`);
  });
  summarizerPanel.webview = webview;
  // 标题直接显示当前总结模型（可见性），tooltip 说明点击行为
  const titleEl = document.getElementById('summary-title');
  titleEl.textContent = `📋 总结 · ${baseAd.name}`;
  titleEl.title = `点开「${baseAd.name}」总结账号页面（手动登录总结专用账号用）`;
}

rebuildSummarizerPanel();

const DOT_LABELS = {
  '': '未加载',
  loading: '加载中',
  ready: '就绪',
  error: '加载失败',
};

function setDots(p, state) {
  p.dot.className = 'dot' + (state ? ` ${state}` : '');
  // 网页状态用按钮右上角小圆点表达（绿=就绪/橙=加载/红=失败），边框/明暗只表达是否参与本轮
  p.statusDot.className = 'model-status' + (state ? ` ${state}` : '');
  const label = DOT_LABELS[state] || state || '';
  p.statusDot.title = `${p.adapter.name}：${label || '未加载'}`;
  p.barBtn.title =
    `${p.adapter.name}${label ? `：${label}` : ''} · 单击全屏打开；参与选择在「设置」`;
}

// 本轮参与选择：持久化在 localStorage（设置弹窗勾选；缺省=全部）
function getSelectedIds() {
  try {
    const v = JSON.parse(localStorage.getItem('rt_selected') || 'null');
    if (Array.isArray(v)) return v.filter((id) => panels.has(id));
  } catch {}
  return [...panels.keys()];
}

// 把存储的选择应用到模型按钮（选中=亮，未选=暗）并刷新计数
function applySelection() {
  const sel = new Set(getSelectedIds());
  for (const p of panels.values()) {
    p.barBtn.classList.toggle('checked', sel.has(p.adapter.id));
    p.barBtn.classList.toggle('unchecked', !sel.has(p.adapter.id));
  }
  updateSubsetCount();
}

// 已选 N/总数 计数（点击打开「设置」调整参与各家）
function updateSubsetCount() {
  subsetCountEl.textContent = `已选 ${getSelectedIds().length}/${panels.size}`;
}

function setStatus(el, text) {
  el.textContent = text || '';
  el.title = text || '';
}

// 状态胶囊：只放短状态，引导语放 tooltip；失败时整行红边 + 重发按钮放大为「↻ 重发」
// V5：失败时按 errCat 视觉分级（risk=橙🛡需人工 / timeout=蓝⏱可重试 / sendfail=红⚠），
// 风控行额外显示「🛡 去验证」按钮（I3）
function setCardState(p, text, cls, errCat) {
  p.rowStateEl.textContent = text;
  p.rowStateEl.className = 'row-state' + (cls ? ` ${cls}` : '');
  p.rowStateEl.title = text;
  const failed = cls === 'err';
  p.row.classList.toggle('failed', failed);
  p.rowResendBtn.classList.toggle('urgent', failed);
  p.rowResendBtn.textContent = failed ? '↻ 重发' : '↻';
  // V5：错误分级样式（仅在失败态有意义；非失败时清掉残留）
  const cat = failed ? errCat || 'sendfail' : '';
  p.row.classList.toggle('errcat-risk', cat === 'risk');
  p.row.classList.toggle('errcat-timeout', cat === 'timeout');
  p.row.classList.toggle('errcat-sendfail', cat === 'sendfail');
  // I3：仅风控（需人工）显示「去验证」
  if (p.rowVerifyBtn) {
    p.rowVerifyBtn.hidden = !(failed && cat === 'risk');
    if (!(failed && cat === 'risk')) p.pendingVerifyResend = false;
  }
}

// V5：错误分类。风控关键词直判；再探一次页面是否停在登录/验证页（风控高发期
// 典型表现是被重定向/弹验证层，抓取端只看到"超时"）；最后才归超时/发送失败。
const RISK_KEYWORDS = ['登录', '登入', '验证', '风控', '扫码', '拦截', '封禁', '账号', '人机', '滑块'];
const TIMEOUT_KEYWORDS = ['未取到', '超时', 'timeout'];
const ERR_LABELS = { risk: '🛡 需人工验证', timeout: '⏱ 超时可重试', sendfail: '⚠ 发送失败' };
// 页面级风控探测：URL 含登录/验证路径，或标题含登录/验证字样（正文关键词易误伤，不用）
const RISK_PROBE = `(function () {
  var u = location.href.toLowerCase();
  if (/login|passport|account|verify|captcha|sec\\./.test(u)) return true;
  return /登录|登入|验证|安全/.test(document.title || '');
})()`;
async function detectErrorCategory(p, hintText) {
  const t = String(hintText || '');
  if (RISK_KEYWORDS.some((k) => t.includes(k))) return 'risk';
  // 探测优先于超时归类：风控页常表现为"抓不到回复超时"，按关键词会漏判
  try {
    if (await execInPanel(p.webview, RISK_PROBE)) return 'risk';
  } catch {}
  if (TIMEOUT_KEYWORDS.some((k) => t.includes(k))) return 'timeout';
  return 'sendfail';
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
      // MiniMax 2026-08-27 实测：发送键可为 div 等非 button 元素，仅有 testid/aria 标识
      '[data-testid*="send" i]', '[aria-label*="发送" i]', '[aria-label*="Send" i]',
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
      // MiniMax 2026-08-27 实测：发送键可为 div 等非 button 元素，仅有 testid/aria 标识
      '[data-testid*="send" i]', '[aria-label*="发送" i]', '[aria-label*="Send" i]',
      'a[class*="send" i]', '[class*="send-btn" i]', '[class*="sendBtn" i]'
    ]);
    var btn = find(sendList);
    if (!enabled(btn)) return { ok: false };
    var r = btn.getBoundingClientRect();
    return { ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`;
}

// 注入后确认内容确实进了输入框：Kimi(Lexical) 偶发"看似填了实则没进编辑器状态"，
// 此时点发送会报错、只能刷新重发（2026-08 超时根因之一），靠这个校验尽早发现
function buildVerifyFilledScript(adapter, text) {
  const cfg = JSON.stringify({ inputSelectors: adapter.inputSelectors, text });
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
    if (!input) return { filled: false };
    var tag = input.tagName;
    var content = ((tag === 'TEXTAREA' || tag === 'INPUT') ? input.value : input.innerText) || '';
    content = content.trim();
    // 长度阈值放宽到一半：contenteditable 的 innerText 与原文存在换行/空白差异
    return { filled: content.length > 0 && content.length >= Math.min(cfg.text.trim().length, 100) * 0.5 };
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
    // strictResponse：只用适配器专属选择器，跳过通用兜底。
    // 适用于「兜底选择器会误中首页元素」的站点：MiMo 首页示例问题按钮类名含 message，
    // 发送阶段（页面重载回首页时轮询已在跑）兜底 [class*="message"] 误抓示例文本并
    // 稳定 3 轮误判完成，真正回复被忽略（2026-08-23 实测三轮均如此）
    strict: !!adapter.strictResponse,
  });
  return `(function () {
    var cfg = ${cfg};
    // 风控/人机验证拦截：阿里系（_____tmd_____/punish）等站点检测到自动化后
    // 弹出验证 iframe，回答被卡在 loading——立即上报，由轮询判错提示人工处理
    // （2026-08-24 实测千问：会话已建、答案卡验证，旧逻辑空等 180s 才判超时）
    var punishIframe = document.querySelector(
      'iframe[src*="punish"], iframe[src*="_____tmd_____"], iframe[src*="captcha"], iframe[src*="verify"]');
    if (punishIframe) return { ok: true, blocked: '站点风控验证' };
    var USER_BOX = '[class*="user" i], [class*="human" i], [class*="question" i], ' +
      '[class*="request" i], [data-testid*="user" i]';
    var PENDING = /^(正在|搜索中|思考中|生成中|加载中)|正在(搜索|思考|生成|联网|整理|执行)|请稍候|searching|thinking|需要补充|^用户(想|问|需要)/i;
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
    var sels = cfg.strict
      ? cfg.responseSelectors
      : cfg.responseSelectors.concat(['[class*="markdown"]', '[class*="message"]']);
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
        // 表格转 Markdown 管道语法：innerText 会把表格单元格直接拍平丢失行列结构，
        // 先换成 <pre> 文本（pre 的换行能被 innerText 保留），完成态渲染时还原成表格
        try {
          var tbls = clone.querySelectorAll('table');
          for (var tb = 0; tb < tbls.length; tb++) {
            var mdRows = [];
            var trs = tbls[tb].querySelectorAll('tr');
            for (var ri = 0; ri < trs.length; ri++) {
              var cells = trs[ri].querySelectorAll('th,td');
              var vals = [];
              for (var ci = 0; ci < cells.length; ci++) {
                vals.push(cells[ci].innerText.trim().replace(/\\|/g, '/').replace(/\\s+/g, ' '));
              }
              if (vals.length) mdRows.push('| ' + vals.join(' | ') + ' |');
            }
            if (mdRows.length >= 2) {
              var sep = '|' + ' --- |'.repeat(mdRows[0].split('|').length - 2);
              mdRows.splice(1, 0, sep);
            }
            var pre = document.createElement('pre');
            // 首尾换行包进 pre 文本内部：innerText 不会在 pre 边界自动补换行，
            // 不包的话表头会粘在前文句尾、末行会粘住后文
            pre.textContent = '\\n' + mdRows.join('\\n') + '\\n';
            tbls[tb].replaceWith(pre);
          }
        } catch (e) {}
        // innerText 依赖渲染布局：DeepSeek 等用块级 div/p 排版（无 <br>），换行完全来自布局；
        // 克隆节点脱离 DOM 后无布局，innerText 会丢失全部块级换行（2026-08-18 实测：
        // 活节点 27 换行 / 脱离克隆 0 换行 / 重新挂回 27 换行）。故把修剪好的克隆临时挂到
        // 屏外（保留布局但不可见）再取 innerText，取完立即移除，不改动真实页面。
        // 隐藏方式必须用 opacity:0 而非 visibility:hidden：Chromium 150（Electron 43）起
        // visibility:hidden 子树按"未渲染"处理，innerText 直接返回空串（2026-08-18 实测：
        // 活节点 602 字/34 行，visibility:hidden 克隆 0 字，opacity:0 克隆 602 字/34 行，
        // 曾致所有站点抓取 ok:false、轮次全部 420s 超时）。
        var text = '';
        var holder = document.createElement('div');
        holder.style.cssText = 'position:absolute;left:-99999px;top:0;opacity:0;';
        holder.appendChild(clone);
        document.body.appendChild(holder);
        try {
          text = clone.innerText.trim();
          // 兜底：个别站点（2026-08-24 千问 qk-markdown 实测）克隆脱离原布局上下文后
          // innerText 返回空串，而 textContent 正常——此时退回 textContent，
          // 并给块级标签补换行，尽量保留段落结构（innerText 正常时此分支不触发）。
          if (text.length < 2 && (clone.textContent || '').trim().length >= 2) {
            try {
              var blocks = clone.querySelectorAll('p,div,li,tr,br,h1,h2,h3,h4,h5,h6,pre,section,article');
              for (var bb = 0; bb < blocks.length; bb++) blocks[bb].insertAdjacentText('afterend', '\\n');
            } catch (e2) {}
            text = clone.textContent.replace(/[ \\t]+/g, ' ').trim();
          }
        } finally {
          holder.remove();
        }
        if (text.length < 2) continue; // 剪完没有答案内容 → 换下一个选择器/继续等待
        if (text.length < 300 && PENDING.test(text)) return { ok: true, pending: true, text: '' };
        // watchStop 家（智谱/Kimi/MiniMax/总结者）："停止生成"按钮仍可见 = 站点仍在生成，
        // 一律 pending。旧判据只保护 <200 字短文本——智谱深度思考的长推理流（>300 字）
        // 在流内停顿 ≥3 个轮询周期就被当成完整答案交卷（2026-08-27 实测 24 点题：
        // 626 字推理被当回复）。生成中不管文本多长都不能判完成；按钮消失后自然走稳定判卷。
        if (stopVisible()) return { ok: true, pending: true, text: '' };
        return { ok: true, text: text.slice(0, 8000) };
      }
    }
    return { ok: false, error: '未抓取到回复内容' };
  })()`;
}

// 整条"回复"恰为界面标签/按钮文字的噪声：不是答案，返回空让轮询继续等待、
// 最终按未取到处理（2026-08-18 实测：文心把「深度思考」模式切换按钮的 4 字标签当交卷答案）
const NOISE_LABELS = new Set([
  '深度思考', '深度思考中', '联网搜索', '全网搜索', '通知', '思考中', '生成中',
  '复制', '重新生成', '展开', '收起', '查看更多', '加载更多',
]);

// 归一化（与抓取脚本同规则）：去空白与标点，用于比对"问题回音"
const normText = (s) =>
  String(s).replace(/[\s\u00a0\u200b]+/g, '').replace(/[\p{P}\p{S}]/gu, '');

// 清洗抓到的回复：截断「猜你想问」类推荐区块，去掉尾部按钮文字（编辑/复制/分享…）；
// 传入 question 时额外剔除首行的"问题回音"（千问等会把问题复述成第一行再接正文，
// 节点级排除兜不住这种"回音独立成行"的情况，曾混进总结附录）
function cleanReply(text, question) {
  const CUT_MARKERS = /^(你可能想问|猜你想问|相关问题|相关视频|为你推荐|推荐问题|推荐追问|继续提问|继续追问)/;
  const TRAIL = /^(编辑|复制|分享|重新生成|收藏|朗读|听全文|点赞|点踩|举报|转发|反馈|引用|追问|换个话题)$/;
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (CUT_MARKERS.test(lines[i].trim())) { lines.length = i; break; }
  }
  while (lines.length && (lines[lines.length - 1].trim() === '' || TRAIL.test(lines[lines.length - 1].trim()))) {
    lines.pop();
  }
  const out = lines.join('\n').trim();
  if (NOISE_LABELS.has(out)) return '';
  if (question) {
    const nq = normText(question);
    if (nq) {
      const ls = out.split('\n');
      while (ls.length) {
        const nl = normText(ls[0]);
        // 首行与问题相同、或为问题的开头一段（回音可能被换行截断），剔除
        if (nl && nl.length >= 4 && (nl === nq || nq.startsWith(nl))) ls.shift();
        else break;
      }
      return ls.join('\n').trim();
    }
  }
  return out;
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

// 单家发送：准备输入框 → 注入文本 → 校验已填入 → JS点发送 → 验证；不行则可信鼠标点击 → 验证；
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
    await sleep(300);
    // 可信注入后确认内容真进了编辑器；没进去就重新聚焦再注入一次
    const filled = await execInPanel(webview, buildVerifyFilledScript(adapter, text)).catch(() => null);
    if (filled && !filled.filled) {
      await execInPanel(webview, buildPrepareScript(adapter)).catch(() => null);
      await sleep(300);
      await roundtable.insertText(wcId, text);
    }
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
  // 能读到输入框且内容仍在 → 确实没发出去，如实报失败（此前返回 ok:unverified，
  // 把"填了没提交"当成功，只能等陈旧检测超时兜底——Kimi 超时假象的来源之一）
  if (v) return { ok: false, error: '发送未生效（内容仍在输入框）' };
  return { ok: true, via: 'unverified' }; // 仅验证脚本本身失败才兜底放行
}

// 等 webview 刷新后重新就绪（dom-ready 或超时兜底），供"刷新重发"恢复用
function waitWebviewReady(webview, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      webview.removeEventListener('dom-ready', done);
      resolve();
    }
    webview.addEventListener('dom-ready', done);
  });
}

// ================= 广播 =================
const promptEl = document.getElementById('prompt');
const sendBtn = document.getElementById('send-btn');
const summarizeBtn = document.getElementById('summarize-btn');

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

// ================= I2：回复行就地展开全文（手风琴） =================
// 行点击=展开/收起该家全文（Markdown 渲染）；展开的行占更大空间、其余行自动压缩，
// rows 列表永不出滚动条--长文只在展开区内部滚动。「跳总结附录」降级为展开区内次级入口。
function renderRowFull(p) {
  const text = p.reply || p.lastText || '';
  if (!text) {
    p.rowFullEl.className = 'row-full empty';
    p.rowFullEl.textContent = p.rowBodyEl.textContent || '（暂无内容）';
    return;
  }
  p.rowFullEl.className = 'row-full';
  const md = document.createElement('div');
  md.className = 'md';
  md.innerHTML = renderMarkdown(text);
  const jump = document.createElement('button');
  jump.className = 'mini row-jump';
  jump.textContent = '在总结附录中查看 ↗';
  jump.title = '跳转到右侧总结里该家的原文小节';
  jump.addEventListener('click', (e) => {
    e.stopPropagation();
    jumpToSummaryFamily(p.adapter.name);
  });
  p.rowFullEl.replaceChildren(md, jump);
}

function collapseRow(p) {
  p.rowFullEl.hidden = true;
  p.row.classList.remove('expanded');
  p.rowCaretEl.classList.remove('open');
}

function expandRow(p) {
  p.rowFullEl.hidden = false;
  p.row.classList.add('expanded');
  p.rowCaretEl.classList.add('open');
  renderRowFull(p);
}

// 手风琴：同时只展开一家（多家齐展开会互相挤压，可读性差）
function toggleRowExpand(p) {
  const willOpen = p.rowFullEl.hidden;
  if (willOpen) {
    for (const other of panels.values()) {
      if (other !== p && !other.rowFullEl.hidden) collapseRow(other);
    }
    expandRow(p);
  } else {
    collapseRow(p);
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
// 新问题：清空输入框（发送不再自动清空），焦点回到输入框
document.getElementById('new-btn').addEventListener('click', () => {
  promptEl.value = '';
  autoGrow();
  promptEl.focus();
});

// 发送快捷键：默认 Ctrl+Enter 发送（Enter 换行）；设置里可切换为 Enter 发送（Shift+Enter 换行）
function getEnterSend() {
  return localStorage.getItem('rt_enterSend') === '1';
}

function syncPromptPlaceholder() {
  promptEl.placeholder = getEnterSend()
    ? '输入问题，Enter 发送到勾选各家（Shift+Enter 换行）'
    : '输入问题，Ctrl+Enter 发送到勾选各家（Enter 换行）';
}

promptEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  if (getEnterSend()) {
    // Enter 发送模式：Shift/Ctrl/Meta+Enter 换行
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      submit();
    }
  } else if (e.ctrlKey || e.metaKey) {
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

function getAutoSummary() {
  // 默认开启「全部交卷后自动总结」，仅显式存过 '0' 才视为关闭
  return localStorage.getItem('rt_autoSummary') !== '0';
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

// ================= 总结 =================
const summaryBody = document.getElementById('summary-body');
const summaryStatus = document.getElementById('summary-status');
const summaryToc = document.getElementById('summary-toc');
let lastSummary = ''; // 最近一次总结原文（复制按钮用）

// 目录标签：扫描渲染后的总结 DOM，为五个部分（一、~五、）与附录各家（【家名】）
// 生成跳转锚点；点击平滑滚动到对应位置。五个部分用固定标签，不按原文照抄。
const TOC_SECTIONS = ['主要共识', '次要共识', '分歧观点', '个性观点', '综合意见'];
// 家名 -> { el(附录锚点), chip(目录标签) }：供左侧回复行点击跳转用
const summaryAnchors = new Map();
// 目录 scroll-spy 锚点序列（文档顺序）：{ el, chip }
let tocAnchors = [];

// 左侧家名行点击：跳转总结版块对应附录锚点并短暂高亮目录标签；
// 尚无总结时在行状态上给出提示，避免"点了没反应"的错觉
function jumpToSummaryFamily(name) {
  const a = summaryAnchors.get(name);
  if (!a) {
    const p = [...panels.values()].find((x) => x.adapter.name === name);
    if (!p) return;
    const prevText = p.rowStateEl.textContent;
    const prevCls = p.rowStateEl.className;
    const prevTitle = p.rowStateEl.title;
    setCardState(p, '尚无总结', 'warn');
    p.rowStateEl.title = '尚未生成总结，先点右上角「总结」';
    setTimeout(() => {
      p.rowStateEl.textContent = prevText;
      p.rowStateEl.className = prevCls;
      p.rowStateEl.title = prevTitle;
    }, 1500);
    return;
  }
  a.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (a.chip) {
    a.chip.classList.add('active');
    setTimeout(() => a.chip.classList.remove('active'), 1200);
  }
}

// scroll-spy：滚动总结正文时，目录里当前阅读位置对应的标签自动高亮
let spyTick = false;
function updateTocSpy() {
  if (!tocAnchors.length) return;
  const base = summaryBody.getBoundingClientRect().top;
  let cur = null;
  for (const a of tocAnchors) {
    if (a.el.getBoundingClientRect().top <= base + 30) cur = a;
    else break;
  }
  for (const a of tocAnchors) a.chip.classList.toggle('active', a === cur);
}

function buildSummaryToc() {
  summaryToc.innerHTML = '';
  summaryToc.hidden = true;
  summaryAnchors.clear();
  tocAnchors = [];
  const sectionEls = new Map(); // label -> el（一、~五、）
  const families = []; // [{ label, el }]（附录各家【家名】）
  const seen = new Set(); // 每家只取第一次出现（回复正文里也可能有【家名】字样）
  let appendixEl = null; // 附录标题（供「各家意见」分组跳转）
  let inAppendix = false;
  // V1：正文包在 .reading-col 里，目录扫描取限位容器的子节点
  const scanRoot = summaryBody.querySelector('.reading-col') || summaryBody;
  for (const el of scanRoot.children) {
    const t = (el.textContent || '').trim();
    if (/^附录/.test(t)) {
      inAppendix = true;
      if (!appendixEl) appendixEl = el;
      continue;
    }
    const sm = t.match(/^([一二三四五])、/);
    if (sm) {
      const label = TOC_SECTIONS['一二三四五'.indexOf(sm[1])];
      if (!sectionEls.has(label)) sectionEls.set(label, el);
      continue;
    }
    if (inAppendix) {
      const fm = t.match(/^【(.+?)】/);
      if (fm && !seen.has(fm[1]) && ADAPTERS.some((a) => a.name === fm[1])) {
        seen.add(fm[1]);
        families.push({ label: fm[1], el });
      }
    }
  }
  if (!sectionEls.size && !families.length) return;

  // 通用目录标签；el 为空时不绑跳转（该部分缺失）
  const mkChip = (label, el, brandId) => {
    const chip = document.createElement('button');
    chip.className = 'toc-chip';
    if (brandId) {
      const dot = document.createElement('span');
      dot.className = 'toc-dot';
      dot.style.background = BRAND_COLORS[brandId] || 'var(--accent)';
      chip.appendChild(dot);
    }
    chip.appendChild(document.createTextNode(label));
    if (el) {
      chip.addEventListener('click', () =>
        el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
    return chip;
  };

  // 五个部分按固定顺序渲染，与正文一一对应
  for (const label of TOC_SECTIONS) {
    const el = sectionEls.get(label) || null;
    const chip = mkChip(label, el);
    if (el) tocAnchors.push({ el, chip });
    summaryToc.appendChild(chip);
  }

  if (families.length) {
    const sep = document.createElement('span');
    sep.className = 'toc-sep';
    summaryToc.appendChild(sep);

    // 「各家意见」一级分组：点击展开/收起各家二级标签，并跳到附录
    const groupWrap = document.createElement('div');
    groupWrap.className = 'toc-group';
    const caret = document.createElement('span');
    caret.className = 'toc-caret';
    caret.textContent = '▸';
    const groupChip = document.createElement('button');
    groupChip.className = 'toc-chip toc-group-chip';
    groupChip.appendChild(caret);
    groupChip.appendChild(document.createTextNode('各家意见'));
    const subBox = document.createElement('div');
    subBox.className = 'toc-sub';
    subBox.hidden = true;
    const setExpanded = (open) => {
      subBox.hidden = !open;
      caret.textContent = open ? '▾' : '▸';
      groupWrap.classList.toggle('expanded', open);
    };
    groupChip.addEventListener('click', () => {
      setExpanded(subBox.hidden);
      if (appendixEl) appendixEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // 附录锚点本身也进 scroll-spy 序列：滚动到附录时高亮「各家意见」分组标签
    if (appendixEl) tocAnchors.push({ el: appendixEl, chip: groupChip });

    for (const f of families) {
      const ad = ADAPTERS.find((a) => a.name === f.label);
      const chip = mkChip(f.label, f.el, ad && ad.id);
      chip.classList.add('toc-subchip');
      summaryAnchors.set(f.label, { el: f.el, chip });
      tocAnchors.push({ el: f.el, chip });
      subBox.appendChild(chip);
    }

    groupWrap.appendChild(groupChip);
    groupWrap.appendChild(subBox);
    summaryToc.appendChild(groupWrap);
  }

  summaryToc.hidden = false;
  updateTocSpy();
}

// scroll-spy 滚动监听（rAF 节流）
summaryBody.addEventListener('scroll', () => {
  if (spyTick) return;
  spyTick = true;
  requestAnimationFrame(() => {
    spyTick = false;
    updateTocSpy();
  });
});

// 轻量 Markdown 渲染（先转义 HTML，支持标题/列表/表格/加粗/行内代码/段落）
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
  const isTableLine = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isTableSep = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (isTableLine(line)) {
      // 表格块：连续管道行；首行为表头，分隔行（|---|）跳过
      closeList();
      const tbl = [];
      while (i < lines.length && isTableLine(lines[i])) { tbl.push(lines[i]); i++; }
      i--;
      const rows = tbl.filter((l) => !isTableSep(l));
      html += '<table>';
      rows.forEach((r, ri) => {
        const cells = r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
          .map((c) => inline(c.trim()));
        const tag = ri === 0 ? 'th' : 'td';
        html += '<tr>' + cells.map((c) => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
      });
      html += '</table>';
      continue;
    }
    if ((m = line.match(/^(#{1,3})\s+(.*)/))) {
      closeList();
      html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`;
    } else if ((m = line.match(/^([一二三四五])、\s*(.*)/))) {
      // 中文一级标题（一、~五、）：五段结构段首
      closeList();
      html += `<h2 class="lv1">${inline(line)}</h2>`;
    } else if (/^附录/.test(line.trim())) {
      closeList();
      html += `<h2 class="appendix">${inline(line)}</h2>`;
    } else if ((m = line.match(/^（[一二三四五六七八九十]+）、?\s*(.*)/))) {
      // 中文二级标题（（一）（二）…）
      closeList();
      html += `<h3 class="lv2">${inline(line)}</h3>`;
    } else if (/^【.+?】/.test(line.trim())) {
      // 【家名】：附录各家小节标题
      closeList();
      html += `<h3 class="family">${inline(line)}</h3>`;
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
    // 总结方式：web=DeepSeek 第二账号网页总结（默认），api=OpenAI 兼容接口
    // API 默认指向智谱免费模型 GLM-4.7-Flash，只需填自己的 API Key 即可用
    summaryMode: localStorage.getItem('rt_summaryMode') === 'api' ? 'api' : 'web',
    baseURL: localStorage.getItem('rt_baseURL') || 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: localStorage.getItem('rt_apiKey') || '',
    model: localStorage.getItem('rt_model') || 'glm-4.7-flash',
  };
}

// 圆桌总结模板（五段结构）。内容要求两种模式共用；排版要求分模式，原因：
// - API 模式：原始文本直接返回，单换行天然保留 → 用「纯文本 + 单换行」即可；
// - 网页模式：输出要经「DeepSeek 页面渲染 → innerText 抓取」，单换行会被 Markdown
//   渲染折叠、抓取后丢失，导致分级排版与目录锚点损坏（2026-08-18 实测确认）→
//   必须要求「任意相邻两行之间都空一行」（每行独立段落），抓取才能保住换行。
// 输出结构必须与 buildSummaryToc 的解析（一、~五、 与附录【家名】）匹配，否则目录导航失效。
const SUMMARY_CONTENT =
  '你是一位中立的圆桌主持人。下面是同一个问题下多家 AI 的回答。' +
  '请输出一份结构化总结，严格按以下五个部分组织：' +
  '一、主要共识：归纳超过半数的参与家数一致的观点（9 家全参与时即 5 家及以上）；' +
  '二、次要共识：2 家到 4 家一致的观点；' +
  '三、分歧观点：任意两家及以上不一致的观点，说明各方立场与各自理由；' +
  '四、个性观点：仅一家提出的独特观点；' +
  '五、综合意见：综合各家意见，给出一个「最大公约数」的回答版本。' +
  '每条观点后用括号注明持该观点的家名，如（千问、豆包、Kimi、MiMo）；' +
  '某部分没有内容时写「无」。' +
  '结构层次用中文序号体现：一级标题（五个部分）用「一、二、三、四、五、」，' +
  '二级标题（部分内的各小节）必须用「（一）（二）（三）」；' +
  '小节内的具体条目用「1. 2. 3.」，再细分用「（1）（2）」。' +
  '注意：二级标题一律用带括号的中文数字，不要用「1.」充当小节标题；' +
  '直接以标题开头，不要任何开场白。' +
  '不要输出附录或各家原文，附录由程序自动拼接。';

// API 模式排版：原始文本直接返回，单换行即保留
const SUMMARY_FORMAT_API =
  '排版要求（必须严格遵守）：输出纯文本，严禁使用任何 Markdown 符号（#、*、-、>、` 等）；' +
  '标题和条目各自独占一行，部分之间空一行。';

// 网页模式排版：渲染→抓取会丢单换行，纯文本指令不可靠（2026-08-18 实测仍连成一行）。
// 改用 Markdown 标题——标题必渲染成独立块级元素，innerText 抓取时块间换行天然保留，
// 且 ## 被渲染剥离后抓回仍是干净中文序号文本，renderMarkdown/buildSummaryToc 均可识别。
const SUMMARY_FORMAT_WEB =
  '排版要求（必须严格遵守）：请用 Markdown 组织版面，确保每个标题独立成块。' +
  '五个部分各用一个二级标题，依次为：## 一、主要共识，## 二、次要共识，## 三、分歧观点，## 四、个性观点，## 五、综合意见。' +
  '部分内的小节用三级标题：### （一）…，### （二）…。' +
  '小节内的条目用 Markdown 列表，每条一行、以 - 开头。' +
  '观点后用括号注明家名，如（DeepSeek）。某部分没有内容时在该标题下写「无」。' +
  '直接以第一个二级标题开头，不要开场白，不要输出附录或各家原文。';

const SUMMARY_TEMPLATE = SUMMARY_CONTENT + SUMMARY_FORMAT_API;
const SUMMARY_TEMPLATE_WEB = SUMMARY_CONTENT + SUMMARY_FORMAT_WEB;

// 核心总结逻辑：按钮与 HTTP 服务轮次共用。成功返回总结文本；失败抛出错误（同时已更新 DOM）。
let summarizeBusy = false; // 自动/手动触发共用的防重入锁
async function doSummarize() {
  if (summarizeBusy) throw new Error('总结正在进行中');
  const settings = getSettings();
  // 只纳入本轮范围内已完成的回复，失败/未完成的跳过（上一轮别家遗留不混入）
  const usable = roundScope().filter((p) => p.state === 'done' && p.reply);
  if (usable.length === 0) throw new Error('没有已完成的回复可供总结');
  const skipped = roundScope()
    .filter((p) => p.state !== 'done')
    .map((p) => p.adapter.name);

  summarizeBusy = true;

  summarizeBtn.disabled = true;
  summaryBody.className = 'summary-body placeholder';
  summaryBody.textContent =
    settings.summaryMode === 'api'
      ? `正在调用 ${settings.model} 总结…`
      : '正在 DeepSeek 网页（第二账号）生成总结…';
  summaryStatus.textContent = '总结中…';
  summaryStatus.className = 'card-state warn';
  summaryToc.hidden = true; // 新一轮总结生成前隐藏旧目录
  summaryToc.innerHTML = '';
  summaryAnchors.clear();

  try {
    // 网页模式：DeepSeek 第二账号生成；API 模式：OpenAI 兼容接口（备选）
    const raw =
      settings.summaryMode === 'api'
        ? await summarizeViaAPI(settings, usable, skipped)
        : await summarizeViaWeb(usable, skipped);
    // 附录由程序拼接（保证各家原文逐字完整，不靠 LLM 复述）
    let appendix = '\n\n附录：各家意见（原文）';
    for (const p of usable) appendix += `\n\n【${p.adapter.name}】\n${p.reply}`;
    if (skipped.length) appendix += `\n\n（${skipped.join('、')} 本轮未纳入总结）`;
    const content = raw.trim() + appendix;
    lastSummary = content;
    summaryBody.className = 'summary-body md';
    // V1：阅读行宽限位容器（46em 居中），正文块都包在里层
    const readingCol = document.createElement('div');
    readingCol.className = 'reading-col settle'; // V6：总结落定动画
    readingCol.innerHTML = renderMarkdown(content);
    summaryBody.replaceChildren(readingCol);
    buildSummaryToc();
    summaryStatus.textContent = `生成时间 ${new Date().toLocaleTimeString()}`;
    summaryStatus.className = 'card-state ok';
    notify('AI 圆桌', '总结已生成');
    return content;
  } catch (e) {
    const msg = `总结调用失败：${e.message || e}`;
    summaryBody.className = 'summary-body error';
    // 错误与登录相关时给出「去登录」直达按钮（失败场景就地引导，不用再找入口）
    summaryBody.replaceChildren();
    const msgEl = document.createElement('div');
    msgEl.textContent = msg;
    summaryBody.appendChild(msgEl);
    if (/登录/.test(msg)) {
      const loginBtn = document.createElement('button');
      loginBtn.className = 'mini sum-login-btn';
      loginBtn.textContent = '去登录';
      loginBtn.title = '全屏打开总结账号页面，登录后再点「总结」';
      loginBtn.addEventListener('click', () => focusPanel('summarizer'));
      summaryBody.appendChild(loginBtn);
    }
    summaryStatus.textContent = '总结失败';
    summaryStatus.className = 'card-state err';
    throw e;
  } finally {
    summarizeBusy = false;
    summarizeBtn.disabled = false;
  }
}

// API 总结路径（OpenAI 兼容接口，设置里配置；作为网页总结的备选保留）
async function summarizeViaAPI(settings, usable, skipped) {
  if (!settings.baseURL || !settings.apiKey || !settings.model) {
    throw new Error('总结 LLM 未配置（baseURL/apiKey/model），请在设置里改用网页总结或补全配置');
  }
  const blocks = usable.map((p) => `【${p.adapter.name}】\n${p.reply}`).join('\n\n');
  const messages = [
    { role: 'system', content: SUMMARY_TEMPLATE },
    {
      role: 'user',
      content: `共 ${usable.length} 家回答${skipped.length ? `（${skipped.join('、')} 未纳入）` : ''}：\n\n${blocks}`,
    },
  ];
  const raw = await roundtable.callLLM({ ...settings, messages });
  return raw.trim();
}

// ================= 网页总结（DeepSeek 第二账号，独立分区）=================
// 【回退模式】各家原文截断上限：附件上传不可用时退化为纯文本提示词，
// 此时控制总长度（9 家约 1.8 万字）防超出网页输入框限制。
const WEB_SUMMARY_PER_FAMILY_LIMIT = 2000;
// 长总结（五段结构、数千字）生成较慢；超时判失败，用户可重试或切 API
const WEB_SUMMARY_TIMEOUT = 300000;

// 【附件模式】docx 内容：模板要求 + 问题 + 各家无删减原文（回复抓取时已天然限 8000 字/家）。
// 整份进附件，输入框只发一句短指令，彻底绕开输入框字数限制。
function buildUploadMarkdown(usable, skipped) {
  const blocks = usable.map((p) => `【${p.adapter.name}】\n${p.reply}`).join('\n\n');
  return (
    SUMMARY_TEMPLATE_WEB +
    `\n\n任务问题：${currentQuestion || '（未提供）'}` +
    `\n\n下面是同一个问题下 ${usable.length} 家 AI 的回答${skipped.length ? `（${skipped.join('、')} 未纳入）` : ''}，` +
    '请根据这些回答直接输出五段总结：\n\n' +
    blocks
  );
}

// 【回退模式】提示词：模板要求在前 + 各家回复（截断）在后
function buildWebSummaryPrompt(usable, skipped) {
  const blocks = usable
    .map((p) => {
      let t = p.reply;
      if (t.length > WEB_SUMMARY_PER_FAMILY_LIMIT) {
        t = t.slice(0, WEB_SUMMARY_PER_FAMILY_LIMIT) + '…（过长已截断）';
      }
      return `【${p.adapter.name}】\n${t}`;
    })
    .join('\n\n');
  return (
    SUMMARY_TEMPLATE_WEB +
    `\n\n下面是同一个问题下 ${usable.length} 家 AI 的回答${skipped.length ? `（${skipped.join('、')} 未纳入）` : ''}，` +
    '请根据这些回答直接输出五段总结：\n\n' +
    blocks
  );
}

// 把附件文件上传进总结者页面：优先直接找 input[type=file]（CDP 直塞文件）；
// 找不到时按 uploadSelectors 逐个点击附件按钮候选，等它进 DOM 再试。成功返回 true。
async function tryUploadFile(sp, filePath) {
  let wcId;
  try {
    wcId = sp.webview.getWebContentsId();
  } catch {
    return false;
  }
  const setFiles = () => roundtable.setFileInput(wcId, filePath);
  try {
    await setFiles();
    return true;
  } catch {}
  for (const sel of sumAd.uploadSelectors || []) {
    try {
      const clicked = await execInPanel(
        sp.webview,
        `(function () {
          var els = document.querySelectorAll(${JSON.stringify(sel)});
          for (var i = 0; i < els.length; i++) {
            var r = els[i].getBoundingClientRect();
            if (r.width > 0 && r.height > 0) { els[i].click(); return true; }
          }
          return false;
        })()`
      );
      if (!clicked) continue;
      await sleep(1000);
      await setFiles();
      return true;
    } catch {}
  }
  return false;
}

// 附件刚经 CDP 塞入时，发送按钮有一段禁用窗口（2026-08-18 实测 t=0 disabled、
// 约 1~5s 恢复 pointer），期间点击/回车都会被静默吞掉，输入框残留文本并最终报
// "发送未生效"。发送前轮询等待按钮恢复可点；超时则照常尝试，由 sendToPanel 自行报错。
async function waitSendReady(webview) {
  const probe = `(function () {
    var btn = document.querySelector('div[role="button"].ds-button--primary.ds-button--filled');
    if (!btn) return true; // 按钮不存在（页面改版）时不阻塞，交给后续流程报错
    return !/disable/i.test(btn.className) && getComputedStyle(btn).cursor !== 'not-allowed';
  })()`;
  for (let i = 0; i < 15; i++) {
    try {
      if (await execInPanel(webview, probe)) return;
    } catch {}
    await sleep(1000);
  }
}

// 网页总结：全屏展开总结者面板 → 回首页开新会话 → 发模板提示词 → 轮询抓取至稳定。
// 总结者账号只做总结：每次都从站点首页进入（等同新会话），上下文不跨轮累积，
// 与参与回答的 deepseek 面板互不干扰。
async function summarizeViaWeb(usable, skipped) {
  const sp = summarizerPanel;
  const sumAd = getSummarizerAdapter(); // 总结模型可在设置中切换（默认 DeepSeek）
  // 全屏展开便于用户看进度/首次手动登录；窗口隐藏时（HTTP 服务轮次）不打扰
  if (!document.hidden) focusPanel('summarizer');

  setStatus(sp.statusEl, '正在打开新总结会话…');
  sp.webview.loadURL(sumAd.url).catch(() => {});
  await waitWebviewReady(sp.webview, 60000);
  await sleep(3000); // 等 SPA 初始化出输入框

  // 基线：发送前抓到的内容都算旧的；发送后若始终只能抓到它，说明新总结还没到
  let baseline = '';
  try {
    const pre = await execInPanel(sp.webview, buildScrapeScript(sumAd, ''));
    if (pre && pre.ok && !pre.pending) baseline = cleanReply(pre.text);
  } catch {}

  // 附件模式优先：模板+各家无删减原文进 docx 上传，输入框只发短指令（绕开字数限制）；
  // 上传不可用（未找到文件输入框等）时回退为截断文本提示词
  let sendText;
  const file = await roundtable.buildUploadFile(buildUploadMarkdown(usable, skipped)).catch(() => null);
  let uploaded = false;
  if (file && file.ok && file.path) {
    setStatus(sp.statusEl, '正在上传原文附件…');
    uploaded = await tryUploadFile(sp, file.path);
  }
  if (uploaded) {
    setStatus(sp.statusEl, '等待附件就绪…');
    await waitSendReady(sp.webview);
    sendText = '请阅读附件，严格按附件开头的要求输出五段总结，不要输出附录或各家原文。';
  } else {
    setStatus(sp.statusEl, '附件上传不可用，改用文本模式…');
    sendText = buildWebSummaryPrompt(usable, skipped);
  }

  setStatus(sp.statusEl, '正在发送总结请求…');
  let res = await sendToPanel(sumAd, sp.webview, sendText);
  if (!res || !res.ok) {
    await sleep(1500);
    res = await sendToPanel(sumAd, sp.webview, sendText);
  }
  if (!res || !res.ok) {
    setStatus(sp.statusEl, '发送失败');
    throw new Error(
      `DeepSeek 总结发送失败：${(res && res.error) || '未知'}。若尚未登录，请在全屏页面手动登录第二个账号后再点「总结」`
    );
  }
  setStatus(sp.statusEl, '生成中…');

  // 轮询抓取：连续多轮稳定且不同于基线才算完成（判据与回答抓取一致）
  const start = Date.now();
  let lastText = '';
  let stable = 0;
  while (Date.now() - start < WEB_SUMMARY_TIMEOUT) {
    await sleep(3000);
    summaryStatus.textContent = `总结中… ${Math.round((Date.now() - start) / 1000)}s`;
    let r;
    try {
      r = await execInPanel(sp.webview, buildScrapeScript(sumAd, ''));
    } catch {
      continue; // 执行超时，下轮再试
    }
    if (!r || !r.ok) continue;
    // 页面仍在生成（含 watchStop 的停止按钮判据）：清零稳定计数继续等
    if (r.pending) {
      stable = 0;
      lastText = '';
      continue;
    }
    const t = cleanReply(r.text);
    if (!t || t === baseline) {
      stable = 0;
      continue;
    }
    if (t === lastText) {
      stable += 1;
    } else {
      lastText = t;
      stable = 0;
    }
    // 计数达到 3 判完成（含变化首轮共约 12 秒稳定，与回答抓取判据一致）；
    // 超短内容几乎必是噪声，要求 8 轮
    const need = lastText.length < 10 ? 8 : 3;
    if (stable >= need) {
      setStatus(sp.statusEl, '总结已生成');
      unfocusPanel(); // 收起全屏面板，让总结面板的结构化结果直接可见（失败时保持展开便于排查）
      return lastText;
    }
  }
  setStatus(sp.statusEl, '等待超时');
  throw new Error('DeepSeek 网页总结等待超时（300 秒），请再点「总结」重试，或在设置中改用 API 总结');
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

// 等进行中的总结收尾后再总结（服务轮次用）：自动总结可能恰好在跑，
// 直接重入会被 summarizeBusy 拒掉导致 summary 为空（2026-08 曾因此 docx 为空）
async function summarizeWhenIdle() {
  for (let i = 0; i < 90 && summarizeBusy; i++) await sleep(2000);
  return doSummarize();
}

summarizeBtn.addEventListener('click', async () => {
  const settings = getSettings();
  // 仅 API 模式需要预先配置；网页模式直接跑（未登录会在错误里给出引导）
  if (
    settings.summaryMode === 'api' &&
    (!settings.baseURL || !settings.apiKey || !settings.model)
  ) {
    openSettings();
    return;
  }
  try {
    await summarizeDesktop();
  } catch {
    /* 错误信息已在 doSummarize 内渲染到总结面板 */
  }
});

// 总结面板配套动作（问题6）：复制全文 / 回到顶部
function copyText(t) {
  const legacy = () => {
    const ta = document.createElement('textarea');
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(t).catch(legacy);
  }
  return Promise.resolve().then(legacy);
}

document.getElementById('summary-copy').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (!lastSummary) return;
  await copyText(lastSummary);
  btn.textContent = '已复制 ✓';
  setTimeout(() => (btn.textContent = '复制'), 1500);
});

// ================= 总结导出（Markdown / PDF 二选一） =================
// 「导出」弹出格式菜单；MD 经主进程对话框直接写盘；
// PDF 由本文件拼出自包含 HTML（含打印浅色排版），主进程离屏窗口 printToPDF——
// HTML 即中转格式（pandoc 转 PDF 需 LaTeX，本机不具备）。
const exportBtn = document.getElementById('summary-export');
const exportMenu = document.getElementById('export-menu');

function toggleExportMenu(show) {
  if (!lastSummary && show) return;
  exportMenu.hidden = !show;
}
exportBtn.addEventListener('click', (e) => {
  e.stopPropagation(); // 不冒泡到 document 的「点别处收起」监听
  toggleExportMenu(exportMenu.hidden);
});
exportMenu.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => toggleExportMenu(false));

for (const item of exportMenu.querySelectorAll('.export-item')) {
  item.addEventListener('click', async () => {
    toggleExportMenu(false);
    if (!lastSummary) return;
    const format = item.dataset.format === 'pdf' ? 'pdf' : 'md';
    const btn = exportBtn;
    btn.textContent = '导出中…';
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp =
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
      `-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const markdown =
      `# ${currentQuestion || 'AI 圆桌总结'}\n\n` +
      `> 生成时间：${d.toLocaleString('zh-CN', { hour12: false })}\n\n` +
      `${lastSummary}\n`;
    let r;
    try {
      r = await roundtable.exportSummary({
        format,
        defaultName: `圆桌总结-${stamp}`,
        markdown,
        html: buildExportHtml(currentQuestion, lastSummary, d),
      });
    } catch (e) {
      r = { ok: false, error: String(e.message || e) };
    }
    btn.textContent = r && r.ok ? '已导出 ✓' : r && r.canceled ? '已取消' : '导出失败';
    if (r && !r.ok && !r.canceled && r.error) setStatus(summaryStatus, `导出失败：${r.error}`);
    setTimeout(() => (btn.textContent = '导出'), 1500);
  });
}

// 自包含导出 HTML：复用界面同款 renderMarkdown（表格/五段标题结构一致），
// 但用打印向的浅色独立排版（与界面主题无关）；printToPDF 按此渲染 A4
function buildExportHtml(question, summaryMd, d) {
  const escQ = String(question || 'AI 圆桌总结')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${escQ}</title>
<style>
  @page { size: A4; margin: 16mm 15mm; }
  body {
    font-family: "Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Micro Hei",
      "Microsoft YaHei", system-ui, sans-serif;
    color: #111; background: #fff;
    font-size: 11pt; line-height: 1.75; margin: 0;
  }
  h1 { font-size: 17pt; line-height: 1.45; margin: 0 0 4px; }
  .meta { color: #666; font-size: 9.5pt; margin: 0 0 14px;
    padding-bottom: 10px; border-bottom: 1px solid #ddd; }
  .md h2 { font-size: 13pt; margin: 18px 0 8px; }
  .md h2.lv1 { border-left: 3px solid #333; padding-left: 9px; }
  .md h2.appendix { border-bottom: 1px dashed #bbb; padding-bottom: 6px; }
  .md h3 { font-size: 11.5pt; margin: 14px 0 6px; color: #222; }
  .md p, .md li { margin: 4px 0; }
  .md ul, .md ol { margin: 6px 0; padding-left: 22px; }
  .md code { background: #f3f3f3; border-radius: 3px; padding: 1px 4px;
    font-size: 10pt; font-family: "JetBrains Mono", Consolas, monospace; }
  .md table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 9.8pt; }
  .md th, .md td { border: 1px solid #999; padding: 4px 8px; text-align: left;
    vertical-align: top; }
  .md th { background: #f2f2f2; }
</style>
</head>
<body>
<h1>${escQ}</h1>
<p class="meta">AI 圆桌总结 · 生成时间：${d.toLocaleString('zh-CN', { hour12: false })}</p>
<div class="md">${renderMarkdown(summaryMd)}</div>
</body>
</html>`;
}

document.getElementById('summary-top').addEventListener('click', () => {
  summaryBody.scrollTop = 0;
});

// 「📋 总结 · XX」标题与「账号」按钮：全屏展开总结账号页面（仅登录/查看，不触发总结）
document.getElementById('summary-title').addEventListener('click', () => {
  focusPanel('summarizer');
});
document.getElementById('sum-account-btn').addEventListener('click', () => {
  focusPanel('summarizer');
});

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

// ================= 界面主题（V4：深色默认 / 浅色 / 跟随系统） =================
// 存储值：''（跟随系统，默认）| 'dark' | 'light'；实际生效值写到 <html data-theme>。
// 深色是基础变量组（:root 原值），浅色由 [data-theme="light"] 覆盖。
const cfgThemeAuto = document.getElementById('cfg-theme-auto');
const cfgThemeDark = document.getElementById('cfg-theme-dark');
const cfgThemeLight = document.getElementById('cfg-theme-light');
const lightMQ = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

function getThemeSetting() {
  const v = localStorage.getItem('rt_theme');
  return v === 'dark' || v === 'light' ? v : 'auto';
}

function applyTheme() {
  const t = getThemeSetting();
  const effective = t === 'auto' ? (lightMQ && lightMQ.matches ? 'light' : 'dark') : t;
  document.documentElement.dataset.theme = effective;
}

applyTheme();
// 系统主题切换时即时跟随（仅「跟随系统」模式受影响）
if (lightMQ && lightMQ.addEventListener) lightMQ.addEventListener('change', applyTheme);

// ================= 总结模型选择（网页总结用哪一家） =================
// 下拉按总结适用度排序（评估结论沉淀在各 option 的 title 里），原则：
// ①附件直传可用（全文总结不截断）②长上下文 ③抓取稳定 ④速度/风控
const SUM_MODEL_NOTES = {
  deepseek: '推荐：附件直传（docx/md）实测可用，抓取稳定，现役总结模型',
  mimo: '百万级上下文、响应快；实测文件框接受 docx/doc/md',
};

const cfgSumModel = document.getElementById('cfg-sum-model');
const cfgModelsEl = document.getElementById('cfg-models');
for (const id of SUM_MODEL_ALLOWED) {
  const a = ADAPTERS.find((x) => x.id === id);
  if (!a) continue;
  const opt = document.createElement('option');
  opt.value = a.id;
  opt.textContent = a.name;
  opt.title = SUM_MODEL_NOTES[a.id] || '';
  cfgSumModel.appendChild(opt);
}

// 重叠确认弹窗（保存时触发）：所选总结模型同时参与分头回答 -> 提醒双账号价值，
// 用户可「仍这样保存」或「返回调整」。共用一个账号也可以（提示里说明）。
const sumOverlapModal = document.getElementById('sum-overlap-modal');
const sumOverlapText = document.getElementById('sum-overlap-text');
function sumModelOverlaps() {
  const checked = new Set(
    [...cfgModelsEl.querySelectorAll('input[type="checkbox"]:checked')].map((cb) => cb.dataset.id)
  );
  return checked.has(cfgSumModel.value);
}
document.getElementById('sum-overlap-ok').addEventListener('click', () => {
  sumOverlapModal.hidden = true;
  doSaveSettings();
});
document.getElementById('sum-overlap-cancel').addEventListener('click', () => {
  sumOverlapModal.hidden = true; // 回到设置弹窗，不保存
});

// ================= 设置弹窗 =================
const modal = document.getElementById('settings-modal');
const cfgModeWeb = document.getElementById('cfg-mode-web');
const cfgModeApi = document.getElementById('cfg-mode-api');
const cfgApiFields = document.getElementById('cfg-api-fields');
const cfgBaseURL = document.getElementById('cfg-baseurl');
const cfgApiKey = document.getElementById('cfg-apikey');
const cfgModel = document.getElementById('cfg-model');
const cfgAutoSummary = document.getElementById('cfg-autosummary');
// cfgModelsEl 已在「总结模型选择」区块声明（勾选区 change 事件要早绑）
const cfgEnterCtrl = document.getElementById('cfg-enter-ctrl');
const cfgEnterEnter = document.getElementById('cfg-enter-enter');

// 参与各家勾选区：按适配器动态生成（官方 logo + 名称），状态在 openSettings 时回填
for (const a of ADAPTERS) {
  const label = document.createElement('label');
  label.className = 'cfg-check cfg-model';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.dataset.id = a.id;
  const dot = document.createElement('span');
  dot.className = 'cfg-dot';
  dot.style.background = BRAND_COLORS[a.id] || 'var(--accent)'; // logo 缺失时的兜底色点
  attachBadgeLogo(dot, a.id);
  label.appendChild(cb);
  label.appendChild(dot);
  label.appendChild(document.createTextNode(a.name));
  cfgModelsEl.appendChild(label);
}

// 网页总结选中时，API 配置区整体置灰并禁用输入（保留为备选，不隐藏）
function syncSummaryModeUI() {
  const off = cfgModeWeb.checked;
  cfgApiFields.classList.toggle('cfg-api-off', off);
  for (const el of [cfgBaseURL, cfgApiKey, cfgModel]) el.disabled = off;
}

function openSettings() {
  const s = getSettings();
  cfgModeWeb.checked = s.summaryMode === 'web';
  cfgModeApi.checked = s.summaryMode === 'api';
  syncSummaryModeUI();
  cfgBaseURL.value = s.baseURL;
  cfgApiKey.value = s.apiKey;
  cfgModel.value = s.model;
  cfgAutoSummary.checked = getAutoSummary();
  // 参与各家 + 发送快捷键回填
  const sel = new Set(getSelectedIds());
  for (const cb of cfgModelsEl.querySelectorAll('input[type="checkbox"]')) {
    cb.checked = sel.has(cb.dataset.id);
  }
  cfgEnterCtrl.checked = !getEnterSend();
  cfgEnterEnter.checked = getEnterSend();
  const theme = getThemeSetting();
  cfgThemeAuto.checked = theme === 'auto';
  cfgThemeDark.checked = theme === 'dark';
  cfgThemeLight.checked = theme === 'light';
  cfgSumModel.value = getSummarizerSiteId(); // 总结模型回填
  modal.hidden = false;
}

document.getElementById('settings-btn').addEventListener('click', openSettings);
// 「已选 N/8」计数本身就是设置入口
subsetCountEl.title = '点击打开「设置」调整参与各家';
subsetCountEl.addEventListener('click', openSettings);
document.getElementById('settings-close').addEventListener('click', () => (modal.hidden = true));
document.getElementById('cfg-cancel').addEventListener('click', () => (modal.hidden = true));
cfgModeWeb.addEventListener('change', syncSummaryModeUI);
cfgModeApi.addEventListener('change', syncSummaryModeUI);
document.getElementById('cfg-sel-all').addEventListener('click', () => {
  for (const cb of cfgModelsEl.querySelectorAll('input[type="checkbox"]')) cb.checked = true;
});
document.getElementById('cfg-sel-none').addEventListener('click', () => {
  for (const cb of cfgModelsEl.querySelectorAll('input[type="checkbox"]')) cb.checked = false;
});
// 实际保存动作（「仍这样保存」与无重叠路径共用）
function doSaveSettings() {
  localStorage.setItem('rt_summaryMode', cfgModeApi.checked ? 'api' : 'web');
  localStorage.setItem('rt_baseURL', cfgBaseURL.value.trim());
  localStorage.setItem('rt_apiKey', cfgApiKey.value.trim());
  localStorage.setItem('rt_model', cfgModel.value.trim());
  localStorage.setItem('rt_autoSummary', cfgAutoSummary.checked ? '1' : '0');
  const ids = [...cfgModelsEl.querySelectorAll('input[type="checkbox"]')]
    .filter((cb) => cb.checked)
    .map((cb) => cb.dataset.id);
  localStorage.setItem('rt_selected', JSON.stringify(ids));
  localStorage.setItem('rt_enterSend', cfgEnterEnter.checked ? '1' : '0');
  // V4：主题即时生效（跟随系统 / 深色 / 浅色）
  localStorage.setItem('rt_theme',
    cfgThemeDark.checked ? 'dark' : cfgThemeLight.checked ? 'light' : '');
  applyTheme();
  // 总结模型：切换时重建总结面板（各模型分区独立，登录态互不丢）
  const prevSumId = getSummarizerSiteId();
  localStorage.setItem('rt_summarizer', cfgSumModel.value);
  if (cfgSumModel.value !== prevSumId) rebuildSummarizerPanel();
  applySelection();
  syncPromptPlaceholder();
  modal.hidden = true;
}

document.getElementById('cfg-save').addEventListener('click', () => {
  // 网页总结且总结模型与勾选的回答模型重叠：弹窗提醒双账号价值，确认后才保存
  if (cfgModeWeb.checked && sumModelOverlaps()) {
    const name = (ADAPTERS.find((a) => a.id === cfgSumModel.value) || {}).name || cfgSumModel.value;
    sumOverlapText.innerHTML =
      `「${name}」同时承担<b>分头回答</b>与<b>总结</b>。建议用<b>两个账号</b>分别承担（本应用已用独立分区支持）：` +
      '①上下文互不污染--回答不带总结任务记忆，总结不混入回答轮上下文；' +
      '②风控/额度独立--两账号限流互不挤占；' +
      '③可并行--回答进行中即可启动总结。' +
      `共用一个账号也可以：在「${name}·总结」面板用同一账号登录一次即可。`;
    sumOverlapModal.hidden = false;
    return;
  }
  doSaveSettings();
});
modal.addEventListener('click', (e) => {
  if (e.target === modal) modal.hidden = true;
});

// ================= 历史记录弹窗（左列表右详情） =================
const historyModal = document.getElementById('history-modal');
const historyList = document.getElementById('history-list');
const historyDetail = document.getElementById('history-detail');
const historySearch = document.getElementById('history-search');

function fmtTs(ts) {
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return ts;
  }
}

async function loadHistoryList() {
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

// 点击左侧条目，在右侧详情区展示（列表保持可见，可连续翻看）
function showHistoryDetail(it) {
  let html = `<div class="hd-q"></div><div class="history-meta">${fmtTs(it.ts)}</div>`;
  html += `<div class="hd-section">📋 总结</div><div class="hd-summary"></div>`;
  html += `<div class="hd-section">各家回复</div>`;
  for (const r of it.replies || []) {
    html += `<div class="hd-reply"><div class="hd-reply-name"></div><div class="hd-reply-text"></div></div>`;
  }
  historyDetail.innerHTML = html;
  historyDetail.scrollTop = 0;
  historyDetail.querySelector('.hd-q').textContent = it.question;
  const sumEl = historyDetail.querySelector('.hd-summary');
  // 总结与各家回复统一走 Markdown 渲染（问题8：标题/列表/表格不再平铺成纯文本）
  if (it.summary) {
    sumEl.classList.add('md');
    sumEl.innerHTML = renderMarkdown(it.summary);
  } else {
    sumEl.textContent = it.summaryError ? `总结失败：${it.summaryError}` : '（无总结）';
  }
  const replyEls = historyDetail.querySelectorAll('.hd-reply');
  (it.replies || []).forEach((r, i) => {
    const tag = r.state === 'done' ? '' : `（${r.state}）`;
    replyEls[i].querySelector('.hd-reply-name').textContent = `${r.name}${tag}`;
    const textEl = replyEls[i].querySelector('.hd-reply-text');
    if (r.text) {
      textEl.classList.add('md');
      textEl.innerHTML = renderMarkdown(r.text);
    } else {
      textEl.textContent = '（无回复）';
    }
  });
}

function openHistory() {
  historyModal.hidden = false;
  loadHistoryList();
}

document.getElementById('history-btn').addEventListener('click', openHistory);
document.getElementById('history-close').addEventListener('click', () => (historyModal.hidden = true));
document.getElementById('history-close-x').addEventListener('click', () => (historyModal.hidden = true));
document.getElementById('history-refresh').addEventListener('click', loadHistoryList);
// 搜索：输入即时过滤（300ms 防抖），Enter 立即触发；× 一键清空搜索词
let historySearchTimer = null;
historySearch.addEventListener('input', () => {
  clearTimeout(historySearchTimer);
  historySearchTimer = setTimeout(loadHistoryList, 300);
});
historySearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadHistoryList();
});
document.getElementById('history-clear').addEventListener('click', () => {
  historySearch.value = '';
  loadHistoryList();
  historySearch.focus();
});
historyModal.addEventListener('click', (e) => {
  if (e.target === historyModal) historyModal.hidden = true;
});

// ================= I7：首次使用轻引导 =================
// 触发条件：从未关闭过引导 且 没有任何历史记录（老用户有历史，视为已上手不再打扰）。
// 关闭即永久记住（localStorage），不再出现。
(async function maybeShowGuide() {
  try {
    if (localStorage.getItem('rt_guide_done')) return;
    const items = await roundtable.getHistory('', 1).catch(() => []);
    if (items && items.length) {
      localStorage.setItem('rt_guide_done', '1'); // 老用户：自动视为已上手
      return;
    }
  } catch {}
  showFirstUseGuide();
})();

function showFirstUseGuide() {
  const el = document.createElement('div');
  el.className = 'guide-bubble';
  el.innerHTML = `
    <div class="guide-title">👋 欢迎使用 AI 圆桌</div>
    <ol class="guide-steps">
      <li><b>登录</b>：点击上方模型按钮全屏打开各家网页完成登录，登录态会长期保存</li>
      <li><b>提问</b>：在顶部输入框输入问题，Ctrl+Enter 同时发给已选的各家</li>
      <li><b>看结果</b>：左下角实时跟进各家回复（点行展开全文），交卷后点「总结」生成五段横向总结</li>
    </ol>
    <div class="guide-actions">
      <button class="primary guide-start">开始使用</button>
    </div>
    <button class="guide-close" title="关闭并不再显示">✕</button>
  `;
  document.body.appendChild(el);
  const dismiss = () => {
    localStorage.setItem('rt_guide_done', '1');
    el.remove();
  };
  el.querySelector('.guide-start').addEventListener('click', dismiss);
  el.querySelector('.guide-close').addEventListener('click', dismiss);
}

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

// ================= 模型栏/输出区 横向拖拽分隔条（调整输入框高度） =================
// 拖动时 8 个模型按钮高度保持不变，只改变顶部输入框高度（输入框在上方，拖下即增高）
const hDivider = document.getElementById('h-divider');
let hDividerDragging = false;
let hDividerMoved = false;
let hDragStartY = 0;
let promptStartH = 0;

// 默认高度以上次拖到的为准（localStorage 持久化；首次为 CSS 默认 54px）
try {
  const savedH = parseInt(localStorage.getItem('rt_prompt_h'), 10);
  if (savedH >= 54 && savedH <= 180) promptEl.style.height = `${savedH}px`;
} catch {}

hDivider.addEventListener('mousedown', (e) => {
  hDividerDragging = true;
  hDividerMoved = false;
  hDragStartY = e.clientY;
  promptStartH = promptEl.getBoundingClientRect().height;
  document.body.style.cursor = 'row-resize';
  document.body.style.userSelect = 'none';
  e.preventDefault();
});
document.addEventListener('mousemove', (e) => {
  if (!hDividerDragging) return;
  const h = Math.max(54, Math.min(180, promptStartH + (e.clientY - hDragStartY)));
  promptEl.style.height = `${h}px`;
  hDividerMoved = true;
});
document.addEventListener('mouseup', () => {
  if (!hDividerDragging) return;
  hDividerDragging = false;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  // 只有真的拖动过才保存，避免误点分隔条把当前高度固化
  if (!hDividerMoved) return;
  try {
    localStorage.setItem('rt_prompt_h', String(parseInt(promptEl.style.height, 10) || ''));
  } catch {}
});

// ================= 启动初始化：应用参与选择 + 输入框快捷键提示语 + 按钮形态 =================
applySelection();
syncPromptPlaceholder();
syncSendStopButton(false);
