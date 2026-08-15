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

describe("reqdoc 打分卡门禁（进入 prd 阶段前）", () => {
  /** 推进 reqdoc 至 edge 完成，准备进入 prd。 */
  function setupReqdocAtEdge() {
    const store = Store.memory(() => "reqdoc")
    const tools = createWorkflowTools(store)
    return { store, tools }
  }

  function setScore(total: number, confirmed = true) {
    return {
      dims: {
        businessValue: { score: 15, max: 15 },
        flowClosure: { score: total > 85 ? 25 : 20, max: 25 },
        edgeControl: { score: total > 85 ? 30 : 25, max: 30 },
        compliance: { score: total > 85 ? 10 : 5, max: 20 },
        authority: { score: 10, max: 10 },
      },
      deductions: [] as never[],
      total,
      confirmed,
      confirmedAt: confirmed ? 1000 : null,
      updatedAt: 1000,
    }
  }

  test("无打分进入 prd 被拒", async () => {
    const { store, tools } = setupReqdocAtEdge()
    await expect(
      tools.workflow_advance!.execute({ stage: "prd", action: "enter", developer_confirmed: false } as never, ctx),
    ).rejects.toThrow(/先打分/)
    store.close()
  })

  test("低于 85 分进入 prd 被拒", async () => {
    const { store, tools } = setupReqdocAtEdge()
    store.mutateWorkflow("s1", (w) => {
      w.score = setScore(75)
    })
    await expect(
      tools.workflow_advance!.execute({ stage: "prd", action: "enter", developer_confirmed: false } as never, ctx),
    ).rejects.toThrow(/未达标/)
    store.close()
  })

  test("已达标但未业务确认进入 prd 被拒", async () => {
    const { store, tools } = setupReqdocAtEdge()
    store.mutateWorkflow("s1", (w) => {
      w.score = setScore(90, false)
    })
    await expect(
      tools.workflow_advance!.execute({ stage: "prd", action: "enter", developer_confirmed: false } as never, ctx),
    ).rejects.toThrow(/未获业务确认/)
    store.close()
  })

  test("达标且业务确认后可进入 prd", async () => {
    const { store, tools } = setupReqdocAtEdge()
    store.mutateWorkflow("s1", (w) => {
      w.score = setScore(90)
    })
    const out = await tools.workflow_advance!.execute({ stage: "prd", action: "enter", developer_confirmed: false } as never, ctx)
    expect(String(out)).toContain("需求规格书")
    expect(store.get("s1")!.workflow!.stages.prd.status).toBe("in_progress")
    store.close()
  })

  test("缺口探针对应维度满分进入 prd 被拒（缺口+满分自相矛盾）", async () => {
    const { store, tools } = setupReqdocAtEdge()
    store.mutateWorkflow("s1", (w) => {
      // exception 缺口映射 edgeControl，但该维打了满分 30/30 —— 自评不诚实
      w.score = setScore(90) // edgeControl 30 满分
      w.probes = { asked: ["main_flow", "exception"], gaps: ["exception"], round: 1, updatedAt: 1000 }
    })
    await expect(
      tools.workflow_advance!.execute({ stage: "prd", action: "enter", developer_confirmed: false } as never, ctx),
    ).rejects.toThrow(/自相矛盾/)
    expect(store.get("s1")!.workflow!.stages.prd.status).toBe("not_started")
    store.close()
  })

  test("探针覆盖达标（无缺口）且打分达标可进入 prd（正向）", async () => {
    const { store, tools } = setupReqdocAtEdge()
    store.mutateWorkflow("s1", (w) => {
      w.score = setScore(90)
      w.probes = { asked: ["main_flow", "exception"], gaps: [], round: 2, updatedAt: 1000 }
    })
    const out = await tools.workflow_advance!.execute({ stage: "prd", action: "enter", developer_confirmed: false } as never, ctx)
    expect(String(out)).toContain("需求规格书")
    expect(store.get("s1")!.workflow!.stages.prd.status).toBe("in_progress")
    store.close()
  })

  test("未记录探针（柔性）达标可进入 prd", async () => {
    const { store, tools } = setupReqdocAtEdge()
    store.mutateWorkflow("s1", (w) => {
      w.score = setScore(90)
      // 无 probes：柔性门禁不强制记录，放行
    })
    const out = await tools.workflow_advance!.execute({ stage: "prd", action: "enter", developer_confirmed: false } as never, ctx)
    expect(String(out)).toContain("需求规格书")
    store.close()
  })

  test("sdlc 进入阶段不受打分卡门禁影响", async () => {
    const store = Store.memory() // 缺省 sdlc
    const tools = createWorkflowTools(store)
    const out = await tools.workflow_advance!.execute({ stage: "design", action: "enter", developer_confirmed: false } as never, ctx)
    expect(String(out)).toContain("设计")
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
