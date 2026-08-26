#!/usr/bin/env bash
#
# sync-bundle.sh —— 从本机（WSL/Linux）把源码改动直接同步进 Windows 上已解压的 bundle，
# 免去手工 copy。
#
# 关键点：bundle 用 hoisted 模式打包，每个 workspace 包在 bundle 里存在两份——
#   packages/<ws>         与  node_modules/<pkgname>
# 插件实际 import 的是 node_modules/<pkgname>，所以改了包必须两处都更新，否则不生效。
# 同步范围与 pack-bundle.sh 一致：拷贝整个包目录（src + package.json + tsconfig + test 等），
# 仅排除嵌套 node_modules；复刻 pack-bundle.sh 的 cp -rL（解引用软链）做法，整包为真实文件。
#
# 用法：
#   bash scripts/sync-bundle.sh
#   BUNDLE="/mnt/c/其它路径/opencode-sm-bundle-0.1.0" bash scripts/sync-bundle.sh
#
# 改完请重启 opencode 守护进程（关闭再开）让插件重新加载。
#
set -euo pipefail

# 脚本位于 opencode-session-mgmt/scripts/，切到仓库根
cd "$(dirname "$0")/.."
REPO="$(pwd)"

# 默认指向 Windows 测试 bundle（WSL 下 C:\ 挂在 /mnt/c）
BUNDLE="${BUNDLE:-/mnt/c/Users/User/Documents/My Tools/node-v22.23.2-win-x64/opencode-sm-bundle-0.1.0}"

if [ ! -d "$REPO/packages" ]; then
  echo "错误：找不到 \$REPO/packages（$REPO）" >&2
  exit 1
fi
if [ ! -d "$BUNDLE" ]; then
  echo "错误：找不到 BUNDLE 目录：$BUNDLE" >&2
  echo "  可用 BUNDLE=... 覆盖" >&2
  exit 1
fi

# 同步工具：优先 rsync（支持 --delete 镜像），否则回退 cp。
# 关键：-L 解引用符号链接，把软链目标作为真实文件拷入 bundle；--exclude node_modules
# 保护目标里可能存在的嵌套 node_modules 不被误删/覆盖。
# 复刻 pack-bundle.sh 的 cp -rL（解引用软链）做法：技术规范要求整包为真实文件，
# 否则跨机器/Windows 上符号链接易断链导致插件加载失败。
if command -v rsync >/dev/null 2>&1; then
  SYNC=(rsync -aL --delete --exclude node_modules)
else
  SYNC=(cp -rL)
fi

# 收集需校验“无符号链接”的目录
check_dirs=()

# workspace 包目录 → node_modules 导入名
ws_packages=(
  "shared:sm-shared"
  "plugin:sm-plugin"
  "cli:opencode-sm"
)

echo "Repo  : $REPO"
echo "Bundle: $BUNDLE"
echo "==> 同步 workspace 包（整个包目录，packages/<ws> 与 node_modules/<pkgname> 两处）"

for entry in "${ws_packages[@]}"; do
  ws="${entry%%:*}"
  name="${entry##*:}"
  src="$REPO/packages/$ws"
  [ -d "$src" ] || { echo "  跳过（源不存在）：$src"; continue; }

  if [ "${SYNC[0]}" = "rsync" ]; then
    "${SYNC[@]}" "$src/" "$BUNDLE/packages/$ws/"
    "${SYNC[@]}" "$src/" "$BUNDLE/node_modules/$name/"
  else
    # 回退：复刻 pack-bundle.sh 的 rm -rf + cp -rL
    rm -rf "$BUNDLE/packages/$ws" && cp -rL "$src" "$BUNDLE/packages/$ws"
    rm -rf "$BUNDLE/node_modules/$name" && cp -rL "$src" "$BUNDLE/node_modules/$name"
  fi
  check_dirs+=("$BUNDLE/packages/$ws" "$BUNDLE/node_modules/$name")
  echo "  ✓ packages/$ws  +  node_modules/$name"
done

echo "==> 同步 docs/（reqdoc 模板送达）"
if [ "${SYNC[0]}" = "rsync" ]; then
  "${SYNC[@]}" "$REPO/docs/" "$BUNDLE/docs/"
else
  rm -rf "$BUNDLE/docs" && cp -r "$REPO/docs" "$BUNDLE/docs"
fi
check_dirs+=("$BUNDLE/docs")
echo "  ✓ docs/"

echo "==> 校验：同步目录不应含符号链接（技术规范要求整包为真实文件）"
syms=$(find "${check_dirs[@]}" -type l 2>/dev/null || true)
if [ -n "$syms" ]; then
  echo "  ⚠ 发现符号链接（可能源自源码），请改为真实文件后重试：" >&2
  echo "$syms" >&2
  exit 1
else
  echo "  ✓ 无符号链接"
fi

echo ""
echo "✅ 同步完成。请重启 opencode 守护进程以重新加载插件。"
