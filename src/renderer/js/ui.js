/* global roundtable */
/**
 * 界面设置与辅助 UI 层。
 * 职责：设置弹窗（总结方式/API 配置/参与各家/快捷键/自动总结）、界面主题、
 * 总结模型选择与重叠确认、历史记录弹窗、首次使用引导、可拖拽分隔条、
 * 输入框行为（快捷键/自适应高度/新问题）。
 * 依赖：js/panels.js（面板与选择）、js/core.js（renderMarkdown）。
 */

// ================= 输入框行为 =================
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

function getAutoSummary() {
  // 默认开启「全部交卷后自动总结」，仅显式存过 '0' 才视为关闭
  return localStorage.getItem('rt_autoSummary') !== '0';
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
