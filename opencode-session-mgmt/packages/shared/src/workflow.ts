/**
 * WorkflowState 及子结构类型定义（设计文档 3.2）。
 * 插件、CLI、收集服务三方共用的契约——任何字段变更必须三包同步。
 *
 * 多流程就绪：阶段键/清单/规则/门禁均从 WorkflowDefinition 注册表驱动，而非硬编码。
 * 本轮只注册 sdlc（设计文档 3.2 注册表）；reqdoc 随需求书工作加入。
 */

export type WorkflowType = "sdlc"
// 预留：后续 reqdoc 加入时扩为 "sdlc" | "reqdoc"

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

export interface ComprehensionRecord {
  codeSegmentId: string
  file: string
  lines: [number, number]
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
  /** 该类型注入的规则全文（原 RULES 移入，7.4） */
  rules: string
}

/** SDLC 五阶段审查清单项（sdlc 专属，3.2）；review_submit 从具名参数生成，字节不变。
 *  designRationale 为 auto：全部片段定论即通过，无需 Agent 逐项上报（LLM 契约仅 3 具名参数）。 */
const SDLC_CHECKLIST: ChecklistItem[] = [
  { key: "businessIntent", label: "业务意图清晰" },
  { key: "logicExplainable", label: "逻辑可解释" },
  { key: "behaviorVerifiable", label: "行为可验证" },
  { key: "designRationale", label: "设计取舍合理", auto: true },
]

/** SDLC 工作流定义：五阶段 + 四清单 + git 门禁 + 规则全文（原硬编码常量原样搬入）。 */
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
  rules: `# Workflow Agent 规则

## 阶段推进
1. 会话开始时初始化 workflow（所有阶段 not_started）。
2. 阶段可能完成时，先输出摘要并询问确认；开发者明确确认后才可调用 workflow_advance 标记 approved。
3. 开发者说"回到XX"时，立即调用 workflow_revisit。
4. 绝不自行判断阶段已完成——阶段转换的唯一来源是开发者的明确操作。
5. 要求提交时先调用 commit_gate_check，检查全部五个阶段（含审查）。

## 审查阶段（理解保障，核心）
6. 审查是唯一不可由 AI 自行推进的阶段，目标是确保开发者真正理解代码。
7. 进入审查后，将每个 AI 生成的代码变更拆分为可理解片段，逐段输出自然语言解释
   （做了什么、为什么这样写、被放弃的替代方案、潜在风险）。
8. 开发者必须逐段确认：comprehension_confirm 单次只接受一个 codeSegmentId。
9. 开发者追问时详细解释，并将问答追加到该片段的 explanation（comprehension_ask）。
10. 每个片段须达成终态（comprehension_confirm 接受 / comprehension_manual 开发者自处理），
    不允许 pending/rejected 悬空；拒绝的片段先 comprehension_rewrite 重写或 manual 定论，全部定论后才可 review_submit；
    清单四项须全为 true，否则回到编码/测试。

## 一次通过率与迭代上限
11. 一次通过率由 review_submit 自动计算（未重写即 accepted 的片段占比），无需 Agent 上报；
    一次通过率低说明返工多，应结合拒绝意见 comprehension_rewrite 改进，而非简单重试。
12. 检测连续重复编辑模式（同一文件连续 3 次以上相同参数的 AI 编辑，或同一文件被编辑 6 次以上），提醒开发者审查是否陷入无效循环，但不拒绝生成。

## 基线对比（预估工时）
13. 进入需求阶段（workflow_advance stage=requirements action=enter）时，主动询问开发者：
    项目经理对本需求的预估人工工时是多少（小时）？开发者明确给出后调用 workflow_baseline 记录
    （developer_confirmed=true）。用于会话结束后与实际周期对比、计算 AI 提效率；未提供不阻塞，
    已录入后可从状态中读到，不必重复询问。

## SDLC 完结与下一需求
14. 提交门禁放行（commit.status=allowed）且 git commit 成功后，主动提醒开发者：
    "本需求 SDLC 已完成。建议执行 /new 开始下一个需求，以保持统计隔离。"`,
}

/** 已注册的工作流定义注册表（3.2）。 */
export const WORKFLOW_DEFINITIONS: Record<WorkflowType, WorkflowDefinition> = {
  sdlc: SDLC,
}

/** 按类型取定义；未知类型抛错（类型安全，消费方应已经 resolveWorkflowType 归一）。 */
export function getDefinition(type: WorkflowType): WorkflowDefinition {
  return WORKFLOW_DEFINITIONS[type]
}

/** 将未知值归一为合法 WorkflowType；未知值回退 "sdlc" 并打 warning（兼容旧身份/旧库）。 */
export function resolveWorkflowType(v: unknown): WorkflowType {
  if (v === "sdlc") return "sdlc"
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