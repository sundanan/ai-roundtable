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
};

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

  // 第二层按钮：品牌徽章 + 名称。单击=切换是否参与本轮；双击=全屏打开该网页。
  // 双击不用原生 dblclick（对慢双击不敏感），手动判定：400ms 内第二次点击算双击；
  // 单击延时 400ms 生效，双击则取消这次切换、直接全屏打开
  const barBtn = document.createElement('div');
  barBtn.className = 'model-btn checked';
  barBtn.innerHTML =
    `<span class="model-badge" data-id="${adapter.id}">${adapter.name[0]}</span>` +
    `<span class="model-name" data-id="${adapter.id}">${adapter.name}</span>` +
    `<span class="model-status"></span>`;
  barBtn.querySelector('.model-badge').style.background =
    BRAND_COLORS[adapter.id] || 'var(--accent)';
  let clickTimer = null;
  barBtn.addEventListener('click', () => {
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
      focusPanel(adapter.id);
      return;
    }
    clickTimer = setTimeout(() => {
      clickTimer = null;
      barBtn.classList.toggle('checked');
      barBtn.classList.toggle('unchecked', !barBtn.classList.contains('checked'));
      updateSubsetCount();
    }, 400);
  });
  modelGrid.appendChild(barBtn);

  // 第三层回复行（点击不展开，跳转总结版块对应该家的附录锚点）
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `
    <div class="row-head">
      <span class="row-name">${adapter.name}</span>
      <span class="row-state">待发送</span>
      <button class="mini row-resend" title="仅重发该家（不影响其他家）">↻</button>
      <span class="row-caret">›</span>
    </div>
    <div class="row-body placeholder">尚未发送</div>
  `;
  row.addEventListener('click', () => jumpToSummaryFamily(adapter.name));
  // 单家补发：只重发该家，阻止冒泡避免触发行点击跳转
  row.querySelector('.row-resend').addEventListener('click', (e) => {
    e.stopPropagation();
    resendPanel(adapter.id);
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
    rowBodyEl: row.querySelector('.row-body'),
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
  // 网页状态用按钮右上角小圆点表达（绿=就绪/橙=加载/红=失败），边框只表达选中态
  p.statusDot.className = 'model-status' + (state ? ` ${state}` : '');
  const label = DOT_LABELS[state] || state || '';
  p.statusDot.title = `${p.adapter.name}：${label || '未加载'}`;
  p.barBtn.title =
    `${p.adapter.name}${label ? `：${label}` : ''} · 单击切换选中，双击全屏打开`;
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
  });
  return `(function () {
    var cfg = ${cfg};
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

let currentQuestion = ''; // 本轮问题原文，抓取时用于排除"把问题当答案"
let activeRoundIds = null; // 本轮参与面板 id 集合；null=全部（改进2 可选子集）
let desktopRoundSaved = false; // 改进1：桌面端本轮是否已落库（防重复总结时重复落库）
let roundSettleHandled = false; // 本轮"全部到终态"收尾是否已做（完成通知/自动总结只触发一次）

// 单家发送任务：抓基线 → 发送（失败重试一次 → 标记的家刷新重发）→ 更新状态。
// 广播与单家补发共用。
async function runSendTask(p, text) {
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
      setStatus(p.statusEl, '已发送');
    } else {
      p.state = 'error';
      setStatus(p.statusEl, (res && res.error) || '注入失败');
      setCardState(p, '发送失败', 'err');
      p.rowBodyEl.className = 'row-body error';
      p.rowBodyEl.textContent =
        ((res && res.error) || '注入失败') + '。可点行尾 ↻ 仅重发该家，或全屏手动发送。';
    }
  } catch (e) {
    p.state = 'error';
    const msg = String(e.message || e).slice(0, 60);
    setStatus(p.statusEl, `失败：${msg}`);
    setCardState(p, '发送失败', 'err');
    p.rowBodyEl.className = 'row-body error';
    p.rowBodyEl.textContent = `${msg}。可点行尾 ↻ 仅重发该家，或全屏手动发送。`;
  }
  updateProgress();
}

async function broadcast(text, siteIds) {
  sendBtn.disabled = true;
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
  sendBtn.disabled = false;
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
        p.genStart = Date.now();
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
        p.genStart = Date.now();
        setStatus(p.statusEl, '生成中…');
        setCardState(p, '生成中…', 'warn');
      }
      // 已进入生成中后，状态文字交给 1s 计时器维护（生成中… Ns），这里不再覆盖
      p.rowBodyEl.className = 'row-body';
      p.rowBodyEl.textContent = text;
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
      setCardState(p, '已完成 ✓（点击跳转总结原文）', 'ok');
      // 完成态做 Markdown 渲染（表格/列表等），流式中途仍按纯文本显示
      p.rowBodyEl.className = 'row-body md';
      p.rowBodyEl.innerHTML = renderMarkdown(text);
    }
    updateProgress();
  });
  await Promise.allSettled(tasks);
}

// 生成等待计时（问题3）：让"慢"可见——生成中每秒刷新已等待秒数；
// 超过 90s 变红并提示可双击上方按钮全屏查看，避免用户误判卡死
setInterval(() => {
  for (const p of panels.values()) {
    if (p.state !== 'generating' || !p.genStart) continue;
    const s = Math.floor((Date.now() - p.genStart) / 1000);
    if (s >= 90) {
      setCardState(p, `仍在生成（已 ${s}s），可双击上方按钮全屏查看`, 'err');
    } else {
      setCardState(p, `生成中… ${s}s`, 'warn');
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
  return localStorage.getItem('rt_autoSummary') === '1';
}

// 本轮全部到终态后的收尾（每轮只触发一次）：完成通知 + 可选自动总结。
// 服务轮次（飞书/HTTP）本身固定会总结，不在这里重复触发
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

// 左侧家名行点击：不展开，跳转总结版块对应附录锚点并短暂高亮目录标签；
// 尚无总结时在行状态上给出提示，避免"点了没反应"的错觉
function jumpToSummaryFamily(name) {
  const a = summaryAnchors.get(name);
  if (!a) {
    const p = [...panels.values()].find((x) => x.adapter.name === name);
    if (!p) return;
    const prevText = p.rowStateEl.textContent;
    const prevCls = p.rowStateEl.className;
    setCardState(p, '尚未生成总结，先点右上角「总结」', 'warn');
    setTimeout(() => {
      p.rowStateEl.textContent = prevText;
      p.rowStateEl.className = prevCls;
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
  const sections = [];
  const families = [];
  const seen = new Set(); // 每家只取第一次出现（回复正文里也可能有【家名】字样）
  let inAppendix = false;
  for (const el of summaryBody.children) {
    const t = (el.textContent || '').trim();
    if (/^附录/.test(t)) { inAppendix = true; continue; }
    const sm = t.match(/^([一二三四五])、/);
    if (sm) {
      const label = TOC_SECTIONS['一二三四五'.indexOf(sm[1])];
      // 每个部分只取第一次出现：LLM 偶尔在正文里重复段标题（曾出现两个"次要共识"）
      if (!sections.some((s) => s.label === label)) sections.push({ label, el });
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
  if (!sections.length && !families.length) return;
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
    chip.addEventListener('click', () =>
      el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    return chip;
  };
  for (const s of sections) {
    const chip = mkChip(s.label, s.el);
    tocAnchors.push({ el: s.el, chip });
    summaryToc.appendChild(chip);
  }
  if (sections.length && families.length) {
    const sep = document.createElement('span');
    sep.className = 'toc-sep';
    summaryToc.appendChild(sep);
  }
  for (const f of families) {
    const ad = ADAPTERS.find((a) => a.name === f.label);
    const chip = mkChip(f.label, f.el, ad && ad.id);
    summaryAnchors.set(f.label, { el: f.el, chip });
    tocAnchors.push({ el: f.el, chip });
    summaryToc.appendChild(chip);
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
let summarizeBusy = false; // 自动/手动触发共用的防重入锁
async function doSummarize() {
  if (summarizeBusy) throw new Error('总结正在进行中');
  const settings = getSettings();
  if (!settings.baseURL || !settings.apiKey || !settings.model) {
    throw new Error('总结 LLM 未配置（baseURL/apiKey/model）');
  }
  // 只纳入本轮范围内已完成的回复，失败/未完成的跳过（上一轮别家遗留不混入）
  const usable = roundScope().filter((p) => p.state === 'done' && p.reply);
  if (usable.length === 0) throw new Error('没有已完成的回复可供总结');
  const skipped = roundScope()
    .filter((p) => p.state !== 'done')
    .map((p) => p.adapter.name);

  summarizeBusy = true;

  summarizeBtn.disabled = true;
  summaryBody.className = 'summary-body placeholder';
  summaryBody.textContent = `正在调用 ${settings.model} 总结…`;
  summaryStatus.textContent = '总结中…';
  summaryStatus.className = 'card-state warn';
  summaryToc.hidden = true; // 新一轮总结生成前隐藏旧目录
  summaryToc.innerHTML = '';
  summaryAnchors.clear();

  const blocks = usable.map((p) => `【${p.adapter.name}】\n${p.reply}`).join('\n\n');
  const messages = [
    {
      role: 'system',
      content:
        '你是一位中立的圆桌主持人。下面是同一个问题下多家 AI 的回答。' +
        '请输出一份结构化总结，严格按以下五个部分组织：' +
        '一、主要共识：归纳超过半数的参与家数一致的观点（8 家全参与时即 5 家及以上）；' +
        '二、次要共识：2 家到 4 家一致的观点；' +
        '三、分歧观点：任意两家及以上不一致的观点，说明各方立场与各自理由；' +
        '四、个性观点：仅一家提出的独特观点；' +
        '五、综合意见：综合各家意见，给出一个「最大公约数」的回答版本。' +
        '每条观点后用括号注明持该观点的家名，如（千问、豆包、Kimi）；' +
        '某部分没有内容时写「无」。' +
        '排版要求（必须严格遵守）：输出纯文本，严禁使用任何 Markdown 符号，' +
        '包括 #、*、-、>、` 等；不要用星号表示加粗或列表。' +
        '结构层次用中文序号体现：一级标题（五个部分）用「一、二、三、四、五、」，' +
        '二级标题（部分内的各小节）必须用「（一）（二）（三）」；' +
        '小节内的具体条目用「1. 2. 3.」，再细分用「（1）（2）」。' +
        '注意：二级标题一律用带括号的中文数字，不要用「1.」充当小节标题；' +
        '标题和条目各自独占一行，部分之间空一行，直接以标题开头，不要任何开场白。' +
        '不要输出附录或各家原文，附录由程序自动拼接。',
    },
    {
      role: 'user',
      content: `共 ${usable.length} 家回答${skipped.length ? `（${skipped.join('、')} 未纳入）` : ''}：\n\n${blocks}`,
    },
  ];

  try {
    const raw = await roundtable.callLLM({ ...settings, messages });
    // 附录由程序拼接（保证各家原文逐字完整，不靠 LLM 复述）
    let appendix = '\n\n附录：各家意见（原文）';
    for (const p of usable) appendix += `\n\n【${p.adapter.name}】\n${p.reply}`;
    if (skipped.length) appendix += `\n\n（${skipped.join('、')} 本轮未纳入总结）`;
    const content = raw.trim() + appendix;
    lastSummary = content;
    summaryBody.className = 'summary-body md';
    summaryBody.innerHTML = renderMarkdown(content);
    buildSummaryToc();
    summaryStatus.textContent = `生成时间 ${new Date().toLocaleTimeString()}`;
    summaryStatus.className = 'card-state ok';
    notify('AI 圆桌', '总结已生成');
    return content;
  } catch (e) {
    summaryBody.className = 'summary-body error';
    summaryBody.textContent = `总结调用失败：${e.message || e}`;
    summaryStatus.textContent = '总结失败';
    summaryStatus.className = 'card-state err';
    throw e;
  } finally {
    summarizeBusy = false;
    summarizeBtn.disabled = false;
  }
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
  if (!settings.baseURL || !settings.apiKey || !settings.model) {
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

// 总结导出 Markdown：带问题与时间抬头，经主进程保存对话框写盘
document.getElementById('summary-save').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (!lastSummary) return;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name =
    `圆桌总结-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}.md`;
  const doc =
    `# ${currentQuestion || 'AI 圆桌总结'}\n\n` +
    `> 生成时间：${d.toLocaleString('zh-CN', { hour12: false })}\n\n` +
    `${lastSummary}\n`;
  const r = await roundtable.saveMarkdown(name, doc);
  btn.textContent = r && r.ok ? '已保存 ✓' : '已取消';
  setTimeout(() => (btn.textContent = '存为 MD'), 1500);
});

document.getElementById('summary-top').addEventListener('click', () => {
  summaryBody.scrollTop = 0;
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

// ================= 设置弹窗 =================
const modal = document.getElementById('settings-modal');
const cfgBaseURL = document.getElementById('cfg-baseurl');
const cfgApiKey = document.getElementById('cfg-apikey');
const cfgModel = document.getElementById('cfg-model');
const cfgAutoSummary = document.getElementById('cfg-autosummary');

function openSettings() {
  const s = getSettings();
  cfgBaseURL.value = s.baseURL;
  cfgApiKey.value = s.apiKey;
  cfgModel.value = s.model;
  cfgAutoSummary.checked = getAutoSummary();
  modal.hidden = false;
}

document.getElementById('settings-btn').addEventListener('click', openSettings);
document.getElementById('settings-close').addEventListener('click', () => (modal.hidden = true));
document.getElementById('cfg-cancel').addEventListener('click', () => (modal.hidden = true));
document.getElementById('cfg-save').addEventListener('click', () => {
  localStorage.setItem('rt_baseURL', cfgBaseURL.value.trim());
  localStorage.setItem('rt_apiKey', cfgApiKey.value.trim());
  localStorage.setItem('rt_model', cfgModel.value.trim());
  localStorage.setItem('rt_autoSummary', cfgAutoSummary.checked ? '1' : '0');
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
