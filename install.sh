#!/bin/bash
# AI 圆桌 · 依赖安装脚本
# 用法：bash install.sh
set -e
cd "$(dirname "$0")"

echo "==> 检查 Node.js 环境"
if ! command -v node >/dev/null 2>&1; then
  echo "错误：未找到 node。请先安装 Node.js 18+（https://nodejs.org 或发行版包管理器）" >&2
  exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "错误：Node.js 版本过低（当前 $(node -v)），需要 18+" >&2
  exit 1
fi
echo "    node $(node -v) / npm $(npm -v)"

echo "==> 安装依赖（electron 体积较大，首次安装请耐心等待）"
npm install

echo "==> 检查环境变量配置"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "    已生成 .env（模板）。如需飞书入口，请填入你自己的 FEISHU_APP_ID / FEISHU_APP_SECRET；"
  echo "    不用飞书可留空，桌面端与本地 HTTP 接口不受影响。"
else
  echo "    .env 已存在，跳过"
fi

echo "==> 完成"
echo ""
echo "后续步骤："
echo "  1. npm start                 # 前台运行（看日志）"
echo "  2. bash service.sh           # 常驻服务方式运行（日志写入 ~/ai-roundtable-service.log）"
echo "  3. 首次启动后，在界面里点各家模型按钮，全屏登录一次你的账号"
echo "  4. 点「设置」配置总结用 LLM（任意 OpenAI 兼容 API：Base URL / Key / 模型名）"
echo ""
echo "提示：Linux 下若遇 GPU/显示问题，npm start 已带 --disable-gpu --ozone-platform=x11；"
echo "      Wayland 会话如仍异常，可尝试在 X11 会话下运行。"
