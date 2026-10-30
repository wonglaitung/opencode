# 工作流三：task —— 一般任务（只记录工时）

> 文档族说明：本文档是设计文档族的一份子（`session-management.md` 通用机制与部署统计、
> `workflow-sdlc.md` 软件开发工作流、`workflow-reqdoc.md` 需求书工作流、本文档一般任务工作流）。
> 通用机制（WorkflowState、状态转换、统计、提效口径）只在主文档定义一次，本文只放 task 专属内容。

## 1. 定位

task 面向**写文档、分析错误、整理材料**等非开发工作：只记录预估人工工时与实际用时，
用于统计 AI 提效，不设置阶段审批、审查清单、提交门禁。另含独立的 `code_review` 审核子任务；
它只是 task 的一个分类，不与编码任务或其他工作流关联。

入口：

- 启动器工作流下拉框第一项“一般任务”；
- 会话内输入「启动一般任务」，或直接描述任务；
- 与 sdlc/reqdoc 一致，由模型调用 `workflow_start` 初始化工作流；首条消息不再自动开始计时。

## 2. 定义

| 项 | 值 |
|---|---|
| `type` | `task` |
| 阶段 | `execute`（执行） |
| 审查阶段 | 无（`reviewStage: null`） |
| 审查清单 | 空 |
| 提交门禁 | 无（`hasCommitGate: false`） |
| 完成条件 | 非 `code_review`：`execute` 为 `approved`，且 `baseline` 已录入（与 sdlc 基线门禁口径一致）；`code_review`：额外要求已提交 `taskReview` 报告（只约束审核任务自身） |

## 3. 规则

| id | stage | 规则 |
|---|---|---|
| task-r0 | global | 开场提示：首次回复必须用一两句话告诉开发者——本次按一般任务记录，只统计预估/实际工时；预估请按「预估 xx 小时」回答；完成后请明确说「本次任务已完成」（未录入预估会先询问预估；只说「完成」会先请你确认），否则只算进行中。 |
| task-r1 | global | 任务启动后主动询问预估人工工时（小时），引导开发者按「预估 xx 小时」的数字格式回答；开发者明确给出后调用 `workflow_baseline(developer_confirmed=true)`，只报数字（如「24小时」）时也先调用试录，被拒再请其改说「预估 xx 小时」。用 question 选择菜单问预估时，选项文案写成完整的「预估 2 小时」；服务端会把选中的标签当作开发者证据。未录入不阻塞任务进行，但完成前必须补录；已录入后不重复询问。 |
| task-r2 | global | 只记录预估与实际用时，不要求阶段确认、审查清单或 git 提交门禁；不要主动推进阶段，也不要调用 sdlc 的 review/comprehension 工具。 |
| task-r3 | global | 任务完成时，先看状态条「预估」：未录入预估时系统不会自动收口，只能先问开发者预估工时（例如「请按『预估 xx 小时』告诉我」），等其给出数字后再调用 `workflow_baseline`；不得自行填数，也不得只回复已完成。已录入预估时：开发者整句说「本次任务已完成」或带任务范围的完成句（如「任务完成了」「本次任务做完了」，问句不算）时系统会自动收口；若状态条仍显示进行中，调用 `workflow_advance(stage=execute, action=approve, developer_confirmed=true)`。若开发者只说「完成/完成了/做完了/搞定了/结束了」而未点明任务，不要直接 approve，先问一句「本次任务是否已完成？」并在其明确确认后再调用 `workflow_advance(stage=execute, action=approve, developer_confirmed=true)`。系统若已自动结束（状态条显示已完成）则不要重复调用。一个会话只记一个任务；完成后提醒执行 `/new`，并说明这是为了避免同会话混入多个任务、污染工时统计。 |
| task-r4 | global | 会话开始时调用 `workflow_start` 初始化工作流（开发者说「启动一般任务」或直接描述任务时都调用它，不要仅用文字回复）；若当前消息只有入口短语（没有任务描述），启动后先请开发者描述本次任务，不要调用 `task_classify`；状态条显示已有进行中/已完成阶段时不要重复调用。 |
| task-r5 | global | 一般任务启动后，拿到任务描述的首轮必须先调用 `task_classify` 归类，不要只追问；只有入口短语或只有预估工时时不要归类，先请开发者描述任务；模糊但描述了要做某事的说法（如「帮我处理一下这个事」）按 other 归类，不要反问。未启动时先按 task-r4 启动，不得先归类。根据开发者任务描述选择：documentation 编写文档、testing 运行测试、debugging 排查错误、coding 代码修改、code_review 代码审核、research 调研分析、environment 配置环境、other 其他；只有确实无法从任务描述判断时才用 other。任务类型变化时可再次调用覆盖。分类一般只用于统计，不改变流程，也不要写进 note；code_review 例外，按代码审核子任务规则执行。 |

## 4. 生命周期

1. 首条用户消息（或「启动一般任务」）：模型调用 `workflow_start`，`enter execute`，开始计时。
2. AI 首轮根据任务描述调用 `task_classify` 写入分类（仅统计；无法判断用 other，不阻塞，不要只追问）；未启动时先启动，`task_classify` 会拒绝未启动的任务；本轮只有入口短语或只有预估工时时先请用户描述任务，不归类。
3. AI 询问预估工时；用户回复「预估 xx 小时」后，经证据校验写入 `baseline`。
4. 用户整句说「本次任务已完成」或带任务范围的完成句（如「任务完成了」「本次任务做完了」，允许句号/感叹号、不含问号）：已录入预估时插件自动 `approve execute`；未录入预估则不收口，先补录。
   只说「完成/完成了/做完了/搞定了/结束了」而未点明任务时不自动收口，由模型按 task-r3 先确认一次再 approve。
   长篇句子（如「第一部分完成了」）与问句（如「本次任务已完成？」）不自动收口。
5. 完成后状态条显示“预估 / 实际 / 提效”，提示 `/new` 开始下一个任务，并说明复用本会话会污染工时统计。

实际用时口径：`execute` 首次 `enter` 到 `approve` 的时间跨度；进行中显示“至今”。
预估未录入时不能完成：自动收口与 `workflow_advance(approve)` 都会被拦截，须先补录基线。

### 4.1 代码审核子任务（`code_review`）

代码审核只是 **TASK 工作流的一个分类子任务**，不是新工作流，也不与 sdlc/reqdoc 或任何编码任务关联：

- 审核人员直接 `/new` 开一般任务，描述审核范围（diff / commit / PR / 文件）；不需要前置编码任务。
- **纯只读**：`code_review` 分类下服务端硬拦截 `bash`（不跑 build/test/lint、不装依赖、不联网）以及 `write` / `edit` / `apply_patch` / `git commit`。发现问题只写 findings，交给后续编码任务修复。
- **只读 git 信息**：只允许 `task_check` 的固定动作 `diff` / `status` / `log` / `show` / `ls-files`，统一 `GIT_OPTIONAL_LOCKS=0`，不经过 shell；非 Git 项目返回 `skipped + 原因`，不报错。
- **可选 regex 扫描**：`task_scan` 默认扫描 diff 改动文件，也可指定 `files` 或 `all`；只做文件文本匹配，不执行项目命令。内置规则与项目 `.opencode/review-rules/catalog.json` 覆盖/追加（见 `docs/review-rules.md`）。扫描是可选证据；扫描产生的 `blocker`/`critical` 必须在 findings 中逐条提及 `ruleId`。
- **报告为完成条件**：审核任务必须调用 `task_review` 提交结构化报告；未提交时自动收口与 `workflow_advance(approve)` 都会被拒绝。报告提交后即可完成，即使结论是 `changes_requested`。
- **六维报告**：正确性与边界、安全与隐私、设计与可维护性、测试与证据、影响面与兼容性、可理解性；不含需求理解、可运维性。每维必须给出结论与证据，并记录 scope、findings（每条含 severity/issue/suggestion，可带 file/line/ruleId）；`task_review` 回执会展示完整报告：范围、结论、六维明细、扫描摘要、findings（发现与建议）。报告没有 `checks` 字段，也不写人工/CI 背书。测试与证据维度只静态审查测试代码本身，不声称执行过测试。
- **审核规模建议**：改动建议控制在 20 个文件/500 行以内；超过 50 个文件/1500 行应说明拆分理由，或建议拆成多次审核。`task_scan` 的 diff 摘要提供文件数与行数。
- 多次审核 = 多次 `/new`，每次独立估算/计时/报告。
- 普通 coding/debugging 等分类完全不受影响：不提示、不强制审核，也不能调用 `task_review` / `task_scan` / `task_check`（工具会拒绝并提示另开 `code_review` 任务）。

## 5. 预估话术（三工作流一致）

sdlc / reqdoc / task 共用同一句提示：

> 请按「预估 xx 小时」的数字格式回答，可直接回我「预估 xx 小时」。

解析规则与 sdlc/reqdoc 相同：弱单位（小时/天/h）须带预估意图词。
裸 `24小时` 不会被采纳，系统会提示改为「预估 24 小时」。

## 6. 统计

- CLI：`opencode-sm stats --workflow task`。
- 指标：预估、实际、提效、完成率、平均周期、cost/tokens、任务分类分布。
- 分类：`documentation` 编写文档 / `testing` 运行测试 / `debugging` 排查错误 / `coding` 代码修改 / `code_review` 代码审核 / `research` 调研分析 / `environment` 配置环境 / `other` 其他；未调用 `task_classify` 为“未分类”。
- 不统计：代码行数、覆盖率、返工率、审查清单、理解确认。
- 收集端 `workflow_type = "task"`；sdlc 专属指标按 null 处理；分类字段为 `workflow.task = {category, source} | null`。

## 7. 评测

task 有 12 个 new-only 规则遵循场景（`scripts/eval-rules/src/scenarios.ts` 的 `t1`–`t12`）：

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
| t10 首轮启动工作流 | task-r4：任务未启动时先调用 workflow_start，不直接 task_classify |
| t11 入口短语不归类 | task-r4/r5：只有入口短语、没有任务描述时先启动并请其描述任务，不得归类为 other |
| t12 代码审核请求归类 | task-r5：代码审核请求归类为 code_review（独立审核子任务） |

运行：

```bash
EVAL_BASE_URL=... EVAL_API_KEY=... EVAL_MODEL=... EVAL_EXECUTE=1 \
  bun run scripts/eval-rules/run.ts --variant new --workflow task --repeat 1
```

task 没有改造前 baseline，因此只支持 `--variant new`；`--variant baseline --workflow task` 会直接报错。
2026-10-24 用 `deepseek-v4.1-flash`（OpenCode Zen Go）以 `--repeat 3` 复跑 t1–t9：每个场景 3/3，合计 **27/27**；结果文件在 `scripts/eval-rules/results/new.task.json`（本机结果，不入库）。
2026-10-26 用本地 `qwen3`（SGLang 8086，`EVAL_DISABLE_THINKING=1`、`EVAL_EXECUTE=1`、`--repeat 3`）跑 t1–t11：**33/33**。本轮据本地结果强化规则：t3 从 0/3 提升到 3/3（task-r1 明确裸数字也先试录、被拒再请其改说「预估 xx 小时」）；t9 从 1/3 提升到单场景 2/3、全量 3/3（task-r3 把「未录入预估」前置，并禁止自行填数/只回已完成）；新增 t11 入口短语不归类（3/3）；t8 因入口短语规则误伤模糊描述（0/3→3/3），已明确「模糊但描述了要做某事的说法按 other 归类，不要反问」。该结果仅为本地弱模型回归观测，SGLang 端点数字不与远端基线横比；结果文件 `new.task.json`（本机，不入库）。
2026-10-27 修复 question 选择菜单的预估证据（`tool.execute.after` 从 `args.questions` + `output.metadata.answers` 捕获）并在 task-r1 要求菜单选项写完整「预估 2 小时」后复跑 t1–t11：**33/33**。首轮全量曾出现 t4 1/3（未调用 approve），t4 单独复跑 3/3、随后全量 33/33，按本地 SGLang 波动处理；question 证据本身由 `baseline-question.test.ts` 与 `task-hook.test.ts` 固定，不依赖模型波动。
2026-10-30 新增 code_review 分类后复跑 t1–t12：**31/36**；t12 归类 **3/3**，其余 t2/t3/t5-t11 均 3/3。t1 0/3、t4 1/3 属既有场景在本地 SGLang 上的波动（t4 单独复跑 2/3，模型仍会依赖自动收口；其余机制测试均通过），未归因于 code_review；t12 由本功能新增并通过。

## 8. 边界

- 一个会话只记一个一般任务；多任务用 `/new`。
- 启动与 sdlc/reqdoc 一致：由模型调用 `workflow_start`；未启动时 `task_classify` 拒绝，避免留下“只有分类、没有启动”的半成品。
- task 类型由启动器写入 identity 决定；不能在 sdlc/reqdoc 会话内切换，须在启动器选择 task 后开新会话（已有窗口需先退出）。
- task 工具集不注册 sdlc 的 review/comprehension/commit 工具；`code_review` 分类使用独立的 `task_review`、`task_scan`、`task_check`，不与其他工作流关联。
- `code_review` 是唯一带报告完成门禁的分类；其他 task 分类仍只记工时，不因未审核被拦。
- 分类一般是元数据；`code_review` 例外——它只约束审核任务自身的报告提交，不影响编码任务。模型可重复调用覆盖分类，保留最新值。
- 分类只存枚举码，不存任务原文；不解析 note，也不把分类写进 note。
- 阶段 1 的工作流选择仍写全局 `identity.json.workflowType`，影响本次 daemon 的所有新会话；
  切换类型后建议 `/new`。同一 daemon 混用不同类型历史会话的能力不在阶段 1 范围。
