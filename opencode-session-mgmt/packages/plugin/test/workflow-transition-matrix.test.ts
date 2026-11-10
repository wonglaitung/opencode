import { describe, expect, test } from "bun:test"
import {
  createWorkflowState,
  getDefinition,
  reviewRecord,
  type StageStatus,
  type WorkflowType,
} from "sm-shared"
import { WorkflowOpError, applyTransition, assertWorkflowNotComplete } from "../src/workflow-ops"

const TYPES = ["task", "sdlc", "reqdoc", "websec"] as const satisfies readonly WorkflowType[]
const STATUSES: StageStatus[] = ["not_started", "in_progress", "approved"]

function stateAt(type: WorkflowType, stage: string, status: StageStatus) {
  const state = createWorkflowState(type)
  state.stages[stage]!.status = status
  return state
}

for (const type of TYPES) {
  const def = getDefinition(type)

  describe(`${type} 状态转换矩阵`, () => {
    for (const stage of def.stages) {
      for (const status of STATUSES) {
        test(`enter：${stage} @ ${status}`, () => {
          const state = stateAt(type, stage, status)
          const record = state.stages[stage]!

          if (status === "approved") {
            expect(() => applyTransition(state, stage, "enter", 1)).toThrow(WorkflowOpError)
            expect(record.status).toBe("approved")
            expect(record.transitions).toHaveLength(0)
            return
          }

          applyTransition(state, stage, "enter", 1)
          expect(record.status).toBe("in_progress")
          expect(record.transitions).toHaveLength(status === "in_progress" ? 0 : 1)
        })

        test(`approve：${stage} @ ${status}`, () => {
          const state = stateAt(type, stage, status)
          const record = state.stages[stage]!

          if (status !== "in_progress") {
            expect(() => applyTransition(state, stage, "approve", 1)).toThrow(WorkflowOpError)
            expect(record.status).toBe(status)
            expect(record.transitions).toHaveLength(0)
            return
          }

          applyTransition(state, stage, "approve", 1)
          expect(record.status).toBe("approved")
          expect(record.transitions).toHaveLength(1)
        })

        test(`revisit：${stage} @ ${status}`, () => {
          const state = stateAt(type, stage, status)
          const record = state.stages[stage]!

          applyTransition(state, stage, "revisit", 1)
          expect(record.status).toBe("in_progress")
          expect(record.revision).toBe(1)
          expect(record.transitions).toHaveLength(1)
          expect(record.transitions[0]!.action).toBe("revisit")
        })
      }
    }
  })

  if (def.stages.length > 1) {
    describe(`${type} 级联回退矩阵`, () => {
      for (const [targetIndex, target] of def.stages.entries()) {
        test(`revisit：${target} 只回退自身与下游`, () => {
          const state = createWorkflowState(type)
          for (const stage of def.stages) state.stages[stage]!.status = "approved"

          applyTransition(state, target, "revisit", 1)

          for (const [index, stage] of def.stages.entries()) {
            const record = state.stages[stage]!
            if (index < targetIndex) {
              expect(record.status).toBe("approved")
              expect(record.revision).toBe(0)
              continue
            }
            if (index === targetIndex) {
              expect(record.status).toBe("in_progress")
              expect(record.revision).toBe(1)
              continue
            }
            expect(record.status).toBe("in_progress")
            expect(record.revision).toBe(1)
            expect(record.transitions.some((transition) => transition.action === "revisit")).toBe(true)
          }
        })
      }
    })
  }

  test(`${type} 完成态写入保护：全部 approved 才拒绝`, () => {
    const complete = createWorkflowState(type)
    for (const stage of def.stages) complete.stages[stage]!.status = "approved"
    expect(() => assertWorkflowNotComplete(complete, "测试写入")).toThrow(/工作流已完成，不能测试写入/)

    for (const stage of def.stages) {
      const state = createWorkflowState(type)
      for (const name of def.stages) state.stages[name]!.status = "approved"
      state.stages[stage]!.status = "in_progress"
      expect(() => assertWorkflowNotComplete(state, "测试写入")).not.toThrow()
    }
  })

  test(`${type} 回退后可重新完成，完成态写入保护解除`, () => {
    const state = createWorkflowState(type)
    for (const stage of def.stages) state.stages[stage]!.status = "approved"
    expect(() => assertWorkflowNotComplete(state, "测试写入")).toThrow(WorkflowOpError)

    applyTransition(state, def.stages[0]!, "revisit", 1)
    expect(() => assertWorkflowNotComplete(state, "测试写入")).not.toThrow()
    expect(state.stages[def.stages[0]!]!.status).toBe("in_progress")
  })
}

for (const type of ["sdlc", "reqdoc"] as const) {
  test(`${type} 级联回退审查阶段时重置已确认的理解片段`, () => {
    const state = createWorkflowState(type)
    const def = getDefinition(type)
    for (const stage of def.stages) state.stages[stage]!.status = "approved"
    const review = reviewRecord(state)
    review.comprehension.push({
      id: "point-1",
      explanation: "示例要点",
      decision: "accepted",
      developerConfirmed: true,
      confirmedAt: 1,
      feedback: null,
      rejectedAt: null,
      rewrites: 0,
      resolution: null,
    })

    applyTransition(state, def.stages[0]!, "revisit", 2)

    expect(review.comprehension[0]!.decision).toBe("pending")
    expect(review.comprehension[0]!.developerConfirmed).toBe(false)
    expect(review.comprehension[0]!.confirmedAt).toBeNull()
  })
}
