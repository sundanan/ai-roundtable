#!/bin/bash
# AI 圆桌 · 服务配置脚本（对当前用户生效，可重复运行）：
# 创建 systemd 用户服务（崩溃自动重启）+ 开机自启，并立即启动。
# 位置自适应：
# - 安装版（deb）：本脚本在 /opt/ai-roundtable/resources/ 下，service.sh 同目录
# - 开发版：本脚本在仓库 scripts/ 下，service.sh 在仓库根
# 用法：bash scripts/setup-autostart.sh（安装版：bash /opt/ai-roundtable/resources/setup-autostart.sh）
set -e
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -x "$SELF_DIR/../ai-roundtable" ] && [ -f "$SELF_DIR/app.asar" ]; then
  # 安装版：resources/ 目录（app.asar 在此，二进制在上一级）
  SERVICE="$SELF_DIR/service.sh"
elif [ -f "$SELF_DIR/../service.sh" ] && [ -x "$SELF_DIR/../node_modules/electron/dist/electron" ]; then
  # 开发版：仓库 scripts/ 目录
  SERVICE="$SELF_DIR/../service.sh"
else
  echo "错误：无法定位应用目录（既不是 deb 安装版 resources/，也不是仓库 scripts/）" >&2
  exit 1
fi

mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/ai-roundtable.service <<EOF
[Unit]
Description=AI 圆桌常驻服务（Electron 多模型圆桌 + 飞书桥接 + 本地 HTTP 8765）
After=graphical-session.target
Wants=graphical-session.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=$SERVICE
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

mkdir -p ~/.config/autostart
cat > ~/.config/autostart/ai-roundtable.desktop <<EOF
[Desktop Entry]
Type=Application
Name=AI 圆桌服务
Comment=登录时拉起 AI 圆桌常驻服务
Exec=systemctl --user start ai-roundtable.service
Terminal=false
X-GNOME-Autostart-enabled=true
EOF

systemctl --user daemon-reload
systemctl --user enable --now ai-roundtable.service
echo "✓ 已配置并启动（service: $SERVICE）。日常管理：systemctl --user status|restart|stop ai-roundtable"
