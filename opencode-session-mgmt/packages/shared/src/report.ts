/**
 * 汇报与 CI 回写的 payload schema（设计文档 §4.3、§10）。
 * 插件 → 收集服务（POST /api/report）；CI → 收集服务（POST /api/ci-quality）。
 * 仅流程摘要，不含代码内容（§12 安全与隐私）。
 */

export interface SessionReport {
  sessionID: string
  /** 以下为 init 身份快照（§3.1 快照语义） */
  account: string
  group: string
  org: string
  /** 工作流摘要：阶段时间戳、revision、审查结果 */
  workflow: unknown // TODO: WorkflowState 的摘要投影类型
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
