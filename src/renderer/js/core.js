/* global roundtable */
/**
 * 引擎核心（平台无关层）。
 *
 * 职责：与具体界面零耦合的圆桌自动化原语——
 *  - 注入脚本构建器（输入框准备/填值/发送点击/发送定位/填入校验/发送校验/回复抓取）
 *  - 回复清洗与判稳纯函数（cleanReply / normText / NOISE_LABELS）
 *  - 轻量 Markdown 渲染（renderMarkdown）
 *  - 错误分类（detectErrorCategory）
 *  - 执行通道与三段降级发送（execInPanel / sendToPanel / waitWebviewReady / sleep）
 *
 * 对宿主的全部依赖只有两个注入点：webview 句柄（参数传入）与 roundtable 桥
 * （Electron 下由 preload 提供；其他宿主提供同接口即可复用，如安卓端 CDP 桥）。
 * 本文件顶层不触碰 document/window，可在 Node 中直接 require（见文末导出），供单元测试。
 */

// V5：错误分类。风控关键词直判；再探一次页面是否停在登录/验证页（风控高发期
// 典型表现是被重定向/弹验证层，抓取端只看到"超时"）；最后才归超时/发送失败。
const RISK_KEYWORDS = ['登录', '登入', '验证', '风控', '扫码', '拦截', '封禁', '账号', '人机', '滑块'];
const TIMEOUT_KEYWORDS = ['未取到', '超时', 'timeout'];
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

// 登录态只读探测（与 scripts/selector-check.js 同口径）：输入框可见 = 已登录；
// URL/标题命中登录/验证特征 = 未登录。webview 尚未加载完时 input=false 且 href
// 仍指向 about:blank 等入口——调用方须把「未加载」与「未登录」区分开（首启向导
// 用 dot 未 ready 判未加载），避免冷启动把加载中的家误报成未登录。
function buildLoginProbeScript(adapter) {
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
    var href = String(location.href || '');
    var loginLike = /login|passport|verify|captcha|account\\./.test(href.toLowerCase()) ||
      /登录|登入|安全验证/.test(document.title || '');
    return { input: !!input, loginLike: loginLike, href: href };
  })()`;
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

// Node 侧引用（单元测试等）；渲染层按浏览器脚本加载时此分支无害
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    detectErrorCategory,
    buildPrepareScript,
    buildFillScript,
    buildClickSendScript,
    buildSendRectScript,
    buildVerifyFilledScript,
    buildVerifySentScript,
    buildScrapeScript,
    buildLoginProbeScript,
    normText,
    cleanReply,
    execInPanel,
    sleep,
    sendToPanel,
    waitWebviewReady,
    renderMarkdown,
  };
}
