---
name: ai-roundtable
description: "AI圆桌/一问八答：把问题同时发给8家AI并汇总，可指定部分家、可查历史。消息含'AI圆桌''一问八答'或查圆桌历史时用。"
---

# AI 圆桌（一问八答）

把用户的问题**同时**发给多家 AI（千问/豆包/元宝/智谱/Kimi/DeepSeek/MiniMax/文心），收集各家回复并生成综合总结。本机已常驻 AI 圆桌服务，通过本地 HTTP 接口调用。

## 何时使用

- 用户消息包含「AI圆桌」「一问八答」「问问各家 AI」「多家 AI 对比」等，或明确要求就某个问题听取多家 AI 意见时 → 发起圆桌。
- 用户想**查以前问过什么 / 之前圆桌的结论**（如"上次圆桌讨论了什么""查下之前关于 X 的圆桌"）→ 查历史（见文末）。

## 各家 id（用于指定子集）

| id | 名称 | id | 名称 |
|---|---|---|---|
| qwen | 千问 | kimi | Kimi |
| doubao | 豆包 | deepseek | DeepSeek |
| yuanbao | 元宝 | minimax | MiniMax |
| zhipu | 智谱 | wenxin | 文心 |

## 调用步骤

### 1. 提取问题

从用户消息里取出真正要问的问题（去掉「AI圆桌」「一问八答」等触发词）。例如用户说「AI圆桌 用一句话介绍杭州」，问题就是「用一句话介绍杭州」。

### 2. 先探活（可选，快速）

```bash
curl -sS --max-time 5 http://127.0.0.1:8765/health
```
返回 `{"ok":true,"ready":true}` 说明服务就绪。若 `ready:false` 或连不上，告知用户「AI 圆桌服务未就绪，请确认桌面应用已启动」。

### 3. 发起圆桌（耗时约 1–7 分钟，务必用长超时）

把问题 JSON 转义后填入 `<问题>`，执行：

```bash
curl -sS --max-time 460 -X POST http://127.0.0.1:8765/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"<问题>"}'
```

**默认问全部 8 家**。若用户指定只要某几家（如"只问千问和 DeepSeek""让豆包、Kimi、文心回答"），在 body 里加 `sites` 数组（用上面的 id）：

```bash
curl -sS --max-time 460 -X POST http://127.0.0.1:8765/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"<问题>","sites":["qwen","deepseek"]}'
```

> 注意：问题里若含双引号/反斜杠/换行，必须做 JSON 转义。此调用会阻塞到各家完成并总结完毕，通常 1–3 分钟，个别家（如 Kimi 深度研究）慢时可到 7 分钟，不要中途打断。

### 4. 解析返回

成功时返回 JSON：
```json
{
  "ok": true,
  "question": "...",
  "summary": "综合总结文本",
  "summaryError": "",
  "replies": [
    {"id":"qwen","name":"千问","state":"done","text":"..."},
    {"id":"doubao","name":"豆包","state":"done","text":"..."}
  ]
}
```

特殊情况：
- `{"ok":false,"error":"busy"}` → 正在处理另一轮，告诉用户稍等片刻再发。
- `{"ok":false,"error":"not-ready"}` → 服务窗口未就绪，提示用户打开 AI 圆桌桌面应用。
- 某条 reply 的 `state` 非 `done` 或 `text` 为空 → 该家失败/超时，呈现时标注即可，不必强求 8 家齐全。

## 结果呈现

按下面的结构回复用户（用当前对话所在平台的排版）：

1. **先给总结**：把 `summary` 作为开头（这是最有价值的部分）。若 `summaryError` 非空，说明总结失败并给出原因。
2. **再列各家观点**：逐家给出 `name` 与其 `text` 的要点。回复较长时做适度概括，保留关键结论与分歧；用户要全文再展开。
3. 末尾可注明「共 N 家成功回复」，失败的家简单带过。

## 查询历史（改进1）

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
返回该轮完整 `summary` 与各家 `replies`。呈现方式同上面的"结果呈现"。

> URL 里的关键词若含中文/空格，需做 URL 编码。

## 约束

- 不要并发发起多轮（服务同一时间只跑一轮）。
- 不要改动本文件或本地服务端口（默认 8765）。
