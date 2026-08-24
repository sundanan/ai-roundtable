#!/bin/bash
# AI 圆桌 · 健康巡检（ai-roundtable-watchdog.timer 每 5 分钟触发）
# /health 异常时自动 `systemctl --user start` 拉起服务并记录；
# 2026-08-22 曾 core-dump 后 44 小时无人发现，巡检是"宕机无人知晓"的兜底。
LOG="$HOME/ai-roundtable-watchdog.log"
PORT="${ROUNDTABLE_PORT:-8765}"

probe() {
  curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/health" 2>/dev/null
}

code=$(probe)
if [ "$code" = "200" ]; then
  # 日志瘦身：只在有事件时写入，长期为空文件
  [ -f "$LOG" ] && [ "$(stat -c%s "$LOG")" -gt 1048576 ] && tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  exit 0
fi

echo "$(date '+%F %T') 探活失败（HTTP ${code:-无响应}），尝试拉起 ai-roundtable.service" >> "$LOG"
systemctl --user start ai-roundtable.service 2>>"$LOG"
sleep 8
code2=$(probe)
if [ "$code2" = "200" ]; then
  echo "$(date '+%F %T') 已自动恢复" >> "$LOG"
else
  echo "$(date '+%F %T') 拉起后仍异常（HTTP ${code2:-无响应}），请人工检查：tail ~/ai-roundtable-service.log" >> "$LOG"
fi
exit 0
