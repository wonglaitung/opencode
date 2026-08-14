#!/usr/bin/env bash
#
# pack-bundle.sh —— 把 opencode-open-ide 打成可移植的整包便携 tarball。
#
# 原理：
#   1. 确保使用 hoisted 链接模式（.npmrc 中 node-linker=hoisted），
#      使 bun install 生成真实文件拷贝而非硬链接/符号链接，目录可跨机器打包。
#   2. 清理旧 node_modules 并重新安装，保证所有依赖为真实文件。
#   3. 生成 setup.sh / setup.ps1 供目标机首次运行。
#   4. 打包为 dist/opencode-open-ide-bundle-<version>.tgz。
#
# 与 opencode-edge-debug 的 pack:bundle 对齐（单插件工程，无 workspace 包）。
#
# 用法：
#   bash scripts/pack-bundle.sh
#   VERSION=0.1.0 bash scripts/pack-bundle.sh   # 覆盖版本号（默认读 package.json）
#
# 目标机使用：
#   tar xzf opencode-open-ide-bundle-<version>.tgz
#   cd opencode-open-ide-bundle-<version>
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

bundle_name="opencode-open-ide-bundle-${version}"
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
cp tsconfig.json "$bundle_dir/"
cp config.json "$bundle_dir/"
cp -r src "$bundle_dir/"
cp -r test "$bundle_dir/"
cp -r docs "$bundle_dir/"
cp AGENTS.md "$bundle_dir/"

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

# 检查 IDE（VS Code / IntelliJ，至少其一）
has_ide=false
if command -v code &>/dev/null; then has_ide=true; fi
if command -v idea &>/dev/null || command -v idea.sh &>/dev/null; then has_ide=true; fi
if [ -x "/opt/idea/bin/idea.sh" ] || ls -d /opt/idea-*/bin/idea.sh &>/dev/null; then has_ide=true; fi
if [ -d "/Applications/IntelliJ IDEA.app" ]; then has_ide=true; fi
if [ "$has_ide" = true ]; then
  echo "✓ 检测到 IDE（code 命令行工具或常见安装路径下的 IDEA）"
else
  echo "⚠ 未检测到 code / idea。运行 open_ide 前需安装 IDE；"
  echo "  IDEA 多数安装（/opt、Program Files、Toolbox）会被插件自动探测，"
  echo "  特殊位置才需在 config.json 的 tools 中指定 binary 绝对路径。"
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
# opencode-open-ide-bundle ${version}

OpenCode 打开 IDE 插件（整包便携版）。

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

## 配置自定义次序与工具

编辑本目录下的 \`config.json\`：

\`\`\`json
{
  "order": ["vscode", "idea"],
  "tools": {
    "cursor": { "binary": "cursor", "kind": "vscode" },
    "idea": { "binary": "/opt/idea/bin/idea.sh", "kind": "idea" }
  }
}
\`\`\`

- \`order\`：IDE 探测次序（缺省 vscode → idea）。
- \`tools\`：只放「覆盖」或「新增」，内置预设不写即用默认：
  - \`idea\` 是**覆盖示例**——内置已有 idea，这里覆盖 binary 为绝对路径；
  - \`cursor\` 是**新增示例**——不在内置 registry，经 tools 注册新工具；
  - \`vscode\` 未写在 tools 中，使用内置默认（binary \`code\`），无需写。
- \`binary\` 为 PATH 名或绝对路径，\`kind\` 仅 \`vscode\` / \`idea\`。
- **Windows 路径注意**：config.json 是 JSON，\`\\\` 是转义符，**单反斜杠会破坏结构**（\`\\P\` 解析失败、\`\\b\`/\`\\n\` 静默转成控制字符）。**请用正斜杠 \`/\` 或双反斜杠 \`\\\\\`**：
  \`\`\`json
  { "idea": { "binary": "C:/Program Files/JetBrains/IntelliJ IDEA/bin/idea64.exe", "kind": "idea" } }
  \`\`\`
- 修改后重启 opencode 生效（插件加载时只读一次）。

## 依赖说明

本包使用 hoisted 模式安装依赖（\`node-linker=hoisted\`），所有包以真实文件形式
存在于 node_modules 中，无符号链接、无硬链接，可直接移动目录。

插件**运行期零依赖**（定位/启动全部用 bun/node 原生 API），
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
echo "  # 然后在 opencode.json 中把 plugin 指向解压目录（根 package.json 的 main 指向 src/index.ts）"
