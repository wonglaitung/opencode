/**
 * 工作流状态的纯函数操作（设计文档 3.3、3.4）。
 * 阶段转换（enter/approve/revisit）、审查回退与提交门禁重算——
 * 集中于此供插件工具复用与单元测试，不触碰数据库。
 */
import { getDefinition, type TransitionAction, type WorkflowState } from "sm-shared"

export class WorkflowOpError extends Error {}

/** 依据定义 stages 的 approved 状况重算提交门禁（3.4）；保留既有的一次性强制提交授权。 */
export function recomputeCommit(workflow: WorkflowState): WorkflowState {
  const def = getDefinition(workflow.type)
  const blockedBy = def.stages.filter((name) => workflow.stages[name].status !== "approved")
  workflow.commit = {
    status: blockedBy.length === 0 ? "allowed" : "blocked",
    blocked_by: blockedBy,
    ...(workflow.commit.force ? { force: workflow.commit.force } : {}),
  }
  return workflow
}

/**
 * 对指定阶段施加一次转换，返回（原地修改后的）状态。
 * 严格遵守 3.3 状态机：enter 仅限 not_started→in_progress（状态机无 approved→in_progress、
 * in_progress→in_progress 的 enter 边），approved 只能经 revisit 回退。
 * - enter:   not_started → in_progress；已 approved 抛错（须 revisit）；已 in_progress 幂等 no-op
 * - approve: in_progress → approved（未 enter 不可 approve）
 * - revisit: → in_progress，revision++（3.3）
 */
export function applyTransition(
  workflow: WorkflowState,
  stage: string,
  action: TransitionAction,
  at: number,
  note?: string,
): WorkflowState {
  const record = workflow.stages[stage]
  switch (action) {
    case "enter":
      if (record.status === "approved") {
        throw new WorkflowOpError(`阶段 ${stage} 已 approved，如需返工请用 workflow_revisit 回退`)
      }
      if (record.status === "in_progress") {
        // 幂等：重复 enter 不再追加 transition（transitions[] 喂耗时统计口径，避免污染）
        return workflow
      }
      record.status = "in_progress"
      break
    case "approve":
      if (record.status !== "in_progress") {
        throw new WorkflowOpError(`阶段 ${stage} 需先处于 in_progress 才能 approve（当前 ${record.status}）`)
      }
      record.status = "approved"
      break
    case "revisit":
      record.status = "in_progress"
      record.revision += 1
      break
  }
  record.transitions.push(note ? { action, at, note } : { action, at })
  return recomputeCommit(workflow)
}
