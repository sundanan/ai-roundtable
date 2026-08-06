/**
 * 8 家 AI 网页版适配器配置。
 *
 * 每家包含：
 *  - id / name：面板标识
 *  - url：入口地址
 *  - inputSelectors / sendSelectors：注入发送时按顺序尝试的 CSS 选择器，
 *    都找不到时回退到通用的「可见 textarea / contenteditable」探测。
 *  - responseSelectors：抓取最后一条 AI 回复时按顺序尝试的选择器。
 *
 * 各家网页改版后只需更新这里的对应条目，无需改其他代码。
 * 选择器均为尽力维护的猜测值，失效时请按 README 的方法更新。
 */
const ADAPTERS = [
  {
    id: 'qwen',
    name: '千问',
    url: 'https://www.tongyi.com/',
    inputSelectors: [
      '[data-slate-editor]',
      'textarea[placeholder*="输入"]',
      '[contenteditable="true"]',
    ],
    sendSelectors: [
      'button[aria-label="发送消息"]',
      'button[class*="send"]',
    ],
    responseSelectors: [
      '[class*="markdown"]',
      '[class*="answerContent"]',
      '[class*="message-content"]',
    ],
  },
  {
    id: 'doubao',
    name: '豆包',
    url: 'https://www.doubao.com/chat/',
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
    inputSelectors: [
      '.ql-editor[contenteditable="true"]',
      '[contenteditable="true"]',
      'textarea',
    ],
    sendSelectors: [
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
    // watchStop：深度思考阶段文本可能停顿，靠"停止生成"按钮可见性保持等待，
    // 避免把思考前奏当完整答案（2026-08 曾误判）
    watchStop: true,
    inputSelectors: [
      'textarea[placeholder]',
      '[contenteditable="true"]',
      'textarea',
    ],
    sendSelectors: [
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
    // watchStop + staleMax 放宽：Kimi 常自动进联网研究，数分钟内页面无新回复文本，
    // 默认 8 轮陈旧检测会误杀（2026-08 曾把已答完的研究判成失败）
    watchStop: true,
    staleMax: 40,
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
    inputSelectors: [
      'textarea#chat-input',
      'textarea[placeholder*="DeepSeek"]',
      'textarea',
    ],
    sendSelectors: [
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
    // watchStop：联网搜索阶段回复区长期停留在"我先搜一下"前奏文本，
    // 靠停止按钮可见性保持等待，避免前奏被当答案（2026-08 曾误判）
    watchStop: true,
    inputSelectors: [
      'textarea[placeholder]',
      '[contenteditable="true"]',
      'textarea',
    ],
    sendSelectors: [
      'button[class*="send"]',
      '[class*="sendBtn"]',
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
];
