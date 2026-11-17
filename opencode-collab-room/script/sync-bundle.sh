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

# 宿主的运行时模块改写用正则匹配 `from "x"`；压缩后会变成 `from"x"` 而匹配不到，
# 导致运行时找不到 solid-js。这里强制校验，避免再次打包出坏产物。
if grep -q 'from"solid-js"' dist/tui.js || ! grep -q 'from "solid-js"' dist/tui.js; then
  echo "错误：dist/tui.js 的 import 格式不利于宿主改写（需要 'from \"solid-js\"'）" >&2
  exit 1
fi

# 插件现在用 @opentui/core 的值导出（SyntaxStyle/RGBA）做 markdown 与 diff 渲染，
# 同样依赖宿主按 `from "x"` 的形式改写；压缩成 from"x" 会退回本地包而版本不一致。
if grep -q 'from"@opentui/core"' dist/tui.js || ! grep -q 'from "@opentui/core"' dist/tui.js; then
  echo "错误：dist/tui.js 的 @opentui/core import 格式不利于宿主改写（需要 'from \"@opentui/core\"'）" >&2
  exit 1
fi

# JSX 必须经过 OpenTUI 的 Solid 转换，产出 `get children()` 之类的反应式取值；
# 否则信号变化不会重绘，界面会一直停在首帧（消息列表与状态都不更新）。
if ! grep -q 'get children' dist/tui.js; then
  echo "错误：dist/tui.js 缺少 Solid 反应式 JSX（构建时需 createSolidTransformPlugin）" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST/dist"
cp package.json "$DEST/package.json"
cp dist/tui.js "$DEST/dist/tui.js"

echo "✅ 已同步到 $DEST"
echo "   下一步：运行 portable-installer/build/sync_payload.bat 重新同步载荷，再重打包安装器。"
