#!/bin/bash
# 安装「选择器每日自检」的用户级 systemd 单元（service + timer）。
# 用法：bash scripts/setup-selector-check.sh
# 前提：主服务以 --remote-debugging-port=9222 启动（service.sh 已带）。
set -e

UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"

cat > "$UNIT_DIR/ai-roundtable-check.service" <<'UNIT'
[Unit]
Description=AI 圆桌 选择器只读自检（CDP 探测输入框/发送键）
After=ai-roundtable.service

[Service]
Type=oneshot
ExecStart=%h/ai-roundtable/scripts/selector-check.js
UNIT

cat > "$UNIT_DIR/ai-roundtable-check.timer" <<'UNIT'
[Unit]
Description=AI 圆桌 选择器自检定时器（每日 09:30，错过后补跑）

[Timer]
OnCalendar=*-*-* 09:30:00
RandomizedDelaySec=300
Persistent=true
Unit=ai-roundtable-check.service

[Install]
WantedBy=timers.target
UNIT

chmod +x "$HOME/ai-roundtable/scripts/selector-check.js" 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user enable --now ai-roundtable-check.timer
echo "已安装并启用 ai-roundtable-check.timer（每日 09:30 自检，Persistent 补跑）"
echo "手动跑一次：systemctl --user start ai-roundtable-check.service"
echo "日志：~/ai-roundtable-selector-check.log"
