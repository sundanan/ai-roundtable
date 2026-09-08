/* global roundtable */
/**
 * 界面设置与辅助 UI 层。
 * 职责：设置弹窗（总结方式/API 配置/参与各家/快捷键/自动总结）、界面主题、
 * 总结模型选择与重叠确认、历史记录弹窗、首次使用引导、可拖拽分隔条、
 * 输入框行为（快捷键/自适应高度/新问题）。
 * 依赖：js/panels.js（面板与选择）、js/core.js（renderMarkdown）。
 */

// ================= 输入框行为 =================
// 新问题：清空输入框 + 轮次界面复位待命（回复行/进度/按钮归位；轮次进行中不复位），
// 焦点回到输入框
document.getElementById('new-btn').addEventListener('click', () => {
  promptEl.value = '';
  autoGrow();
  resetToStandby();
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
  // 分隔条锁死（2026-09-07 用户反馈）：拖动过 h-divider 后高度锁定为固定值，
  // 不再随内容自动增减（内容多行时 textarea 内部滚动）；未拖过才自适应
  const saved = parseInt(localStorage.getItem('rt_prompt_h'), 10);
  if (saved >= 54) {
    promptEl.style.height = saved + 'px';
    return;
  }
  promptEl.style.height = 'auto';
  promptEl.style.height = Math.min(promptEl.scrollHeight, 180) + 'px';
}
promptEl.addEventListener('input', autoGrow);

function getAutoSummary() {
  // 默认开启「全部交卷后自动总结」，仅显式存过 '0' 才视为关闭
  return localStorage.getItem('rt_autoSummary') !== '0';
}

// ================= 关窗行为（退出程序 / 最小化到托盘） =================
// 默认「退出程序」；选托盘时主进程会创建托盘（微信/HTTP 服务保持常驻）。
// 持久化在 localStorage，任何变更经 setCloseMode 同步给主进程
function getCloseMode() {
  return localStorage.getItem('rt_closeMode') === 'tray' ? 'tray' : 'exit';
}

function applyCloseMode() {
  roundtable.setCloseMode(getCloseMode());
}

// ================= 输入框附件（随问题分发给各家） =================
// 单文件 v1：选定的磁盘路径在发送时经主进程按各家 attach 配置上传，
// 失败自动降级纯文本。仅桌面 GUI 发送携带；「＋」复位时清除
let currentAttachment = null;

function getActiveAttachment() {
  return currentAttachment;
}

function clearAttachmentChips() {
  currentAttachment = null;
  renderAttachChips();
}

function renderAttachChips() {
  const box = document.getElementById('attach-chips');
  // 输入框底部留出 chip 空间（chip 悬浮于输入框内靠下位置）
  promptEl.classList.toggle('has-attach', !!currentAttachment);
  if (!box) return;
  if (!currentAttachment) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  box.hidden = false;
  box.replaceChildren();
  const chip = document.createElement('span');
  chip.className = 'attach-chip';
  chip.textContent = currentAttachment.name;
  const x = document.createElement('button');
  x.className = 'attach-chip-x';
  x.textContent = '×';
  x.title = '移除附件';
  x.addEventListener('click', () => {
    currentAttachment = null;
    renderAttachChips();
  });
  chip.appendChild(x);
  box.appendChild(chip);
}

document.getElementById('attach-btn').addEventListener('click', async () => {
  const r = await roundtable.chooseAttachment().catch(() => null);
  if (!r || r.canceled || !r.path) return;
  currentAttachment = { path: r.path, name: r.name };
  renderAttachChips();
  promptEl.focus();
});

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

// ================= 分辨率自适应缩放（V5：保持当前视觉效果） =================
// 首次运行记录窗口宽度为设计基准；之后按 当前宽度/基准 计算缩放系数，用 CSS zoom
// 整体等比缩放（字体/间距/布局同步放大缩小），换分辨率后视觉比例与基准一致。
// 钳制 0.7~3.0 防极端值；resize 时防抖重算。
(function applyResolutionScale() {
  const KEY = 'rt_design_w';
  try {
    if (!localStorage.getItem(KEY)) {
      const w = window.innerWidth;
      if (w >= 600 && w <= 6000) localStorage.setItem(KEY, String(w));
    }
    let timer = null;
    const apply = () => {
      const base = parseFloat(localStorage.getItem(KEY));
      if (!base || base < 600) return;
      const scale = Math.max(0.7, Math.min(3, window.innerWidth / base));
      document.documentElement.style.zoom = scale.toFixed(3);
    };
    apply();
    window.addEventListener('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(apply, 150);
    });
  } catch {}
})();

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
// ①附件直传可用（全文总结不截断）②长上下文 ③抓取稳定 ④速度/风控。
// 附件能力标注源自 2026-09-01 CDP 对各家 webview 文件框的只读实测。
const SUM_MODEL_NOTES = {
  deepseek: '推荐：附件直传（docx/md）实测可用，抓取稳定，现役总结模型',
  doubao: '文件框实测接受 docx/md（附件直传）；总结流程未实测，失败自动回退文本模式',
  mimo: '附件直传实测可用（docx/doc/md）；百万级上下文、响应快',
  kimi: '网页支持传文档但文件框懒加载，附件直传未实测；失败自动回退文本模式',
  zhipu: '文件框以图片为主，附件直传未实测；失败自动回退文本模式',
  qwen: '无常驻文件框，附件直传未实测；失败自动回退文本模式',
  yuanbao: '无常驻文件框，附件直传未实测；失败自动回退文本模式',
  wenxin: '无常驻文件框，附件直传未实测；失败自动回退文本模式',
  minimax: '文件框未标注类型，附件直传未实测；失败自动回退文本模式',
};

const cfgSumModel = document.getElementById('cfg-sum-model');
const cfgModelsEl = document.getElementById('cfg-models');
// 填充总结模型下拉（设置弹窗与首启向导共用）
function fillSumModelSelect(sel) {
  for (const id of SUM_MODEL_ALLOWED) {
    const a = ADAPTERS.find((x) => x.id === id);
    if (!a) continue;
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.name;
    opt.title = SUM_MODEL_NOTES[a.id] || '';
    sel.appendChild(opt);
  }
}
fillSumModelSelect(cfgSumModel);

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
const cfgCloseExit = document.getElementById('cfg-close-exit');
const cfgCloseTray = document.getElementById('cfg-close-tray');

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
  cfgCloseExit.checked = getCloseMode() === 'exit';
  cfgCloseTray.checked = getCloseMode() === 'tray';
  const theme = getThemeSetting();
  cfgThemeAuto.checked = theme === 'auto';
  cfgThemeDark.checked = theme === 'dark';
  cfgThemeLight.checked = theme === 'light';
  cfgSumModel.value = getSummarizerSiteId(); // 总结模型回填
  modal.hidden = false;
}

document.getElementById('settings-btn').addEventListener('click', openSettings);
// 「已选 N/9」计数本身就是设置入口
subsetCountEl.title = '点击打开「设置」调整参与各家';
subsetCountEl.addEventListener('click', openSettings);
document.getElementById('settings-close').addEventListener('click', () => (modal.hidden = true));
document.getElementById('cfg-cancel').addEventListener('click', () => (modal.hidden = true));
// 首启向导重入口：关闭设置弹窗并打开向导（回填当前配置，按需只走某几步）
document.getElementById('cfg-guide').addEventListener('click', () => {
  modal.hidden = true;
  openWizard();
});
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
  // 关窗行为即时同步主进程（exit=关窗即退出；tray=创建托盘常驻）
  localStorage.setItem('rt_closeMode', cfgCloseTray.checked ? 'tray' : 'exit');
  applyCloseMode();
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
  // 网页总结且总结模型与勾选的回答模型重叠：弹窗提醒双账号价值，确认后才保存。
  // 只在重叠组合"发生变化"时提醒（换了总结模型，或该家新加入回答勾选）——
  // 已确认过的组合再保存（改主题/快捷键等无关项）不重复弹窗
  if (cfgModeWeb.checked && sumModelOverlaps()) {
    const prevSumId = getSummarizerSiteId();
    let prevSelected = [];
    try {
      const v = JSON.parse(localStorage.getItem('rt_selected') || '[]');
      if (Array.isArray(v)) prevSelected = v;
    } catch {}
    const overlapChanged =
      cfgSumModel.value !== prevSumId || !prevSelected.includes(cfgSumModel.value);
    if (overlapChanged) {
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
let currentHistoryItem = null; // 右侧详情当前展示的记录（导出按钮的作用对象）

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

// 点击左侧条目，在右侧详情区展示（列表保持可见，可连续翻看）。
// 布局与主界面总结面板同构：顶部工具条 + 左侧纵向章节目录 + 右侧内容独立滚动
function showHistoryDetail(it) {
  currentHistoryItem = it;
  let html = `
    <div class="hd-toolbar">
      <button class="mini hd-export" data-format="md" title="本条记录导出为 Markdown 文件">导出 MD</button>
      <button class="mini hd-export" data-format="pdf" title="本条记录导出为 PDF 文件">导出 PDF</button>
      <button class="mini hd-delete" title="删除本条记录（不可恢复）">删除</button>
    </div>
    <div class="hd-detail-main">
      <div class="hd-toc" hidden></div>
      <div class="hd-body">
        <div class="hd-q"></div><div class="history-meta">${fmtTs(it.ts)}</div>`;
  html += `<div class="hd-section">📋 总结</div><div class="hd-summary"></div>`;
  html += `<div class="hd-section">各家回复</div>`;
  for (const r of it.replies || []) {
    html += `<div class="hd-reply"><div class="hd-reply-name"></div><div class="hd-reply-text"></div></div>`;
  }
  html += `</div></div>`;
  historyDetail.innerHTML = html;
  historyDetail.querySelector('.hd-body').scrollTop = 0;
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
  for (const btn of historyDetail.querySelectorAll('.hd-export')) {
    btn.addEventListener('click', () => exportHistoryRecord(btn.dataset.format === 'pdf' ? 'pdf' : 'md', btn));
  }
  historyDetail.querySelector('.hd-delete').addEventListener('click', (e) => deleteHistoryRecord(e.currentTarget));
  buildHistoryToc();
}

// ================= 历史记录导出（MD / PDF，复用 export-summary 通道） =================
// 导出正文：总结全文（已含「各家意见」附录）优先；总结缺失/失败时兜底拼接各家回复
function buildHistoryBody(it) {
  if (it.summary) return it.summary;
  const parts = [];
  for (const r of it.replies || []) {
    if (!r.text) continue;
    parts.push(`【${r.name}】\n${r.state === 'done' ? '' : `（${r.state}）\n`}${r.text}`);
  }
  return parts.length ? `各家回复（原文）\n\n${parts.join('\n\n')}` : '（本条记录没有总结，也没有回复内容）';
}

// 完整 Markdown 文件内容：问题作标题 + 圆桌时间 + 正文
function buildHistoryMarkdown(it) {
  return (
    `# ${it.question || 'AI 圆桌记录'}\n\n` +
    `> 圆桌时间：${fmtTs(it.ts)}\n\n` +
    `${buildHistoryBody(it)}\n`
  );
}

async function exportHistoryRecord(format, btn) {
  const it = currentHistoryItem;
  if (!it) return;
  const d = new Date(it.ts);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const markdown = buildHistoryMarkdown(it);
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '导出中…';
  let r;
  try {
    r = await roundtable.exportSummary({
      format,
      defaultName: `圆桌记录-${stamp}`,
      markdown,
      html: buildExportHtml(it.question || 'AI 圆桌记录', buildHistoryBody(it), d, 'AI 圆桌记录'),
    });
  } catch (e) {
    r = { ok: false, error: String(e.message || e) };
  }
  btn.disabled = false;
  btn.textContent = r && r.ok ? '已导出 ✓' : r && !r.canceled ? '导出失败' : origText;
  setTimeout(() => (btn.textContent = origText), 1500);
}

// 删除当前记录：两步确认（先点变「确认删除？」，3 秒内再点执行），防误触。
// 删除后清掉详情区并刷新左侧列表（保持当前搜索词）
async function deleteHistoryRecord(btn) {
  const it = currentHistoryItem;
  if (!it) return;
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.classList.add('confirm');
    btn.textContent = '确认删除？';
    setTimeout(() => {
      if (!btn.isConnected) return; // 详情已重渲染（换了记录），旧按钮直接作废
      delete btn.dataset.armed;
      btn.classList.remove('confirm');
      btn.textContent = '删除';
    }, 3000);
    return;
  }
  const ok = await roundtable.deleteHistory(it.id).catch(() => false);
  if (ok) {
    currentHistoryItem = null;
    hdTocAnchors = [];
    historyDetail.innerHTML = '<div class="history-empty">记录已删除</div>';
    loadHistoryList();
  } else {
    btn.textContent = '删除失败';
    setTimeout(() => (btn.textContent = '删除'), 1500);
  }
}

// ================= 详情章节标签（纵向目录，与主界面总结面板同构） =================
// 五段固定标签 + 分隔线 + 「各家意见」可展开分组（各家带品牌色点），点击平滑跳转，
// 滚动时 scroll-spy 高亮当前章节。复用主界面 toc-chip/toc-group 全套样式。
// 解析口径与 buildSummaryToc 一致（按渲染后块级元素的文本识别，不依赖 CSS 类——
// 网页模式总结的「## 一、」渲染成无 lv1 类的 h2）。无总结的老记录退化为各家回复锚点。
let hdTocAnchors = [];

function updateHdTocSpy() {
  if (!hdTocAnchors.length) return;
  const body = historyDetail.querySelector('.hd-body');
  if (!body) return;
  const base = body.getBoundingClientRect().top;
  let cur = null;
  for (const a of hdTocAnchors) {
    if (a.el.getBoundingClientRect().top <= base + 30) cur = a;
    else break;
  }
  for (const a of hdTocAnchors) a.chip.classList.toggle('active', a === cur);
}

// scroll 事件不冒泡：用捕获阶段监听内层 .hd-body 的滚动（内容区每次渲染重建，
// 监听挂在不重建的 .history-detail 容器上）
let hdSpyTick = false;
historyDetail.addEventListener(
  'scroll',
  () => {
    if (hdSpyTick) return;
    hdSpyTick = true;
    requestAnimationFrame(() => {
      hdSpyTick = false;
      updateHdTocSpy();
    });
  },
  true
);

function buildHistoryToc() {
  hdTocAnchors = [];
  const toc = historyDetail.querySelector('.hd-toc');
  if (!toc) return;
  toc.innerHTML = '';
  toc.hidden = true;

  const mk = (label, el, brandId) => {
    const chip = document.createElement('button');
    chip.className = 'toc-chip';
    if (brandId) {
      const dot = document.createElement('span');
      dot.className = 'toc-dot';
      dot.style.background = BRAND_COLORS[brandId] || 'var(--accent)';
      chip.appendChild(dot);
    }
    chip.appendChild(document.createTextNode(label));
    chip.addEventListener('click', () => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    hdTocAnchors.push({ el, chip });
    return chip;
  };

  const sumEl = historyDetail.querySelector('.hd-summary');
  if (sumEl && sumEl.classList.contains('md')) {
    // 五段固定顺序 + 附录各家（每家只取第一次出现，回复正文里的【家名】字样不算）
    const sections = new Map();
    const families = [];
    let appendixEl = null;
    let inAppendix = false;
    const seen = new Set();
    for (const el of sumEl.children) {
      const t = (el.textContent || '').trim();
      if (/^附录/.test(t)) {
        inAppendix = true;
        if (!appendixEl) appendixEl = el;
        continue;
      }
      const sm = t.match(/^([一二三四五])、/);
      if (sm) {
        const label = TOC_SECTIONS['一二三四五'.indexOf(sm[1])];
        if (!sections.has(label)) sections.set(label, el);
        continue;
      }
      if (inAppendix) {
        const fm = t.match(/^【(.+?)】/);
        if (fm && !seen.has(fm[1])) {
          seen.add(fm[1]);
          families.push({ label: fm[1], el });
        }
      }
    }
    for (const label of TOC_SECTIONS) {
      const el = sections.get(label);
      if (el) toc.appendChild(mk(label, el));
    }
    if (families.length) {
      const sep = document.createElement('span');
      sep.className = 'toc-sep';
      toc.appendChild(sep);

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
      // 附录锚点也进 scroll-spy 序列：滚到附录时高亮分组标签
      if (appendixEl) hdTocAnchors.push({ el: appendixEl, chip: groupChip });

      for (const f of families) {
        const ad = ADAPTERS.find((a) => a.name === f.label);
        const chip = mk(f.label, f.el, ad && ad.id);
        chip.classList.add('toc-subchip');
        subBox.appendChild(chip);
      }
      groupWrap.appendChild(groupChip);
      groupWrap.appendChild(subBox);
      toc.appendChild(groupWrap);
    }
  } else {
    // 无总结的老记录：各家回复逐家纵向排列
    for (const nameEl of historyDetail.querySelectorAll('.hd-reply-name')) {
      const name = (nameEl.textContent || '').replace(/（.+?）\s*$/, '').trim();
      const ad = ADAPTERS.find((a) => a.name === name);
      toc.appendChild(mk(name, nameEl, ad && ad.id));
    }
  }
  if (!hdTocAnchors.length) return;
  toc.hidden = false;
  updateHdTocSpy();
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

// ================= I7：首次使用向导（欢迎 → 登录各家 → 总结方式 → 完成） =================
// 触发：从未关闭过向导 且 没有任何历史记录（老用户有历史，视为已上手不再打扰）。
// 任何方式关闭（完成/跳过/点遮罩）都记 rt_guide_done，不再自动弹出；
// 「设置」弹窗底部「新手引导」可随时重新打开（打开时回填当前配置）。
// 登录态检测与 scripts/selector-check.js 同口径（core.buildLoginProbeScript）：
// 只读探测、尽力判断，个别站点不准时点「去登录」人工确认，不卡流程。

let wizardRoot = null;
let wizardStep = 1;
let wizardProbeTimer = null;
const wizardLoginRows = new Map(); // adapter.id -> { stateEl, btn, entry, adapter, state }
let wizardSumRow = null; // 总结账号行：entry/adapter 动态取（跟随总结模型选择）

function wizardApplyRowState(row, st) {
  row.state = st;
  row.stateEl.textContent = st === 'ok' ? '✓ 已登录' : st === 'bad' ? '✗ 未登录' : '… 检测中';
  row.stateEl.className = 'wz-state ' + st;
  row.btn.textContent = st === 'ok' ? '查看' : '去登录';
}

// 单行探测：webview 未就绪（冷启动加载中）返回 unknown，不误报「未登录」
async function wizardProbeRow(row) {
  const adapter = row === wizardSumRow ? getSummarizerAdapter() : row.adapter;
  try {
    row.entry.webview.getWebContentsId();
  } catch {
    return 'unknown';
  }
  if (!row.entry.dot || !row.entry.dot.classList.contains('ready')) return 'unknown';
  try {
    const r = await execInPanel(row.entry.webview, buildLoginProbeScript(adapter));
    if (!r) return 'unknown';
    if (r.loginLike) return 'bad';
    return r.input ? 'ok' : 'bad';
  } catch {
    return 'unknown';
  }
}

// 循环探测：跳过已 ✓ 的行；已登录后关闭面板不会掉线，无需反复探测
async function wizardProbeAll() {
  if (!wizardRoot || wizardRoot.hidden) return;
  for (const row of wizardLoginRows.values()) {
    if (row.state === 'ok') continue;
    wizardApplyRowState(row, await wizardProbeRow(row));
  }
  if (wizardSumRow && wizardSumRow.state !== 'ok') {
    wizardApplyRowState(wizardSumRow, await wizardProbeRow(wizardSumRow));
  }
}

function wizardStartProbing() {
  wizardProbeAll();
  if (!wizardProbeTimer) wizardProbeTimer = setInterval(wizardProbeAll, 3000);
}

function wizardStopProbing() {
  if (wizardProbeTimer) {
    clearInterval(wizardProbeTimer);
    wizardProbeTimer = null;
  }
}

function wizardShowStep(n) {
  wizardStep = n;
  const names = ['欢迎', '登录各家', '总结方式', '完成'];
  for (const page of wizardRoot.querySelectorAll('.wizard-page')) {
    page.hidden = Number(page.dataset.step) !== n;
  }
  // 步骤计数：明确告知共几步、当前第几步、还剩几步
  wizardRoot.querySelector('.wizard-crumbs').textContent =
    `共 ${names.length} 步 · 当前第 ${n} 步 · 还剩 ${names.length - n} 步　·　${names[n - 1]}`;
  wizardRoot.querySelector('#wizard-back').hidden = n === 1;
  wizardRoot.querySelector('#wizard-next').textContent = n === 4 ? '开始使用' : '下一步';
}

// 步骤 3 → 4 时落地总结设置（与设置弹窗 doSaveSettings 同键位；不动参与各家/快捷键）
function applyWizardSettings() {
  const webMode = wizardRoot.querySelector('#wz-mode-web').checked;
  localStorage.setItem('rt_summaryMode', webMode ? 'web' : 'api');
  if (webMode) {
    const prev = getSummarizerSiteId();
    const val = wizardRoot.querySelector('#wz-sum-model').value;
    localStorage.setItem('rt_summarizer', val);
    if (val !== prev) rebuildSummarizerPanel(); // 分区独立，切回不丢登录态
  } else {
    localStorage.setItem('rt_baseURL', wizardRoot.querySelector('#wz-baseurl').value.trim());
    localStorage.setItem('rt_apiKey', wizardRoot.querySelector('#wz-apikey').value.trim());
    localStorage.setItem('rt_model', wizardRoot.querySelector('#wz-model').value.trim());
  }
}

function closeWizard() {
  wizardRoot.hidden = true;
  wizardStopProbing();
  try {
    localStorage.setItem('rt_guide_done', '1');
  } catch {}
}

function buildWizard() {
  wizardRoot = document.createElement('div');
  wizardRoot.className = 'modal-mask wizard-mask';
  wizardRoot.hidden = true;
  wizardRoot.innerHTML = `
    <div class="modal modal-wizard">
      <button class="modal-close" id="wizard-x" title="关闭，不再自动显示">✕</button>
      <div class="wizard-crumbs"></div>
      <div class="wizard-page" data-step="1">
        <h2>欢迎使用 AI 圆桌</h2>
        <p class="wz-lead">一个问题，同时发给 9 家 AI 网页版，收齐后自动生成五段结构总结（主要共识 / 次要共识 / 分歧观点 / 个性观点 / 综合意见）。首次使用只需两步：</p>
        <ol class="wz-preview">
          <li><b>登录各家</b>——复用各家网页版账号，无需任何 API Key，登录态长期保存</li>
          <li><b>选择总结方式</b>——默认「网页总结」用一个第二账号免费生成，也可改 API</li>
        </ol>
        <p class="wz-note">约 5 分钟；随时可跳过，之后在「设置」里也能继续配置。</p>
      </div>
      <div class="wizard-page" data-step="2">
        <h2>第一步：登录各家</h2>
        <p class="wz-lead">未登录的家点「去登录」，在全屏页面完成登录后关闭（Esc 或 ✕），这里的状态会自动刷新。</p>
        <div id="wz-login-list" class="wz-list"></div>
        <p class="wz-note">检测为尽力判断（探测各家输入框是否出现）；个别站点不准时，点「去登录」人工确认即可，不影响使用。完成向导后，回复行行头的家名就是常驻入口：单击即全屏打开该家网页（重新登录 / 查看）。</p>
      </div>
      <div class="wizard-page" data-step="3">
        <h2>第二步：总结方式</h2>
        <label class="cfg-check"><input type="radio" name="wz-sum-mode" id="wz-mode-web" checked> 网页总结（默认，免费，免 API Key）</label>
        <div id="wz-web-box" class="wz-subbox">
          <div class="wz-sum-line">
            <span>总结账号</span>
            <select id="wz-sum-model"></select>
            <span id="wz-sum-state" class="wz-state unknown">… 检测中</span>
            <button id="wz-sum-login" class="mini">去登录</button>
          </div>
          <p class="wz-note">总结用「第二个账号」，与回答互不污染。支持附件直传的模型（DeepSeek / MiMo / 豆包）可完整输入各家原文；不支持时自动回退文本模式（每家截断 2000 字）。</p>
        </div>
        <label class="cfg-check"><input type="radio" name="wz-sum-mode" id="wz-mode-api"> API 总结 · OpenAI 兼容接口</label>
        <div id="wz-api-box" class="wz-subbox" hidden>
          <label>Base URL <input id="wz-baseurl" type="text"></label>
          <label>API Key <input id="wz-apikey" type="password" placeholder="sk-..."></label>
          <label>模型名 <input id="wz-model" type="text"></label>
        </div>
        <p class="wz-note">配置仅保存在本机。API 默认指向智谱免费模型 glm-4.7-flash，填自己的 Key 即可。</p>
      </div>
      <div class="wizard-page" data-step="4">
        <h2>完成，开始使用</h2>
        <ul class="wz-tips">
          <li><b>提问</b>：顶部输入框写问题，<b>Ctrl+Enter</b> 发送到勾选的各家；发送后文本保留，点「＋」换新问题</li>
          <li><b>看回复</b>：每行一家，点 ▸ 展开全文；点行体或行首家名全屏打开该家网页（登录/查看）；失败行标红，行尾 ↻ 可单独重发该家</li>
          <li><b>总结</b>：默认全部交卷后自动生成；4 家交卷后也可点「总结」提前生成</li>
          <li><b>更多</b>：参与各家勾选、发送快捷键、界面主题在「设置」；每轮结果在「历史」可查</li>
        </ul>
      </div>
      <div class="wizard-footer">
        <button id="wizard-skip">跳过向导</button>
        <span class="wz-spacer"></span>
        <button id="wizard-back" hidden>上一步</button>
        <button id="wizard-next" class="primary">下一步</button>
      </div>
    </div>
  `;
  document.body.appendChild(wizardRoot);

  // 登录清单：9 家逐行（品牌点 + 名称 + 状态 + 去登录）
  const list = wizardRoot.querySelector('#wz-login-list');
  for (const adapter of ADAPTERS) {
    const rowEl = document.createElement('div');
    rowEl.className = 'wz-row';
    const dot = document.createElement('span');
    dot.className = 'cfg-dot';
    dot.style.background = BRAND_COLORS[adapter.id] || 'var(--accent)';
    attachBadgeLogo(dot, adapter.id);
    const name = document.createElement('span');
    name.className = 'wz-name';
    name.textContent = adapter.name;
    const stateEl = document.createElement('span');
    stateEl.className = 'wz-state unknown';
    stateEl.textContent = '… 检测中';
    const btn = document.createElement('button');
    btn.className = 'mini';
    btn.textContent = '去登录';
    btn.addEventListener('click', () => focusPanel(adapter.id));
    rowEl.append(dot, name, stateEl, btn);
    list.appendChild(rowEl);
    wizardLoginRows.set(adapter.id, {
      stateEl,
      btn,
      entry: panels.get(adapter.id),
      adapter,
      state: 'unknown',
    });
  }

  // 总结账号行：状态随探测刷新，按钮全屏打开总结面板（登录/查看）
  const sumStateEl = wizardRoot.querySelector('#wz-sum-state');
  const sumBtn = wizardRoot.querySelector('#wz-sum-login');
  sumBtn.addEventListener('click', () => focusPanel('summarizer'));
  wizardSumRow = { stateEl: sumStateEl, btn: sumBtn, entry: summarizerPanel, state: 'unknown' };

  fillSumModelSelect(wizardRoot.querySelector('#wz-sum-model'));

  // 总结方式切换显隐（与设置弹窗 syncSummaryModeUI 同逻辑）
  const modeWeb = wizardRoot.querySelector('#wz-mode-web');
  const modeApi = wizardRoot.querySelector('#wz-mode-api');
  const syncMode = () => {
    wizardRoot.querySelector('#wz-web-box').hidden = modeApi.checked;
    wizardRoot.querySelector('#wz-api-box').hidden = modeWeb.checked;
  };
  modeWeb.addEventListener('change', syncMode);
  modeApi.addEventListener('change', syncMode);

  wizardRoot.querySelector('#wizard-x').addEventListener('click', closeWizard);
  wizardRoot.querySelector('#wizard-skip').addEventListener('click', closeWizard);
  wizardRoot.querySelector('#wizard-back').addEventListener('click', () => {
    if (wizardStep > 1) wizardShowStep(wizardStep - 1);
  });
  wizardRoot.querySelector('#wizard-next').addEventListener('click', () => {
    if (wizardStep === 3) applyWizardSettings();
    if (wizardStep === 4) return closeWizard();
    wizardShowStep(wizardStep + 1);
  });
  wizardRoot.addEventListener('click', (e) => {
    if (e.target === wizardRoot) closeWizard();
  });
}

function openWizard() {
  if (!wizardRoot) buildWizard();
  // 每次打开回填当前配置 + 重置检测状态（账号可能已变化，重新检测一轮）
  const s = getSettings();
  wizardRoot.querySelector('#wz-mode-web').checked = s.summaryMode === 'web';
  wizardRoot.querySelector('#wz-mode-api').checked = s.summaryMode === 'api';
  wizardRoot.querySelector('#wz-web-box').hidden = s.summaryMode !== 'web';
  wizardRoot.querySelector('#wz-api-box').hidden = s.summaryMode === 'web';
  wizardRoot.querySelector('#wz-baseurl').value = s.baseURL;
  wizardRoot.querySelector('#wz-apikey').value = s.apiKey;
  wizardRoot.querySelector('#wz-model').value = s.model;
  wizardRoot.querySelector('#wz-sum-model').value = getSummarizerSiteId();
  for (const row of wizardLoginRows.values()) wizardApplyRowState(row, 'unknown');
  wizardApplyRowState(wizardSumRow, 'unknown');
  wizardRoot.hidden = false;
  wizardShowStep(1);
  wizardStartProbing();
}

// Esc 关向导：须用捕获阶段——panels.js 的冒泡 Esc 先注册，全屏面板打开时它先跑
// 并移除 dock 的 active，冒泡阶段再判就晚了（会把向导连同面板一起关掉）。
// 捕获阶段先看浮层状态：面板全屏打开时交给 panels.js（先关浮层），否则关向导。
document.addEventListener(
  'keydown',
  (e) => {
    if (
      e.key === 'Escape' &&
      wizardRoot &&
      !wizardRoot.hidden &&
      !dock.classList.contains('active')
    ) {
      closeWizard();
    }
  },
  true
);

(async function maybeShowWizard() {
  try {
    if (localStorage.getItem('rt_guide_done')) return;
    const items = await roundtable.getHistory('', 1).catch(() => []);
    if (items && items.length) {
      localStorage.setItem('rt_guide_done', '1'); // 老用户：自动视为已上手
      return;
    }
  } catch {}
  openWizard();
})();

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
  if (e.buttons === 0) endDividerDrag(); // mouseup 被系统对话框吞掉时防拖拽卡死
  const rect = outputCols.getBoundingClientRect();
  let pct = ((e.clientX - rect.left) / rect.width) * 100;
  pct = Math.max(20, Math.min(78, pct));
  dividerPct = pct;
  rowsEl.style.flex = `0 0 ${pct}%`;
});
function endDividerDrag() {
  dividerDragging = false;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  if (dividerPct) {
    try { localStorage.setItem('rt_divider_pct', String(dividerPct)); } catch {}
  }
}
document.addEventListener('mouseup', () => {
  if (dividerDragging) endDividerDrag();
});
// 失焦（系统对话框/切窗）时终止拖拽，防止分隔条自己跟着鼠标走
window.addEventListener('blur', () => {
  dividerDragging = false;
  hDividerDragging = false;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});

// ================= 输入区/输出区 横向拖拽分隔条（调整输入框高度） =================
// 拖动时回复行高度保持不变，只改变顶部输入框高度（输入框在上方，拖下即增高）
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
  if (e.buttons === 0) endHDividerDrag(); // mouseup 被吞时防卡死
  const h = Math.max(54, Math.min(180, promptStartH + (e.clientY - hDragStartY)));
  promptEl.style.height = `${h}px`;
  hDividerMoved = true;
});
function endHDividerDrag() {
  hDividerDragging = false;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  // 只有真的拖动过才保存，避免误点分隔条把当前高度固化
  if (!hDividerMoved) return;
  try {
    localStorage.setItem('rt_prompt_h', String(parseInt(promptEl.style.height, 10) || ''));
  } catch {}
}
document.addEventListener('mouseup', () => {
  if (hDividerDragging) endHDividerDrag();
});
