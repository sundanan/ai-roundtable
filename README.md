# AI 圆桌（AI Roundtable）

一个输入框，把同一个问题**同时发给 8 个 AI 网页版**，收集各家回复，再自动汇总成一份横向总结。

| | | | |
|---|---|---|---|
| 千问 | 豆包 | 元宝 | 智谱 |
| Kimi | DeepSeek | MiniMax | 文心 |

**不需要申请任何 API Key**——复用你浏览器里已登录的各家网页版账号，通过网页自动化模拟真人提问、轮询抓取回复。多家独立作答、交叉验证，缓解单一模型的幻觉与视角偏差。

📖 用户向使用说明（安装 / 登录 / 提问 / 总结 / 历史 / 故障 Q&A）见 `docs/AI圆桌-使用说明书.md`。

## 工作原理

```
                 ┌────────────── 桌面 GUI（输入框/状态灯/总结面板）────────────┐
 飞书机器人 ────► │   Electron 常驻应用                                        │
 (长连接,可选)    │   ├─ 8 个 webview（persist 分区保存登录态，常驻）           │
                 │   ├─ 引擎：广播→轮询抓取→(陈旧检测/重试)→LLM 总结           │
 Agent skill ───►│   ├─ 本地 HTTP 接口 127.0.0.1:8765                         │
 (curl /ask)     │   └─ 历史记录落库（userData，最多 200 条）                  │
                 └────────────────────────────────────────────────────────────┘
```

- 每家一个独立 webview，登录态通过 `persist:` 分区持久化，重启不丢；
- 引擎每 3 秒轮询抓取回复，内置防误判机制：问题回音排除、"思考中/搜索中"占位识别、陈旧回复检测、发送失败自动重试；
- 全部交卷（或到达轮次上限）后生成五段结构化总结：默认 **网页总结**——DeepSeek 第二账号（独立分区、免 API Key），各家无删减原文合成 docx 以附件上传、绕开输入框字数限制；设置里可切换为任意 OpenAI 兼容 API（备选）。

## 三种入口

1. **桌面 GUI**：输入框 + 8 家状态灯 + 总结面板（五段结构 + 目录跳转/scroll-spy），单击模型按钮全屏打开（手动登录/查看），参与各家与发送快捷键（Enter 或 Ctrl+Enter）在「设置」里勾选，行尾 ↻ 单家补发；设置里可开「全部交卷后自动总结」；
2. **飞书机器人**（可选）：私聊机器人发一句话即触发，回复"摘要 + 总结 docx 附件"；
3. **本地 HTTP 接口**：供 agent/脚本集成（见下方接口说明与 `integrations/hermes-skill/` 内的现成 skill），返回 `summaryFile`（总结 docx 路径）供微信等渠道按附件发送。

## 安装

环境要求：**Linux + X11 图形会话**（开发环境为 Linux；Windows/macOS 未适配）、**Node.js 18+**；飞书/HTTP 渠道的总结 docx 附件依赖 **pandoc**（未安装时自动回退纯文本，不影响其他功能）。

```bash
git clone https://github.com/sundanan/ai-roundtable.git
cd ai-roundtable
bash install.sh      # 检查环境 → npm install → 生成 .env 模板
```

Electron 需要显示环境（窗口与 webview 必须真实渲染），无头服务器不适用。

## 配置

1. **登录各家账号**：`npm start` 启动后，单击第二排每个模型按钮进入全屏，手动登录一次；
2. **总结方式**：默认**网页总结**——点「总结」后首次会全屏展开 DeepSeek 页面，手动登录一个第二账号即可（免费、无需 API Key）；如需 **API 总结**，在「设置」勾选「API 总结」并填任意 OpenAI 兼容 API 的 Base URL / API Key / 模型名。配置只存本机 localStorage；
3. **飞书入口（可选）**：在 [飞书开放平台](https://open.feishu.cn) 创建企业自建应用，开通机器人能力，事件订阅选「长连接」模式并订阅 `im.message.receive_v1`，然后把 App ID/Secret 填入 `.env`（参照 `.env.example`）。不配置飞书不影响桌面端与 HTTP 接口。
   可选在 `.env` 配 `FEISHU_ALLOW_CHAT_IDS`（逗号分隔 chat_id 白名单，防陌生人/无关群消耗账号额度）；群消息无论是否在名单内都必须 @机器人 才触发。

## 运行

```bash
npm start            # 前台运行（日志直接输出）
systemctl --user start ai-roundtable    # 推荐：systemd 用户服务（崩溃自动重启）
```

systemd 用户服务开机自启（经 `~/.config/autostart/ai-roundtable.desktop` 拉起，登录后自动运行），
进程崩溃（如 GPU FATAL）5 秒后自动重启；手动方式 `bash service.sh` 仍可用（日志写入 `~/ai-roundtable-service.log`，超 20MB 自动截断）。
日常管理：`systemctl --user status|restart|stop ai-roundtable`。

关窗不退出，应用隐藏到托盘常驻；托盘菜单可重新显示窗口或退出。

## HTTP 接口（仅监听 127.0.0.1）

| 方法 路径 | 说明 |
|---|---|
| `GET /health` | `{ok, ready}` 探活 |
| `POST /ask` | body `{question, sites?}`；跑一轮返回 `{ok, question, summary, summaryError, summaryFile, replies[]}`；`sites` 为可选子集（id 数组），同一时间只跑一轮，并发返回 busy；`summaryFile` 为总结 docx 的本机绝对路径（生成失败为空）。耗时约 1–7 分钟，请给足超时 |
| `GET /history?limit=N&q=关键词` | 历史列表 `{items:[{id,ts,question,summary,count}]}` |
| `GET /history/item?id=xxx` | 单轮完整内容 `{item:{summary, replies[]}}` |

```bash
curl -sS --max-time 460 -X POST http://127.0.0.1:8765/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"用一句话介绍杭州","sites":["qwen","deepseek"]}'
```

`integrations/hermes-skill/SKILL.md` 是一份可直接用于 [Hermes](https://github.com/NousResearch/hermes-agent) 等 agent 框架的 skill：把它放进 skills 目录，即可在聊天里用「AI圆桌 + 问题」触发圆桌、查历史。

## 维护

各家网站改版会导致选择器失效（输入框/发送按钮/回复容器）。全部选择器集中在 `src/adapters.js`，维护方法：

1. 以调试端口启动：`electron . --disable-gpu --ozone-platform=x11 --remote-debugging-port=9222`；
2. `node scripts/cdp-verify.js` 跑一轮自检，看哪家 state 异常；
3. 通过 CDP 连进对应 webview 查真实 DOM，更新对应选择器。

历年踩坑与对策（陈旧回复、思考前奏误判、长答案分块截断等）见 `docs/交付说明.md` 坑表；飞书桥接设计见 `docs/飞书桥接技术方案.md`。

## 安全说明

- HTTP 接口**仅绑定 127.0.0.1**，不暴露到网络；
- 凭证只存 `.env`（已 gitignore），源码不含任何硬编码密钥；
- Electron 启用 `contextIsolation`、禁用 `nodeIntegration`，渲染页带 CSP；
- webview 内外链一律经主进程白名单校验后交系统浏览器打开。

## 合规提醒（必读）

本项目以自动化方式操作**消费级网页版**AI，可能触碰各家服务条款（ToS）。仅供个人学习研究使用，请自行评估风险、控制频率、勿用于商业化批量抓取。使用本项目产生的一切后果由使用者自行承担。

## 已知限制

- 强依赖各家网页结构，改版即需适配（这是此类方案的固有代价）；
- 深度思考/联网研究耗时长的回答可能超出单轮上限（默认 7 分钟）；
- 单轮串行，一次只跑一个提问；
- 未做安装包打包（electron-builder），以源码方式运行。

## License

[MIT](LICENSE)
