# opencode-open-ide 部署手册

## 1 环境要求

- 安装 opencode（TUI / 桌面版 / IDE 扩展均可——插件运行在 daemon 进程内，与界面无关）。
- 安装至少一个 IDE：
  - **VS Code**：安装后执行「Shell Command: Install 'code' command in PATH」（macOS 需手动装；Windows/Linux 一般自动入 PATH）。
  - **IntelliJ IDEA**：插件内置常见安装路径与版本化 glob 探测——linux `/opt/idea*/bin/idea.sh`、macOS `/Applications/IntelliJ IDEA.app`、Windows `Program Files\JetBrains\IntelliJ IDEA*\bin\idea64.exe` 及 Toolbox 目录，多数安装可**开箱即用**，无需配 PATH。特殊安装位置才需在 `config.json` 的 `tools` 里写绝对路径。

## 2 安装插件

在项目的 `opencode.json`（或全局 `~/.config/opencode/opencode.json`）的 `plugin` 中加入本插件目录：

```json
{
  "plugin": ["./opencode-open-ide"]
}
```

路径含 `.` 时确保有 `package.json`（入口取 `main: src/index.ts`）。Windows 注意路径用正斜杠 `/` 或双反斜杠 `\\`。

## 3 配置自定义次序与工具

编辑插件根目录的 `config.json`（本仓库已含默认：`order: ["vscode", "idea"]`）：

```json
{
  "order": ["idea", "vscode"],
  "tools": {
    "idea": { "binary": "/opt/idea/bin/idea.sh", "kind": "idea" },
    "cursor": { "binary": "cursor", "kind": "vscode" }
  }
}
```

- `order`：探测次序（缺省 vscode → idea）。
- `tools`：只放「覆盖」或「新增」，内置预设不写即用默认：
  - `idea` 是**覆盖示例**——内置已有 idea，这里覆盖 binary 为绝对路径；
  - `cursor` 是**新增示例**——不在内置 registry，经 tools 注册新工具；
  - `vscode` 未写在 tools 中，使用内置默认（binary `code`），无需写。
- `binary` 为 PATH 名或绝对路径，`kind` 仅 `vscode` / `idea`。
- **Windows 路径注意**：config.json 是 JSON，`\` 是转义符，**单反斜杠会破坏结构**（`\P` 解析失败、`\b`/`\n` 静默转成控制字符）。**请用正斜杠 `/` 或双反斜杠 `\\`**：
  ```json
  { "idea": { "binary": "C:/Program Files/JetBrains/IntelliJ IDEA/bin/idea64.exe", "kind": "idea" } }
  ```
- 修改 config.json 后重启 opencode 生效（插件加载时只读一次）。

## 4 使用

在 TUI 对话中让 AI 调用 `open_ide`：

```
开发者: 打开 IDE 看看，我要手改代码
Agent:   🖐 已用 vscode 打开 /home/dev/project。

开发者: 打开 src/main/java/com/example/A.java 第 42 行
Agent:   🖐 已用 vscode 打开 src/main/java/com/example/A.java:42。
```

人工改完后回到对话继续（如需与会话管理插件配合，可在审查阶段经 `comprehension_manual` 声明处理结果）。

## 5 验证

```bash
cd opencode-open-ide
bun test          # 16 个测试：config 合并 / 参数构造 / 探测顺序
bun run typecheck
```

冒烟验证：进 TUI → 让 AI「打开 IDE 定位到 src/index.ts:1」→ 确认 IDE 弹出并定位。若报「未找到可用的 IDE」，按错误提示补 PATH 或改 config.json。

## 6 排障

| 现象 | 原因与处理 |
|------|-----------|
| 报「未找到可用的 IDE」 | IDE 命令行工具不在 PATH，且常见安装路径探测未命中。装好 `code`；或把 `idea` 入 PATH；或 config.json 的 `tools` 写绝对路径 |
| 打开了但没定位到行 | 文件是相对路径且不存在于项目目录；确认 file 参数路径正确 |
| 指定 `ide` 报 id 不存在 | 该 id 不在 config.json 的 `order` 中；先加进 order 或用预设 id（vscode/idea） |
| win32 打开失败 | `code`/`idea` 是 `.cmd` shim，插件已用 `shell: true`；确认 PATH 含其安装 bin 目录 |

## 7 卸载

从 `opencode.json` 的 `plugin` 移除该目录，删除本目录即可完整还原；不修改任何上游文件。
