import { describe, expect, test } from "bun:test"
import { createWorkflowState, type WorkflowState } from "sm-shared"
import { buildSystemFragment } from "../src/prompt"
import { applyTransition } from "../src/workflow-ops"

/** 推进到全部阶段 approved（完成态）。 */
function completeSdlc(): WorkflowState {
  const s = createWorkflowState("sdlc")
  for (const name of ["requirements", "design", "implementation", "testing", "review"]) {
    applyTransition(s, name, "enter", 1)
    applyTransition(s, name, "approve", 2)
  }
  return s
}

function completeReqdoc(): WorkflowState {
  const s = createWorkflowState("reqdoc")
  for (const name of ["goal", "rules", "edge", "prd", "review"]) {
    applyTransition(s, name, "enter", 1)
    applyTransition(s, name, "approve", 2)
  }
  return s
}

describe("buildSystemFragment", () => {
  test("未开始：注入起步提示，不出现完成态横幅与矛盾文案", () => {
    const s = createWorkflowState("sdlc")
    const text = buildSystemFragment(s)
    expect(text).toContain("工作流尚未开始")
    expect(text).toContain("需求分析")
    // 完成态横幅不出现（避免「尚未开始」与「已完成」自相矛盾）
    expect(text).not.toContain("Workflow 已完成")
    expect(text).not.toContain("已全部完成")
  })

  test("进行中：只注入 global + 当前阶段规则，不出现完成态横幅", () => {
    const s = createWorkflowState("sdlc")
    applyTransition(s, "requirements", "enter", 1)
    const text = buildSystemFragment(s)
    // 当前阶段专属规则（需求阶段问基线）被注入
    expect(text).toContain("workflow_baseline")
    // 其它阶段的专属规则不注入（如审查的 comprehension_add）
    expect(text).not.toContain("comprehension_add")
    expect(text).not.toContain("Workflow 已完成")
  })

  test("空档态：部分 approved 无进行中 → 提示进入下一阶段而非「尚未开始」", () => {
    const s = createWorkflowState("sdlc")
    applyTransition(s, "requirements", "enter", 1)
    applyTransition(s, "requirements", "approve", 2)
    // 尚未 enter design → 无 in_progress、非完成态（stage===null 空档态）
    const text = buildSystemFragment(s)
    expect(text).toContain("当前无进行中阶段")
    expect(text).toContain("需求分析")
    expect(text).toContain("设计")
    expect(text).toContain("workflow_revisit")
    expect(text).not.toContain("工作流尚未开始")
    expect(text).not.toContain("Workflow 已完成")
  })

  test("SDLC 完成：提示 /new + revisit，且不再出现「尚未开始」或误导性「初始化工作流」", () => {
    const text = buildSystemFragment(completeSdlc())
    expect(text).toContain("/new")
    expect(text).toContain("统计隔离")
    expect(text).toContain("commit_gate_check")
    expect(text).toContain("workflow_revisit") // 完成态也给「改本需求」路径
    expect(text).not.toContain("尚未开始")
    expect(text).not.toContain("初始化工作流")
    expect(text).toContain("提交门禁：allowed")
  })

  test("reqdoc 完成：提示 /new + revisit，无 git 门禁相关文案", () => {
    const text = buildSystemFragment(completeReqdoc())
    expect(text).toContain("/new")
    expect(text).toContain("workflow_revisit")
    expect(text).not.toContain("commit_gate_check")
    expect(text).not.toContain("尚未开始")
  })

  test("进行中 stuck 警告仅在非完成态注入", () => {
    const s = createWorkflowState("sdlc")
    applyTransition(s, "implementation", "enter", 1)
    const active = buildSystemFragment(s, { "src/a.ts": 3 })
    expect(active).toContain("重复编辑模式")
    const done = buildSystemFragment(completeSdlc(), { "src/a.ts": 3 })
    expect(done).not.toContain("重复编辑模式")
  })

  test("SDLC 完成 + 有锁文件 → 注入解锁提示（列文件清单）", () => {
    const text = buildSystemFragment(completeSdlc(), {}, ["/home/dev/project/src/A.java"])
    expect(text).toContain("人工锁定")
    expect(text).toContain("src/A.java")
    expect(text).toContain("unlock_file")
  })

  test("SDLC 完成 + 无锁文件 → 不注入解锁提示", () => {
    const text = buildSystemFragment(completeSdlc())
    expect(text).not.toContain("人工锁定")
  })

  test("reqdoc 完成 + 有锁文件 → 不注入解锁提示（hasCommitGate 护栏）", () => {
    const text = buildSystemFragment(completeReqdoc(), {}, ["/home/dev/project/src/A.java"])
    expect(text).not.toContain("人工锁定")
  })

  test("SDLC 进行中（未完成）+ 有锁文件 → 不注入解锁提示", () => {
    const s = createWorkflowState("sdlc")
    applyTransition(s, "requirements", "enter", 1)
    const text = buildSystemFragment(s, {}, ["/home/dev/project/src/A.java"])
    expect(text).not.toContain("人工锁定")
  })
})
