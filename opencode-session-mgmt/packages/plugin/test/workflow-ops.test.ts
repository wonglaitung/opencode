import { describe, expect, test } from "bun:test"
import { createWorkflowState } from "sm-shared"
import { WorkflowOpError, applyTransition, recomputeCommit } from "../src/workflow-ops"

describe("applyTransition", () => {
  test("enter → approve 记录转换并更新状态", () => {
    const state = createWorkflowState("sdlc")
    applyTransition(state, "requirements", "enter", 1000)
    expect(state.stages.requirements.status).toBe("in_progress")
    applyTransition(state, "requirements", "approve", 2000, "确认")
    expect(state.stages.requirements.status).toBe("approved")
    expect(state.stages.requirements.transitions).toHaveLength(2)
  })

  test("未经 in_progress 不可 approve", () => {
    const state = createWorkflowState("sdlc")
    expect(() => applyTransition(state, "design", "approve", 1)).toThrow(WorkflowOpError)
  })

  test("enter 已 approved 阶段抛错，须走 revisit", () => {
    const state = createWorkflowState("sdlc")
    applyTransition(state, "requirements", "enter", 1)
    applyTransition(state, "requirements", "approve", 2)
    expect(() => applyTransition(state, "requirements", "enter", 3)).toThrow(WorkflowOpError)
    // 合法路径：revisit 回退后再 enter
    applyTransition(state, "requirements", "revisit", 4)
    applyTransition(state, "requirements", "enter", 5)
    expect(state.stages.requirements.status).toBe("in_progress")
  })

  test("enter 已 approved 报错区分返工与开新需求（引导 /new 防统计污染）", () => {
    const state = createWorkflowState("sdlc")
    applyTransition(state, "requirements", "enter", 1)
    applyTransition(state, "requirements", "approve", 2)
    let message = ""
    try {
      applyTransition(state, "requirements", "enter", 3)
    } catch (e) {
      message = (e as WorkflowOpError).message
    }
    expect(message).toContain("workflow_revisit")
    expect(message).toContain("/new")
    expect(message).toContain("统计隔离")
  })

  test("enter 已 in_progress 阶段幂等，不追加 transition", () => {
    const state = createWorkflowState("sdlc")
    applyTransition(state, "requirements", "enter", 1)
    const before = state.stages.requirements.transitions.length
    applyTransition(state, "requirements", "enter", 2)
    expect(state.stages.requirements.status).toBe("in_progress")
    expect(state.stages.requirements.transitions).toHaveLength(before)
  })

  test("revisit 使 revision++", () => {
    const state = createWorkflowState("sdlc")
    applyTransition(state, "requirements", "enter", 1)
    applyTransition(state, "requirements", "approve", 2)
    applyTransition(state, "requirements", "revisit", 3)
    expect(state.stages.requirements.status).toBe("in_progress")
    expect(state.stages.requirements.revision).toBe(1)
  })
})

describe("recomputeCommit", () => {
  test("全部 approved 才 allowed", () => {
    const state = createWorkflowState("sdlc")
    for (const name of ["requirements", "design", "implementation", "testing"] as const) {
      applyTransition(state, name, "enter", 1)
      applyTransition(state, name, "approve", 2)
    }
    recomputeCommit(state)
    expect(state.commit.status).toBe("blocked")
    expect(state.commit.blocked_by).toEqual(["review"])
  })

  test("重算门禁保留一次性强制提交授权", () => {
    const state = createWorkflowState("sdlc")
    state.commit.force = { reason: "紧急 hotfix", at: 1, used: false }
    recomputeCommit(state)
    expect(state.commit.status).toBe("blocked")
    expect(state.commit.force).toEqual({ reason: "紧急 hotfix", at: 1, used: false })
  })
})
