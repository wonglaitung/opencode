/**
 * 工作流工具测试：commit_force_unlock 强制提交授权（3.4 逃生口）、
 * workflow_baseline 基线预估工时录入（6.3）。
 */
import { describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { createWorkflowTools } from "../src/tools/workflow"

const ctx = { sessionID: "s1" } as never

function setup() {
  const store = Store.memory()
  const tools = createWorkflowTools(store)
  return { store, tools }
}

describe("commit_force_unlock", () => {
  test("需 developer_confirmed 与非空原因", async () => {
    const { store, tools } = setup()
    const unlock = tools.commit_force_unlock!
    await expect(
      unlock.execute({ reason: "紧急", developer_confirmed: false } as never, ctx),
    ).rejects.toThrow(/developer_confirmed/)
    await expect(
      unlock.execute({ reason: "   ", developer_confirmed: true } as never, ctx),
    ).rejects.toThrow(/原因/)
    store.close()
  })

  test("写入一次性授权并留痕", async () => {
    const { store, tools } = setup()
    await tools.commit_force_unlock!.execute({ reason: "紧急 hotfix", developer_confirmed: true } as never, ctx)
    const force = store.get("s1")!.workflow!.commit.force
    expect(force?.reason).toBe("紧急 hotfix")
    expect(force?.used).toBe(false)
    expect(typeof force?.at).toBe("number")
    store.close()
  })

  test("workflow_advance 仍拒绝审查阶段自批", async () => {
    const { store, tools } = setup()
    await expect(
      tools.workflow_advance!.execute({ stage: "review", action: "approve", developer_confirmed: true } as never, ctx),
    ).rejects.toThrow(/review_submit/)
    store.close()
  })
})

describe("workflow_baseline（基线预估工时，6.3）", () => {
  test("录入预估工时并记录 setAt", async () => {
    const { store, tools } = setup()
    await tools.workflow_baseline!.execute({ estimated_hours: 8, developer_confirmed: true } as never, ctx)
    const baseline = store.get("s1")!.workflow!.baseline
    expect(baseline?.estimatedHours).toBe(8)
    expect(typeof baseline?.setAt).toBe("number")
    store.close()
  })

  test("需 developer_confirmed，防 AI 杜撰基线", async () => {
    const { store, tools } = setup()
    await expect(
      tools.workflow_baseline!.execute({ estimated_hours: 8, developer_confirmed: false } as never, ctx),
    ).rejects.toThrow(/developer_confirmed/)
    expect(store.get("s1")?.workflow?.baseline).toBeUndefined()
    store.close()
  })

  test("重设为幂等覆盖（记最新值）", async () => {
    const { store, tools } = setup()
    await tools.workflow_baseline!.execute({ estimated_hours: 8, developer_confirmed: true } as never, ctx)
    await tools.workflow_baseline!.execute({ estimated_hours: 12, developer_confirmed: true } as never, ctx)
    expect(store.get("s1")!.workflow!.baseline?.estimatedHours).toBe(12)
    store.close()
  })
})

describe("workflow_revisit 级联回退", () => {
  test("回退早阶段返回信息含级联回退列表", async () => {
    const { store, tools } = setup()
    // 推进 requirements/design/implementation 至 approved
    for (const stage of ["requirements", "design", "implementation"] as const) {
      await tools.workflow_advance!.execute({ stage, action: "enter", developer_confirmed: false } as never, ctx)
      await tools.workflow_advance!.execute({ stage, action: "approve", developer_confirmed: true } as never, ctx)
    }
    const out = await tools.workflow_revisit!.execute({ stage: "requirements", note: "需求改动" } as never, ctx)
    expect(String(out)).toContain("已回退到 需求分析")
    expect(String(out)).toContain("级联回退")
    expect(String(out)).toContain("设计")
    expect(String(out)).toContain("编码")
    const wf = store.get("s1")!.workflow!
    expect(wf.stages.design.status).toBe("in_progress")
    expect(wf.stages.implementation.status).toBe("in_progress")
    store.close()
  })

  test("回退末段阶段不出现级联提示", async () => {
    const { store, tools } = setup()
    await tools.workflow_advance!.execute({ stage: "requirements", action: "enter", developer_confirmed: false } as never, ctx)
    await tools.workflow_advance!.execute({ stage: "requirements", action: "approve", developer_confirmed: true } as never, ctx)
    const out = await tools.workflow_revisit!.execute({ stage: "requirements", note: "改动" } as never, ctx)
    expect(String(out)).not.toContain("级联回退")
    store.close()
  })
})
