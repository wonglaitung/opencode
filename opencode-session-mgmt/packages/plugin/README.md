# `sm-plugin`（OpenCode 插件）

会话管理的运行时主体：由 `opencode.jsonc` 的 `plugin` 加载，跑在 opencode daemon 内，
负责工作流状态、规则注入、提交门禁、工时与质量统计、汇报上报。

## 注册的 hooks

| Hook | 作用 |
|---|---|
| `experimental.chat.system.transform` | 每轮注入工作流规则与 `WorkflowState`（含 open-ide 文件锁提示） |
| `tool` | 工作流工具集（任务分类、工时、需求书、审查、WEB 安全、open_ide 等） |
| `tool.execute.before` | 提交门禁硬拦截；人工文件锁拦截先行；命中即 throw |
| `tool.execute.after` | 迭代计数、状态变更入队、工具调用汇报 |
| `chat.message` | 会话首次活动触发汇报，捕获工时证据 |
| `event` | `session.status=idle` 时 best-effort 补推汇报 |

启动后台任务（孤儿清理、标题回填、补推汇报）见 `src/startup.ts`。

## 结构

```
src/
├── index.ts        # 插件入口，装配 hooks
├── prompt.ts       # 系统提示注入（规则 + 状态）
├── gate.ts         # SDLC/REQDOC 提交门禁
├── task-*.ts       # 一般任务：分类、生命周期、审查门禁
├── report*.ts      # 汇报载荷组装与上报
├── stats.ts        # 工时/Token/成本统计
├── db/             # 本地 Store（状态、文件锁、汇报队列）
├── tools/          # 全部工作流工具
├── open-ide/       # 打开 IDE 与人工文件锁
└── websec-*.ts     # WEB 安全自测校验与 Edge 桥接
config.json         # 运行时配置
conventions/        # 规约清单
review-rules/       # 审查规则
```

## 开发

```bash
bun test
bun x tsc --noEmit
```

工作流定义与规则全文见 [`../../docs/workflow-sdlc.md`](../../docs/workflow-sdlc.md)、
[`workflow-reqdoc.md`](../../docs/workflow-reqdoc.md)、
[`workflow-task.md`](../../docs/workflow-task.md)、
[`workflow-websec.md`](../../docs/workflow-websec.md)；
通用机制见 [`../../docs/session-management.md`](../../docs/session-management.md)。
