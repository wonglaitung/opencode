# 启动器（`OpenCode-launch.exe`）

替代「双击命令行 + 手写配置」的图形入口：选项目目录、确认工作流、勾选插件，
点一下进入 opencode；同时提供会话交接与协作房间入口。

- **技术栈**：.NET 8 WinForms + WebView2，界面是 `index.html`（编译时作为
  `EmbeddedResource` 内嵌进 exe）。改界面必须重新 `dotnet publish` 并重打安装包。
- **不需要管理员**：所有写入都在用户目录。
- **不持有业务逻辑**：启动、配置写入、会话查询、交接文件操作都由 C# 调
  `launcher-config.js`、`opencode.cmd` 与 `opencode-team-share` 完成。

## 界面

### 启动向导

| 区域 | 功能 |
|---|---|
| 项目目录 | 输入或「浏览」；记住上次目录（`last_project.txt`） |
| 工作流 | 一般任务 / SDLC / REQDOC / WEB 安全自测，四选一；卡片显示当前说明，「查看使用说明」弹全文 |
| 启动设置 | 终端类型（原生 / 专用 Windows Terminal）、「继续上次会话」 |
| 插件 | 会话管理（默认）、Edge 调试、服务器调试；机器级生效 |
| 打开数字程序员 | 写配置 → 启动终端 → 关闭启动器 |

### 团队协作

顶部「团队协作」进入，三个 tab：

1. **导出会话**：搜索、项目筛选（含无 git 会话的目录分组）、时间范围（默认近 7 天）、
   排序、显示子会话、分页；填交接说明后导出 `.ocsave`。
2. **导入会话**：选文件后只读预览（来源、会话、消息数、说明），选目标项目与导入模式
   （接手继续 / 仅参考），导入成功后可直接打开该会话。
   导入要求 opencode 未运行（`tasklist` 检测），避免并发写库。
3. **协作房间**：主持人填写目录并可恢复上次会话（房间卡会提示先确认工作流）；
   访客粘贴邀请码、填昵称、选工作目录。

## 启动流程

1. 校验目录存在。
2. 调 `launcher-config.js --apply --home ... --root ... --terminal ... --plugins ... [--workflow ...]`
   写配置；失败则报错并取消启动。
3. 组装参数：
   - 恢复：命中数据库会话则 `--session <id>`；否则 `-c`。
   - 新会话：`--prompt` 注入启动短语（`启动一般任务` / `启动SDLC工作流` /
     `启动REQDOC工作流` / `启动 WEB 安全测试工作流`）。
   - 协作房间访客：不注入启动短语（`noPrompt`），避免消耗访客 token。
4. 用所选终端打开：原生直接启动 `runtime\opencode.cmd`；专用走
   `terminal\WindowsTerminal.exe -p "{0caa0dad-...}" -d <目录>`，固定 cmd.exe。
5. 写入 `last_project.txt` / `last_workflow.txt`，关闭启动器。

「继续上次会话」是否可用由数据库查询决定（按目录找最近会话），不再依赖文本记录；
恢复时工作流以数据库中的会话为准。

## 配置写入位置

| 文件 | 字段 |
|---|---|
| `~/.config/opencode/opencode.jsonc` | `plugin` 数组（服务端插件：sm / edge / server） |
| `~/.config/opencode/tui.json`（或 `.jsonc`） | `plugin` 数组（TUI 插件：collab-room 等） |
| `~/.config/opencode/session-mgmt/identity.json` | `workflowType` |
| `~/.config/opencode/terminal_mode.ini` | 首行 `native` / `dedicated` |
| `~/.config/opencode/last_project.txt`、`last_workflow.txt` | 上次选择 |

`launcher-config.js` 只改目标字段，其余内容原样保留；写前留 `.bak`，写后做 JSON 校验。
显式 `"plugin": []` 视为用户主动全关，不会被强行加回。

## 协作房间意图

开/加入房间时启动器向所选目录写 `.opencode/collab-room.json`，再启动 opencode：

- 主持：`{"mode":"host"}` — 插件据此在当前会话开房。
- 访客：`{"mode":"join","invite":"ws://...","name":"昵称"}` — 插件进房间视图。

文件 60 秒内有效，读取后立即删除，避免下一次普通启动误开房间；目录既是项目根，
子目录启动时插件也会在 `cwd` 下再找一次。

## 文件

```
launcher/
├── index.html      # 全部界面与前端逻辑（内嵌资源）
├── Program.cs      # WebView2 host、消息分发、启动与文件对话框
└── Launcher.csproj # 单文件 publish，嵌入 index.html / launcher-config.js
```

C# 消息类型：`init`、`browse`、`resume`、`launch`、`openHub`、`openScheduler`、
`teamListSessions`、`teamListProjects`、`teamBrowseFile`、`teamSaveFile`、`teamExport`、
`teamInspect`、`teamImport`、`teamOpenSession`、`teamOpenFolder`、`roomResume`、
`roomStart`、`roomJoin`、`cancel`。

## 开发与验证

- 界面改动：改 `index.html` → `dotnet publish launcher/Launcher.csproj` → 完整重打包
  （`index.html` 在内嵌资源里，不重编译不会生效）。
- 静态回归：`cd opencode-session-mgmt/packages/plugin && bun test test/launcher-text.test.ts`
  （断言按钮、字段、文案、NSIS 入口与帮助排版）。
- 手工冒烟：打开各工作流的帮助弹窗；导出/导入一条会话；开一次房间并确认侧栏出现邀请码。

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 界面空白 | 缺 WebView2 Runtime；装 Edge WebView2（Win10/11 通常自带） |
| 插件开关置灰 | `opencode.jsonc` 缺失或解析失败；重装或用 `OpenCode-Reset.exe` 后重配 |
| 工作流不可选 | `identity.json` 缺失或损坏；重新跑一次安装包配置页 |
| 启动后立刻退出 | 看 `~/.local/share/opencode/log/`；常见是 `runtime\opencode.cmd` 缺失 |
| 导入报「请先退出 opencode」 | 有 opencode.exe 在运行；退出后重试 |
| 房间页无内容 | 访客连上但主机无输出；看 `log/collab-room.log` |
