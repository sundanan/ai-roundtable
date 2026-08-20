#!/bin/bash
# AI 圆桌 · macOS (Apple Silicon, darwin-arm64) 安装包构建脚本
#
# electron-builder 不支持在 Linux 上打 mac 包，但 .app 只是目录结构：
# Electron 官方 darwin-arm64 发行包 + 我们的纯 JS 应用（app.asar）+ Info.plist/图标。
# 本脚本手工组装 AI圆桌.app 并打 zip（未签名，Mac 上右键"打开"或 xattr -cr 放行）。
#
# 用法：bash scripts/build-macos.sh
# 产物：dist/AI圆桌-<版本>-macos-arm64.zip（含 AI圆桌.app）
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
VERSION="$(node -p "require('./package.json').version")"
ELECTRON_VER="43.2.0"
MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
ZIP_NAME="electron-v${ELECTRON_VER}-darwin-arm64.zip"
WORK="dist/macos-build"
APP_NAME="AI圆桌"
EXE_NAME="ai-roundtable"
BUNDLE_ID="com.sundanan.ai-roundtable"
OUT_ZIP="dist/AI圆桌-${VERSION}-macos-arm64.zip"

echo "==> [1/6] 下载 Electron darwin-arm64（镜像：$MIRROR）"
mkdir -p "$WORK" dist/electron-cache
# 缓存命中条件：文件存在且是有效 zip（此前 404 时留下过 417 字节的坏文件）
is_valid_zip() {
  [ -f "$1" ] && unzip -tqq "$1" > /dev/null 2>&1
}
if ! is_valid_zip "dist/electron-cache/$ZIP_NAME"; then
  rm -f "dist/electron-cache/$ZIP_NAME"
  curl -L --retry 5 --retry-delay 3 -o "dist/electron-cache/$ZIP_NAME" \
    "${MIRROR}${ELECTRON_VER}/${ZIP_NAME}"
  is_valid_zip "dist/electron-cache/$ZIP_NAME" || { echo "下载的 zip 无效"; exit 1; }
fi

echo "==> [2/6] 解压 Electron.app 并更名为 ${APP_NAME}.app"
rm -rf "$WORK/app"
mkdir -p "$WORK/app"
unzip -q "dist/electron-cache/$ZIP_NAME" -d "$WORK/app"
[ -d "$WORK/app/Electron.app" ] || { echo "解压后未找到 Electron.app"; exit 1; }
mv "$WORK/app/Electron.app" "$WORK/app/${APP_NAME}.app"
APP="$WORK/app/${APP_NAME}.app"

echo "==> [3/6] 准备应用内容（生产依赖 + 源码 -> app.asar）"
rm -rf "$WORK/staging"
mkdir -p "$WORK/staging"
cp -r src assets package.json README.md "$WORK/staging/"
(
  cd "$WORK/staging"
  npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
)
node -e "
const asar = require('@electron/asar');
asar.createPackage('$WORK/staging', '$APP/Contents/Resources/app.asar')
  .then(() => console.log('app.asar 打包完成'))
  .catch((e) => { console.error(e); process.exit(1); });
"

echo "==> [4/6] 重命名主程序 + 修改 Info.plist + 生成 icns 图标"
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/$EXE_NAME"
python3 - "$APP/Contents/Info.plist" "$APP_NAME" "$EXE_NAME" "$BUNDLE_ID" "$VERSION" <<'PYEOF'
import plistlib, sys
path, name, exe, bundle_id, version = sys.argv[1:6]
with open(path, 'rb') as f:
    p = plistlib.load(f)
p['CFBundleName'] = name
p['CFBundleDisplayName'] = name
p['CFBundleExecutable'] = exe
p['CFBundleIdentifier'] = bundle_id
p['CFBundleShortVersionString'] = version
p['CFBundleVersion'] = version
p['CFBundleIconFile'] = 'ai-roundtable.icns'
with open(path, 'wb') as f:
    plistlib.dump(p, f)
print('Info.plist 已更新')
PYEOF
python3 - assets/icon.png "$APP/Contents/Resources/ai-roundtable.icns" <<'PYEOF'
import struct, sys
from PIL import Image
src, out = sys.argv[1], sys.argv[2]
img = Image.open(src).convert('RGBA')
# ICNS 各尺寸类型码：ic07=128 ic08=256 ic09=512（源图 256，512 为放大插值）
types = [(b'ic07', 128), (b'ic08', 256), (b'ic09', 512)]
chunks = b''
for code, size in types:
    im = img.resize((size, size), Image.LANCZOS)
    import io
    buf = io.BytesIO()
    im.save(buf, 'PNG')
    data = buf.getvalue()
    chunks += code + struct.pack('>I', len(data) + 8) + data
with open(out, 'wb') as f:
    f.write(b'icns' + struct.pack('>I', len(chunks) + 8) + chunks)
print('ai-roundtable.icns 已生成')
PYEOF

echo "==> [5/6] 附带 launchd 服务配置脚本"
cp scripts/setup-autostart-macos.sh "$APP/Contents/Resources/"
chmod +x "$APP/Contents/Resources/setup-autostart-macos.sh"

echo "==> [6/6] 打 zip（保留符号链接）"
rm -f "$OUT_ZIP"
(cd "$WORK/app" && zip -q -r --symlinks "$ROOT/$OUT_ZIP" "${APP_NAME}.app")

echo ""
echo "✓ 构建完成：$OUT_ZIP  ($(du -h "$OUT_ZIP" | cut -f1))"
echo "  .app 主程序：$APP/Contents/MacOS/$EXE_NAME"
