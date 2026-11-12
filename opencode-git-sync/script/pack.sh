#!/usr/bin/env bash
# 打包成可在其它机器直接解压安装的 tarball。
#   ./script/pack.sh  →  dist/opencode-git-sync-<version>.tgz
# 目标机器：
#   tar xzf opencode-git-sync-*.tgz && cd opencode-git-sync && ./install.sh --generate
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(python3 -c 'import json;print(json.load(open("package.json"))["version"])' 2>/dev/null || echo "0.0.0")"
NAME="opencode-git-sync-${VERSION}"
STAGE="$(mktemp -d)/${NAME}"
mkdir -p "$STAGE"

# 需要 bun 就先构建
if command -v bun >/dev/null 2>&1; then
  bun run build >/dev/null
fi
[[ -f dist/git-sync.ts ]] || { echo "缺少 dist/git-sync.ts，请先 bun run build" >&2; exit 1; }

cp install.sh install.ps1 README.md "$STAGE/"
cp dist/git-sync.ts "$STAGE/"
cp package.json "$STAGE/"
mkdir -p "$STAGE/script"
cp script/verify.ts "$STAGE/script/"
# 一并带上源码：目标机器既能跑 verify.ts，也能在需要时重新 build
cp -r src "$STAGE/src"
cp tsconfig.json "$STAGE/"

mkdir -p dist
tar -czf "dist/${NAME}.tgz" -C "$(dirname "$STAGE")" "$NAME"
echo "已打包: dist/${NAME}.tgz"
echo "目标机器: tar xzf ${NAME}.tgz && cd ${NAME} && ./install.sh --generate"
