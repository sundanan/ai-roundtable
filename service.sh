#!/bin/bash
# AI 圆桌 · 常驻服务启动脚本
# 供开机自启（~/.config/autostart/ai-roundtable.desktop）与手动启动共用。
# 依赖单实例锁：若已有实例在跑，本次启动会自动退出，不会重复。
cd "$(dirname "$0")" || exit 1

LOG="$HOME/ai-roundtable-service.log"

# 图形环境兜底：自启动场景下若 DISPLAY 未继承，尝试 :1 / :0
if [ -z "$DISPLAY" ]; then
  if [ -e /tmp/.X11-unix/X1 ]; then
    export DISPLAY=:1
  elif [ -e /tmp/.X11-unix/X0 ]; then
    export DISPLAY=:0
  fi
  [ -f "$HOME/.Xauthority" ] && export XAUTHORITY="$HOME/.Xauthority"
fi

echo "===== AI圆桌服务启动 $(date '+%F %T') =====" >> "$LOG"
exec ./node_modules/electron/dist/electron . --disable-gpu --ozone-platform=x11 >> "$LOG" 2>&1
