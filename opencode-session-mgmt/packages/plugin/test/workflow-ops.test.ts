import { describe, expect, test } from "bun:test"
import { createWorkflowState } from "sm-shared"
import { WorkflowOpError, applyTransition, recomputeCommit } from "../src/workflow-ops"

describe("applyTransition", () => {
  test("enter → approve 记录转换并更新状态", () => {
    const state = createWorkflowState()
    applyTransition(state, "requirements", "enter", 1000)
    expect(state.stages.requirements.status).toBe("in_progress")
    applyTransition(state, "requirements", "approve", 2000, "确认")
    expect(state.stages.requirements.status).toBe("approved")
    expect(state.stages.requirements.transitions).toHaveLength(2)
  })

  test("未经 in_progress 不可 approve", () => {
    const state = createWorkflowState()
    expect(() => applyTransition(state, "design", "approve", 1)).toThrow(WorkflowOpError)
  })

  test("revisit 使 revision++", () => {
    const state = createWorkflowState()
    applyTransition(state, "requirements", "enter", 1)
    applyTransition(state, "requirements", "approve", 2)
    applyTransition(state, "requirements", "revisit", 3)
    expect(state.stages.requirements.status).toBe("in_progress")
    expect(state.stages.requirements.revision).toBe(1)
  })
})

describe("recomputeCommit", () => {
  test("全部 approved 才 allowed", () => {
    const state = createWorkflowState()
    for (const name of ["requirements", "design", "implementation", "testing"] as const) {
      applyTransition(state, name, "enter", 1)
      applyTransition(state, name, "approve", 2)
    }
    recomputeCommit(state)
    expect(state.commit.status).toBe("blocked")
    expect(state.commit.blocked_by).toEqual(["review"])
  })
})
