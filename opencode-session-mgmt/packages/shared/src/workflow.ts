/**
 * WorkflowState 及子结构类型定义（设计文档 3.2）。
 * 插件、CLI、收集服务三方共用的契约——任何字段变更必须三包同步。
 */

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

export interface ReviewChecklist {
  businessIntent: boolean
  logicExplainable: boolean
  behaviorVerifiable: boolean
  designRationale: boolean
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
  checklist: ReviewChecklist
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

export interface QualityMetrics {
  /** 一次通过率（3.2）：未重写即 accepted 的片段数 ÷ 全部定论片段数(accepted+manual)。
   *  review_submit 通过时由插件自动计算写回，不依赖 Agent 上报。纯讨论会话（无片段）保持 null。 */
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

export interface Stages {
  requirements: StageRecord
  design: StageRecord
  implementation: StageRecord
  testing: StageRecord
  review: ReviewStageRecord
}

export interface WorkflowState {
  stages: Stages
  commit: CommitGate
  quality: QualityMetrics
}

/** 五个阶段键（提交门禁要求全部 approved，3.4）。 */
export const STAGE_ORDER = ["requirements", "design", "implementation", "testing", "review"] as const

export type StageName = (typeof STAGE_ORDER)[number]

/** 阶段中文名（供工具回显与统计展示）。 */
export const STAGE_LABELS: Record<StageName, string> = {
  requirements: "需求分析",
  design: "设计",
  implementation: "编码",
  testing: "测试",
  review: "审查",
}

function createStageRecord(): StageRecord {
  return { status: "not_started", revision: 0, transitions: [] }
}

function createReviewStageRecord(): ReviewStageRecord {
  return {
    ...createStageRecord(),
    checklist: {
      businessIntent: false,
      logicExplainable: false,
      behaviorVerifiable: false,
      designRationale: false,
    },
    comprehension: [],
  }
}

/** 会话开始时初始化的全新工作流状态（所有阶段 not_started，7.4 规则 1）。 */
export function createWorkflowState(): WorkflowState {
  return {
    stages: {
      requirements: createStageRecord(),
      design: createStageRecord(),
      implementation: createStageRecord(),
      testing: createStageRecord(),
      review: createReviewStageRecord(),
    },
    commit: { status: "blocked", blocked_by: [...STAGE_ORDER] },
    quality: {
      firstPassRate: null,
      iterationCount: null,
      reworkRate: null,
      testCoverage: null,
    },
  }
}
