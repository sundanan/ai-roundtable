#!/bin/bash
# AI 圆桌 · Windows x64 NSIS 安装包构建脚本（在 arm64 Linux 上交叉构建）
#
# electron-builder 在 Linux 上打 NSIS 包有两个坑，本脚本自动处理：
# 1. 官方 nsis-3.0.4.1 工具链里 linux/makensis 是 x86-64 ELF，arm64 机器无法执行
#    -> 用 Debian 源的 nsis 3.04（arm64 原生）替换缓存里的二进制，保留原 Stubs/Plugins
# 2. 卸载器提取默认走 wine（运行 exe），arm64 无 wine 可用
#    -> 给 node_modules 里的 NsisTarget.js 打补丁，改走纯 JS 的 UninstallerReader
#    （该补丁随 npm install 失效，本脚本幂等自动重打）
#
# 用法：bash scripts/build-windows.sh
# 产物：dist/ai-roundtable-Setup-<版本>-x64.exe
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION="$(node -p "require('./package.json').version")"
MIRROR_ELECTRON="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
MIRROR_BINS="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"

echo "==> [1/3] 确保缓存工具链里的 makensis 是 arm64 原生"
BUNDLE_DIR="$(ls -d ~/.cache/electron-builder/nsis-3.0.4.1/nsis-3.0.4.1-* 2>/dev/null | head -1 || true)"
if [ -z "$BUNDLE_DIR" ]; then
  echo "  nsis 工具链尚未下载（首次构建时自动下载），先跑一次构建让缓存生成..."
fi
if [ -n "$BUNDLE_DIR" ] && ! "$BUNDLE_DIR/linux/makensis" -HDRINFO > /dev/null 2>&1; then
  echo "  缓存里的 makensis 不可执行（x86-64），替换为 Debian arm64 原生版..."
  TMP="$(mktemp -d)"
  (cd "$TMP" && apt-get download nsis > /dev/null 2>&1 && dpkg -x nsis_*.deb ./pkg)
  [ -x "$TMP/pkg/usr/bin/makensis" ] || { echo "  apt 下载 nsis 失败"; exit 1; }
  cp "$TMP/pkg/usr/bin/makensis" "$BUNDLE_DIR/linux/makensis"
  chmod +x "$BUNDLE_DIR/linux/makensis"
  rm -rf "$TMP"
  "$BUNDLE_DIR/linux/makensis" -HDRINFO > /dev/null && echo "  ✓ arm64 makensis 已就位"
else
  echo "  ✓ makensis 可用"
fi

echo "==> [2/3] 补丁：卸载器提取走纯 JS 路径（免 wine）"
NSIS_TARGET="node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js"
if grep -q "isMacOsCatalina" "$NSIS_TARGET"; then
  sed -i 's/if ((0, macosVersion_1\.isMacOsCatalina)()) {/if (true) { \/\/ PATCH: 纯 JS UninstallerReader，免 wine/' "$NSIS_TARGET"
  grep -q "PATCH: 纯 JS" "$NSIS_TARGET" || { echo "  补丁失败"; exit 1; }
  echo "  ✓ 已打补丁"
else
  echo "  ✓ 补丁已存在（或版本变化），跳过"
fi

echo "==> [3/3] electron-builder 构建 NSIS x64"
ELECTRON_MIRROR="$MIRROR_ELECTRON" ELECTRON_BUILDER_BINARIES_MIRROR="$MIRROR_BINS" \
  npx electron-builder --win nsis --x64

OUT="dist/ai-roundtable-Setup-${VERSION}-x64.exe"
[ -f "$OUT" ] || { echo "未找到产物 $OUT"; exit 1; }
echo ""
echo "✓ 构建完成：$OUT  ($(du -h "$OUT" | cut -f1))"
