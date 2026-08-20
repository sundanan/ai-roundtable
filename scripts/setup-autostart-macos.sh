#!/bin/bash
# AI 圆桌 · macOS 服务配置脚本（对当前用户生效，可重复运行）：
# 创建 launchd 用户代理（崩溃自动重启 + 登录自启）并立即启动。
# 位置自适应：本脚本随 .app 发布在 AI圆桌.app/Contents/Resources/ 下。
# 用法：bash "/Applications/AI圆桌.app/Contents/Resources/setup-autostart-macos.sh"
set -e
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$(cd "$SELF_DIR/../../MacOS" && pwd)"
BIN="$BIN_DIR/ai-roundtable"
if [ ! -x "$BIN" ]; then
  echo "错误：未找到应用可执行文件：$BIN（本脚本应位于 AI圆桌.app/Contents/Resources/ 内运行）" >&2
  exit 1
fi

mkdir -p ~/Library/LaunchAgents ~/Library/Logs
LABEL="com.sundanan.ai-roundtable"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/ai-roundtable.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/ai-roundtable.log</string>
</dict>
</plist>
EOF

# 重复运行先卸载旧实例再加载新配置
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "✓ 已配置并启动。日常管理："
echo "  状态/停止/重启：launchctl list | grep ai-roundtable ；launchctl unload $PLIST"
echo "  日志：tail -f ~/Library/Logs/ai-roundtable.log"
