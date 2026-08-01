/**
 * WorkflowState 及子结构类型定义（设计文档 §3.2）。
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
  acceptanceRate: number | null
}

export interface ComprehensionRecord {
  codeSegmentId: string
  file: string
  lines: [number, number]
  explanation: string
  developerConfirmed: boolean
  confirmedAt: number | null
}

export interface ReviewStageRecord extends StageRecord {
  checklist: ReviewChecklist
  comprehension: ComprehensionRecord[]
}

export interface CommitGate {
  status: "blocked" | "allowed"
  blocked_by: string[]
}

export interface QualityMetrics {
  /** 会话内追踪（插件写本机库，随汇报上行） */
  acceptanceRate: number | null
  iterationCount: number | null
  /** 合并后由 CI 按 sessionID 回写收集服务（设计文档 §4.3） */
  reworkRate: number | null
  testCoverage: number | null
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
