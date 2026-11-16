#!/usr/bin/env bash
#
# 把协作房间插件的构建产物同步到 Windows 便携 runtime 源目录，
# 供 portable-installer/build/sync_payload.bat 随载荷一起打包。
#
# 用法：
#   bash script/sync-bundle.sh
#   bash script/sync-bundle.sh /mnt/d/其它路径/node-v22.23.2-win-x64
#
set -euo pipefail

cd "$(dirname "$0")/.."

SRC="${1:-/mnt/d/Tools/node-v22.23.2-win-x64}"
DEST="$SRC/opencode-collab-room"

if [ ! -d "$SRC" ]; then
  echo "错误：找不到 Windows runtime 源目录：$SRC" >&2
  echo "  可用第一个参数覆盖" >&2
  exit 1
fi

bun run build

rm -rf "$DEST"
mkdir -p "$DEST/dist"
cp package.json "$DEST/package.json"
cp dist/tui.js "$DEST/dist/tui.js"

echo "✅ 已同步到 $DEST"
echo "   下一步：运行 portable-installer/build/sync_payload.bat 重新同步载荷，再重打包安装器。"
