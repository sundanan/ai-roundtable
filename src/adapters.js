/**
 * 8 家 AI 网页版适配器配置。
 *
 * 每家包含：
 *  - id / name：面板标识
 *  - url：入口地址
 *  - inputSelectors / sendSelectors：注入发送时按顺序尝试的 CSS 选择器，
 *    都找不到时回退到通用的「可见 textarea / contenteditable」探测。
 *  - responseSelectors：抓取最后一条 AI 回复时按顺序尝试的选择器。
 *  - resetBeforeSend（可选，默认 true）：每轮发送前先回 url 开新会话，
 *    避免上一轮问答留在模型上下文里；某站入口页会恢复旧会话时可设 false 退出。
 *
 * 各家网页改版后只需更新这里的对应条目，无需改其他代码。
 * 选择器均为尽力维护的猜测值，失效时请按 README 的方法更新。
 */
const ADAPTERS = [
  {
    id: 'qwen',
    name: '千问',
    // tongyi.com 已改版重定向到 qianwen.com（2026-08-24 CDP 实测）
    url: 'https://www.tongyi.com/',
    attach: { entry: ['[aria-label*="附件"]'], menuText: '上传文档', input: 'afterEntry' }, // 附件：+号→菜单「上传文档」
    inputSelectors: [
      '[data-slate-editor]',
      'textarea[placeholder*="输入"]',
      '[contenteditable="true"]',
    ],
    sendSelectors: [
      'button[aria-label="发送消息"]',
      'button[class*="send"]',
    ],
    // 2026-08-24 改版实测：答案渲染在 div.qk-markdown（qk-md-paragraph > span.qk-md-text），
    // 外层容器 .answer-common-card / .markdown-pc-special-class；问题气泡是
    // .question-text-card（类名含 question，会被 USER_BOX 启发式排除，专属选择器在前更稳）
    responseSelectors: [
      '.qk-markdown',
      '[class*="answer-common-card"]',
      '[class*="markdown"]',
      '[class*="answerContent"]',
      '[class*="message-content"]',
    ],
  },
  {
    id: 'doubao',
    name: '豆包',
    url: 'https://www.doubao.com/chat/',
    attach: { input: 'resident' }, // 附件：常驻文件框直塞（2026-09 E2E 实测）
    // 2026-08 改版：输入框 data-testid 移除（改 .semi-input-textarea），
    // 发送按钮类名不含 send（svg 带 send-msg-btn）；回复容器仍是 md-box-root
    inputSelectors: [
      'textarea.semi-input-textarea',
      'textarea[data-testid="chat_input_input"]',
      'textarea[placeholder*="发消息"]',
      '[contenteditable="true"]',
    ],
    sendSelectors: [
      'button:has([class*="send-msg-btn"])',
      '[class*="send-msg-btn"]',
      'button[data-testid="chat_input_send_button"]',
      'button[class*="send"]',
    ],
    responseSelectors: [
      '[class*="md-box-root"]',
      '[data-container-type="block-v2"]',
      '[data-streaming="false"]',
      '[class*="inner-item-"]',
      '[data-testid="message_text_content"]',
      '[class*="markdown"]',
    ],
  },
  {
    id: 'yuanbao',
    name: '元宝',
    url: 'https://yuanbao.tencent.com/chat',
    attach: { entry: ['svg[class*="extra"]'], menuText: '本地文件', input: 'afterEntry' }, // 附件：左下角+号→菜单「本地文件」
    inputSelectors: [
      '.ql-editor[contenteditable="true"]',
      '[contenteditable="true"]',
      'textarea',
    ],
    // 2026-08-27 校准（selector-check 抓到专属失效）：发送键是 div.SendButton_sendButton__*
    // （CSS Modules 稳定前缀，空输入时并列 disabled 态类），aria-label="发送"——
    // 旧 a[class*=send-btn]/button[class*=send] 全部失配，此前一直靠通用兜底 [aria-label*=发送] 命中
    sendSelectors: [
      '[aria-label="发送"]',
      '[class*="SendButton_sendButton"]',
      'a[class*="send-btn"]',
      'button[class*="send"]',
      '[class*="send__button"]',
    ],
    responseSelectors: [
      '[class*="markdown"]',
      '[class*="hyc-content"]',
    ],
  },
  {
    id: 'zhipu',
    name: '智谱',
    url: 'https://chatglm.cn/main/alltoolsdetail?lang=zh',
    attach: { input: 'resident' }, // 附件：3 个文件框，取无 accept 的那个直塞（chip 实测）
    // watchStop：深度思考阶段文本可能停顿，靠"停止生成"按钮可见性保持等待，
    // 避免把思考前奏当完整答案（2026-08 曾误判）
    watchStop: true,
    inputSelectors: [
      'textarea[placeholder]',
      '[contenteditable="true"]',
      'textarea',
    ],
    // 2026-08-27 实测：发送键是 div.enter.is-main-chat > .enter-icon-container（纸飞机
    // img.enter_icon），类名不含 send；不同页面状态下对回车的响应时灵时不灵（同一会话
    // 有时"内容仍在输入框"判发送失败），故显式配上发送键选择器走可信鼠标点击主路径
    sendSelectors: [
      '.enter.is-main-chat .enter-icon-container',
      '.enter.is-main-chat',
      '.enter-icon-container',
      'button[class*="send"]',
      '[class*="send" i]',
    ],
    // 2026-08：长答案被拆成多个 .markdown-body 块，且会自动生成脑图（svg 内节点标签）。
    // 只取"最后一块"会丢掉前面所有章节（曾只抓到 307 字的末节）；
    // 改抓整条答案容器 .answer-content-wrap，并剪掉脑图 svg 噪声。
    responseSelectors: [
      '.answer-content-wrap',
      '[class*="markdown"]',
      '[class*="prose"]',
      '[class*="message-content"]',
    ],
    pruneSelectors: ['svg'],
  },
  {
    id: 'kimi',
    name: 'Kimi',
    url: 'https://www.kimi.com/',
    attach: { entry: ['.toolkit-trigger-btn'], input: 'afterEntry' }, // 附件：工具箱按钮唤出文件框（可信点击）
    // watchStop + staleMax 放宽：Kimi 常自动进联网研究，数分钟内页面无新回复文本，
    // 默认 8 轮陈旧检测会误杀（2026-08 曾把已答完的研究判成失败）
    watchStop: true,
    staleMax: 40,
    // reloadOnSendFail：Kimi 会话偶发损坏——内容已填进输入框但提交报错，
    // 手动刷新+重贴可恢复；发送失败时自动刷新页面重发一次（2026-08 超时根因）
    reloadOnSendFail: true,
    // 思考/工具调用块不是答案：抓取时整体排除（2026-08 曾把思考前奏当回复）
    pruneSelectors: ['.thinking-container', '[class*="toolcall-container"]'],
    inputSelectors: [
      '[data-lexical-editor="true"]',
      '.chat-input-editor [contenteditable="true"]',
      '[contenteditable="true"]',
    ],
    sendSelectors: [
      '.send-button-container',
      '[class*="send-button"]',
      '[data-testid="chat-input-send-button"]',
      'button[class*="send"]',
    ],
    responseSelectors: [
      '.markdown-container',
      '[class*="markdown"]',
      '[class*="segment-content"]',
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    url: 'https://chat.deepseek.com/',
    attach: { input: 'resident' }, // 附件：常驻隐藏文件框直塞（快速模式；深思考发送环节未验证）
    // 2026-08-17 实测：输入框无 id（#chat-input 失效），class 含稳定的 ds-scroll-area，
    // placeholder 为「给 DeepSeek 发送消息」；页面常驻隐藏 input[type=file]（accept 含 docx/md），
    // 附件可经 CDP DOM.setFileInputFiles 直塞，无需点击
    // 排除思考块：DeepSeek 深度思考内容容器真实类名为 ds-think-content
    // （2026-08-18 CDP 实测；[class*=thought]/[class*=thinking] 均不匹配）
    pruneSelectors: ['.ds-think-content'],
    inputSelectors: [
      'textarea.ds-scroll-area',
      'textarea[placeholder*="DeepSeek"]',
      'textarea#chat-input',
      'textarea',
    ],
    // 2026-08-18 改版后按钮类名不再含 send：发送键是主色实心圆形按钮
    // （ds-button--primary ds-button--filled），实测页面唯一
    sendSelectors: [
      'div[role="button"].ds-button--primary.ds-button--filled',
      'div[role="button"][class*="send"]',
      'button[class*="send"]',
    ],
    responseSelectors: [
      '[class*="markdown"]',
      '.ds-markdown',
      '[class*="message"] [class*="content"]',
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    url: 'https://agent.minimaxi.com/',
    attach: { input: 'resident' }, // 附件：2 个无类型文件框直塞（chip 实测）
    // watchStop：联网搜索阶段回复区长期停留在"我先搜一下"前奏文本，
    // 靠停止按钮可见性保持等待，避免前奏被当答案（2026-08 曾误判）
    watchStop: true,
    inputSelectors: [
      'textarea[placeholder]',
      '[contenteditable="true"]',
      'textarea',
    ],
    // 2026-08-27 改版实测：整体是 TipTap 富文本编辑器；发送键不是 <button>，
    // 而是 div[data-testid="send-button"][aria-label="发送消息"]（bg_interaction_primary_*），
    // 类名全是 Tailwind 原子类不含 send——旧 button[class*=send] 与全部通用兜底均不命中，
    // 只剩可信回车兜底而本站不认回车，导致“填进去了但永远发不出去”。
    sendSelectors: [
      '[data-testid="send-button"]',
      '[aria-label="发送消息"]',
      'button[class*="send"]',
      'button[class*="sendBtn"]',
    ],
    responseSelectors: [
      '[data-testid="assistant-segment-active"]',
      '[data-testid*="assistant"]',
      '[class*="matrix-markdown"]',
      '[class*="message-content"]',
      '[class*="markdown"]',
    ],
  },
  {
    id: 'wenxin',
    name: '文心',
    url: 'https://wenxin.baidu.com/',
    attach: { entry: ['[class*="ci-"] svg'], entryMinX: 600, menuText: '上传本地文件', input: 'chooser' }, // 附件：回形针→菜单，chooser backendNodeId 直塞
    // staleMax 放宽：文心回复明显偏慢，连续两轮被默认 8 轮（约 24s）陈旧检测
    // 误判"未取到本轮回复"，实际稍后即交卷（2026-08 实测）
    staleMax: 20,
    inputSelectors: [
      'textarea[class*="input"]',
      'textarea',
      '[contenteditable="true"]',
    ],
    sendSelectors: [
      'button[class*="send"]',
      '[class*="send" i]',
      '[class*="submit" i]',
    ],
    responseSelectors: [
      '[class*="markdown"]',
      '[class*="answer" i]',
      '[class*="result" i]',
      '[class*="message-content"]',
    ],
  },
  {
    id: 'mimo',
    name: 'MiMo',
    url: 'https://aistudio.xiaomimimo.com/#/c',
    attach: { input: 'resident' }, // 附件：常驻文件框直塞
    // 小米 MiMo（Xiaomi MiMo Studio）。2026-08-23 登录后实测校准：
    // - 需小米账号登录才能聊天，未登录点发送会跳 account.xiaomi.com 登录页（登录态在
    //   persist:mimo 分区长期保存）；
    // - 输入框是无 id 的 textarea（Tailwind 类名无稳定标识），placeholder 随登录态变化；
    // - 发送键无 aria/testid/类名标识，靠结构定位：输入区容器内最后一个按钮（纸飞机），
    //   :has() 绑定 textarea 结构，不会误配侧栏/公告等按钮；
    // - 回复渲染在 CSS Modules 容器 Markdown_markdown__*（含稳定前缀）；
    // - strictResponse：首页示例问题按钮类名含 message，通用兜底 [class*="message"]
    //   会在发送阶段误抓示例文本（2026-08-23 实测三轮均误判完成），故只用专属选择器；
    // - 剪掉思考折叠条 Collapsible_*（"已深度思考"标签及展开的推理文本不算答案）。
    strictResponse: true,
    inputSelectors: [
      'textarea[placeholder]',
      'textarea',
    ],
    // 2026-09-07 站点更新：加号/工具键排在发送键之前（同容器结构）——
    // sendPickLast 取最后一个启用的匹配（纸飞机发送键在最右），避免点到加号弹文件框
    sendPickLast: true,
    sendSelectors: [
      'div:has(> div > textarea) button[type="button"]',
      'div:has(> div > textarea) button:last-child',
      'button[class*="send" i]',
      'button[class*="submit" i]',
    ],
    responseSelectors: [
      '[class*="Markdown_markdown__"]',
    ],
    pruneSelectors: ['[class*="Collapsible_" i]'],
  },
];

/**
 * 总结者：DeepSeek 网页版「第二账号」，专职生成圆桌总结。
 * 使用独立分区（persist:deepseek-sum），与参与广播的 deepseek 面板会话完全隔离，
 * 总结不会污染回答流程；选择器与上方 deepseek 条目保持同步维护。
 */
const SUMMARIZER = {
  id: 'deepseek-sum',
  name: 'DeepSeek·总结',
  url: 'https://chat.deepseek.com/',
  // 长总结生成慢：靠"停止生成"按钮可见性保持等待，避免提前判完成
  watchStop: true,
  // 排除思考/推理块：ds-think-content 为 DeepSeek 真实类名（2026-08-18 CDP 实测），
  // 其余为历史猜测值，不存在时不剪枝，无害
  pruneSelectors: ['.ds-think-content', '[class*="thought"]', '[class*="thinking"]'],
  // 附件上传按钮候选（备用）：2026-08-17 实测页面常驻隐藏 input[type=file]（accept 含 docx/md），
  // 正常走 CDP 直塞即可；仅当改版后直塞失败才按序点击这些候选把输入框展开出来
  uploadSelectors: [
    '[class*="attach" i]',
    '[aria-label*="附件" i]',
    '[aria-label*="upload" i]',
    '[data-testid*="attach" i]',
    '[class*="upload" i]',
    '[class*="clip" i]',
  ],
  inputSelectors: [
    'textarea.ds-scroll-area',
    'textarea[placeholder*="DeepSeek"]',
    'textarea#chat-input',
    'textarea',
  ],
  // 与 deepseek 条目同步：改版后发送键为主色实心圆形按钮，类名不含 send
  sendSelectors: [
    'div[role="button"].ds-button--primary.ds-button--filled',
    'div[role="button"][class*="send"]',
    'button[class*="send"]',
  ],
  responseSelectors: [
    '[class*="markdown"]',
    '.ds-markdown',
    '[class*="message"] [class*="content"]',
  ],
};

// Node 侧引用（主进程校验 /ask 的 sites 参数）；渲染层按浏览器脚本加载时此分支无害
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ADAPTERS, SUMMARIZER };
}
