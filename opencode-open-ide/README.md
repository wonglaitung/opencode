# opencode-open-ide

OpenCode 打开 IDE 插件：用自然语言让 Agent 拉起本机 **VS Code / IntelliJ IDEA**，
打开项目目录或定位到指定文件的指定行，方便开发者人工查看/修改 AI 生成的代码。
带**人工文件锁**，防止 AI 在开发者手工修改期间覆盖改动。零运行时依赖、跨平台（win32 / darwin / linux）。

## 功能

| 工具 | 说明 |
|---|---|
| `open_ide` | 打开 IDE（默认按 config.json 顺序探测 VS Code → IDEA）；指定 `file` 时自动锁定该文件，可选 `line`/`column` 精确定位。**不指定 file 只开目录、不锁定** |
| `lock_file` | 人工文件锁：开发者声明某文件由自己接管，AI 不得修改 |
| `unlock_file` | 解锁（须开发者明确确认 `developer_confirmed=true` 才生效） |
| `list_locked_files` | 查看当前会话锁定清单 |

典型用法（直接在 OpenCode 会话中说）：

- 「打开 IDE」→ 打开项目目录，**不锁定任何文件**
- 「打开 src/main/java/com/example/A.java，我自己改」→ 打开并**自动锁定该文件**
- 「我改完了，可以继续」→ 由 AI 调用 `unlock_file` 解锁并继续

如需精确定位，可让 AI 打开指定行（可选）：「打开 A.java 第 42 行，我自己改」。

> 注意：**只有指定文件才会自动锁定**。仅说「打开 IDE」不会锁定，此后的改动仍可能被 AI 覆盖——要保护某个文件，必须让它打开具体文件或显式 `lock_file`。

## 人工文件锁

开发者打开文件手工修改时，该文件被自动锁定。锁定期间：

- AI **仍可继续其它任务**（改其它文件、答疑、推进阶段）——锁是按文件的，不是会话暂停；
- AI 对被锁文件的 `write` / `edit` / `apply_patch` 会被**服务端硬拦截**（不靠模型自觉）；
- 改完说「改完了」，由 AI 调用 `unlock_file` 解锁，并重新读取最新内容后继续。

## 前置条件

- 已安装至少一个 IDE：
  - **VS Code**：安装后执行「Shell Command: Install 'code' command in PATH」；
  - **IntelliJ IDEA**：插件内置常见安装路径与版本化 glob 探测（`/opt/idea*/`、`/Applications/IntelliJ IDEA.app`、`Program Files\JetBrains\...`、Toolbox），多数安装开箱即用，无需配 PATH。

## 启用

在项目的 `opencode.json` 中加入：

```json
{
  "plugin": ["./opencode-open-ide"]
}
```

首次使用前在本目录安装开发依赖（运行期无依赖，仅 peer/dev 依赖）：

```bash
cd opencode-open-ide
bun install
```

移除该条目即可完全卸载，不改变上游任何行为。

> 从零到能用的完整安装、验证与排查见 [docs/deployment.md](./docs/deployment.md)。

## 配置自定义次序与工具

编辑插件根目录的 `config.json`（默认 `order: ["vscode", "idea"]`）：

```json
{
  "order": ["vscode", "idea"],
  "tools": {
    "cursor": { "binary": "cursor", "kind": "vscode" },
    "idea": { "binary": "/opt/idea/bin/idea.sh", "kind": "idea" }
  }
}
```

- `order`：IDE 探测次序。
- `tools`：只放「覆盖」或「新增」，内置预设不写即用默认——`cursor` 是**新增示例**、`idea` 是**覆盖示例**、`vscode` 未写即用内置默认。
- `kind` 仅 `vscode`（`-g file:line:col` 定位）或 `idea`（`--line n --column n file` 定位）。
- **Windows 路径注意**：config.json 是 JSON，`\` 是转义符，请用正斜杠 `/` 或双反斜杠 `\\`。

## 开发

```bash
bun test              # 测试（零 mock，注入假探针验证探测/提取/拦截）
bun run typecheck     # tsc 类型检查
bun run pack:bundle   # 打成可移植 tarball → dist/opencode-open-ide-bundle-<版本>.tgz
```

- 工程规约见 [CLAUDE.md](./AGENTS.md)；架构与决策记录见 [docs/design.md](./docs/design.md)。
- 与会话管理插件的协作契约（时序/职责/局限）见 [docs/manual-edit-loop.md](./docs/manual-edit-loop.md)。
- 跨插件通用开发规范见 [../opencode-session-mgmt/docs/plugin-dev-guide.md](../opencode-session-mgmt/docs/plugin-dev-guide.md)。

## 隐私

仅在本机 `spawn` IDE 进程，不产生任何网络请求、不读取/上行项目代码；锁只记文件路径字符串。IDE 进程由用户掌控，插件不注入内容、不捕获其输出。

## 已知限制（v1）

- 不经 `open_ide`/`lock_file` 的手改不受保护（插件不读磁盘文件，无法感知外部编辑）。
- `bash` 工具的写操作（如 `echo > file`）无法拦截。
- 锁内存级，daemon 重启即失。
