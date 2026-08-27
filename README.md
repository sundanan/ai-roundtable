# AI 圆桌（AI Roundtable）

一个输入框，把同一个问题**同时发给 9 个 AI 网页版**，收集各家回复，再自动汇总成一份横向总结。

| | | | |
|---|---|---|---|
| 千问 | 豆包 | 元宝 | 智谱 |
| Kimi | DeepSeek | MiniMax | 文心 | MiMo |

**不需要申请任何 API Key**——复用你浏览器里已登录的各家网页版账号，通过网页自动化模拟真人提问、轮询抓取回复。多家独立作答、交叉验证，缓解单一模型的幻觉与视角偏差。

📖 用户向使用说明（安装 / 登录 / 提问 / 总结 / 历史 / 故障 Q&A）见 `docs/AI圆桌-使用说明书.md`。

## 工作原理

```
                 ┌────────────── 桌面 GUI（输入框/状态灯/总结面板）────────────┐
                 │   Electron 常驻应用                                        │
                 │   ├─ 9 个 webview（persist 分区保存登录态，常驻）           │
                 │   ├─ 引擎：广播→轮询抓取→(陈旧检测/重试)→LLM 总结           │
 Agent skill ───►│   ├─ 本地 HTTP 接口 127.0.0.1:8765                         │
 (curl /ask)     │   └─ 历史记录落库（userData，最多 200 条）                  │
                 └────────────────────────────────────────────────────────────┘
```

- 每家一个独立 webview，登录态通过 `persist:` 分区持久化，重启不丢；
- 引擎每 3 秒轮询抓取回复，内置防误判机制：问题回音排除、"思考中/搜索中"占位识别、陈旧回复检测、发送失败自动重试、面板活动看门狗；
- 全部交卷（或到达轮次上限）后生成五段结构化总结：默认 **网页总结**——用总结者专用账号（独立分区、免 API Key，模型可在设置里切换），各家无删减原文合成 docx 以附件上传、绕开输入框字数限制；设置里可切换为任意 OpenAI 兼容 API（备选）。

## 两种入口

1. **桌面 GUI**：输入框 + 9 家状态灯 + 总结面板（五段结构 + 目录跳转/scroll-spy），单击模型按钮全屏打开（手动登录/查看），参与各家与发送快捷键（Enter 或 Ctrl+Enter）在「设置」里勾选，行尾 ↻ 单家补发；「全部交卷后自动总结」默认开启（设置里可关），4 家交卷后也可手动提前总结；
2. **本地 HTTP 接口**：供 agent/脚本集成（见下方接口说明与 `integrations/hermes-skill/` 内的现成 skill），返回 `summaryFile`（总结 docx 路径）供微信等渠道按附件发送。

## 安装

环境要求：**Linux + X11 图形会话**（开发环境为 Linux；Windows/macOS 未适配）、**Node.js 18+**；HTTP 渠道的总结 docx 附件依赖 **pandoc**（未安装时自动回退纯文本，不影响其他功能）。

```bash
git clone https://github.com/sundanan/ai-roundtable.git
cd ai-roundtable
bash install.sh      # 检查环境 → npm install
```

Electron 需要显示环境（窗口与 webview 必须真实渲染），无头服务器不适用。

## 配置

1. **登录各家账号**：`npm start` 启动后，单击第二排每个模型按钮进入全屏，手动登录一次；
2. **总结方式**：默认**网页总结**——点「总结」后首次会全屏展开总结者页面，手动登录一个专用账号即可（免费、无需 API Key；总结模型可在「设置」下拉切换，当前支持 DeepSeek / MiMo）；如需 **API 总结**，在「设置」勾选「API 总结」——默认已指向智谱免费模型 GLM-4.7-Flash（`https://open.bigmodel.cn/api/paas/v4` + `glm-4.7-flash`），只需填你自己的 API Key，也可改填任意 OpenAI 兼容接口。配置只存本机 localStorage。

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
| `POST /ask` | body `{question, sites?, async?}`；同步跑一轮返回 `{ok, question, summary, summaryError, summaryFile, replies[]}`；`sites` 为可选子集（id 数组）；`async:true` 受理即返回 202 `{requestId, poll}`，结果经 `/ask/status` 轮询（一轮最坏 ≈12 分钟，长任务推荐异步）；同一时间只跑一轮，并发返回 busy；`summaryFile` 为总结 docx 的本机绝对路径（生成失败为空） |
| `GET /ask/status?id=xxx` | 异步轮次状态：`running` / `done`（含完整结果）/ `not-found` |
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

1. 服务运行时调试端口已开（`--remote-debugging-port=9222`，service.sh 自带）；手动前台调试：`electron . --disable-gpu --in-process-gpu --ozone-platform=x11 --remote-debugging-port=9222`；
2. `node scripts/selector-check.js` 做只读体检（哪家输入框/发送键没命中），或 `node scripts/cdp-verify.js` 跑一轮看哪家 state 异常；
3. 通过 CDP 连进对应 webview 查真实 DOM，更新对应选择器。

另有 `ai-roundtable-check.timer` 每日 09:30 自动做上述只读体检，专属选择器失效会桌面通知。

历年踩坑与对策（陈旧回复、思考前奏误判、长答案分块截断等）见 `docs/交付说明.md` 坑表；改 `js/core.js` 判据逻辑先跑 `npm test`。

## 安全说明

- HTTP 接口**仅绑定 127.0.0.1**，不暴露到网络；并对所有请求做 **Host/Origin 来源校验**（防 DNS rebinding 与浏览器跨站触发，curl/脚本工具不受影响；可选设 `ROUNDTABLE_TOKEN` 环境变量要求 `X-RT-Token` 头）；
- API Key 等凭证只存本机 localStorage，源码不含任何硬编码密钥；
- Electron 启用 `contextIsolation`、禁用 `nodeIntegration`，渲染页带 CSP；
- webview 内外链交系统浏览器打开时**仅放行 http(s) 协议**，其余协议（`javascript:`/`file:`/自定义协议等）一律拒绝；无域名白名单——聊天里的引用外链需要可点。

## 合规提醒（必读）

本项目以自动化方式操作**消费级网页版**AI，可能触碰各家服务条款（ToS）。仅供个人学习研究使用，请自行评估风险、控制频率、勿用于商业化批量抓取。使用本项目产生的一切后果由使用者自行承担。

## 已知限制

- 强依赖各家网页结构，改版即需适配（这是此类方案的固有代价）；
- 深度思考/联网研究耗时长的回答可能超出单轮上限（默认 7 分钟）；
- 单轮串行（桌面 GUI 与 HTTP/agent 互斥），一次只跑一个提问；
- 已支持 deb（arm64）、Windows NSIS、macOS 安装包构建（`npm run dist:deb` 与 `scripts/build-*.sh`，本机交叉构建）。

## License

[MIT](LICENSE)
