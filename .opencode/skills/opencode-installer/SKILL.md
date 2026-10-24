---
name: opencode-installer
description: 打包 Windows 版 OpenCode 图形化安装包（portable-installer/build 下的 NSIS 脚本）。当用户说「重新打包」「打安装包」「出 OpenCode-Setup.exe」「installer 打包」「重新编译启动器」时使用。强制清缓存、重新提取载荷、同步依赖声明、完整重建，覆盖载荷同步、编译顺序、体积与编码校验、常见坑位。
---

# OpenCode Windows 安装包打包

> 本文件是迁入 opencode 仓库后的维护副本；如继续使用 `D:\projects\doc_process` 旧副本，请注意两边同步，避免路径规则漂移。

## 强制规则：先清缓存，再完整重建

每次执行「重新打包」都必须走完整流程，不复用旧载荷、旧 exe、旧缓存。只改一行文案也要重跑全部步骤，代价是多花十几分钟，换来产物与源目录一致、问题可复现。

禁止的省事做法：直接跑 `build.bat` 复用 `payload`；只重编 `OpenCode-launch.nsi`；保留上一次的 `OpenCode-Setup.exe`。

依赖声明同样不许滞后。`runtime\package.json` 的版本号必须与 `node_modules` 里的实装版本一致，每次重建都要核对；发现不一致就改源目录和载荷两处，再编译。

## 前置检查

1. NSIS 3.x 存在：优先 `C:\Program Files (x86)\NSIS\makensis.exe`，其次 `C:\Program Files\NSIS\`，最后 PATH。
2. 源目录齐全：`D:\Tools\node-v22.23.2-win-x64`、`D:\Tools\Python312`、`D:\Tools\terminal-1.23.20211.0`。可用 `SRC_NODE`、`SRC_PY`、`SRC_TERMINAL` 覆盖。
3. 三个 `.nsi` 保持 UTF-8 带 BOM，且脚本内 `Unicode true` 在位，否则安装界面中文乱码。
4. 空闲磁盘至少 5 GB，完整重建要同时容纳源目录、新载荷和压缩中间文件。

## 完整重建步骤

在仓库根目录依次执行。

> 必须在 Windows 本地盘符路径的仓库副本中执行；UNC 路径（`\\wsl.localhost\...`）不支持 `cmd.exe`、`robocopy` 和 NSIS。
>
> 从 WSL 仓库构建时，先在 Windows PowerShell 复制并保留 `portable-installer` 目录层级，同时复制本技能以便在副本中直接触发：
> ```powershell
> robocopy \\wsl.localhost\Ubuntu\data\opencode\portable-installer D:\Tools\opencode-build\portable-installer /E /XD payload
> robocopy \\wsl.localhost\Ubuntu\data\opencode\.opencode\skills\opencode-installer D:\Tools\opencode-build\.opencode\skills\opencode-installer /E
> cd D:\Tools\opencode-build
> ```
> 后续命令继续使用 `portable-installer\...`。

```powershell
# 1. 清构建产物与日志
Remove-Item portable-installer\build\OpenCode-Setup.exe,portable-installer\build\OpenCode-launch.exe,portable-installer\build\OpenCode-Reset.exe,portable-installer\build\_build.log -Force -ErrorAction SilentlyContinue

# 2. 清空整个载荷目录，避免旧文件残留
Remove-Item portable-installer\payload\OpenCode -Recurse -Force -ErrorAction SilentlyContinue

# 3. 从源目录重新提取 runtime / python / terminal
cmd /c portable-installer\build\sync_payload.bat

# 4. 清缓存（同步会从源目录带入）
Get-ChildItem portable-installer\payload\OpenCode -Recurse -Force -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -in @('__pycache__','.pytest_cache','.ruff_cache','.mypy_cache','.cache') } |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem portable-installer\payload\OpenCode -Recurse -Force -File -Include *.pyc,*.pyo -ErrorAction SilentlyContinue |
  Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem portable-installer\payload\OpenCode -Recurse -Force -Directory -Filter '.bin' -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem portable-installer\payload\OpenCode -Recurse -Force -File -Filter '*.bak-*' -ErrorAction SilentlyContinue |
  Remove-Item -Force -ErrorAction SilentlyContinue

# 5. 核对并更新依赖声明（见下节）
#    声明与实装不一致时，先改 D:\Tools 源目录，再改 payload 副本

# 6. 重新编译清空工具、启动器与主安装包
cmd /c portable-installer\build\build.bat
```

`sync_payload.bat` 用 robocopy `/E /PURGE /SL` 覆盖，并自动补 `python3.exe`、删除 `torch`、删除各 bundle 的 `node_modules/.bin` 符号链接。第 4 步再清一遍源目录带进来的 Python 缓存，避免把上千个 `__pycache__` 打进安装包。

## 依赖声明同步

载荷目录不是独立项目，`runtime\package.json` 只是清单。里面的版本号落后于实装版本，下一位维护者会按错版本排查。每次同步载荷后跑一遍核对：

```powershell
$rt='portable-installer\payload\OpenCode\runtime'
$declared = Get-Content "$rt\package.json" -Raw | ConvertFrom-Json
foreach($n in @('opencode-ai','opencode-sm','npm','corepack','bun','@mermaid-js/mermaid-cli')){
  $installed = (Get-Content "$rt\node_modules\$n\package.json" -Raw | ConvertFrom-Json).version
  "{0}: declared={1} installed={2}" -f $n,$declared.dependencies.$n,$installed
}
& "$rt\node_modules\opencode-ai\bin\opencode.exe" --version
```

处理规则：

- `opencode-ai` 用插入符跟随实装版本，例如 `^1.19.4`；`opencode.exe --version` 必须与之一致。
- `opencode-sm` 是本地打包产物，精确锁定实装版本，例如 `0.1.0`，不要写成 `^0.x` 让下游误以为可跨小版本升级。
- 其余依赖只在确实换过版本时改，不动无变化的声明。
- 先改源目录 `D:\Tools\node-v22.23.2-win-x64\package.json`，再同步到 `portable-installer\payload\OpenCode\runtime\package.json`；只改 payload 会在下次清空重建时被覆盖。
- 改完再跑第 6 步编译，确保进包的是新声明。

`build.bat` 先编 `OpenCode-Reset.exe`，再编 `OpenCode-launch.exe`，最后编内嵌载荷的 `OpenCode-Setup.exe`；任一步 `makensis` 返回非零立即 `exit /b 1`，不会留下看似成功的残缺包。

## 清空历史会话工具

`OpenCode-Reset.nsi` 编译出 `OpenCode-Reset.exe`，安装到 `%USERPROFILE%\OpenCode`，开始菜单「智能研发助手\清空历史会话」指向它。目标机没有 PowerShell，这个工具只用 NSIS 原生命令和系统 `tasklist.exe`，不调用脚本解释器。

行为：

- 检测不到会话库时提示后退出。
- `opencode.exe` 或 `opencode-sm.exe` 在运行时拒绝删除。
- 确认框默认“否”。
- 删除 `opencode.db*`、`snapshot\`、`tool-output\`、`repos\`、`prompt-history.jsonl`。
- 保留 `.config\opencode`、`model.json`、`kv.json`、`models.json` 和项目 `.opencode\session-mgmt.db`。
- 删除后复查 `opencode.db`，残留时明确报错。

修改删除范围时同步改 `OpenCode-Reset.nsi` 顶部 `!define SHARE` / `!define STATE` 和删除清单；`OpenCode-Setup.nsi` 只负责释放 exe 和建快捷方式。

## 耗时与中断

完整重建包含约 2 GB 载荷复制和 LZMA 固实压缩，合计十几分钟。压缩阶段没有中间进度输出，不要按 Ctrl+C。中断后从第 1 步重来，不要从中间续跑。

## 验收

1. 看时间戳：`OpenCode-Setup.exe`、`OpenCode-launch.exe`、`OpenCode-Reset.exe` 均晚于本次开始时间，且晚于对应 `.nsi`。
2. 看输出尾部：出现 `Output: "...\OpenCode-Setup.exe"` 与 `Using lzma (compress whole) compression` 即成功。
3. 看体积：启动器约 76 KB，清空工具约 65 KB；载荷低于 2 GiB（NSIS 上限），主包压后约 330 MB。量级明显偏离时先查载荷是否被误删或缓存未清。
4. 看残留：`portable-installer\payload\OpenCode\python` 下 `__pycache__` 计数应为 0，`runtime` 下 `opencode-windows-x64*` 目录计数应为 0。
5. 看可执行文件：`runtime\node_modules\opencode-ai\bin\opencode.exe` 必须存在（约 200 MB）。平台包删掉后，运行时只认这个文件。
6. 看声明：`runtime\package.json` 中 `opencode-ai`、`opencode-sm` 的版本与 `node_modules` 实装版本一致，`opencode.exe --version` 与声明一致。
7. 看清空工具：安装后开始菜单出现「清空历史会话」；点“否”数据不变；opencode 运行中执行会被拒绝；全部退出后执行，会话与快照消失，配置和项目工作流库保留。

## 常见坑位

- 载荷超 2 GiB 时先删 `opencode-ai\node_modules` 下的平台包，再考虑清理 `python\Lib\site-packages` 下无用大包，不要换压缩算法。
- `opencode-ai` 的平台包可能嵌在 `node_modules\opencode-ai\node_modules\` 下，不在顶层；同步脚本的第 6 步两处都要删。
- 符号链接（`node_modules/.bin`）NSIS 打不进去，必须在同步或清缓存阶段删除，不要手工加回。
- opencode 自动升级会留下 `opencode.exe.bak-*`（约 200 MB），同步脚本第 6 步已删；手工同步时必须清理，否则载荷逼近 2 GiB。
- `.bat` 必须 CRLF 换行。LF 换行的批处理会让 cmd 把相邻命令拼在一起，报出莫名其妙的「不是内部或外部命令」。
- `::` 注释里不要出现 `>` 或 `->`，cmd 会当成重定向；统一用 `rem`。
- 默认 baseURL、collector、模型名、上下文/输出上限都在 `OpenCode-Setup.nsi` 顶部的 `!define DEFAULT_*`，业务安装时仍可在弹窗改。
- 未签名 exe 首次运行会被 SmartScreen 拦一次，需点「更多信息 → 仍要运行」。
- 改动文件清单或默认参数后，同步更新 `portable-installer/OpenCode一键安装包方案.md`。
