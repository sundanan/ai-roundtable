#!/bin/bash
# AI 圆桌 · 常驻服务启动脚本
# 供 systemd 用户服务（~/.config/systemd/user/ai-roundtable.service，
# 崩溃自动重启）、开机自启（~/.config/autostart/ai-roundtable.desktop）与手动启动共用。
# 依赖单实例锁：若已有实例在跑，本次启动会自动退出，不会重复。
cd "$(dirname "$0")" || exit 1

LOG="$HOME/ai-roundtable-service.log"

# 日志轮转：超过 20MB 只保留末尾 5000 行，防止无限增长（进度行即使已去重仍会累积）
if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG")" -gt 20971520 ]; then
  tail -n 5000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

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
# GPU 加固：--disable-gpu 仅关硬件加速，Chromium 仍会尝试拉起独立 GPU 进程；
# 本机（统信 UOS arm64）该进程反复启动失败（error_code=1002）并 FATAL 掉整个应用
# （2026-08-21/22/23 三次同样死法，8-22 那次宕机 44 小时）。--in-process-gpu 把
# GPU 任务并入主进程，不再派生这个必崩的子进程。
# CDP 调试端口（仅 127.0.0.1）：供选择器每日自检（ai-roundtable-check.timer +
# scripts/selector-check.js 只读探测）与排障使用；单用户桌面环境风险可控。
GPU_FLAGS="--disable-gpu --in-process-gpu --ozone-platform=x11 --remote-debugging-port=9222"
# 位置自适应：
# - 开发版：本脚本在仓库根（electron 在 node_modules 里，应用根为当前目录 "."）
# - 安装版（deb）：本脚本在 /opt/ai-roundtable/resources/ 下，二进制在上一级
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -x "$SELF_DIR/node_modules/electron/dist/electron" ]; then
  cd "$SELF_DIR" || exit 1
  exec ./node_modules/electron/dist/electron . $GPU_FLAGS >> "$LOG" 2>&1
elif [ -x "$SELF_DIR/../ai-roundtable" ]; then
  exec "$SELF_DIR/../ai-roundtable" $GPU_FLAGS >> "$LOG" 2>&1
else
  echo "未找到 electron 可执行文件（$SELF_DIR 下既无 node_modules/electron，上一级也无 ai-roundtable）" >> "$LOG"
  exit 1
fi
