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

  test("revisit 级联回退下游已 approved 阶段（revision++ 且记 transition）", () => {
    const state = createWorkflowState("sdlc")
    for (const name of ["requirements", "design", "implementation", "testing"] as const) {
      applyTransition(state, name, "enter", 1)
      applyTransition(state, name, "approve", 2)
    }
    // requirements approved 后回退 → design/implementation/testing 全部级联回退到 in_progress
    applyTransition(state, "requirements", "revisit", 3, "需求改动")
    expect(state.stages.requirements.status).toBe("in_progress")
    expect(state.stages.requirements.revision).toBe(1)
    expect(state.stages.design.status).toBe("in_progress")
    expect(state.stages.design.revision).toBe(1)
    expect(state.stages.implementation.status).toBe("in_progress")
    expect(state.stages.implementation.revision).toBe(1)
    expect(state.stages.testing.status).toBe("in_progress")
    expect(state.stages.testing.revision).toBe(1)
    // 被级联阶段也记录 revisit transition（喂耗时统计口径）
    expect(state.stages.design.transitions.some((t) => t.action === "revisit")).toBe(true)
    expect(state.stages.implementation.transitions.some((t) => t.action === "revisit")).toBe(true)
  })

  test("revisit 未 approved 的下游阶段不受影响；回退中间阶段仅级联其后", () => {
    const state = createWorkflowState("sdlc")
    applyTransition(state, "requirements", "enter", 1)
    applyTransition(state, "requirements", "approve", 2)
    applyTransition(state, "design", "enter", 3)
    applyTransition(state, "design", "approve", 4)
    applyTransition(state, "implementation", "enter", 5)
    // 回退 design：下游 implementation（in_progress 非 approved）不动，testing/review 本就 not_started
    applyTransition(state, "design", "revisit", 6)
    expect(state.stages.design.status).toBe("in_progress")
    expect(state.stages.implementation.status).toBe("in_progress") // 保持 in_progress，不级联
    expect(state.stages.testing.status).toBe("not_started")
    // implementation 未被级联，revision 仍为 0
    expect(state.stages.implementation.revision).toBe(0)
  })

  test("revisit 已含 review approved 时 review 也级联回退（review 不例外）", () => {
    const state = createWorkflowState("sdlc")
    for (const name of ["requirements", "design", "implementation", "testing", "review"] as const) {
      applyTransition(state, name, "enter", 1)
      applyTransition(state, name, "approve", 2)
    }
    applyTransition(state, "requirements", "revisit", 3)
    expect(state.stages.review.status).toBe("in_progress")
    expect(state.stages.review.revision).toBe(1)
    // 门禁重算：回退后 blocked
    expect(state.commit.status).toBe("blocked")
    expect(state.commit.blocked_by).toEqual(["requirements", "design", "implementation", "testing", "review"])
  })

  test("reqdoc：revisit(goal) 级联回退 rules/edge/prd/review（与 sdlc 同语义）", () => {
    const state = createWorkflowState("reqdoc")
    for (const name of ["goal", "rules", "edge", "prd", "review"] as const) {
      applyTransition(state, name, "enter", 1)
      applyTransition(state, name, "approve", 2)
    }
    // 全部 approved 后回退到目标与场景
    applyTransition(state, "goal", "revisit", 3, "业务补充")
    expect(state.stages.goal.status).toBe("in_progress")
    expect(state.stages.goal.revision).toBe(1)
    // 下游四阶段全部级联回退，revision++，且记 revisit transition
    expect(state.stages.rules.status).toBe("in_progress")
    expect(state.stages.edge.status).toBe("in_progress")
    expect(state.stages.prd.status).toBe("in_progress")
    expect(state.stages.review.status).toBe("in_progress")
    expect(state.stages.rules.revision).toBe(1)
    expect(state.stages.review.revision).toBe(1)
    expect(state.stages.prd.transitions.some((t) => t.action === "revisit")).toBe(true)
    expect(state.stages.review.transitions.some((t) => t.action === "revisit")).toBe(true)
    // 业务确认回退后门禁重算：blocked 且包含被级联阶段
    expect(state.commit.status).toBe("blocked")
    expect(state.commit.blocked_by).toEqual(["goal", "rules", "edge", "prd", "review"])
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
