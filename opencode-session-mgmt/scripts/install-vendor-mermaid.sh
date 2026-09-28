#!/usr/bin/env bash
#
# install-vendor-mermaid.sh —— 把 mermaid-cli 预装进 <bundle>/vendor/（离线 Mermaid 渲染）。
#
# 背景：reqdoc_export 渲染 Mermaid 流程图需要 mermaid-cli + 浏览器。离线机无法 npx
# 拉包，也不预装 puppeteer 的 chrome-headless-shell（~260MB），故：
#   1. 用 **Windows npm**（cmd.exe）把 @mermaid-js/mermaid-cli 装到
#      <bundle>/vendor/mermaid-cli（独立 package.json，不与 bundle 的 bun node_modules 混用）。
#      必须用 Windows npm：@napi-rs/canvas 等是平台二进制，WSL Linux npm 会拉 linux 版。
#      PUPPETEER_SKIP_DOWNLOAD=1 跳过浏览器下载；运行时插件改用系统 Edge/Chrome
#      （见 packages/plugin/src/tools/reqdoc-export.ts 的 systemBrowser()）。
#   2. 幂等：入口已存在则跳过；FORCE_VENDOR=1 强制重装；安装失败返回非 0。
#
# 用法：
#   bash scripts/install-vendor-mermaid.sh <bundle_dir>
# 环境变量：
#   FORCE_VENDOR=1   强制重装（删除已有 vendor/mermaid-cli 后重来）
#   SKIP_VENDOR=1    跳过（打 Linux 包时用）
# 依赖：WSL（能调 cmd.exe）；首装需联网。
# 被 sync-bundle.sh 与 pack-bundle.sh 调用，也可单独执行。
set -euo pipefail

BUNDLE="${1:?用法：bash scripts/install-vendor-mermaid.sh <bundle_dir>}"
ENTRY_REL="vendor/mermaid-cli/node_modules/@mermaid-js/mermaid-cli/src/cli.js"
entry="$BUNDLE/$ENTRY_REL"
vendor_dir="$BUNDLE/vendor/mermaid-cli"

if [ -n "${SKIP_VENDOR:-}" ]; then
  echo "  → 跳过 vendor/mermaid-cli（SKIP_VENDOR=1）"
  exit 0
fi

if [ -f "$entry" ] && [ -z "${FORCE_VENDOR:-}" ]; then
  echo "  ✓ vendor/mermaid-cli 已安装（跳过；FORCE_VENDOR=1 强制重装）"
  exit 0
fi

# Windows 侧命令入口：优先 PATH 上的 cmd.exe，其次 WSL 默认挂载点
cmd_exe="$(command -v cmd.exe || true)"
if [ -z "$cmd_exe" ] && [ -x /mnt/c/Windows/System32/cmd.exe ]; then
  cmd_exe=/mnt/c/Windows/System32/cmd.exe
fi
if [ -z "$cmd_exe" ]; then
  echo "  ⚠ 未找到 cmd.exe，跳过 vendor 安装（离线 Mermaid 渲染将不可用）" >&2
  exit 0
fi

# Windows npm：优先 bundle 同级便携 runtime 自带的 npm.cmd（D:\Tools\node-* 布局），
# 否则问 Windows PATH。两者都拿 WSL 路径，后面统一 wslpath -w 转换。
runtime="$(dirname "$BUNDLE")"
npm_wsl=""
if [ -f "$runtime/npm.cmd" ]; then
  npm_wsl="$runtime/npm.cmd"
else
  npm_from_where="$("$cmd_exe" /c "where npm.cmd" 2>/dev/null | head -1 || true)"
  if [ -n "$npm_from_where" ] && command -v wslpath >/dev/null 2>&1; then
    npm_wsl="$(wslpath -u "$npm_from_where")"
  fi
fi
if [ -z "$npm_wsl" ] || [ ! -f "$npm_wsl" ]; then
  echo "  ⚠ 未找到 Windows npm.cmd，跳过 vendor 安装（离线 Mermaid 渲染将不可用）" >&2
  exit 0
fi

if [ -n "${FORCE_VENDOR:-}" ]; then
  rm -rf "$vendor_dir"
fi
mkdir -p "$vendor_dir"
if [ ! -f "$vendor_dir/package.json" ]; then
  printf '{\n  "name": "mermaid-cli-vendor",\n  "private": true\n}\n' > "$vendor_dir/package.json"
fi

# 生成批处理执行安装：WSL→cmd 的 argv 编组会破坏内嵌双引号（cd /d "D:\..." 直接报
# 「volume label syntax is incorrect」），故把带引号的命令写进 .cmd 文件、只把文件路径
# 传给 cmd.exe（单一 token，无内嵌引号歧义）。批处理无 goto/call 标签，LF 即可，
# 统一转 CRLF 更稳（与 pack-bundle.sh 处理 setup.cmd 一致）。
npm_win="$(wslpath -w "$npm_wsl")"
installer="$vendor_dir/install.cmd"
printf '@echo off\r\nsetlocal\r\nset "PUPPETEER_SKIP_DOWNLOAD=1"\r\ncd /d "%%~dp0"\r\ncall "%s" install --no-audit --no-fund @mermaid-js/mermaid-cli\r\nexit /b %%errorlevel%%\r\n' "$npm_win" > "$installer"

echo "  → 首装 vendor/mermaid-cli（Windows npm，需联网，约 1-3 分钟）"
if ! "$cmd_exe" /c "$(wslpath -w "$installer")"; then
  echo "  ✗ vendor/mermaid-cli 安装失败（npm 退出码非 0）" >&2
  exit 1
fi
if [ ! -f "$entry" ]; then
  echo "  ✗ 安装后仍缺入口：$ENTRY_REL" >&2
  exit 1
fi
echo "  ✓ vendor/mermaid-cli 安装完成（离线 Mermaid 渲染就绪）"
