/* global ADAPTERS, SUMMARIZER */
/**
 * 面板与视觉状态层。
 * 职责：9+1 个 webview 面板/回复行（行头即每家唯一模型入口）的构建与视觉状态
 * （加载灯、可点家名全屏、状态胶囊、参与置灰、行展开手风琴、全屏浮层切换、
 * 总结者面板重建）。
 * 依赖：js/core.js（execInPanel）；轮次生命周期见 js/engine.js。
 */

// ================= 状态 =================
// id -> { adapter, webview, dot(面板内), rowDot(行头灯), rowNameEl(行头家名),
//         statusEl, rowStateEl, rowBodyEl, row,
//         state: idle|sending|generating|done|error, lastText, stableCount, reply }
const panels = new Map();

// 总结模型白名单：全部 9 家均可选用。附件直传能力有差异（2026-09-01 CDP 实测
// 各家常驻 input[type=file] 的 accept）：
//  - deepseek/mimo：实测附件直传可用（docx/doc/md），完整输入 9 家原文；
//  - doubao：文件框常驻且 accept 明确含 docx/md（总结流程未实测）；
//  - 其余家无常驻文件框或仅图片：附件上传失败自动回退文本模式（每家截断 2000 字）。
// 顺序即下拉展示顺序：附件直传能力强的排前面。
const SUM_MODEL_ALLOWED = [
  'deepseek', 'doubao', 'mimo', 'kimi',
  'zhipu', 'qwen', 'yuanbao', 'wenxin', 'minimax',
];

const dock = document.getElementById('dock');
const rowsEl = document.getElementById('rows');
const subsetCountEl = document.getElementById('subset-count');

// ================= webview 面板（dock 隐藏层 + 全屏浮层） =================
// 聚焦必须互斥：.focused 全屏面板同 z-index 叠放、按 DOM 顺序盖住彼此，而总结者
// 面板在 dock 里最后创建——若不先清旧的，总结进行中（总结者被程序化聚焦长达 300s）
// 再点任何模型按钮，新面板会被总结者页面压住，表现为"点哪家打开的都是总结页"。
function clearFocusedPanels() {
  for (const el of document.querySelectorAll('.webview-panel.focused')) {
    el.classList.remove('focused');
  }
}

function focusPanel(id) {
  const p = panels.get(id) || (id === 'summarizer' ? summarizerPanel : null);
  if (!p) return;
  // 用户全屏看过该家 = 页面可能被手动操作过，下轮发送前照旧重载（新鲜页才可跳过）
  if (p !== summarizerPanel) p.pageDirty = true;
  clearFocusedPanels();
  p.panelEl.classList.add('focused');
  dock.classList.add('active');
}

function unfocusPanel() {
  clearFocusedPanels();
  dock.classList.remove('active');
  scheduleVerifyResends(); // I3：从「去验证」全屏返回 -> 自动补发该家
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') unfocusPanel();
});

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
  // 2026-09-07：撤销错峰加载——用户使用模式为"每天数次、打开即用"，错峰让最后
  // 一家晚 10s 才开始加载，改为并行加载保证开屏即就绪
  webview.setAttribute('partition', `persist:${adapter.id}`);
  webview.setAttribute('allowpopups', '');
  panelEl.appendChild(webview);
  dock.appendChild(panelEl);

  // 回复行 = 每家的唯一身份位（原上部模型栏已并入此处）：
  //   加载灯（异常时显示）+ logo + 家名（单击全屏打开网页）+ 轮次胶囊
  //   + 🛡去验证 + ↻重发 + ▸展开全文。是否参与本轮在「设置」勾选（未选行置灰）
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `
    <div class="row-head">
      <span class="dot row-dot" title="网页加载状态（橙=加载中，红=失败）"></span>
      <span class="row-logo">${adapter.name[0]}</span>
      <span class="row-name">${adapter.name}</span>
      <span class="row-state">待发送</span>
      <button class="mini row-verify" hidden title="全屏打开该家完成登录/验证，回来后自动补发">🛡 去验证</button>
      <button class="mini row-resend" title="仅重发该家（不影响其他家）">↻</button>
      <span class="row-caret" title="展开 / 收起回复全文">›</span>
    </div>
    <div class="row-body placeholder" title="单击全屏打开该家网页（登录 / 查看 / 手动操作）">尚未发送</div>
    <div class="row-full" hidden></div>
  `;
  const rowLogo = row.querySelector('.row-logo');
  rowLogo.style.background = BRAND_COLORS[adapter.id] || 'var(--accent)';
  attachBadgeLogo(rowLogo, adapter.id);
  // 全屏入口：行头家名/logo 与 行体；展开/收起全文只归 ▸ 三角管（行体点击不展开，
  // 展开后的正文区可自由选择复制，点击不会误收起）
  const openPanel = (e) => {
    e.stopPropagation();
    focusPanel(adapter.id);
  };
  rowLogo.addEventListener('click', openPanel);
  row.querySelector('.row-name').addEventListener('click', openPanel);
  row.querySelector('.row-body').addEventListener('click', openPanel);
  row.querySelector('.row-caret').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleRowExpand(entry);
  });
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
    dot: panelEl.querySelector('.dot'),
    rowDot: row.querySelector('.row-dot'),
    rowNameEl: row.querySelector('.row-name'),
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
    pageDirty: false, // 开屏加载后未使用的干净页（发送时可跳过重载，见 engine.runSendTask）
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
    // ERR_ABORTED(-3)：站点入口跳转/SPA 重定向掐断首次导航的正常现象
    // （文心入口每次加载都触发，曾把状态灯打成"加载失败"并因 did-stop-loading
    // 的防覆盖守卫卡死红点），不算失败，交给后续 did-stop-loading 归位
    if (e.errorCode === -3) return;
    setDots(entry, 'error');
    setStatus(entry.statusEl, `加载失败：${e.errorDescription || e.errorCode}`);
  });

  panels.set(adapter.id, entry);
}

// 并行加载（撤销错峰，理由见上）：开屏即全部开始加载
for (const p of panels.values()) {
  try { p.webview.setAttribute('src', p.adapter.url); } catch {}
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
// 各家分区独立持久化，切回不丢登录态）；startDelayMs>0 时错峰加载（冷启动排队第 10 位）
function rebuildSummarizerPanel() {
  const ad = getSummarizerAdapter();
  const siteId = getSummarizerSiteId();
  // 面板名用基础站点名（SUMMARIZER.name 已含「·总结」后缀，直接拼会重复）
  const baseAd = ADAPTERS.find((a) => a.id === siteId) || ad;
  summarizerPanel.adapter = ad;
  summarizerPanel.panelEl.querySelector('.panel-name').textContent = `${baseAd.name}·总结`;
  setStatus(summarizerPanel.statusEl, '首次使用：请在此手动登录总结专用账号（可与回答用同一家的不同账号）');
  if (summarizerPanel.webview) {
    // 先显式摘掉旧 webview 的监听再移除：重建（切换总结模型）时若 guest 销毁晚于
    // 新建，事件转发监听会在宿主上瞬时叠加，触发 MaxListenersExceededWarning
    if (summarizerPanel._unbind) summarizerPanel._unbind();
    summarizerPanel.webview.remove();
  }
  const webview = document.createElement('webview');
  webview.setAttribute('partition', `persist:${siteId}-sum`);
  webview.setAttribute('allowpopups', '');
  summarizerPanel.panelEl.appendChild(webview);
  webview.setAttribute('src', ad.url);
  const bind = (ev, fn) => {
    webview.addEventListener(ev, fn);
    return [ev, fn];
  };
  const bound = [
    bind('did-start-loading', () => (summarizerPanel.dot.className = 'dot loading')),
    bind('did-finish-load', () => (summarizerPanel.dot.className = 'dot ready')),
    bind('dom-ready', () => (summarizerPanel.dot.className = 'dot ready')),
    bind('did-stop-loading', () => {
      if (summarizerPanel.dot.className !== 'dot error') summarizerPanel.dot.className = 'dot ready';
    }),
    bind('did-fail-load', (e) => {
      if (e.errorCode === -3) return; // 同上：入口跳转掐断导航不算失败
      summarizerPanel.dot.className = 'dot error';
      setStatus(summarizerPanel.statusEl, `加载失败：${e.errorDescription || e.errorCode}`);
    }),
  ];
  summarizerPanel._unbind = () => bound.forEach(([ev, fn]) => webview.removeEventListener(ev, fn));
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
  // 网页状态用行头小圆点表达，只在异常时显示（橙=加载中、红=加载失败）；
  // 绿色"就绪"启动后几乎永远常亮、信息量低，不显示（沿用原模型栏口径），
  // 状态文字在家名 tooltip 里
  p.rowDot.className = 'dot row-dot' + (state ? ` ${state}` : '');
  const label = DOT_LABELS[state] || state || '';
  p.rowNameEl.title =
    `${p.adapter.name}${label ? `：${label}` : ''} · 单击全屏打开该家网页（登录/查看）；参与选择在「设置」`;
}

// 本轮参与选择：持久化在 localStorage（设置弹窗勾选；缺省=全部）
function getSelectedIds() {
  try {
    const v = JSON.parse(localStorage.getItem('rt_selected') || 'null');
    if (Array.isArray(v)) return v.filter((id) => panels.has(id));
  } catch {}
  return [...panels.keys()];
}

// 把存储的选择应用到回复行（未勾选的家整行置灰；行不隐藏，9 行均分布局保持完整）
// 并刷新计数
function applySelection() {
  const sel = new Set(getSelectedIds());
  for (const p of panels.values()) {
    p.row.classList.toggle('unchecked', !sel.has(p.adapter.id));
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

// ================= I2：回复行就地展开全文（手风琴） =================
// 行点击=展开/收起该家全文（Markdown 渲染）；展开的行占更大空间、其余行自动压缩，
// rows 列表永不出滚动条--长文只在展开区内部滚动。「跳总结附录」降级为展开区内次级入口。
function renderRowFull(p) {
  const text = p.reply || p.lastText || '';
  if (!text) {
    // 空态不渲染内容：行体占位文本（如"尚未发送"）是唯一显示，
    // 展开区整体隐藏，不再在下方重复一行相同占位
    p.rowFullEl.className = 'row-full empty';
    p.rowFullEl.replaceChildren();
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
