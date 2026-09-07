/* global roundtable */
/**
 * 总结与导出层。
 * 职责：五段结构总结（网页总结者账号 / OpenAI 兼容 API 两路）、附件上传、
 * 目录导航（TOC/scroll-spy/附录锚点）、复制/导出（Markdown / PDF）。
 * 依赖：js/core.js（execInPanel/sleep/sendToPanel/清洗/renderMarkdown）、
 * js/panels.js（面板与视觉状态）、js/engine.js（roundScope/notify/currentQuestion）。
 */

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

// 当前总结模型的基础站名（如「DeepSeek」「豆包」）：提示与报错文案跟随所选模型，
// 不再写死 DeepSeek（总结模型已扩充到全部 9 家）
function summarizerBaseName() {
  const ad = ADAPTERS.find((a) => a.id === getSummarizerSiteId());
  return (ad && ad.name) || '总结模型';
}

// 复位总结面板到空态骨架（「＋ 新问题」配套）：清掉上一轮总结、目录与状态，
// lastSummary 一并清空——复制/导出按钮随之失效，避免复制到已不可见的内容
function resetSummaryPanel() {
  lastSummary = '';
  summaryAnchors.clear();
  tocAnchors = [];
  summaryStatus.textContent = '';
  summaryStatus.className = 'card-state';
  summaryToc.innerHTML = '';
  for (const label of TOC_SECTIONS) {
    const chip = document.createElement('span');
    chip.className = 'toc-chip toc-static';
    chip.textContent = label;
    summaryToc.appendChild(chip);
  }
  const sep = document.createElement('span');
  sep.className = 'toc-sep';
  summaryToc.appendChild(sep);
  const groupChip = document.createElement('span');
  groupChip.className = 'toc-chip toc-static';
  groupChip.textContent = '各家意见';
  summaryToc.appendChild(groupChip);
  summaryToc.hidden = false;
  summaryBody.className = 'summary-body placeholder';
  const readingCol = document.createElement('div');
  readingCol.className = 'reading-col';
  const outline = document.createElement('div');
  outline.className = 'skel-outline';
  for (const line of [...TOC_SECTIONS.map((t, i) => `${'一二三四五'[i]}、${t}`), '附录：各家意见']) {
    const el = document.createElement('div');
    el.className = 'skel-line' + (line.startsWith('附录') ? ' dim' : '');
    el.textContent = line;
    outline.appendChild(el);
  }
  readingCol.appendChild(outline);
  summaryBody.replaceChildren(readingCol);
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
      : `正在 ${summarizerBaseName()} 网页（第二账号）生成总结…`;
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

// 通用附件按钮候选：与 SUMMARIZER.uploadSelectors 同口径。总结模型已扩充到全部
// 9 家，多数适配器没有专属 uploadSelectors——没有时用这份通用候选兜底
// （点开懒加载的附件按钮让 input[type=file] 进 DOM，再 CDP 直塞）
const GENERIC_UPLOAD_SELECTORS = [
  '[class*="attach" i]',
  '[aria-label*="附件" i]',
  '[aria-label*="upload" i]',
  '[data-testid*="attach" i]',
  '[class*="upload" i]',
  '[class*="clip" i]',
];

// 把附件文件上传进总结者页面：优先直接找 input[type=file]（CDP 直塞文件）；
// 找不到时按 uploadSelectors 逐个点击附件按钮候选，等它进 DOM 再试。成功返回 true。
// ad 由调用方传入（总结者适配器随设置切换，不是全局量——此前直接引用 summarizeViaWeb
// 的局部 sumAd，回退路径一跑就 ReferenceError，整个总结失败而非降级为文本模式）
async function tryUploadFile(sp, ad, filePath) {
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
  for (const sel of (ad && ad.uploadSelectors) || GENERIC_UPLOAD_SELECTORS) {
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
  // 总结期间关闭总结者面板节流（窗口可能已隐藏到托盘，防流式生成停摆）
  try {
    roundtable.setThrottling(sp.webview.getWebContentsId(), false);
  } catch {}
  // 不再自动全屏展开总结页：保持主界面不动（2026-09-07 用户反馈），抓取走 CDP
  // 与页面可见性无关。需要查看/登录总结账号时，点总结面板标题「📋 总结」或「账号」按钮手动展开。

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
    uploaded = await tryUploadFile(sp, sumAd, file.path);
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
    try { roundtable.setThrottling(sp.webview.getWebContentsId(), true); } catch {}
    setStatus(sp.statusEl, '发送失败');
    throw new Error(
      `${summarizerBaseName()} 总结发送失败：${(res && res.error) || '未知'}。若尚未登录，请在全屏页面手动登录总结专用账号后再点「总结」`
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
      try { roundtable.setThrottling(sp.webview.getWebContentsId(), true); } catch {}
      return lastText;
    }
  }
  setStatus(sp.statusEl, '等待超时');
  try { roundtable.setThrottling(sp.webview.getWebContentsId(), true); } catch {}
  throw new Error(`${summarizerBaseName()} 网页总结等待超时（300 秒），请再点「总结」重试，或在设置中改用 API 总结`);
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
// 但用打印向的浅色独立排版（与界面主题无关）；printToPDF 按此渲染 A4。
// metaLabel：页眉标签（总结面板导出为「AI 圆桌总结」，历史记录导出传「AI 圆桌记录」）
function buildExportHtml(question, summaryMd, d, metaLabel) {
  const label = metaLabel || 'AI 圆桌总结';
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
<p class="meta">${label} · 生成时间：${d.toLocaleString('zh-CN', { hour12: false })}</p>
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
