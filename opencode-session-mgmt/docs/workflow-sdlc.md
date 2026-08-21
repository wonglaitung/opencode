# 工作流一：sdlc —— 软件开发标准流程

> **文档族说明**：本文档是设计文档族的一份子（`session-management.md` 通用机制与部署统计、`workflow-sdlc.md` 软件开发工作流、`workflow-reqdoc.md` 需求书工作流）。引用约定：跨文件引用带文件名前缀（如「见 session-management.md 3.2」）；不带前缀的章号（如「见 2 章」）指本文档。通用机制（WorkflowState 核心 schema、状态转换、提交门禁、理解确认、质量指标、统计、评测方法论）只在主文档定义一次，本文档只放 sdlc 专属内容并引用。

## 1. 工作流定位

sdlc 是**开发者**的默认工作流，覆盖一次软件开发会话的完整周期：需求分析 → 设计 → 编码 → 测试 → 审查 → 提交。核心哲学是**完成门控**（见 session-management.md 2.1 方案 B）：不强制阶段单向推进，而是约束「所有必需产物都已完成」——五阶段可自由跳转反复迭代（`workflow_revisit`），提交是唯一的硬门禁（`hasCommitGate=true`，见 session-management.md 3.4）。

**审查是唯一不可被 AI 自行推进的阶段**（见 session-management.md 2.1）：审查不仅检查代码正确性，更检查**人是否真正理解了代码**，必须经 `review_submit` 通过（见 5 章）。审查阶段与编码、测试阶段形成迭代循环。

## 2. 工作流定义

**sdlc 定义**：五阶段 `["requirements","design","implementation","testing","review"]`，审查阶段为 `review`，四清单项（businessIntent/logicExplainable/behaviorVerifiable/designRationale），`hasCommitGate=true`，结构化规则见 3 章。

## 3. 规则全文（sdlc-r1~r12）

规则以 `WorkflowDefinition.rules: RuleItem[]` 存储（见 session-management.md 3.2 注册表）。插件每轮经 `rulesForStage` **只注入 global + 当前 in_progress 阶段的规则**；无进行中阶段时只给 global + 起步提示（完成态走专用完成块，见 session-management.md 7.1）。规则文本只承载**模型可行动作**（调用哪个工具、何时、确认语义）；插件内部机制（行数统计、stuck 检测、一次通过率计算）由代码强制，不进注入文本。

以下是 **sdlc** 的 12 条规则（6 global + 1 requirements + 5 review）：

| id | stage | 注入文本 |
|----|-------|----------|
| sdlc-r1 | global | 会话开始时，调用 workflow_advance(stage=requirements, action=enter) 初始化工作流。 |
| sdlc-r2 | global | 阶段可能完成时，先输出摘要并询问确认；仅开发者明确表示「确认/通过/可以」才算确认——「你看着办」「差不多」等模糊表态不算，不得自行 approve。确认后调用 workflow_advance(action=approve, developer_confirmed=true)。 |
| sdlc-r3 | global | 开发者说「回到XX」时，立即调用 workflow_revisit(stage=XX)。绝不自行判断阶段已完成。 |
| sdlc-r4 | global | 要求提交时，先调用 commit_gate_check；全部五阶段（含审查）approved 后才可 git commit。 |
| sdlc-r5 | global | 提交门禁放行且 git commit 成功后，提醒开发者执行 /new 开始下一个需求，保持统计隔离。 |
| sdlc-r12 | global | 开发者表示要手工修改某段/某文件代码时，先调用 open_ide 并**必须携带 file 参数指明该文件**（不指定 file 不会锁定），以锁定该文件防 AI 覆盖。若开发者未明确文件，先询问要改哪个文件。锁定期间可继续其它任务（改其它文件/答疑），但不得修改被锁定的文件（write/edit/apply_patch 会被服务端拒绝）。开发者确认改完后，须经其明确确认（如说「改完了/可以继续」）再调用 unlock_file 解锁该文件，并重新读取最新文件内容后继续；多个锁定文件须逐个确认解锁。 |
| sdlc-r13 | global | 阶段可见性（通用）：你每条回复的开头，必须用一行向开发者展示当前所处阶段与全部阶段进展，格式——📍 阶段：<当前阶段中文名>（第 N/Y 步）｜ 目的：<本阶段一句话目的> ｜ 已完成：<已 approved 阶段名>✓ ｜ 下一步：<下一阶段名>。处于「未开始/空档」态时，说明「尚未开始，请从<首阶段>开始」或「空档，下一步：<阶段名>」。向开发者询问确认/approve 时，必须显式点明所确认的**阶段名**（如「【编码 阶段】以上编码是否确认？」），不得用笼统的「以上流程与规则是否确认」之类不点名阶段的问法。 |
| sdlc-r6 | requirements | 进入需求阶段时，主动询问预估人工工时（小时）；开发者明确给出后调用 workflow_baseline(developer_confirmed=true)。未提供不阻塞；已录入后不必重复询问。 |
| sdlc-r7 | review | review 是唯一不可由 AI 自行推进的阶段（必须经 review_submit），目标是确保开发者真正理解代码。 |
| sdlc-r8 | review | 进入审查后，将每个 AI 生成的代码变更拆分为可理解片段，comprehension_add 逐段登记并输出解释（做了什么、为什么这样写、被放弃的替代方案、潜在风险）。 |
| sdlc-r9 | review | 开发者确认某片段时，立即调用 comprehension_confirm(codeSegmentId=该片段 id)；单次只接受一个 codeSegmentId，逐段确认、禁止一次确认多个。 |
| sdlc-r10 | review | 开发者追问时详细解释，comprehension_ask 将问答追加到该片段的 explanation。 |
| sdlc-r11 | review | 每个片段须达成终态（confirm 接受 / manual 开发者自处理），不允许 pending/rejected 悬空；拒绝的片段先 comprehension_rewrite 重写或 manual 定论，全部定论且前序阶段（requirements/design/implementation/testing）全部 approved 后才可 review_submit；清单四项须全为 true，否则回到编码/测试。返工多应结合拒绝意见 rewrite 改进，而非简单重试。 |

> 注入时机：进行中阶段为 requirements 时注入 7 条（r1-r6 + r12）；design/implementation/testing 时注入 6 条（r1-r5 + r12）；review 时注入 11 条（r1-r5 + r7-r12）。

## 4. 实际效果：开发者看到什么（场景一~四）

以一次典型的开发会话为例，展示开发者视角的交互过程。

**场景一：阶段推进（对话中自然触发）**

```
开发者: 用户认证模块的需求就这些了，你帮我总结一下

Agent:  📋 需求分析摘要
       1. 支持用户名+密码登录
       2. 支持 JWT token 刷新（access token 15min, refresh token 7d）
       3. 登录失败 5 次锁定 30 分钟
       4. 密码强度要求：8位+，含大小写+数字
       
       需求分析阶段是否确认完成？确认后进入设计阶段。

开发者: 确认

Agent:  ✅ 需求分析已确认。进入设计阶段。
       需要我帮你设计数据库 schema 和 API 接口吗？
```

**场景二：审查阶段——理解确认（逐段交互）**

```
开发者: 代码写完了，进入审查吧

Agent:  🔍 审查阶段 — 本会话共生成 3 个代码变更片段，逐段确认理解：

       ─── 片段 1/3: auth/service.ts:12-45 ───
       📖 这是 TokenService.refresh() 方法。
       它实现了 refresh token 轮换机制：每次用旧 refresh token 换取新 token 对时，
       旧 token 立即失效。选择这个方案（而非延长旧 token 有效期）是因为：
       - 如果 refresh token 泄露，轮换机制确保只有最新的 token 可用
       - 被放弃的替代方案：延长有效期（不够安全）、双 token 队列（复杂度高）
       - 潜在风险：并发刷新时可能触发竞态条件，已在 L38 用数据库行锁处理
       
       你是否理解这段代码的工作原理？[确认/追问]

开发者: 确认

Agent:  ─── 片段 2/3: auth/middleware.ts:8-32 ───
       📖 这是 AuthMiddleware，拦截所有 /api/* 请求...
       （解释内容同上结构）
       
       你是否理解这段代码的工作原理？[确认/追问]

开发者: L22 的缓存逻辑为什么用 Map 而不是 Redis？

Agent:  好问题。这里用了内存 Map 而非 Redis，原因是：
       - 缓存的是公钥（JWK），不是用户数据，不需要持久化
       - 每个服务实例独立缓存，内存占用极小（~2KB）
       - 如果将来需要多实例共享，可以切换到 Redis，接口不变
       - 替代方案：每次请求都去 Auth Server 验证（延迟高，已被放弃）
       
       现在理解了吗？[确认/追问]

开发者: 确认

Agent:  ─── 片段 3/3: auth/model.ts:1-20 ───
       ...
       
       ✅ 所有 3 个片段已确认理解。审查清单验证：
       ✓ businessIntent   — 公共方法有业务意图注释
       ✓ logicExplainable  — 圈复杂度 >10 的方法有行内注释
       ✓ behaviorVerifiable — 每个 Service 方法有集成测试
       ✓ designRationale   — 所有片段已定论（accepted/manual）
       
       审查阶段通过。可以提交了。
```

**场景三：提交门禁（对话中触发）**

```
开发者: 帮我提交代码

Agent:  🔒 提交门禁检查...
       ✓ requirements — approved
       ✓ design       — approved
       ✓ implementation — approved
       ✓ testing      — approved
       ✗ review       — 未完成（审查清单未通过）
       
       请先完成审查阶段再提交。输入 "进入审查阶段" 开始。

开发者: 进入审查阶段

Agent:  🔍 审查阶段 — 本会话共生成 2 个代码变更片段...
       （进入审查交互）
```

**场景四：重复编辑模式检测触发**

```
开发者: 这段代码还是有问题，再改一下

Agent:  ⚠ 检测到重复编辑模式：scheduler.py（连续相同操作 3 次），
       建议审查是否陷入无效循环，考虑人工介入修改。
       
       我可以继续帮你修改，但你可能需要先确认：
       1. 问题描述是否准确？
       2. 是否需要换一个思路来解决？
```

## 5. 审查阶段（可接手标准检查项）

理解确认（ComprehensionRecord）与审查闭环是**通用机制**（sdlc 与 reqdoc 共用），见 session-management.md 3.2：每个代码片段经 `comprehension_add` 登记解释 → 开发者逐段 confirm/ask/reject/rewrite/manual 定夺 → 全部终态后 `review_submit` 通过。sdlc 的片段为**代码片段**（`file`/`lines` 必填）。

sdlc 的审查清单（`ReviewChecklist`）由 `WorkflowDefinition.checklist` 定义，全部通过后审查阶段才可 approve：

| 检查项 | 要求 | 验证方式 |
|--------|------|----------|
| `businessIntent` | 公共方法必须有注释，说明业务意图而非只描述参数 | 审查清单 |
| `logicExplainable` | 圈复杂度 > 10 的方法必须有行内注释 | 静态分析 + 审查 |
| `behaviorVerifiable` | 每个 Service 方法至少有一个集成测试，测试即使用文档 | 审查清单 + 门禁 |
| **`designRationale`** | **AI 必须为每个代码变更输出设计推导：为什么这样写、有哪些替代方案被放弃、潜在风险是什么** | **开发者逐段定夺（accepted / manual）** |

**一次通过率**（`firstPassRate`）由 `review_submit` 审查通过时自动计算，公式与口径见 session-management.md 3.2——sdlc 分母为「代码片段」、reqdoc 分母为「PRD 要点」。

## 6. 提交门禁与强制提交

提交门禁机制（`WorkflowDefinition.hasCommitGate` 驱动、`tool.execute.before` 硬拦截、`commit_force_unlock` 强制提交逃生口）见 session-management.md 3.4。sdlc 是 `hasCommitGate=true` 的工作流，因此 `commit_gate_check` / `commit_force_unlock` 工具对 sdlc 会话启用（reqdoc 不启用）。**手工修改走 open_ide 锁定**（sdlc-r12，软提示 + 硬拦截）：锁持久化进 SQLite `file_lock` 表，SDLC 完结时完成态注入解锁提示（仅 sdlc）。

## 7. sdlc 专属统计口径

统计分层与质量维度定义见 session-management.md 6。sdlc 会话填充**全部**质量字段：`firstPassRate`（一次通过率）、`iterationCount`（迭代轮次）、`linesByFile`（AI 净增行数，业务/测试/配置三分类，见 session-management.md 3.2「AI 代码行数统计」）、`reworkRate`/`testCoverage`（CI 回写）。reqdoc 会话这些字段为 `null`（显示 N/A）。

## 8. 评测场景（s1-s22）

规则遵循度评测**方法论**（run 方式、baseline 冻结纪律、判定方式、关键教训、改动分级决策图）见 session-management.md 13；reqdoc 场景 r1-r24 见 workflow-reqdoc.md 10 章。sdlc 场景 s1-s22 明细如下：

- 基线录入不重复、确认后 approve、无确认不 approve、回到XX→revisit、审查逐段不批量、前序未完成不 submit、提交前查门禁
- **完成后提示 /new**（s9，`text.keyword` 判定回复须含 `/new`；reqdoc 侧 r7 同口径）
- **完成后开新需求不重启**（s10，`no_tool` 禁 `workflow_advance`/`workflow_revisit`）
- **空档态继续进入下一阶段**（s11，部分 approved 无 in_progress → `workflow_advance` enter 下一阶段）
- **审查全流程**（s12-s19：正向 review_submit 且片段全定论、片段未定论不 submit、reject 必带反馈、拒绝后 rewrite/manual、追问 ask、审查不可 advance approve 必须 review_submit、拒绝复议后 confirm）
- **手工修改走 open_ide 锁定与改完确认解锁**（s20-s21，sdlc-r12 规则，open_ide/unlock_file 契约——open-ide 已**物理合并**进本工程 `packages/plugin/src/open-ide/`，单一插件加载；锁持久化进 SQLite `file_lock` 表，daemon 重启自动恢复，会话删除后由启动时 `pruneLocks` 修剪）
- **SDLC 完结 → 提示解锁**（合并新增，插件硬能力）：完成态注入与 `review_submit` 返回均直接读锁表，有锁时提示开发者确认后逐个 `unlock_file`；仅 sdlc（`hasCommitGate` 门控），reqdoc 完成态不提示

> sdlc 改动走**共享评测门**（session-management.md 13.6 改动分级决策图，baseline→new 对比）验证零回退，只看**通过率**不降；sdlc **不跑** reqdoc 的质量飞轮（打分卡 0-100 五维度量是 reqdoc 专属，见 workflow-reqdoc.md 10 章）。reqdoc 侧 r7/r8-r10 同口径场景见 workflow-reqdoc.md 10 章。
