/**
 * WorkflowState 及子结构类型定义（设计文档 3.2）。
 * 插件、CLI、收集服务三方共用的契约——任何字段变更必须三包同步。
 *
 * 多流程就绪：阶段键/清单/规则/门禁均从 WorkflowDefinition 注册表驱动，而非硬编码。
 * 本轮只注册 sdlc（设计文档 3.2 注册表）；reqdoc 随需求书工作加入。
 */

export type WorkflowType = "sdlc" | "reqdoc"

export type StageStatus = "not_started" | "in_progress" | "approved"

export type TransitionAction = "enter" | "revisit" | "approve"

export interface Transition {
  action: TransitionAction
  at: number
  note?: string
}

export interface StageRecord {
  status: StageStatus
  revision: number
  transitions: Transition[]
}

/** 可接手标准检查项（3.2，sdlc 专属）：键→布尔，具体项由审查阶段定义驱动。 */
export interface ReviewChecklist {
  [key: string]: boolean
}

/** 片段评审去留状态机（3.2 审查）：add→pending；confirm→accepted；reject→rejected；rewrite→pending；manual→manual。终态为 accepted / manual。 */
export type ComprehensionDecision = "pending" | "accepted" | "rejected" | "manual"

/**
 * 理解确认记录（3.2 审查，工作流无关的通用机制）。
 * 泛化语义：sdlc 为「代码片段」（id 为代码段标识，file/lines 必填）；
 * reqdoc 为「PRD 要点」（id 为要点标识，file/lines 不填）。sdlc 契约逐字节不变。
 * 工具参数名一律 `codeSegmentId`（LLM 契约），内部映射到本字段 `id`。
 */
export interface ComprehensionRecord {
  /** 唯一标识：sdlc 为代码段 id（如 a.ts:1-2），reqdoc 为 PRD 要点 id */
  id: string
  /** sdlc 专属：所属文件路径；reqdoc（PRD 要点）无文件归属 → undefined */
  file?: string
  /** sdlc 专属：行区间；reqdoc 无 → undefined */
  lines?: [number, number]
  explanation: string
  /** 片段当前去留状态（3.2）。 */
  decision: ComprehensionDecision
  /** 旧确认语义保留：accepted 时为 true（统计/展示的 confirmed 口径不变）。 */
  developerConfirmed: boolean
  confirmedAt: number | null
  /** reject 时开发者补充的意见（rewrite 的依据）。 */
  feedback: string | null
  rejectedAt: number | null
  /** 被拒绝后经 rewrite 重写的次数（一次通过率判定：accepted 且 rewrites===0 视为一次通过）。 */
  rewrites: number
  /** manual 终态时开发者自处理的结果说明。 */
  resolution: string | null
}

export interface ReviewStageRecord extends StageRecord {
  checklist: Record<string, boolean>
  comprehension: ComprehensionRecord[]
}

export interface CommitGate {
  status: "blocked" | "allowed"
  blocked_by: string[]
  /**
   * 一次性强制提交授权（3.4 逃生口）：开发者明确要求并给出原因后由
   * commit_force_unlock 写入；门禁放行一次后置 used=true 留痕（不删除，供统计审计）。
   */
  force?: { reason: string; at: number; used: boolean }
}

/**
 * 基线对比（6.3）：需求创建时由项目经理给出的预估人工工时，开发者在 TUI 内经
 * workflow_baseline 工具转述录入。用于与实际周期对比得出 AI 提效率。
 * 纯数字 + 时间戳，不含代码/路径，汇报投影直接上行（12）。
 */
export interface BaselineEstimate {
  /** 预估人工工时（小时，>0） */
  estimatedHours: number
  /** 录入/最近一次重设时间（epoch ms，幂等覆盖） */
  setAt: number
}

export interface QualityMetrics {
  /** 一次通过率（3.2）：未重写即 accepted 的片段数 ÷ 全部定论片段数(accepted+manual)。
   *  review_submit 通过时由插件自动计算写回，不依赖 Agent 上报。纯讨论会话（无片段）保持 null。
   *  sdlc 专属（代码片段语义）；reqdoc 无此概念时为 null。 */
  firstPassRate: number | null
  /** 「同一段代码/文件」的最大生成-修改循环次数（3.2），取 iterationByFile 各文件最大值 */
  iterationCount: number | null
  /** 合并后由 CI 按 sessionID 回写收集服务（设计文档 4.3） */
  reworkRate: number | null
  testCoverage: number | null
  /**
   * 按文件的 AI 生成-修改循环计数（3.2「同一段代码」语义）。键为文件路径；
   * 无单一文件的工具（如 apply_patch）归入 "(<工具名>)" 桶。
   * 可选字段：首次计数前缺省（不改 createWorkflowState 既有形状），随汇报上行。
   */
  iterationByFile?: Record<string, number>
  /**
   * 按文件的 AI 净增代码行数（3.2「AI 代码行数统计」，规则 26）：净增量口径、可为负，
   * 同会话去重累计（write 整文件覆盖计、edit 新行−旧行、apply_patch +行−−行）。
   * 可选字段：首次计数前缺省（不改 createWorkflowState 既有形状）。
   * 键为文件路径仅存本机插件库，汇报投影剥离、只上行三分类聚合（12）。
   */
  linesByFile?: Record<string, number>
}

/**
 * 会话工作流状态（3.2）：本会话属于哪种工作流 + 泛化阶段集。
 * type 决定取哪个 WorkflowDefinition（阶段键/清单/规则/门禁），随汇报上行。
 */
export interface WorkflowState {
  /** 本会话所属工作流类型（用户级身份继承，3.1） */
  type: WorkflowType
  /** 泛化阶段集：键为定义 stages 的元素，值含状态/迭代/时间戳 */
  stages: Record<string, StageRecord>
  commit: CommitGate
  quality: QualityMetrics
  /**
   * 基线对比（6.3）：预估人工工时，需求创建时录入。
   * 可选字段：录入前缺省（不改 createWorkflowState 既有形状），随汇报上行。
   */
  baseline?: BaselineEstimate
}

/** 工作流阶段键（Record 泛化，3.2）。 */
export type WorkflowStageKey = string

/** 审查清单项（3.2 注册表）：key 为清单键，label 为渲染/注入用中文名，auto 表示 review_submit 自动置真。 */
export interface ChecklistItem {
  key: string
  label: string
  /** 由插件自动满足、无需 Agent 逐项确认的项（如覆盖率由 CI 回写）。 */
  auto?: boolean
}

/**
 * 规则项（7.4 阶段化注入）：stage 为生效阶段键，"global" 为所有阶段通用。
 * text 只承载模型可行动作（调用哪个工具、何时、确认语义）——
 * 插件内部机制（行数统计、stuck 检测）由代码强制，不进注入文本。
 */
export interface RuleItem {
  /** 稳定标识（如 sdlc-r1），供测试/评测/文档交叉引用 */
  id: string
  stage: string | "global"
  text: string
}

/**
 * 工作流定义（3.2 注册表）：把「流程的定义」与通用机制解耦。
 * 消费方一律 getDefinition(workflow.type) 取定义，不硬编码阶段/清单/规则。
 */
export interface WorkflowDefinition {
  type: WorkflowType
  /** 阶段键，顺序即推进顺序 */
  stages: string[]
  /** 阶段中文名（渲染/注入用） */
  labels: Record<string, string>
  /** 哪个阶段是审查阶段（可无）；审查清单/理解确认仅在该阶段存在时使用 */
  reviewStage: string | null
  /** 审查清单项（仅 reviewStage 存在时用） */
  checklist: ChecklistItem[]
  /** sdlc=true；reqdoc 定稿无 git 门禁 → false */
  hasCommitGate: boolean
  /** 该类型注入的规则项（7.4），注入时经 rulesForStage 取 global + 当前阶段 */
  rules: RuleItem[]
}

/** SDLC 五阶段审查清单项（sdlc 专属，3.2）；review_submit 从具名参数生成，字节不变。
 *  designRationale 为 auto：全部片段定论即通过，无需 Agent 逐项上报（LLM 契约仅 3 具名参数）。 */
const SDLC_CHECKLIST: ChecklistItem[] = [
  { key: "businessIntent", label: "业务意图清晰" },
  { key: "logicExplainable", label: "逻辑可解释" },
  { key: "behaviorVerifiable", label: "行为可验证" },
  { key: "designRationale", label: "设计取舍合理", auto: true },
]

/** SDLC 工作流定义：五阶段 + 四清单 + git 门禁 + 结构化规则（global + 阶段归属，7.4）。 */
export const SDLC: WorkflowDefinition = {
  type: "sdlc",
  stages: ["requirements", "design", "implementation", "testing", "review"],
  labels: {
    requirements: "需求分析",
    design: "设计",
    implementation: "编码",
    testing: "测试",
    review: "审查",
  },
  reviewStage: "review",
  checklist: SDLC_CHECKLIST,
  hasCommitGate: true,
  rules: [
    // ---- global：所有阶段通用 ----
    { id: "sdlc-r1", stage: "global", text: "会话开始时，调用 workflow_advance(stage=requirements, action=enter) 初始化工作流。" },
    { id: "sdlc-r2", stage: "global", text: "阶段可能完成时，先输出摘要并询问确认；仅开发者明确表示「确认/通过/可以」才算确认——「你看着办」「差不多」等模糊表态不算，不得自行 approve。确认后调用 workflow_advance(action=approve, developer_confirmed=true)。" },
    { id: "sdlc-r3", stage: "global", text: "开发者说「回到XX」时，立即调用 workflow_revisit(stage=XX)。绝不自行判断阶段已完成。" },
    { id: "sdlc-r4", stage: "global", text: "要求提交时，先调用 commit_gate_check；全部五阶段（含审查）approved 后才可 git commit。" },
    { id: "sdlc-r5", stage: "global", text: "提交门禁放行且 git commit 成功后，提醒开发者执行 /new 开始下一个需求，保持统计隔离。" },
    { id: "sdlc-r12", stage: "global", text: "开发者表示要手工修改某段/某文件代码时，先调用 open_ide 并**必须携带 file 参数指明该文件**（不指定 file 不会锁定），以锁定该文件防 AI 覆盖。若开发者未明确文件，先询问要改哪个文件。锁定期间可继续其它任务（改其它文件/答疑），但不得修改被锁定的文件（write/edit/apply_patch 会被服务端拒绝）。开发者确认改完后，须经其明确确认（如说「改完了/可以继续」）再调用 unlock_file 解锁该文件，并重新读取最新文件内容后继续；多个锁定文件须逐个确认解锁。" },
    // ---- requirements ----
    { id: "sdlc-r6", stage: "requirements", text: "进入需求阶段时，主动询问预估人工工时（小时）；开发者明确给出后调用 workflow_baseline(developer_confirmed=true)。未提供不阻塞；已录入后不必重复询问。" },
    // ---- review（理解保障，核心）----
    { id: "sdlc-r7", stage: "review", text: "review 是唯一不可由 AI 自行推进的阶段（必须经 review_submit），目标是确保开发者真正理解代码。" },
    { id: "sdlc-r8", stage: "review", text: "进入审查后，将每个 AI 生成的代码变更拆分为可理解片段，comprehension_add 逐段登记并输出解释（做了什么、为什么这样写、被放弃的替代方案、潜在风险）。" },
    { id: "sdlc-r9", stage: "review", text: "开发者确认某片段时，立即调用 comprehension_confirm(codeSegmentId=该片段 id)；单次只接受一个 codeSegmentId，逐段确认、禁止一次确认多个。" },
    { id: "sdlc-r10", stage: "review", text: "开发者追问时详细解释，comprehension_ask 将问答追加到该片段的 explanation。" },
    { id: "sdlc-r11", stage: "review", text: "每个片段须达成终态（confirm 接受 / manual 开发者自处理），不允许 pending/rejected 悬空；拒绝的片段先 comprehension_rewrite 重写或 manual 定论，全部定论且前序阶段（requirements/design/implementation/testing）全部 approved 后才可 review_submit；清单四项须全为 true，否则回到编码/测试。返工多应结合拒绝意见 rewrite 改进，而非简单重试。" },
  ],
}

/** reqdoc 审查清单项（reqdoc 专属，3.2）：业务确认 PRD 要点（区别于 sdlc 的代码理解确认）。 */
const REQDOC_CHECKLIST: ChecklistItem[] = [
  { key: "completeness", label: "信息完整（背景/口径/字段齐全）" },
  { key: "clarity", label: "表达明确（无歧义、可落地）" },
  { key: "edgeCoverage", label: "边界覆盖（异常/权限/合规场景俱到）" },
  { key: "resolution", label: "职责清晰（技术初步可行性已确认）" },
]

/**
 * reqdoc 工作流定义：需求书（需求分析师角色，3.2、7.4）。
 * 源于《业务需求难点与解决方案》的四段式渐进引导（目标与场景 → 主流程与规则 →
 * 边界与异常探针 → 自动化排版），外加业务确认闭环。审查阶段（review）语义为
 * 业务确认 PRD 要点，复用通用 comprehension/checklist/review_submit 机制。
 * 定稿无 git 门禁（hasCommitGate=false）。结构化规则（global + 阶段归属），
 * 需求资料目录契约（7.5）落在 goal 阶段规则与各阶段扫描映射。
 */
export const REQDOC: WorkflowDefinition = {
  type: "reqdoc",
  stages: ["goal", "rules", "edge", "prd", "review"],
  labels: {
    goal: "目标与场景",
    rules: "流程与规则",
    edge: "边界与异常",
    prd: "需求规格书",
    review: "业务确认",
  },
  reviewStage: "review",
  checklist: REQDOC_CHECKLIST,
  hasCommitGate: false,
  rules: [
    // ---- global：所有阶段通用 ----
    { id: "reqdoc-r1", stage: "global", text: "会话开始时，调用 workflow_advance(stage=goal, action=enter) 初始化工作流。" },
    { id: "reqdoc-r2", stage: "global", text: "采用渐进式分段引导，不要一次性抛出所有问题；单次提问不超过 2 个问题，避免业务有被「质问」的挫败感。" },
    { id: "reqdoc-r3", stage: "global", text: "阶段可能完成时，先输出摘要并询问确认；仅业务明确表示「确认/可以」才算确认——模糊表态不算，不得自行 approve。确认后调用 workflow_advance(action=approve, developer_confirmed=true)。" },
    { id: "reqdoc-r4", stage: "global", text: "业务说「回到XX」时，立即调用 workflow_revisit(stage=XX)。绝不自行判断阶段已完成。" },
    { id: "reqdoc-r5", stage: "global", text: "业务确认完成（review_submit 通过）后，建议执行 /new 开始下一个需求，保持统计隔离。" },
    // ---- goal 目标与场景 ----
    { id: "reqdoc-r6", stage: "goal", text: "用一两句话引导业务说明：上线后谁在用、解决什么痛点；提炼【核心用户】【业务场景】【业务价值】，表达模糊时给出 2-3 个选项让业务勾选确认。" },
    { id: "reqdoc-r7", stage: "goal", text: "进入 goal 阶段时，主动询问预估人工书写工时（小时）；业务明确给出后调用 workflow_baseline(developer_confirmed=true)。未提供不阻塞；已录入后不必重复询问。" },
    { id: "reqdoc-r8", stage: "goal", text: "目录就绪检查：项目根约定 01~07 需求资料目录（01_业务背景与目标、02_制度与合规依据、03_现状与业务流程、04_数据与字段要求、05_用户与权限角色、06_界面与交互参考、07_需求规格产出）。尚无时询问业务是否搭建骨架，确认后创建（幂等，绝不重建或覆盖业务已放材料）；业务说资料已放好则扫描 01 目录作引导输入。" },
    // ---- rules 流程与规则 ----
    { id: "reqdoc-r9", stage: "rules", text: "引导补全主流程：用户输入哪些信息、系统处理后给什么结果；将自然语言转化为字段定义（数据项 / 是否必填 / 校验规则）。" },
    { id: "reqdoc-r10", stage: "rules", text: "自动推演 Mermaid 流程图，反向展示给业务确认；业务说资料已放好则扫描 03、04 目录作输入。" },
    // ---- edge 边界与异常（最关键）----
    { id: "reqdoc-r11", stage: "edge", text: "主动追问三类探针：数据与权限（所有岗位可见还是按机构/层级隔离）、异常流程（接口超时 / 操作失败 / 审批驳回，报错还是人工补单）、合规留痕（资金/敏感变更是否留审计日志、是否二次授权）。" },
    { id: "reqdoc-r12", stage: "edge", text: "按已投放材料反问缺口（如已有制度但缺权限，追问「不同岗位的权限如何隔离」）；业务说资料已放好则扫描 02、05 目录作输入。" },
    // ---- prd 需求规格书 ----
    { id: "reqdoc-r13", stage: "prd", text: "将对话信息自动渲染成《业务需求说明书》（模板：docs/reqdoc-prd-template.md，源 docs/模版.docx；运行目录可读则按完整模板，否则按内联骨架）。骨架：封面（项目名称、项目信息表：项目编号/名称/性质/用户部门/配合部门/项目经理/技术经理/业务人员/开发人员、文档变更过程表：版本号/修改内容/变更日期/修改者/备注）→ 第一章 需求概述（需求类型：新增/更改功能、是否流程优化/跨部门/总行开发、希望完成时间、需求提出原因及功能概述）→ 第二章 需求概述（术语定义、业务规则）→ 第三章 需求功能详述（逐功能点：编号/名称/优先级，输入要素：简要概述/控制要求，处理要求：输入要素检查/系统处理过程/异常处理/提示信息/其他要求/清算处理/差错处理/交易安全性/数据存贮和清理/附件）。未涉及项在 ○/● 中选「不涉及/不适用」并留白正文；业务说资料已放好则扫描 06 目录作输入。" },
    { id: "reqdoc-r14", stage: "prd", text: "产出归档：需求澄清记录、自动提取的 Mermaid 流程图、最终 PRD 一律写入 07_需求规格产出 目录。" },
    // ---- review 业务确认（核心）----
    { id: "reqdoc-r15", stage: "review", text: "review 是唯一不可由 AI 自行推进的阶段（必须经 review_submit），确保业务真正理解并确认 PRD 要点。" },
    { id: "reqdoc-r16", stage: "review", text: "将 PRD 拆分为可确认要点（业务目标 / 核心字段 / 异常规则 / 合规要求），comprehension_add 逐段复述输出。" },
    { id: "reqdoc-r17", stage: "review", text: "业务确认某要点时，立即调用 comprehension_confirm(codeSegmentId=该要点 id)；单次只接受一个要点，逐段确认、禁止一次确认多个。" },
    { id: "reqdoc-r18", stage: "review", text: "业务追问时详细解释，comprehension_ask 将问答追加到该要点的 explanation。" },
    { id: "reqdoc-r19", stage: "review", text: "每个要点须达成终态（confirm 接受 / manual 自处理），不允许 pending/rejected 悬空；拒绝的要点先 rewrite 重写或 manual 定论，全部定论且前序阶段（goal/rules/edge/prd）全部 approved 后才可 review_submit；清单四项须全为 true，否则回到 edge/prd。通过率低说明要点含糊，应结合拒绝意见重写，而非简单重试。" },
  ],
}

/** 已注册的工作流定义注册表（3.2）。 */
export const WORKFLOW_DEFINITIONS: Record<WorkflowType, WorkflowDefinition> = {
  sdlc: SDLC,
  reqdoc: REQDOC,
}

/** 按类型取定义；未知类型抛错（类型安全，消费方应已经 resolveWorkflowType 归一）。 */
export function getDefinition(type: WorkflowType): WorkflowDefinition {
  return WORKFLOW_DEFINITIONS[type]
}

/** 将未知值归一为合法 WorkflowType；未知值回退 "sdlc" 并打 warning（兼容旧身份/旧库）。 */
export function resolveWorkflowType(v: unknown): WorkflowType {
  if (v === "sdlc") return "sdlc"
  if (v === "reqdoc") return "reqdoc"
  console.warn(`未知工作流类型 ${JSON.stringify(v)}，回退为 "sdlc"`)
  return "sdlc"
}

function createStageRecord(): StageRecord {
  return { status: "not_started", revision: 0, transitions: [] }
}

function createReviewStageRecord(def: WorkflowDefinition): ReviewStageRecord {
  const checklist: Record<string, boolean> = {}
  for (const item of def.checklist) checklist[item.key] = false
  return {
    ...createStageRecord(),
    checklist,
    comprehension: [],
  }
}

/** 会话开始时初始化的全新工作流状态（所有阶段 not_started，7.4 规则 1）。 */
export function createWorkflowState(type: WorkflowType): WorkflowState {
  const def = getDefinition(type)
  const stages: Record<string, StageRecord> = {}
  for (const key of def.stages) {
    const isReview = def.reviewStage !== null && def.reviewStage === key
    stages[key] = isReview ? createReviewStageRecord(def) : createStageRecord()
  }
  return {
    type,
    stages,
    commit: { status: "blocked", blocked_by: [...def.stages] },
    quality: {
      firstPassRate: null,
      iterationCount: null,
      reworkRate: null,
      testCoverage: null,
    },
  }
}

/** 取指定阶段记录；缺键抛错（消费方不应访问不存在的阶段）。 */
export function getStage(s: WorkflowState, key: string): StageRecord {
  const stage = s.stages[key]
  if (!stage) throw new Error(`阶段 ${key} 不存在（工作流类型 ${s.type}）`)
  return stage
}

/** 取审查阶段记录（经定义 reviewStage 定位）；无审查阶段时抛错。 */
export function reviewRecord(s: WorkflowState): ReviewStageRecord {
  const def = getDefinition(s.type)
  if (def.reviewStage === null) throw new Error(`工作流类型 ${s.type} 无审查阶段`)
  return getStage(s, def.reviewStage) as ReviewStageRecord
}

/** 取指定阶段应注入的规则：global + 该阶段规则；stage 为 null 时只给 global（7.4 阶段化注入）。 */
export function rulesForStage(def: WorkflowDefinition, stage: string | null): RuleItem[] {
  if (stage === null) return def.rules.filter((r) => r.stage === "global")
  return def.rules.filter((r) => r.stage === "global" || r.stage === stage)
}

/** 当前进行中阶段：按 def.stages 顺序取第一个 in_progress；无则 null（阶段化注入选规则用）。 */
export function currentInProgressStage(workflow: WorkflowState): string | null {
  const def = getDefinition(workflow.type)
  return def.stages.find((name) => workflow.stages[name].status === "in_progress") ?? null
}

/** 一小时对应的毫秒数（基线提效计算口径）。 */
const MS_PER_HOUR = 3_600_000

/**
 * AI 提效率（6.3）：（预估人工工时 − 实际周期）÷ 预估人工工时。
 * 比率型指标，可为负（实际周期超过预估时），仅展示不设阈值。
 * 无基线（estimatedHours 缺失或非正）或无有效周期（durationMs≤0）时返回 null（展示 N/A）。
 */
export function efficiencyRatio(estimatedHours: number | null | undefined, durationMs: number): number | null {
  if (estimatedHours === null || estimatedHours === undefined || estimatedHours <= 0) return null
  if (durationMs <= 0) return null
  return (estimatedHours * MS_PER_HOUR - durationMs) / (estimatedHours * MS_PER_HOUR)
}