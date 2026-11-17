# portable-installer

把 OpenCode 及其整套运行环境打包成 Windows 图形化安装包（产品名「数字程序员」）：
双击安装、无需管理员、无需命令行，装完从快捷方式选项目目录即可使用。

本目录负责**打包**，不包含 OpenCode 源码。完整的背景、参数与历史决策见
[`OpenCode一键安装包方案.md`](./OpenCode一键安装包方案.md)（启动器部分已过时，
以 [`launcher/README.md`](./launcher/README.md) 为准）。

## 产物

| 文件 | 作用 | 说明 |
|---|---|---|
| `OpenCode-Setup.exe` | 主安装包（约 440 MB） | NSIS 3，内嵌 payload；首次安装时弹窗填写 API、模型、收集服务地址、默认工作流与终端类型 |
| `OpenCode-launch.exe` | 启动器 | .NET 8 WinForms + WebView2 + 内嵌 HTML；选目录/工作流/插件/终端并启动，另有「团队协作」三页 |
| `OpenCode-Scheduler.exe` | 定时任务 | 托盘常驻，按计划在后台执行 opencode `run`；见 [`scheduler/README.md`](./scheduler/README.md) |
| `OpenCode-Reset.exe` | 清空历史 | 删除本机会话库与日志，保留配置 |

## 目录

```
portable-installer/
├── launcher/              # 启动器（C# + index.html），见 launcher/README.md
├── scheduler/             # 定时任务（C#），见 scheduler/README.md
├── build/                 # NSIS 脚本、launcher-config.js、sync_payload.bat
├── payload/               # 构建时由 sync_payload 生成，不入库
├── OpenCode一键安装包方案.md
└── README.md
```

## 安装布局

安装根目录固定为 `%USERPROFILE%\OpenCode`（路径无空格、无需管理员）：

| 路径 | 内容 |
|---|---|
| `runtime\` | Node.js 22 工具链、`opencode.exe`、`opencode-sm`、插件 bundle（sm / edge / server / collab-room）、team-share |
| `python\` | Python 3.12（pandas、openpyxl；已剔除 torch，单文件超 NSIS 2 GB 上限） |
| `terminal\` | Windows Terminal（专用终端使用其中的 `WindowsTerminal.exe`） |
| `opencode.jsonc` / `tui.json` | 插件注册（server 插件看前者，TUI 插件只看后者） |
| `OpenCode-*.exe` | 启动器、定时任务、清空工具 |

用户配置与数据在 `%USERPROFILE%\.config\opencode\` 与 `%USERPROFILE%\.local\share\opencode\`，
不在安装目录内，卸载/重装不丢会话。

## 构建

优先使用 `opencode-installer` 技能（`.opencode/skills/opencode-installer/SKILL.md`），
它会强制清缓存、重新提取载荷、校验并完整重建。手工兜底步骤见方案文档第 6 节。

关键约束：

- 构建目录用 `D:\Tools\opencode-build\portable-installer`，由仓库 `portable-installer` robocopy 过去；
  排除 `payload`、`bin`、`obj`、`publish` 与旧 exe。
- `dotnet` 不在 PATH，需 `$env:PATH = 'D:\Tools\dotnet;' + $env:PATH`；NSIS 在
  `C:\Program Files (x86)\NSIS\makensis.exe`。
- PowerShell 5.1 驱动脚本只用 ASCII；`.nsi` 必须 UTF-8 **带 BOM** 且 `Unicode true`；
  `.bat` 不允许 BOM，且必须 CRLF（`rebuild.ps1` 会校验）。
- `Tee-Object` 日志是 UTF-16LE，读取时用 `iconv -f UTF-16LE`。
- 载荷合计约 1.7 GB，接近 NSIS 单文件 2 GB 上限；不要加回 torch 或重复平台包。

## 验收清单

`rebuild.ps1` 会输出并通过以下检查：

- `encoding-ok`：`.bat` 无 BOM、CRLF；`.nsi` 有 BOM 且 `Unicode true`
- `collab-room-bundle-ok`：`payload\OpenCode\runtime\opencode-collab-room\dist\tui.js` 存在
- 依赖声明与实装一致（opencode-ai / opencode-sm / npm / corepack / bun）
- `opencode.exe --version` 可执行
- `build-ok`：NSIS 编译成功

打包后建议再抽查：

- `payload` 内无 `__pycache__`、`opencode-windows-x64*` 重复平台包
- 抽检新字符串（启动器 `index.html` 内嵌于 `OpenCode-launch.exe`，插件在 `tui.js`）
- 四个 exe 复制回仓库 `build/` 存档，并同步安装机上的 `OpenCode-launch.exe` 与
  `runtime\opencode-collab-room\dist\tui.js`

## 测试

启动器的静态回归断言在 `opencode-session-mgmt/packages/plugin/test/launcher-text.test.ts`
（直接读 `launcher/index.html`、`Program.cs` 与 NSIS 脚本）：

```bash
cd opencode-session-mgmt/packages/plugin && bun test test/launcher-text.test.ts
```

插件自身的测试在各目录内，例如 `opencode-collab-room`、`opencode-team-share` 的 `bun test`。
