#!/usr/bin/env bash
#
# pack-bundle.sh —— 把 opencode-session-mgmt 工作区打成可移植的整包便携 tarball。
#
# 原理：
#   1. 确保使用 hoisted 链接模式（.npmrc 中 node-linker=hoisted），
#      使 bun install 生成真实文件拷贝而非硬链接/符号链接，目录可跨机器打包。
#   2. 清理旧 node_modules 并重新安装，保证所有依赖为真实文件。
#   3. 删除非必要缓存文件以减小体积。
#   4. 生成 setup.sh / setup.ps1 供目标机首次运行。
#   5. 打包为 dist/opencode-sm-bundle-<version>.tgz。
#
# 用法：
#   bash scripts/pack-bundle.sh
#   VERSION=0.1.0 bash scripts/pack-bundle.sh   # 覆盖版本号
#
# 目标机使用：
#   tar xzf opencode-sm-bundle-<version>.tgz
#   cd opencode-sm-bundle-<version>
#   bash setup.sh                # Linux/macOS
#   # 或 PowerShell: .\setup.ps1  # Windows
#
set -euo pipefail

# 切到 opencode-session-mgmt 根目录（本脚本位于 scripts/ 下）
cd "$(dirname "$0")/.."

# ---- 版本号 ----
version="${VERSION:-$(grep -m1 '"version"' packages/cli/package.json | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')}"
version="${version:-0.0.0}"
if [ "$version" = "0.0.0" ]; then
  echo "提示：当前版本为 0.0.0，可用 VERSION=x.y.z 覆盖"
fi

# ---- 检查 .npmrc ----
if [ ! -f .npmrc ] || ! grep -q 'node-linker=hoisted' .npmrc; then
  echo "错误：缺少 .npmrc 或其中不含 node-linker=hoisted" >&2
  echo "  请确保 .npmrc 文件存在且包含：node-linker=hoisted" >&2
  exit 1
fi

bundle_name="opencode-sm-bundle-${version}"
bundle_dir="dist/${bundle_name}"

echo "==> 清理旧 node_modules"
rm -rf node_modules
rm -rf packages/*/node_modules

echo "==> bun install（hoisted 模式）"
# 某些 bun 版本在 hoisted 模式下链接 workspace 包时报 EINVAL（WSL / 部分 Linux 已知），
# 但外部依赖仍安装成功。容错此错误，后续手动补齐 workspace 包。
if ! bun install; then
  echo "警告：bun install 报错（可能为 workspace EINVAL），将尝试补齐 workspace 包后继续" >&2
fi

echo "==> 补齐 workspace 包到 node_modules"
# 在 hoisted 模式下，外部依赖已扁平安装至根 node_modules/；
# 但 workspace 包（sm-shared / sm-plugin / opencode-sm / opencode-sm-collector）
# 可能因 EINVAL 未被链接。手动以真实文件拷贝替代，确保打包后可跨机器使用。
for ws_pkg in shared plugin cli collector; do
  pkg_dir="packages/${ws_pkg}"
  if [ ! -d "$pkg_dir" ]; then
    continue
  fi
  pkg_name=$(grep -m1 '"name"' "${pkg_dir}/package.json" | sed 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
  if [ -z "$pkg_name" ]; then
    echo "警告：无法读取 ${pkg_dir}/package.json 的 name，跳过" >&2
    continue
  fi
  # 移除 bun 可能创建的空目录或符号链接
  rm -rf "node_modules/${pkg_name}"
  # 以真实文件拷贝方式放入 node_modules（-r 递归，-L 解引用符号链接）
  cp -rL "$pkg_dir" "node_modules/${pkg_name}"
  echo "  ✓ ${pkg_name} → node_modules/${pkg_name}"
done

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

# 拷贝核心文件
cp package.json "$bundle_dir/"
cp bun.lock "$bundle_dir/"
cp .npmrc "$bundle_dir/"
cp -r packages "$bundle_dir/"

# 让 bundle 根 package.json 兼作插件入口（与 edge-debug 一致，opencode 可直接指 bundle 根）。
# 只改 bundle 里的副本，源码根 package.json 不动。
bundle_main="packages/plugin/src/index.ts"
BUNDLE_MAIN="$bundle_main" BUNDLE_PKG="$bundle_dir/package.json" bun -e '
  const fs = require("node:fs");
  const p = process.env.BUNDLE_PKG;
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  j.main = process.env.BUNDLE_MAIN;
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
'

# 拷贝 node_modules（hoisted 模式，真实文件）
cp -r node_modules "$bundle_dir/"

# 排除构建产物和测试数据库
rm -rf "$bundle_dir/dist" 2>/dev/null || true
find "$bundle_dir" -name "*.db" -delete 2>/dev/null || true
find "$bundle_dir" -name "*.db-journal" -delete 2>/dev/null || true
find "$bundle_dir" -name "*.db-wal" -delete 2>/dev/null || true
find "$bundle_dir" -name "*.db-shm" -delete 2>/dev/null || true

# ---- 生成 seed/（内网离线依赖种子） ----
# 背景：opencode 配置插件后，启动会对各 config 目录执行 install(dir,{add:[@opencode-ai/plugin]})；
# 其幂等判定只需 node_modules 存在 + package-lock.json 根 packages[""].dependencies 含 @opencode-ai/plugin。
# 内网机无法联网 npm、无 registry 镜像，故在打包机一次性生成种子随包分发，setup.cmd 只做拷贝。
# 详见 docs/plugin-dev-guide.md 内网部署小节。
seed_dir="$bundle_dir/seed"
mkdir -p "$seed_dir/node_modules/@opencode-ai"

# 1) @opencode-ai/plugin 真实拷贝（版本与 bundle 一致；checkDirty 只按包名比对，版本无关）
cp -rL "$bundle_dir/node_modules/@opencode-ai/plugin" "$seed_dir/node_modules/@opencode-ai/plugin"

# 2) 从 bundle 自身读版本（不依赖 npm/网络；与 pack-bundle.sh 读 CLI 版本的写法一致）
sdk_version=$(grep -m1 '"version"' "$seed_dir/node_modules/@opencode-ai/plugin/package.json" | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
sdk_version="${sdk_version:-0.0.0}"

# 3) 最小但正确的 package-lock.json（checkDirty 只读 packages[""].dependencies 的包名；不 reify 就不会跑 npm ci）
cat > "$seed_dir/package-lock.json" <<EOF
{
  "lockfileVersion": 3,
  "packages": {
    "": {
      "dependencies": {
        "@opencode-ai/plugin": "${sdk_version}"
      }
    },
    "node_modules/@opencode-ai/plugin": {
      "version": "${sdk_version}"
    }
  }
}
EOF

# 4) package.json（与上述 lock 一致）
cat > "$seed_dir/package.json" <<EOF
{
  "dependencies": {
    "@opencode-ai/plugin": "${sdk_version}"
  }
}
EOF

echo "  ✓ seed/ 生成完毕（@opencode-ai/plugin@${sdk_version}）"

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
  echo "⚠ bun 未安装。插件需要 bun 运行时。"
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

if [ -d "$here/node_modules/zod" ]; then
  echo "✓ zod 存在"
else
  echo "⚠ zod 不存在（插件加载将失败）"
  echo "  如有 bun 和网络，可运行：cd $here && rm -rf node_modules && bun install"
fi

echo ""
echo "配置 opencode.json 指向插件（直接指向本目录即可）："
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
    Write-Host "⚠ bun 未安装。插件需要 bun 运行时。"
    Write-Host "  安装：npm install -g bun（需先有 node）"
}

# 检查 node_modules 完整性
if (Test-Path "$here\node_modules\@opencode-ai\plugin") {
    Write-Host "✓ @opencode-ai/plugin 存在"
} else {
    Write-Host "⚠ @opencode-ai/plugin 不存在"
    Write-Host "  如有 bun 和网络：cd $here; bun install"
}

if (Test-Path "$here\node_modules\zod") {
    Write-Host "✓ zod 存在"
} else {
    Write-Host "⚠ zod 不存在（插件加载将失败）"
    Write-Host "  如有 bun 和网络：cd $here; Remove-Item -Recurse node_modules; bun install"
}

Write-Host ""
Write-Host "配置 opencode.json 指向插件（直接指向本目录即可）："
$pluginPath = $here -replace '\\', '/'
Write-Host "  { `"plugin`": [`"$pluginPath`"] }"
SETUP_PS1

# ---- 生成 setup.cmd（Windows，纯 cmd，内网机主用） ----
cat > "$bundle_dir/setup.cmd" <<'SETUP_CMD'
@echo off
chcp 65001 >nul
setlocal EnableExtensions
rem setup.cmd —— 内网离线部署：设开关 + 预填 @opencode-ai/plugin 依赖种子（纯 cmd，无需 PowerShell）。
rem
rem 背景：opencode 配置插件后，启动会对各 config 目录执行依赖安装，内网机无法联网而卡约 2 分钟。
rem 本脚本把 bundle 内 seed/ 拷贝进 config 目录，让安装判定变为 no-op；并设
rem OPENCODE_DISABLE_PROJECT_CONFIG=1 让项目 .opencode 退出安装列表（只需种全局一处）。
rem 代价：项目级 opencode.json（agents/modes/commands）不再加载；插件不受影响。
rem
rem 用法：
rem   setup.cmd                 设开关 + 种全局 config 目录 + ~/.opencode（若存在）
rem   setup.cmd seed <项目目录>  为指定项目的 .opencode 补种（仅保留项目级配置时用；不设开关）
rem
rem 撤销开关：setx OPENCODE_DISABLE_PROJECT_CONFIG ""

set "HERE=%~dp0"
set "SEED=%HERE%seed"

if not exist "%SEED%\node_modules\@opencode-ai\plugin" (
  echo 错误：bundle 内缺少 seed\node_modules\@opencode-ai\plugin，包可能不完整。
  exit /b 1
)

rem ---- 兜底：setup.cmd seed <项目目录> ----
if /i "%~1"=="seed" (
  call :seed_target "%~2"
  echo 项目 .opencode 已种：%~2
  exit /b 0
)

rem ---- 默认：设开关 + 种全局 + 种 home ----
rem setx 持久化（只影响之后新开的进程）；set 让当前窗口立即生效，便于立刻验证。
set "OPENCODE_DISABLE_PROJECT_CONFIG=1"
setx OPENCODE_DISABLE_PROJECT_CONFIG 1 >nul 2>&1
echo [1/3] 已设置 OPENCODE_DISABLE_PROJECT_CONFIG=1（持久化；撤销：setx OPENCODE_DISABLE_PROJECT_CONFIG ""）

call :seed_target "%USERPROFILE%\.config\opencode"
echo [2/3] 全局 config 目录已种：%USERPROFILE%\.config\opencode

if exist "%USERPROFILE%\.opencode" (
  call :seed_target "%USERPROFILE%\.opencode"
  echo [2/3] ~/.opencode 已种
)

echo [3/3] 完成。打开 opencode 应秒开；日志不应再出现 "background dependency install failed"。
exit /b 0

:seed_target
rem 把 seed 铺进 %1（目标 config 目录），幂等。
set "T=%~1"
if not exist "%T%\node_modules" mkdir "%T%\node_modules"
if not exist "%T%\node_modules\@opencode-ai" mkdir "%T%\node_modules\@opencode-ai"
xcopy /E /I /Y /Q "%SEED%\node_modules\@opencode-ai\plugin" "%T%\node_modules\@opencode-ai\plugin" >nul 2>&1
copy /Y "%SEED%\package.json" "%T%\package.json" >nul 2>&1
copy /Y "%SEED%\package-lock.json" "%T%\package-lock.json" >nul 2>&1
exit /b 0
SETUP_CMD
# cmd.exe 对 LF-only 批处理配合 call :label / goto 有兼容问题，统一转 CRLF 行尾
sed -i 's/$/\r/' "$bundle_dir/setup.cmd"

# ---- 生成 README ----
cat > "$bundle_dir/README.md" <<EOF
# opencode-sm-bundle ${version}

OpenCode 会话管理整包便携版：插件 + CLI + 收集服务 + 依赖。

## 快速开始

### Linux/macOS

\`\`\`bash
bash setup.sh                              # 可选：校验环境
\`\`\`

### Windows

内网/离线环境（纯 cmd）建议用 \`setup.cmd\`（自动设依赖种子 + 启动开关，见下方「内网部署」）：

\`\`\`cmd
setup.cmd
\`\`\`

有 PowerShell 的环境也可用 \`setup.ps1\`（仅环境校验）：

\`\`\`powershell
.\\setup.ps1
\`\`\`

## 内网部署（纯 cmd，无网络）

内网机配置插件后启动慢（约 1-2 分钟）的原因：opencode 启动时会对各 config 目录联网安装
插件 SDK \`@opencode-ai/plugin\`，内网无法联网而卡住。本 bundle 已内置离线种子 \`seed/\`：

\`\`\`cmd
cd /d 解压目录
setup.cmd                 # 设 OPENCODE_DISABLE_PROJECT_CONFIG=1 + 种全局 config 目录依赖
\`\`\`

之后打开 opencode 即秒开。注意：该开关会让项目级 opencode.json（agents/modes/commands）
不再加载（插件不受影响）。若某项目必须保留项目级配置，可用 \`setup.cmd seed <项目目录>\`
为该项目 .opencode 补种依赖。撤销开关：\`setx OPENCODE_DISABLE_PROJECT_CONFIG ""\`

### 配置 OpenCode 加载插件

在 \`opencode.json\`（项目级或 \`~/.config/opencode/opencode.json\`）中添加：

\`\`\`json
{ "plugin": ["/解压路径"] }
\`\`\`

Windows 注意：JSON 中路径用正斜杠 \`/\` 或双反斜杠 \`\\\\\`。

## 依赖说明

本包使用 hoisted 模式安装依赖（\`node-linker=hoisted\`），所有包以真实文件形式
存在于 node_modules 中，无符号链接、无硬链接，可直接移动目录。

如需重新安装依赖（例如升级版本）：

\`\`\`bash
cd <本目录>
rm -rf node_modules packages/*/node_modules
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
echo "  bash setup.sh              # Linux/macOS（环境校验）"
echo "  setup.cmd                  # Windows 内网/纯 cmd：设开关 + 种全局 config 目录依赖"
echo "  # 然后在 opencode.json 中配置 plugin 路径指向解压目录"
