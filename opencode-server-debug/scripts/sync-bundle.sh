#!/usr/bin/env bash
#
# sync-bundle.sh —— 从本机（WSL/Linux）把 server-debug 插件源码改动镜像进 Windows 上已解压的插件目录，
# 免去手工 copy。
#
# 与 opencode-edge-debug 的 sync-bundle.sh 同型，但本工程是单插件（无 workspace 包双份）：
# 插件以 package.json 的 main=src/index.ts 被 OpenCode 直接加载，整份源码就是运行所需。
#
# 同步范围：镜像 src / test / package.json / README.md / AGENTS.md / bun.lock / .npmrc / docs。
# 必须保留不覆盖的项（用 --exclude 同时从传输与 --delete 中剔除）：
#   - node_modules：Windows 侧已用 hoisted 模式装好，真实文件，覆盖会破坏/误删
#   - setup.sh / setup.ps1：由 pack-bundle.sh 在打包时生成、源码仓库不含，删除会让目标机失去环境校验脚本
#   - dist：Windows 侧以 src 加载，本机 Linux 构建产物无意义；不推送
#
# 用法：
#   bash scripts/sync-bundle.sh
#   BUNDLE="/mnt/c/其它路径/opencode-server-debug-bundle-0.0.1" bash scripts/sync-bundle.sh
#
# 改完请重启 Windows 上的 opencode 守护进程（关闭再开）让插件重新加载。
#
set -euo pipefail

# 脚本位于 opencode-server-debug/scripts/，切到插件根
cd "$(dirname "$0")/.."
REPO="$(pwd)"

# 默认指向 Windows 测试 bundle（WSL 下 C:\ 挂在 /mnt/c）
BUNDLE="${BUNDLE:-/mnt/c/Users/User/Documents/My Tools/node-v22.23.2-win-x64/opencode-server-debug-bundle-0.0.1}"

if [ ! -d "$REPO/src" ]; then
  echo "错误：找不到 \$REPO/src（$REPO）" >&2
  exit 1
fi
if [ ! -d "$BUNDLE" ]; then
  echo "错误：找不到 BUNDLE 目录：$BUNDLE" >&2
  echo "  可用 BUNDLE=... 覆盖" >&2
  exit 1
fi

# 同步工具：优先 rsync（支持 --delete 镜像），否则回退 cp。
# -L 解引用符号链接（如本工程的 AGENTS.md -> CLAUDE.md），把软链目标作为真实文件拷入。
# --exclude 项既不被传输，也不被 --delete 删除（保护 Windows 侧 node_modules 与 setup 脚本）。
if command -v rsync >/dev/null 2>&1; then
  SYNC=(rsync -aL --delete \
    --exclude node_modules \
    --exclude dist \
    --exclude setup.sh \
    --exclude setup.ps1 \
    --exclude '.git')
else
  # 回退：cp -rL 整份后恢复被覆盖的保留项
  SYNC=(cp -rL)
fi

echo "Repo  : $REPO"
echo "Bundle: $BUNDLE"
echo "==> 镜像插件源码（保留 node_modules / setup.* 不被覆盖或删除）"

if [ "${SYNC[0]}" = "rsync" ]; then
  "${SYNC[@]}" "$REPO/" "$BUNDLE/"
else
  # 回退 cp：先备份保留项，整份覆盖后还原
  tmp="$(mktemp -d)"
  mv "$BUNDLE/node_modules" "$tmp/node_modules"
  mv "$BUNDLE/setup.sh" "$tmp/setup.sh" 2>/dev/null || true
  mv "$BUNDLE/setup.ps1" "$tmp/setup.ps1" 2>/dev/null || true
  rm -rf "$BUNDLE" && mkdir -p "$BUNDLE"
  cp -rL "$REPO/." "$BUNDLE/"
  rm -rf "$BUNDLE/node_modules" && mv "$tmp/node_modules" "$BUNDLE/node_modules"
  mv "$tmp/setup.sh" "$BUNDLE/setup.sh" 2>/dev/null || true
  mv "$tmp/setup.ps1" "$BUNDLE/setup.ps1" 2>/dev/null || true
  rm -rf "$tmp"
fi

echo "==> 校验：同步目录不应含符号链接（技术规范要求整包为真实文件）"
syms=$(find "$BUNDLE" -type l 2>/dev/null || true)
if [ -n "$syms" ]; then
  echo "  ⚠ 发现符号链接（可能源自源码），请改为真实文件后重试：" >&2
  echo "$syms" >&2
  exit 1
else
  echo "  ✓ 无符号链接"
fi

echo ""
echo "✅ 同步完成。请重启 Windows 上的 opencode 守护进程以重新加载插件。"
