#!/usr/bin/env bash
#
# pack-bundle.sh —— 把 opencode-edge-debug 打成可移植的整包便携 tarball。
#
# 原理：
#   1. 确保使用 hoisted 链接模式（.npmrc 中 node-linker=hoisted），
#      使 bun install 生成真实文件拷贝而非硬链接/符号链接，目录可跨机器打包。
#   2. 清理旧 node_modules 并重新安装，保证所有依赖为真实文件。
#   3. 生成 setup.sh / setup.ps1 供目标机首次运行。
#   4. 打包为 dist/opencode-edge-debug-bundle-<version>.tgz。
#
# 与 opencode-session-mgmt 的 pack:bundle 对齐，但本工程是单插件：
# 无 workspace 包、无 CLI、无收集服务，故省略「补齐 workspace 包」步骤。
#
# 用法：
#   bash scripts/pack-bundle.sh
#   VERSION=0.1.0 bash scripts/pack-bundle.sh   # 覆盖版本号（默认读 package.json）
#
# 目标机使用：
#   tar xzf opencode-edge-debug-bundle-<version>.tgz
#   cd opencode-edge-debug-bundle-<version>
#   bash setup.sh                # Linux/macOS
#   # 或 PowerShell: .\setup.ps1  # Windows
#
set -euo pipefail

# 切到本工程根目录（本脚本位于 scripts/ 下）
cd "$(dirname "$0")/.."

# ---- 版本号 ----
version="${VERSION:-$(grep -m1 '"version"' package.json | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')}"
version="${version:-0.0.1}"
if [ "$version" = "0.0.0" ]; then
  echo "提示：当前版本为 0.0.0，可用 VERSION=x.y.z 覆盖"
fi

# ---- 检查 .npmrc ----
if [ ! -f .npmrc ] || ! grep -q 'node-linker=hoisted' .npmrc; then
  echo "错误：缺少 .npmrc 或其中不含 node-linker=hoisted" >&2
  echo "  请确保 .npmrc 文件存在且包含：node-linker=hoisted" >&2
  exit 1
fi

bundle_name="opencode-edge-debug-bundle-${version}"
bundle_dir="dist/${bundle_name}"

echo "==> 清理旧 node_modules"
rm -rf node_modules

echo "==> bun install（hoisted 模式）"
bun install

echo "==> 验证无符号链接"
symlinks=$(find node_modules -type l 2>/dev/null || true)
if [ -n "$symlinks" ]; then
  echo "警告：node_modules 中仍存在符号链接（可能影响跨机器移植）：" >&2
  echo "$symlinks" | head -5 >&2
  echo "  请检查 .npmrc 是否生效" >&2
fi

echo "==> 清理缓存文件以减小体积"
rm -rf node_modules/.cache
find node_modules -name "*.tsbuildinfo" -delete 2>/dev/null || true

echo "==> 组装打包目录"
rm -rf "$bundle_dir"
mkdir -p "$bundle_dir"

# 拷贝核心文件（含源码：插件经 opencode.json 指向 src/index.ts，bun 直接跑 TS）
cp package.json "$bundle_dir/"
cp bun.lock "$bundle_dir/"
cp .npmrc "$bundle_dir/"
cp -r src "$bundle_dir/"
cp -r test "$bundle_dir/"
cp README.md "$bundle_dir/"
cp CLAUDE.md "$bundle_dir/"

# 拷贝 node_modules（hoisted 模式，真实文件）
cp -r node_modules "$bundle_dir/"

# 排除构建产物与测试数据库
rm -rf "$bundle_dir/dist" 2>/dev/null || true
find "$bundle_dir" -name "*.db" -delete 2>/dev/null || true
find "$bundle_dir" -name "*.db-journal" -delete 2>/dev/null || true
find "$bundle_dir" -name "*.db-wal" -delete 2>/dev/null || true
find "$bundle_dir" -name "*.db-shm" -delete 2>/dev/null || true

# ---- 生成 setup.sh（Linux/macOS） ----
cat > "$bundle_dir/setup.sh" <<'SETUP_SH'
#!/usr/bin/env bash
#
# setup.sh —— 解压后的环境校验（可选运行）。
#
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
echo "解压目录：$here"

# 检查 bun
if command -v bun &>/dev/null; then
  echo "✓ bun 已安装：$(bun --version)"
else
  echo "⚠ bun 未安装。插件运行时需要 bun。"
  echo "  安装：curl -fsSL https://bun.sh/install | bash"
  echo "  或：npm install -g bun"
fi

# 检查 node_modules 完整性
if [ -d "$here/node_modules/@opencode-ai/plugin" ]; then
  echo "✓ @opencode-ai/plugin 存在"
else
  echo "⚠ @opencode-ai/plugin 不存在，依赖可能不完整"
  echo "  如有 bun 和网络，可运行：cd $here && bun install"
fi

# 检查 Edge（三大平台常见路径之一）
if [ -x "$(command -v microsoft-edge 2>/dev/null)" ] \
   || [ -x "$(command -v microsoft-edge-stable 2>/dev/null)" ] \
   || [ -x "$(command -v microsoft-edge-dev 2>/dev/null)" ] \
   || [ -d "/Applications/Microsoft Edge.app" ]; then
  echo "✓ Microsoft Edge 已安装"
else
  echo "⚠ 未检测到 Microsoft Edge。启动浏览器前需先安装 Edge。"
fi

echo ""
echo "配置 opencode.json 指向插件："
echo '  { "plugin": ["'"$here"'"] }'
SETUP_SH
chmod +x "$bundle_dir/setup.sh"

# ---- 生成 setup.ps1（Windows） ----
cat > "$bundle_dir/setup.ps1" <<'SETUP_PS1'
# setup.ps1 —— 解压后的环境校验（Windows，可选运行）。

$here = Split-Path -Parent $MyInvocation.MyCommand.Definition
Write-Host "解压目录：$here"

# 检查 bun
try {
    $bunVer = & bun --version 2>$null
    if ($bunVer) { Write-Host "✓ bun 已安装：$bunVer" }
    else { throw }
} catch {
    Write-Host "⚠ bun 未安装。插件运行时需要 bun。"
    Write-Host "  安装：npm install -g bun（需先有 node）"
}

# 检查 node_modules 完整性
if (Test-Path "$here\node_modules\@opencode-ai\plugin") {
    Write-Host "✓ @opencode-ai/plugin 存在"
} else {
    Write-Host "⚠ @opencode-ai/plugin 不存在"
    Write-Host "  如有 bun 和网络：cd $here; bun install"
}

Write-Host ""
Write-Host "配置 opencode.json 指向插件："
$pluginPath = $here -replace '\\', '/'
Write-Host "  { `"plugin`": [`"$pluginPath`"] }"
SETUP_PS1

# ---- 生成 README ----
cat > "$bundle_dir/README.md" <<EOF
# opencode-edge-debug-bundle ${version}

OpenCode 按需 Edge 浏览器调试插件（整包便携版）。

## 快速开始

### Linux/macOS

\`\`\`bash
bash setup.sh                              # 可选：校验环境
\`\`\`

### Windows

\`\`\`powershell
.\\setup.ps1                                # 可选：校验环境
\`\`\`

### 配置 OpenCode 加载插件

在 \`opencode.json\`（项目级或 \`~/.config/opencode/opencode.json\`）中添加：

\`\`\`json
{ "plugin": ["/解压路径"] }
\`\`\`

Windows 注意：JSON 中路径用正斜杠 \`/\` 或双反斜杠 \`\\\\\`。

## 依赖说明

本包使用 hoisted 模式安装依赖（\`node-linker=hoisted\`），所有包以真实文件形式
存在于 node_modules 中，无符号链接、无硬链接，可直接移动目录。

插件**运行期零依赖**（CDP 客户端用 bun 原生 WebSocket + fetch 实现），
node_modules 仅含编译期所需的 peer/dev 依赖。

如需重新安装依赖（例如升级版本）：

\`\`\`bash
cd <本目录>
rm -rf node_modules
bun install
\`\`\`
EOF

echo "==> 打包"
mkdir -p dist
tar czf "dist/${bundle_name}.tgz" -C dist "${bundle_name}"
rm -rf "$bundle_dir"

size=$(du -sh "dist/${bundle_name}.tgz" | cut -f1)
echo ""
echo "✅ 完成：dist/${bundle_name}.tgz（${size}）"
echo ""
echo "目标机使用："
echo "  tar xzf dist/${bundle_name}.tgz"
echo "  cd ${bundle_name}"
echo "  bash setup.sh              # 或 PowerShell: .\\setup.ps1"
echo "  # 然后在 opencode.json 中配置 plugin 路径指向 src/"