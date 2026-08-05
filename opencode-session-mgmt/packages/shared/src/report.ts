/**
 * 汇报与 CI 回写的 payload schema（设计文档 4.3、10）。
 * 插件 → 收集服务（POST /api/report）；CI → 收集服务（POST /api/ci-quality）。
 * 仅流程摘要，不含代码内容（12 安全与隐私）。
 */
import type {
  CommitGate,
  QualityMetrics,
  ReviewChecklist,
  StageRecord,
  StageStatus,
  Transition,
  WorkflowState,
} from "./workflow"

/** 单个阶段的摘要投影：状态、迭代次数与时间戳序列（分析数据源，6.1）。 */
export interface StageSummary {
  status: StageStatus
  revision: number
  transitions: Transition[]
}

/** 审查阶段的摘要投影：在阶段摘要之上保留清单与理解确认计数（不含 explanation 正文）。 */
export interface ReviewStageSummary extends StageSummary {
  checklist: ReviewChecklist
  /** 理解确认片段总数与已确认数（不携带片段正文，12） */
  comprehension: {
    total: number
    confirmed: number
  }
}

/** 质量指标的汇报投影：剔除 iterationByFile（键为文件路径，12 不外传代码相关标识）。 */
export type QualitySummary = Omit<QualityMetrics, "iterationByFile">

/**
 * WorkflowState 的汇报投影：剔除代码相关内容（comprehension.explanation、file/lines，
 * 以及 quality.iterationByFile 的文件路径），只保留流程时间戳、迭代、审查结论与质量指标。
 */
export interface WorkflowSummary {
  stages: {
    requirements: StageSummary
    design: StageSummary
    implementation: StageSummary
    testing: StageSummary
    review: ReviewStageSummary
  }
  commit: CommitGate
  quality: QualitySummary
}

function summarizeStage(stage: StageRecord): StageSummary {
  return { status: stage.status, revision: stage.revision, transitions: stage.transitions }
}

/** 将完整 WorkflowState 投影为汇报摘要（剥离代码相关内容）。 */
export function summarizeWorkflow(workflow: WorkflowState): WorkflowSummary {
  const review = workflow.stages.review
  const confirmed = review.comprehension.filter((c) => c.developerConfirmed).length
  return {
    stages: {
      requirements: summarizeStage(workflow.stages.requirements),
      design: summarizeStage(workflow.stages.design),
      implementation: summarizeStage(workflow.stages.implementation),
      testing: summarizeStage(workflow.stages.testing),
      review: {
        ...summarizeStage(review),
        checklist: review.checklist,
        comprehension: { total: review.comprehension.length, confirmed },
      },
    },
    commit: workflow.commit,
    // 显式投影：不外传 iterationByFile（其键为文件路径，12）。
    quality: {
      firstPassRate: workflow.quality.firstPassRate,
      iterationCount: workflow.quality.iterationCount,
      reworkRate: workflow.quality.reworkRate,
      testCoverage: workflow.quality.testCoverage,
    },
  }
}

export interface SessionReport {
  sessionID: string
  /** 以下为 init 身份快照（3.1 快照语义） */
  account: string
  group: string
  org: string
  /** 工作流摘要：阶段时间戳、revision、审查结果（不含代码内容） */
  workflow: WorkflowSummary
  cost: number | null
  tokensInput: number | null
  tokensOutput: number | null
  reportedAt: number
}

export interface CiQualityReport {
  sessionID: string
  quality: {
    reworkRate?: number
    testCoverage?: number
  }
}
