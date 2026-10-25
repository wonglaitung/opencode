# 工作流三：task —— 一般任务（只记录工时）

> 文档族说明：本文档是设计文档族的一份子（`session-management.md` 通用机制与部署统计、
> `workflow-sdlc.md` 软件开发工作流、`workflow-reqdoc.md` 需求书工作流、本文档一般任务工作流）。
> 通用机制（WorkflowState、状态转换、统计、提效口径）只在主文档定义一次，本文只放 task 专属内容。

## 1. 定位

task 面向**写文档、分析错误、整理材料**等非开发工作：只记录预估人工工时与实际用时，
用于统计 AI 提效，不设置阶段审批、审查清单、提交门禁。

入口：

- 启动器工作流下拉框第一项“一般任务”；
- 会话内输入「启动一般任务」；
- 首条用户消息也会自动开始计时。

## 2. 定义

| 项 | 值 |
|---|---|
| `type` | `task` |
| 阶段 | `execute`（执行） |
| 审查阶段 | 无（`reviewStage: null`） |
| 审查清单 | 空 |
| 提交门禁 | 无（`hasCommitGate: false`） |
| 完成条件 | `execute` 为 `approved`，且 `baseline` 已录入（与 sdlc 基线门禁口径一致） |

## 3. 规则

| id | stage | 规则 |
|---|---|---|
| task-r0 | global | 开场提示：首次回复必须用一两句话告诉开发者——本次按一般任务记录，只统计预估/实际工时；预估请按「预估 xx 小时」回答；完成后请明确说「完成」，否则只算进行中。 |
| task-r1 | global | 任务开始时主动询问预估人工工时（小时），引导开发者按「预估 xx 小时」的数字格式回答；开发者明确给出后调用 `workflow_baseline(developer_confirmed=true)`。未录入不阻塞任务进行，但完成前必须补录；已录入后不重复询问。 |
| task-r2 | global | 只记录预估与实际用时，不要求阶段确认、审查清单或 git 提交门禁；不要主动推进阶段，也不要调用 review/comprehension 工具。 |
| task-r3 | global | 任务完成时，若开发者明确说「完成/做完了/搞定了/结束了」，调用 `workflow_advance(stage=execute, action=approve, developer_confirmed=true)`；未录入预估时不得收口，先询问并调用 `workflow_baseline` 补录。系统若已自动结束（状态条显示已完成）则不要重复调用。一个会话只记一个任务；完成后提醒执行 `/new`，并说明这是为了避免同会话混入多个任务、污染工时统计。 |
| task-r4 | global | 入口提示：开发者说「启动一般任务」时视为任务开始；系统也会在首条消息自动开始计时，不要重复调用 `workflow_start`。 |
| task-r5 | global | 一般任务开始后，首轮必须先调用 `task_classify` 归类，不要只追问。根据开发者任务描述选择：documentation 编写文档、testing 运行测试、debugging 排查错误、coding 代码修改、research 调研分析、environment 配置环境、other 其他。描述不足以判断时用 other；任务类型变化时可再次调用覆盖。分类只用于统计，不改变流程，也不要写进 note。 |

## 4. 生命周期

1. 首条用户消息：插件自动 `enter execute`，开始计时。
2. AI 首轮根据任务描述调用 `task_classify` 写入分类（仅统计；无法判断用 other，不阻塞，不要只追问）。
3. AI 询问预估工时；用户回复「预估 xx 小时」后，经证据校验写入 `baseline`。
4. 用户明确说「完成/完成了/做完了/搞定了/结束了」（整句，允许标点）：已录入预估时插件自动 `approve execute`；未录入预估则不收口，先补录。
   长篇句子（如「第一部分完成了」）不自动收口，由模型按 task-r3 判断。
5. 完成后状态条显示“预估 / 实际 / 提效”，提示 `/new` 开始下一个任务，并说明复用本会话会污染工时统计。

实际用时口径：`execute` 首次 `enter` 到 `approve` 的时间跨度；进行中显示“至今”。
预估未录入时不能完成：自动收口与 `workflow_advance(approve)` 都会被拦截，须先补录基线。

## 5. 预估话术（三工作流一致）

sdlc / reqdoc / task 共用同一句提示：

> 请按「预估 xx 小时」的数字格式回答，可直接回我「预估 xx 小时」。

解析规则与 sdlc/reqdoc 相同：弱单位（小时/天/h）须带预估意图词。
裸 `24小时` 不会被采纳，系统会提示改为「预估 24 小时」。

## 6. 统计

- CLI：`opencode-sm stats --workflow task`。
- 指标：预估、实际、提效、完成率、平均周期、cost/tokens、任务分类分布。
- 分类：`documentation` 编写文档 / `testing` 运行测试 / `debugging` 排查错误 / `coding` 代码修改 / `research` 调研分析 / `environment` 配置环境 / `other` 其他；未调用 `task_classify` 为“未分类”。
- 不统计：代码行数、覆盖率、返工率、审查清单、理解确认。
- 收集端 `workflow_type = "task"`；sdlc 专属指标按 null 处理；分类字段为 `workflow.task = {category, source} | null`。

## 7. 评测

task 有 9 个 new-only 规则遵循场景（`scripts/eval-rules/src/scenarios.ts` 的 `t1`–`t9`）：

| 场景 | 考点 |
|---|---|
| t1 开场提示预估与完成 | task-r0：首次回复说明一般任务、预估 xx 小时、完成方式 |
| t2 预估 2 小时录基线 | task-r1：按「预估 xx 小时」报数后调用 workflow_baseline |
| t3 裸 24 小时被拒 | A 口径：裸数字无预估意图词，服务端拒收 |
| t4 完成时 approve | task-r3：开发者明确说完成时调用 workflow_advance |
| t5 完成后提示 /new | task-r3：完成态提示 /new |
| t6 分类为编写文档 | task-r5：写文档类任务归类为 documentation |
| t7 分类为排查错误 | task-r5：排查报错类任务归类为 debugging |
| t8 无法判断用 other | task-r5：无法判断时用 other，不额外追问 |
| t9 未预估完成先补预估 | task-r1/r3：未录入预估时不得收口，先补问预估 |

运行：

```bash
EVAL_BASE_URL=... EVAL_API_KEY=... EVAL_MODEL=... EVAL_EXECUTE=1 \
  bun run scripts/eval-rules/run.ts --variant new --workflow task --repeat 1
```

task 没有改造前 baseline，因此只支持 `--variant new`；`--variant baseline --workflow task` 会直接报错。
2026-10-24 用 `deepseek-v4.1-flash`（OpenCode Zen Go）以 `--repeat 3` 复跑 t1–t9：每个场景 3/3，合计 **27/27**；结果文件在 `scripts/eval-rules/results/new.task.json`（本机结果，不入库）。

## 8. 边界

- 一个会话只记一个一般任务；多任务用 `/new`。
- task 类型由启动器写入 identity 决定；不能在 sdlc/reqdoc 会话内切换，须在启动器选择 task 后开新会话（已有窗口需先退出）。
- task 工具集不注册 review/comprehension/commit 工具。
- 分类是元数据，不是门禁：未分类也能完成；模型可重复调用覆盖，保留最新值。
- 分类只存枚举码，不存任务原文；不解析 note，也不把分类写进 note。
- 阶段 1 的工作流选择仍写全局 `identity.json.workflowType`，影响本次 daemon 的所有新会话；
  切换类型后建议 `/new`。同一 daemon 混用不同类型历史会话的能力不在阶段 1 范围。
