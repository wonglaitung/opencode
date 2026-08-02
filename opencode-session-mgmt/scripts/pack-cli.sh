#!/usr/bin/env bash
#
# pack-cli.sh —— 把 opencode-sm CLI 打成可用 `npm install <压缩包>` 安装的 tarball。
#
# 原理：
#   1. `bun build --compile` 出**自包含单二进制**（内嵌 Bun 运行时，目标机无需 node/bun）。
#   2. 组装一个最小 npm 包目录 dist/pkg/<target>/：package.json（bin 指向二进制）+ bin/ + README。
#   3. `npm pack` 产出 opencode-sm-<version>-<target>.tgz，拷到目标机执行
#      `npm install -g ./opencode-sm-<version>-<target>.tgz` 即得全局命令 opencode-sm。
#
# 用法：
#   bash scripts/pack-cli.sh [target]      # target 缺省 = 当前机器平台
#   VERSION=0.1.0 bash scripts/pack-cli.sh # 覆盖版本号（默认读 packages/cli/package.json）
#
# 支持的 target：linux-x64 / linux-arm64 / darwin-x64 / darwin-arm64 / windows-x64
#
set -euo pipefail

# 切到 opencode-session-mgmt 根目录（本脚本位于 scripts/ 下）
cd "$(dirname "$0")/.."

# ---- 解析目标平台 ----
req_target="${1:-}"
if [ -z "$req_target" ]; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)  req_target="linux-x64" ;;
    Linux-aarch64) req_target="linux-arm64" ;;
    Darwin-arm64)  req_target="darwin-arm64" ;;
    Darwin-x86_64) req_target="darwin-x64" ;;
    *) echo "无法自动识别平台，请显式传 target（如 linux-x64）" >&2; exit 1 ;;
  esac
fi

case "$req_target" in
  linux-x64)    bun_target="bun-linux-x64";    os="linux";  cpu="x64";   ext="" ;;
  linux-arm64)  bun_target="bun-linux-arm64";  os="linux";  cpu="arm64"; ext="" ;;
  darwin-x64)   bun_target="bun-darwin-x64";   os="darwin"; cpu="x64";   ext="" ;;
  darwin-arm64) bun_target="bun-darwin-arm64"; os="darwin"; cpu="arm64"; ext="" ;;
  windows-x64)  bun_target="bun-windows-x64";  os="win32";  cpu="x64";   ext=".exe" ;;
  *) echo "未知 target：$req_target（支持 linux-x64/linux-arm64/darwin-x64/darwin-arm64/windows-x64）" >&2; exit 1 ;;
esac

# ---- 版本号：默认读 CLI 包，可用环境变量 VERSION 覆盖 ----
version="${VERSION:-$(node -p "require('./packages/cli/package.json').version")}"
if [ "$version" = "0.0.0" ]; then
  echo "提示：当前版本为 0.0.0，可用 VERSION=x.y.z 覆盖（如 VERSION=0.1.0 bash scripts/pack-cli.sh）"
fi

bin_name="opencode-sm$ext"
pkg_dir="dist/pkg/$req_target"

echo "==> 构建二进制：target=$req_target（$bun_target），版本=$version"
rm -rf "$pkg_dir"
mkdir -p "$pkg_dir/bin"
bun build packages/cli/src/index.ts --compile --target="$bun_target" --outfile "$pkg_dir/bin/$bin_name"

echo "==> 组装 npm 包目录：$pkg_dir"
cat > "$pkg_dir/package.json" <<EOF
{
  "name": "opencode-sm",
  "version": "$version",
  "description": "OpenCode 会话管理 CLI：五阶段门禁 / 理解保障 / 效能分析（Token ROI、返工率）",
  "bin": {
    "opencode-sm": "bin/$bin_name"
  },
  "os": ["$os"],
  "cpu": ["$cpu"]
}
EOF

cat > "$pkg_dir/README.md" <<EOF
# opencode-sm

OpenCode 会话管理独立 CLI（\`opencode-sm\`）：init / tag / workflow / stats / list。

本包内置自包含二进制，安装机无需 node / bun 运行时。

## 安装

\`\`\`bash
npm install -g ./opencode-sm-$version-$req_target.tgz
\`\`\`

## 首次使用

\`\`\`bash
opencode-sm init   # 交互四问：账号 / 组 / 组织 / 收集服务地址
opencode-sm --help
\`\`\`
EOF

echo "==> npm pack"
# 打到 dist/ 下，再加上平台后缀以便多平台共存
npm pack "$pkg_dir" --pack-destination dist >/dev/null
packed="dist/opencode-sm-$version.tgz"
final="dist/opencode-sm-$version-$req_target.tgz"
mv -f "$packed" "$final"

echo ""
echo "✅ 完成：$final"
echo "   目标机安装：npm install -g ./$final"
echo "   （安装后全局可用 opencode-sm；先跑一次 opencode-sm init）"
