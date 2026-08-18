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
