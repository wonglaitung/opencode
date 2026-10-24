# OpenCode 一键图形化安装包方案（含启动器）

> 面向非技术业务人员：双击安装包 → 弹窗填一次信息 → 完成；之后每次双击「智能研发助手」快捷方式 → 选一下项目目录 → 直接进 opencode。全程无需命令行、无需管理员权限、不依赖 PowerShell。
>
> **打包入口**：正式打包优先使用 `opencode-installer` 技能（`.opencode/skills/opencode-installer/SKILL.md`）。本文档第 6 节的 `build.bat` / `sync_payload.bat` 是技能内部调用的底层脚本，仅在技能不可用时手工兜底。

## 1. 背景与目标

当前 OpenCode 在 Windows 上的部署是手工方式（见 `task3/OpenCode在Windows上的安装手册.md`），步骤包括解压 Node.js 压缩包、配置 PATH、手写 `opencode.jsonc` / `.npmrc` / `identity.json` 三份配置。这套流程依赖技术人员，不适合直接交给业务人员。

本方案把整套运行环境（Node.js 工具链 + Python + 配置）打包成一个图形化安装包，并额外提供一个**启动器**，解决一个关键问题：opencode 的项目根目录（`ctx.directory`）由启动时的当前工作目录决定，而插件（reqdoc 扫描、校验、导出）全部基于这个根目录。因此快捷方式不能把工具安装目录或用户主目录当成项目根，必须由业务在打开时明确选择真正的项目目录。

## 2. 已锁定参数

| 项 | 取值 |
|---|---|
| 产品名称 | 智能研发助手（安装包显示名、快捷方式、终端标题；原称「数字员工」） |
| 安装包形态 | 主安装包 `OpenCode-Setup.exe`（NSIS，含卸载）+ 启动器 `OpenCode-launch.exe`（NSIS）+ 清空历史工具 `OpenCode-Reset.exe`（NSIS） |
| 安装根目录 | `%USERPROFILE%\OpenCode`（用户目录、路径无空格、无需管理员） |
| Node 工具链目录 | `%USERPROFILE%\OpenCode\runtime` |
| Python 目录 | `%USERPROFILE%\OpenCode\python`（含 `python3.exe` 别名） |
| 默认模型 | `athlon-coder`（含 `limit.context=1000000` / `limit.output=65536`） |
| 收集服务地址 | `http://<内网看板收集器地址>:<端口>`（占位，业务弹窗填真实地址） |
| 默认工作流 | `sdlc` |
| 弹窗填写项 | **分两页**：第 1 页（baseURL、API 密钥、默认模型名称、collector）；第 2 页（context、output、workflow、终端类型） |
| 终端类型 | 默认「原生终端」；可选「专用终端(OpenConsole)」；写入 `terminal_mode.ini` 为 ASCII 令牌（`native`/`dedicated`），用户可事后自行修改 |
| 项目目录 | **不随安装包分发**（方案②）：业务经网络盘/单独包已取得 doc_process 项目（含 `.claude/skills`、`工作要求.txt`、`raw/`、`00~07` 骨架），启动器每次打开时由业务选择 |
| 代码签名 | 先出**未签名包**；业务首次运行点「更多信息 → 仍要运行」即可，IT 可按需把 exe 哈希加进 Defender/AppLocker 允许列表 |

## 3. 安装包载荷

安装包内嵌以下已核实自包含的内容（均来自本机 `D:\Tools`）：

- `node-v22.23.2-win-x64` 整目录 → `runtime\`
  - 含 `node.exe` / `opencode` / `opencode-sm` 及三个 plugin bundle：`opencode-sm-bundle-0.1.0`、`opencode-edge-debug-bundle-0.0.1`、`opencode-server-debug-bundle-0.0.1`；无需 `npm install`
- `Python312` 整目录 → `python\`
  - 含 `pandas 2.3.2`、`openpyxl 3.1.5`，技能（如 md-to-word）可直接调用；并已补 `python3.exe` 别名
  - **已剔除 `torch`**：单文件 `Lib\site-packages\torch\lib\dnnl.lib` 体积 2.17 GB，超出 NSIS 单文件 2 GB 上限；且技能仅需 pandas/openpyxl，不依赖 torch
- `terminal-1.23.20211.0` 整目录 → `terminal\`
  - 含 `OpenConsole.exe`（Windows Terminal 命令行宿主）、`wt.exe`、字体、defaults.json 等完整终端环境；所有用户均部署，由 `terminal_mode.ini` 控制是否使用

> 载荷约 1.8 GB（另已剔除各 plugin bundle 内 `node_modules/.bin` 的 npm 符号链接——属构建期工具，opencode 运行时不调用，且符号链接无法被 NSIS 直接打包），已加入 `portable-installer/.gitignore`（忽略 `payload/` 与 `build/*.exe`），不入库。经 LZMA 固实压缩后，最终安装包 `OpenCode-Setup.exe` 约 330 MB。

## 4. 主安装包流程（`OpenCode-Setup.nsi`，免管理员）

1. 创建 `%USERPROFILE%\OpenCode`，复制 `runtime\` 与 `python\`，补 `python\python3.exe` 别名。
2. 弹窗分两页填写：
   - **第 1 页**：模型服务地址 `baseURL`、`API 密钥`（密码框掩码）、默认模型名称 `model`（默认 `athlon-coder`）、收集服务地址 `collector_url`
   - **第 2 页**：上下文长度上限 `limit.context`、输出长度上限 `limit.output`、工作流类型（下拉 `sdlc` / `reqdoc`）、终端类型（下拉「原生终端」/「专用终端(OpenConsole)」）
3. 写入三处配置 + 一个终端模式文件（路径在安装时展开为实际绝对路径）：模型名称取第 1 页「默认模型名称」输入框的值，并作为 `opencode.jsonc` 中唯一（即默认）模型写入。
    - `opencode.jsonc` → `%USERPROFILE%\.config\opencode\`
      ```jsonc
      {
        "$schema": "https://opencode.ai/config.json",
        "shell": "cmd.exe",
        "plugin": [
          "C:/Users/<用户名>/OpenCode/runtime/opencode-sm-bundle-0.1.0/packages/plugin",
          "C:/Users/<用户名>/OpenCode/runtime/opencode-edge-debug-bundle-0.0.1",
          "C:/Users/<用户名>/OpenCode/runtime/opencode-server-debug-bundle-0.0.1"
        ],
        "provider": {
          "athlon-coding": {
            "npm": "@ai-sdk/openai-compatible",
            "name": "athlon",
            "options": {
              "baseURL": "<填的baseURL>",
              "apiKey": "<填的apiKey>",
              "temperature": 0.1,
              "maxTokens": 16384,
              "topP": 0.9,
              "thinking": { "type": "disabled" }
            },
            "models": {
              "athlon-coder": {
                "name": "athlon-coder",
                "modalities": { "input": ["text", "image"], "output": ["text"] },
                "limit": { "context": "<填的context>", "output": "<填的output>" }
              }
            }
          }
        },
        "permission": {
          "read": "allow",
          "edit": "allow",
          "bash": "ask",
          "webfetch": "allow"
        }
      }
      ```
   - `.npmrc` → `%USERPROFILE%\.npmrc`：`offline=true`
    - `identity.json` → `%USERPROFILE%\.config\opencode\session-mgmt\`
      ```json
       { "apiKey": "<填的apiKey>", "collector_url": "<填的collector_url>", "workflowType": "sdlc" }
      ```
    - `terminal_mode.ini` → `%USERPROFILE%\.config\opencode\terminal_mode.ini`
      ```ini
      native
      ; mode: native | dedicated (edit this file to switch terminal)
      ```
      启动器每次启动时读取首行决定终端类型（`native` 或 `dedicated`）；用户可直接编辑此文件切换，无需重装。
4. 当前用户 PATH（HKCU）追加两条：`%USERPROFILE%\OpenCode\runtime`、`%USERPROFILE%\OpenCode\python`。
5. 部署 `OpenCode-launch.exe` 与 `OpenCode-Reset.exe` 到 `%USERPROFILE%\OpenCode\`。
6. 桌面 + 开始菜单「智能研发助手」快捷方式 → `%USERPROFILE%\OpenCode\OpenCode-launch.exe`；开始菜单同一文件夹下另建「清空历史会话」→ `%USERPROFILE%\OpenCode\OpenCode-Reset.exe`。
7. 生成卸载程序（删目录、去 PATH、删配置、删两个开始菜单快捷方式）。

## 4.1 清空历史会话工具（`OpenCode-Reset.exe`）

重装不会删除 `%USERPROFILE%\.local\share\opencode`，旧会话会一直留在 `/sessions`。这个工具提供独立入口，不依赖 PowerShell，也不改启动器。

- 开始菜单「智能研发助手\清空历史会话」，确认框默认按钮为“否”。
- 检测到 `opencode.exe` 或 `opencode-sm.exe` 在运行就拒绝执行。
- 删除 `opencode.db` 及 `-wal`/`-shm`/`-journal`、`snapshot\`、`tool-output\`、`repos\`、`prompt-history.jsonl`。
- 保留 `.config\opencode`、`model.json`、`kv.json`、`models.json`、项目 `.opencode\session-mgmt.db`。
- 清除范围是所有项目共用的会话库；不做备份，确认框已写明不可恢复。

## 5. 启动器流程（`OpenCode-launch.exe`，方案②）

用 NSIS 的 nsDialogs 画一个原生页面（不调用 PowerShell/VBScript，零运行时依赖，不受 PowerShell 禁用影响）：

- 目录选择框（`DirRequest` 控件，系统级 dialog）和「浏览」按钮；下方是工作流、终端类型和三个插件开关，底部按钮「打开 OpenCode」。
- 打开前读取当前配置回填：工作流取 `identity.json` 的 `workflowType`（缺省 `sdlc`），终端取 `terminal_mode.ini` 首行（缺省 `native`），插件状态取 `opencode.jsonc` 的 `plugin` 数组。
- 点「打开 OpenCode」时才写配置：工作流写回 `identity.json`，终端写回 `terminal_mode.ini`，插件只替换 `opencode.jsonc` 的 `plugin` 数组，其余字段原样保留。写前留 `.bak`，失败弹窗并取消启动。
- 工作流和终端都是不可编辑下拉菜单。终端「原生」直接 `Exec opencode.cmd -c`，使用系统控制台；「专用」用 `Exec OpenConsole.exe cmd /c "title 智能研发助手 && opencode.cmd -c"`，使用打包的 Windows Terminal，退出即关。两种模式都以 `-c` 启动，自动续接上次对话。
- 关闭「会话管理」插件时工作流菜单置灰；插件开关是机器级设置，对所有项目生效。配置文件缺失或无法解析时，插件开关置灰并提示重装；`identity.json` 缺失时工作流不可选。
- `SetOutPath` 设为所选目录 → **该目录即项目根 `ctx.directory`**，reqdoc 扫描/导出/技能全部基于此。
- 所选目录须为业务已取得的 doc_process 项目（含 `.claude/skills`、`工作要求.txt`、`raw/`、`00~07` 骨架）；安装包不负责分发这些项目文件。
- 上次目录写入 `%USERPROFILE%\.config\opencode\last_project.txt`，下次打开预填（仍可改）。
- 用户可随时直接编辑 `terminal_mode.ini` 切换终端类型，无需重装。

> 之所以不直接把快捷方式指向 `opencode.cmd` 并写死 start-in，是因为业务的项目目录不固定；启动器把「选目录」这一步固化进打开动作，保证根目录永远正确。

## 6. 构建步骤（优先使用 `opencode-installer` 技能）

> **首选方式：直接使用 `opencode-installer` 技能，不要手工逐步执行。** 在 opencode 里说「重新打包」「打安装包」「出 OpenCode-Setup.exe」即可触发。技能位于 `.opencode/skills/opencode-installer/SKILL.md`，会强制执行：清空旧载荷与旧 exe → 重新同步载荷 → 清理 Python 缓存、符号链接和自动升级备份 → 核对依赖声明 → 按序编译 → 验收时间戳、体积、版本与残留。只改一行文案也要完整重建，避免复用旧缓存导致产物与源码不一致。
>
> 技能必须在 **Windows 本地盘符路径**的仓库副本中运行；`cmd.exe`、`robocopy`、NSIS 都不支持 UNC 路径。从 WSL 仓库打包时，先在 Windows PowerShell 复制并保留 `portable-installer` 目录层级：
> ```powershell
> robocopy \\wsl.localhost\Ubuntu\data\opencode\portable-installer D:\Tools\opencode-build\portable-installer /E /XD payload
> robocopy \\wsl.localhost\Ubuntu\data\opencode\.opencode\skills\opencode-installer D:\Tools\opencode-build\.opencode\skills\opencode-installer /E
> cd D:\Tools\opencode-build
> ```
> 然后在 opencode 中打开 `D:\Tools\opencode-build` 并触发技能。后续命令均使用 `portable-installer\...`。
>
> 前置条件：NSIS 3.x（优先 `C:\Program Files (x86)\NSIS\makensis.exe`）；`D:\Tools\node-v22.23.2-win-x64`、`D:\Tools\Python312`、`D:\Tools\terminal-1.23.20211.0` 齐全（可用 `SRC_NODE` / `SRC_PY` / `SRC_TERMINAL` 覆盖）；空闲磁盘至少 5 GB。产物为 `portable-installer\build\OpenCode-Setup.exe`。

### 6.1 技能内部调用的脚本

`portable-installer\build\` 下两个脚本由技能调用，也可在技能不可用时手工兜底：

- **`sync_payload.bat`** — 从源目录重新同步载荷到 `portable-installer\payload\OpenCode`，并自动完成裁剪：同步 Node → Python → Windows Terminal，补 `python3.exe`、剔 `torch`、剔各 bundle 的 `node_modules/.bin` 符号链接。源目录可用环境变量 `SRC_NODE` / `SRC_PY` / `SRC_TERMINAL` 覆盖。
- **`build.bat`** — 自动定位 NSIS（ProgramFiles / PATH），依次编 `OpenCode-Reset.exe`、`OpenCode-launch.exe`、`OpenCode-Setup.exe`。**任一 `makensis` 编译失败会立即报错并退出（exit /b 1），不会产出残缺的 exe。**
- **编码注意**：三个 `.nsi` 必须保存为 **UTF-8 带 BOM**，且脚本头部已声明 `Unicode true`，否则安装页面中文会变成乱码。用其他编辑器改完请确认仍是「UTF-8 含 BOM」。

技能不可用时的兜底流程（仍需先清空旧载荷和旧 exe）：

```powershell
Remove-Item portable-installer\payload\OpenCode -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item portable-installer\build\OpenCode-Setup.exe,portable-installer\build\OpenCode-launch.exe,portable-installer\build\OpenCode-Reset.exe -Force -ErrorAction SilentlyContinue
cmd /c portable-installer\build\sync_payload.bat
cmd /c portable-installer\build\build.bat
```

> 兜底流程只重建脚本产物，不包含技能里的缓存清理、依赖声明核对和完整验收；正式交付仍应走技能。

### 6.2 手工编译（仅调试，不用于交付）

仅在排查 NSI 语法时使用；手工编译不会清理载荷和缓存，产物不能作为最终交付包。

1. 载荷由 `sync_payload.bat` 生成到 `portable-installer\payload\OpenCode`（`payload/` 不入库）。
2. 安装 NSIS 3.x（官方源 https://nsis.sourceforge.io/ ，本站已装于 `C:\Program Files (x86)\NSIS`）。PATH 维护用 NSIS 自带的 `StrFunc`/`WordFunc`（无需额外 `EnvVarUpdate.nsh`）。
3. 按序编译（清空工具和启动器先出，主包再内嵌）：
   ```
   cd portable-installer\build
   "C:\Program Files (x86)\NSIS\makensis.exe" OpenCode-Reset.nsi    ; 产出 OpenCode-Reset.exe
   "C:\Program Files (x86)\NSIS\makensis.exe" OpenCode-launch.nsi   ; 产出 OpenCode-launch.exe
   "C:\Program Files (x86)\NSIS\makensis.exe" OpenCode-Setup.nsi    ; 嵌入载荷 + 两个 exe → OpenCode-Setup.exe (~330MB)
   ```
4. （可选）用内部证书对两 exe 签名；未签名则业务首次运行点「仍要运行」。

## 7. 测试

- 干净机（无 Node/Python/opencode）：装主包 → 填第 1 页（baseURL / API 密钥 / collector / workflow）→ 下一步 → 填第 2 页（context / output / 终端类型）→ 完成 → 双击启动器 → 选一个**已有的 doc_process 项目目录** → 确认：
  - `python` / `python3` 命令可用；
  - 模型可正常对话；
  - 会话能上报 `123.33.13.9:9090`；
  - reqdoc 扫描/导出基于所选项目根目录；
  - `native` 模式：opencode 在系统默认控制台中运行；
  - `dedicated` 模式：opencode 在打包的 Windows Terminal 窗口中运行，退出即关；
  - `terminal_mode.ini` 为 ASCII 编码（`native` 或 `dedicated`），人可阅读、可改。
  - 启动器回填当前工作流、终端和插件状态；改完点「打开 OpenCode」后按选择写入，点「取消」或关闭窗口不写入。
  - 插件开关全局生效；关掉「会话管理」后工作流菜单置灰，重新勾选并打开可恢复，`identity.json` 的 `workflowType` 不会被改动。
  - **路径验证**：检查 `%USERPROFILE%\.config\opencode\opencode.jsonc` 中的 plugin 路径为实际绝对路径（如 `C:/Users/xxx/OpenCode/runtime/...`），不含 `%USERPROFILE%` 字面量。
  - **清空历史会话**：开始菜单入口存在；点“否”后 `opencode.db` 不变；opencode 运行中执行被拒绝；全部退出后执行，会话与快照消失，`.config\opencode` 与项目 `session-mgmt.db` 保留。

## 8. 备注与权衡

- `runtime` 用稳定名而非版本号目录，升级 node 时只需覆盖该目录，PATH 与 plugin 路径不变。
- 模型列表仅预置 `athlon-coder`（含 `limit.context`/`limit.output`），业务启动后 `/models` 可自行增改。
- `baseURL` 默认值由打包方在 NSIS 脚本常量中设定（业务弹窗可改）。
- 载荷体量较大（node + python 合计数 GB），靠 LZMA 固实压缩；如需更小可剔除 Python 的 `__pycache__`/`test` 与 node 多余 dev 依赖。
- 多用户共用一台机器时每人一份完整副本（单人单机场景影响可忽略）。
- 清空历史会话删除所有项目共用的会话库，不备份；配置、模型设置和项目工作流库不动。
- 未签名 exe 会被 SmartScreen 拦一次（未知发布者），点「仍要运行」即可；若组织策略硬性禁止未签名程序，需 IT 把 exe 哈希加进允许列表。

## 9. 交付物清单

| 文件 | 说明 |
|---|---|
| `portable-installer/OpenCode一键安装包方案.md` | 本方案文档 |
| `portable-installer/build/OpenCode-Setup.nsi` | 主安装脚本 |
| `portable-installer/build/OpenCode-launch.nsi` | 启动器脚本（构建中间产物，已内嵌进主包） |
| `portable-installer/build/launcher-config.js` | 启动器配置助手（编译时内嵌，读写 `identity.json`、`terminal_mode.ini` 与 `opencode.jsonc`） |
| `portable-installer/build/OpenCode-Reset.nsi` | 清空历史会话工具脚本（构建中间产物，已内嵌进主包） |
| `.opencode/skills/opencode-installer/SKILL.md` | **首选打包入口**：强制清缓存、完整重建、依赖核对与验收 |
| `portable-installer/payload/OpenCode/runtime` | Node 工具链载荷 |
| `portable-installer/payload/OpenCode/python` | Python 载荷（含 `python3.exe`） |
| `portable-installer/payload/OpenCode/terminal` | Windows Terminal 载荷（`OpenConsole.exe`，所有用户均部署） |
| `OpenCode-Setup.exe`（构建产物） | **唯一需要分发给业务的文件**：内置载荷 + 启动器 + 清空历史工具，双击即装 |

> **交付与安装只需一个文件**：业务侧只分发并双击 `OpenCode-Setup.exe` 即可。`OpenCode-launch.exe` 与 `OpenCode-Reset.exe` 是构建中间产物，已被主安装包内嵌并释放到 `%USERPROFILE%\OpenCode\`，桌面/开始菜单的「智能研发助手」快捷方式指向启动器，开始菜单的「清空历史会话」指向重置工具，无需单独安装或分发。安装后双击「智能研发助手」快捷方式 → 选项目目录 → 进 opencode。
>
> 项目目录里的 `doc_process` 文件（`.claude/skills`、`工作要求.txt`、`raw/`、`00~07` 骨架）仍按方案②另行取得，安装包不负责分发。
