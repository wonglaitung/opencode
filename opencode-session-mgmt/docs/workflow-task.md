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
| 完成条件 | `execute` 为 `approved` |

## 3. 规则

| id | stage | 规则 |
|---|---|---|
| task-r0 | global | 开场提示：首次回复必须用一两句话告诉开发者——本次按一般任务记录，只统计预估/实际工时；预估请按「预估 xx 小时」回答；完成后请明确说「完成」，否则只算进行中。 |
| task-r1 | global | 任务开始时主动询问预估人工工时（小时），引导开发者按「预估 xx 小时」的数字格式回答；开发者明确给出后调用 `workflow_baseline(developer_confirmed=true)`。未提供不阻塞；已录入后不重复询问。 |
| task-r2 | global | 只记录预估与实际用时，不要求阶段确认、审查清单或 git 提交门禁；不要主动推进阶段，也不要调用 review/comprehension 工具。 |
| task-r3 | global | 任务完成时，若开发者明确说「完成/做完了/搞定了/结束了」，调用 `workflow_advance(stage=execute, action=approve, developer_confirmed=true)`；系统若已自动结束（状态条显示已完成）则不要重复调用。一个会话只记一个任务；完成后提醒执行 `/new`。 |
| task-r4 | global | 入口提示：开发者说「启动一般任务」时视为任务开始；系统也会在首条消息自动开始计时，不要重复调用 `workflow_start`。 |

## 4. 生命周期

1. 首条用户消息：插件自动 `enter execute`，开始计时。
2. AI 询问预估工时；用户回复「预估 xx 小时」后，经证据校验写入 `baseline`。
3. 用户明确说「完成/完成了/做完了/搞定了/结束了」（整句，允许标点）：插件自动 `approve execute`。
   长篇句子（如「第一部分完成了」）不自动收口，由模型按 task-r3 判断。
4. 完成后状态条显示“预估 / 实际 / 提效”，提示 `/new` 开始下一个任务。

实际用时口径：`execute` 首次 `enter` 到 `approve` 的时间跨度；进行中显示“至今”。
预估未录入时仍可完成，统计显示 N/A。

## 5. 预估话术（三工作流一致）

sdlc / reqdoc / task 共用同一句提示：

> 请按「预估 xx 小时」的数字格式回答，可直接回我「预估 xx 小时」。

解析规则与 sdlc/reqdoc 相同：弱单位（小时/天/h）须带预估意图词。
裸 `24小时` 不会被采纳，系统会提示改为「预估 24 小时」。

## 6. 统计

- CLI：`opencode-sm stats --workflow task`。
- 指标：预估、实际、提效、完成率、平均周期、cost/tokens。
- 不统计：代码行数、覆盖率、返工率、审查清单、理解确认。
- 收集端 `workflow_type = "task"`；sdlc 专属指标按 null 处理。

## 7. 边界

- 一个会话只记一个一般任务；多任务用 `/new`。
- task 工具集不注册 review/comprehension/commit 工具。
- 阶段 1 的工作流选择仍写全局 `identity.json.workflowType`，影响本次 daemon 的所有新会话；
  切换类型后建议 `/new`。同一 daemon 混用不同类型历史会话的能力不在阶段 1 范围。
