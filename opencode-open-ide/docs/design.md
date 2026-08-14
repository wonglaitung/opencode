# opencode-open-ide 设计文档

OpenCode 打开 IDE 插件：以自然语言驱动「打开 IDE → 打开项目目录或定位到文件行 → 开发者人工修改」的闭环，零运行时依赖，对上游零修改。

## 1 概述

```mermaid
flowchart LR
    A[Agent 自然语言指令] --> B[OpenCode 工具层]
    B --> C[index.ts 插件入口]
    C --> D[config.ts 读取 config.json]
    D --> E[presets.ts 内置 registry]
    E --> F[ide.ts 二进制定位 + 参数构造]
    F -->|spawn detached + unref| G[IDE 进程]
```

插件注册一个工具 `open_ide`（见 4）。流程：
读取插件根 `config.json`（合并内置预设）→ 按 `order` 探测可用 IDE → 构造定位参数 → `spawn` 拉起，返回中文结果供 Agent 回显。

## 2 配置与预设

### 2.1 config.json 位置与语义

配置文件放**插件目录根**（`import.meta.dir` 上溯一层），用户直接编辑：

```json
{
  "order": ["vscode", "idea"],
  "tools": {
    "cursor": { "binary": "cursor", "kind": "vscode" },
    "idea": { "binary": "/opt/idea/bin/idea.sh", "kind": "idea" }
  }
}
```

**tools 的语义：只放「覆盖」或「新增」，内置预设不写即用默认。** 上例中：
- `cursor` 是**新增示例**——不在内置 registry（`src/presets.ts` 只内置 vscode + idea），经 `tools` 注册新工具，kind 沿用 vscode 定位语法；
- `idea` 是**覆盖示例**——内置已有 `idea`，这里覆盖其 binary 为绝对路径（同 id 覆盖时 binary/kind 均生效）；
- `vscode` 未出现在 tools 中——使用内置默认（`binary: code`），无需写，写了反而冗余。

- `order`：探测优先级，缺省 `["vscode", "idea"]`。
- `kind` 仅允许 `"vscode" | "idea"`，决定定位参数语法；binary 可为 PATH 名或绝对路径。

> **Windows 路径警告**：config.json 是 JSON，`\` 是转义符——单反斜杠会破坏结构。`\P` 等非法转义导致解析失败回退预设；`\b`/`\n` 等合法转义会被静默转成控制字符（路径错但解析"成功"）。**请用正斜杠 `/`（Windows 原生接受），或双反斜杠 `\\`**。例：`"binary": "C:/Program Files/JetBrains/IntelliJ IDEA/bin/idea64.exe"`。

**兜底**：文件缺失/字段缺失 → 内置预设；无效 JSON 记 warning 回退默认，不崩溃。插件加载时只读一次。

### 2.2 内置预设（决策记录 D1）

| id | binary（按平台候选） | kind | 文件定位参数 |
|----|----------------------|------|-------------|
| `vscode` | `code` | vscode | `-g <path>:<line>[:<col>]` |
| `idea` | 见下方（PATH 名 + 常见绝对安装路径 + 版本化 glob） | idea | `--line <n> [--column <n>] <path>` |

idea 候选覆盖三类安装形态（候选含 `*` 时按 glob 展开取首个命中）：
- **PATH 名**：`idea` / `idea.sh`（darwin、linux）、`idea64.exe` / `idea.cmd`（win32）；
- **常见绝对路径**：linux `/opt/idea/bin/idea.sh`、darwin `/Applications/IntelliJ IDEA.app/Contents/MacOS/idea`、win32 `Program Files\JetBrains\IntelliJ IDEA*\bin\idea64.exe` 等；
- **版本化 glob**：`/opt/idea-*/bin/idea.sh`、`~/.local/share/JetBrains/Toolbox/apps/IDEA-U/ch-0/*/bin/idea.sh`、win32 `Users\*\AppData\Local\JetBrains\Toolbox\apps\IDEA-U\ch-0\*\bin\idea64.exe` 等。

只内置最小集（vscode + idea）；其余 IDE 经 `tools` 自行新增，避免 registry 膨胀。

### 2.3 探测与解析

按 `order` 逐项取 `tools` 覆盖后的候选：
- 含 `*` → `Bun.Glob` 展开取首个命中（零依赖）；
- 含 `/`、`\` 或 `~` 前缀 → `~` 展开 HOME 后查存在性；
- 否则 `which`（posix）/ `where`（win32）查 PATH。

第一个命中启用，命中返回**解析后的真实可执行路径**（供 spawn 直接用）；全部未命中抛中文错误含安装指引。探测函数可注入以便测试。

## 3 进程与平台

- posix：`spawn(binary, args, { cwd: directory, detached: true, stdio: "ignore" })` + `unref()`——自成进程组、daemon 不挂起。
- win32：`code`/`idea` 经 `.cmd` shim，须 `shell: true` 才能解析；含空格的参数手动加双引号，避免被 shell 拆词。
- **dispose 不杀 IDE**：IDE 由用户自主关闭，不同于 Edge 调试实例（对比 `opencode-edge-debug` 的 `killProcessTree` 兜底）。

## 4 工具定义

| 工具名 | 入参 | 行为 |
|--------|------|------|
| `open_ide` | `file?: string`（相对项目目录或绝对路径）、`line?: number`、`column?: number`、`ide?: string`（强制指定 id） | 探测可用 IDE，打开项目目录或定位到文件行，回显「已用 X 打开 Y」 |

## 5 健壮性与降级

- 可预期失败抛 `OpenIdeError`：中文消息附修复路径（安装指引、config.json binary 配置建议）。
- config.json 解析失败仅记 warning 回退默认，不阻断插件加载。
- 无任何状态需清理：不持句柄、不留后台任务，插件卸载无副作用。

## 6 安全与隐私

- 仅在本机 `spawn` IDE 进程，不产生任何网络请求、不读取/上行代码。
- 不读取项目文件内容；只把 `file` 参数拼进 IDE 定位参数。
- IDE 进程由用户掌控，插件不注入内容、不捕获其输出。

## 7 v1 限制与未来扩展

- 单 IDE 同时探测（order 取第一个命中）；未来可支持 `ide` 强制参数逐项重试、或按文件后缀自动选 IDE。
- 不等待 IDE 启动结果（fire-and-forget）；未来可加启动失败探测。
- `~` 前缀展开仅简单替换 HOME，不含用户自定义 shell 语义。

## 8 决策记录

- **D1 内置预设最小集 + config.json 覆盖**：只内置 vscode + idea，其余按需经 `tools` 新增；配置文件放插件目录内（非 opencode.json options），用户编辑成本最低、改动可见、与代码解耦。
- **D2 探测即决、失败即报**：不做「探测不到就静默降级」，避免「以为开了 IDE 实际没开」的困惑；错误消息直接给出安装/配置修复路径。
- **D3 detached + 不杀进程**：IDE 是长驻用户工具，与浏览器调试实例生命周期不同；插件只负责拉起，关闭完全交给用户。
