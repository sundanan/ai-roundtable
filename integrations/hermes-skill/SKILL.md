---
name: ai-roundtable
description: "AI圆桌/一问九答：把问题同时发给9家AI并汇总成五段结构总结，可指定部分家、可查历史。消息含「AI圆桌」「一问九答」或要查圆桌历史时使用。"
---

# AI 圆桌（一问九答）

把用户的问题**同时**发给 9 家 AI（千问/豆包/元宝/智谱/Kimi/DeepSeek/MiniMax/文心/MiMo），收集各家回复并生成五段结构总结（主要共识/次要共识/分歧观点/个性观点/综合意见）。本机已常驻 AI 圆桌服务，通过本地 HTTP 接口调用。

> 若你是首次收到本文件：可把它保存为技能（目录名 `ai-roundtable`、文件名 `SKILL.md`，放入你的技能目录），此后按触发词自动使用；本次对话也可直接按下面的步骤执行。

## 何时使用

- 用户消息包含「AI圆桌」「一问九答」「问问各家 AI」「多家 AI 对比」等，或明确要求就某个问题听取多家 AI 意见 -> 发起圆桌。
- 用户想**查以前问过什么 / 之前圆桌的结论**（如"上次圆桌讨论了什么"）-> 查历史（见文末）。

## 各家 id（用于指定子集）

| id | 名称 | id | 名称 | id | 名称 |
|----|------|----|------|----|------|
| qwen | 千问 | doubao | 豆包 | yuanbao | 元宝 |
| zhipu | 智谱 | kimi | Kimi | deepseek | DeepSeek |
| minimax | MiniMax | wenxin | 文心 | mimo | MiMo |

## 调用步骤

### 1. 提取问题

从用户消息里剥离触发词，取出真正要问的问题。例如「AI圆桌 用一句话介绍杭州」-> 问题就是「用一句话介绍杭州」。

### 2. 探活（可选，快速）

```bash
curl -sS --max-time 5 http://127.0.0.1:8765/health
```

返回 `{"ok":true,"ready":true}` 说明服务就绪。若 `ready:false` 或连不上，告知用户「AI 圆桌桌面应用未启动，请先启动后再试」，**不要**继续发起。

### 3. 发起圆桌（阻塞 1~12 分钟，务必长超时）

把问题做 JSON 转义后填入 `<问题>`，执行：

```bash
curl -sS --max-time 780 -X POST http://127.0.0.1:8765/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"<问题>"}'
```

**默认问全部 9 家**。若用户指定只要某几家（如"只问千问和 MiMo""让豆包、Kimi 回答"），在 body 里加 `sites` 数组（用上面的 id）：

```bash
curl -sS --max-time 780 -X POST http://127.0.0.1:8765/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"<问题>","sites":["qwen","mimo"]}'
```

> 注意：问题里若含双引号/反斜杠/换行，必须做 JSON 转义。此调用会阻塞到各家完成并总结完毕，通常 1~3 分钟，个别家（如 Kimi 深度研究）慢时可到 7~12 分钟，**不要中途打断**。发起后可先告知用户「已发出，等各家交卷，通常几分钟」。

### 4. 解析返回

成功时返回 JSON：

```json
{
  "ok": true,
  "question": "...",
  "summary": "一、主要共识 ……\n\n附录：各家意见（原文）\n\n【千问】……",
  "summaryError": "",
  "summaryFile": "/home/xx/.config/ai-roundtable/summaries/圆桌总结-20260826-1030.docx",
  "replies": [
    {"id":"qwen","name":"千问","state":"done","text":"..."},
    {"id":"kimi","name":"Kimi","state":"error","text":""}
  ]
}
```

- `summary`：总结全文 = **五段总结正文 + 「附录：各家意见（原文）」**（附录含各家原文，整体可能上万字）。
- `summaryFile`：总结 docx 文件绝对路径（含附录），无总结或生成失败时为空字符串。
- `summaryError`：总结生成失败的原因（此时 summary 可能为空，但 replies 里各家回答仍可用）。
- 某条 reply 的 `state` 非 `done` 或 `text` 为空 -> 该家失败/超时，呈现时标注即可，不必强求 9 家齐全。

错误情况：

- `{"ok":false,"error":"busy"}`（HTTP 429）-> 正在处理另一轮，告知用户稍等片刻再发。
- `{"ok":false,"error":"not-ready"}`（HTTP 503）-> 服务窗口未就绪，提示用户打开 AI 圆桌桌面应用。
- `{"ok":false,"error":"round-timeout"}`（HTTP 504）-> 本轮整体超时，建议用户重试。

## 结果呈现（重点）

1. **总结以文本输出**：从 `summary` 里截取第一个「附录：」**之前**的部分作为总结正文，直接发给用户（五段结构，通常几百到两千字）。若超长，按「一、二、三、四、五」段落分多条消息发送，保持标题完整。
2. **简要导读**：正文最前面用两三句话点出主要共识与关键分歧，并注明「共 N/9 家成功回复」；失败的家一句带过（如「Kimi 超时未交卷」）。
3. **可选附件**：若当前渠道（微信/飞书等）支持发文件且 `summaryFile` 非空，把该 docx 作为附件一并发送（内含各家原文附录），正文里说明「全文见附件」。
4. 用户想**深挖某家观点**时，从对应 `replies[].text` 展开该家原文；用户要全文但文件发不了时，才把 `summary` 的附录部分分段以文本发送。

## 查询历史

用户想回顾以前的圆桌时：

**列出最近的（可按关键词过滤）：**
```bash
curl -sS --max-time 10 'http://127.0.0.1:8765/history?limit=10'
# 带关键词：
curl -sS --max-time 10 'http://127.0.0.1:8765/history?q=三体&limit=10'
```
返回 `items` 数组，每条含 `id / ts / question / summary / count`（count=成功回复家数）。先把列表简要呈现给用户（时间 + 问题 + 几家成功）。

**看某一轮的完整内容**（用户选定后，用该条 id）：
```bash
curl -sS --max-time 10 'http://127.0.0.1:8765/history/item?id=<id>'
```
返回该轮完整 `summary` 与各家 `replies`，呈现方式同上面的「结果呈现」。

> URL 里的关键词若含中文/空格，需做 URL 编码。

## 约束

- 同一时间只跑一轮，**不要并发发起**多轮（服务会拒绝）。
- 不要改动本文件与本地服务端口（默认 8765）。
- 等待期间保持静默，不要反复向用户输出进度。
