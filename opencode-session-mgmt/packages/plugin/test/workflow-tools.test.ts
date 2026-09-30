/**
 * 工作流工具测试：commit_force_unlock 强制提交授权（3.4 逃生口）、
 * workflow_baseline 基线预估工时录入（6.3）。
 */
import { describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { requiredSlots } from "sm-shared"
import { createWorkflowTools } from "../src/tools/workflow"
import { createReviewTools } from "../src/tools/review"

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

describe("reqdoc 知识库门禁（进入 prd 阶段前，2c）", () => {
  /** 推进 reqdoc 至 edge 完成，准备进入 prd。 */
  function setupReqdocAtEdge() {
    const store = Store.memory(() => "reqdoc")
    const tools = createWorkflowTools(store)
    return { store, tools }
  }

  /**
   * 知识库夹具（2c）：fill=full 全确认；none 未填；partial 只填一半。
   * 门禁读 kbGate，不再有打分卡。
   */
  function setKb(mode: "full" | "none" | "partial") {
    const features = [{ no: 1, name: "名单排查", priority: "high" as const, confirmedAt: 1000 }]
    const req = requiredSlots(features)
    const addrs = mode === "full" ? req : mode === "partial" ? req.slice(0, Math.ceil(req.length / 2)) : []
    return {
      slots: addrs.map((address) => ({
        kind: "prose" as const,
        address,
        content: `${address} 内容`,
        source: "文档" as const,
        status: "confirmed" as const,
      })),
      features,
      containers: {
        "4.1": { required: false, reason: "无特殊术语" },
        "5.1.2.1": { required: false, reason: "无结构化字段" },
      },
      askCounts: {},
      updatedAt: 1000,
    }
  }

  test("知识库未建进入 prd 被拒", async () => {
    const { store, tools } = setupReqdocAtEdge()
    await expect(
      tools.workflow_advance!.execute({ stage: "prd", action: "enter", developer_confirmed: false } as never, ctx),
    ).rejects.toThrow(/知识库未建/)
    store.close()
  })

  test("★ 槽位覆盖不足进入 prd 被拒（kbGate 覆盖率）", async () => {
    const { store, tools } = setupReqdocAtEdge()
    store.mutateWorkflow("s1", (w) => {
      w.kb = setKb("partial")
    })
    await expect(
      tools.workflow_advance!.execute({ stage: "prd", action: "enter", developer_confirmed: false } as never, ctx),
    ).rejects.toThrow(/覆盖率|未就绪/)
    store.close()
  })

  test("★ 槽位全确认后可进入 prd（正向路径）", async () => {
    const { store, tools } = setupReqdocAtEdge()
    store.mutateWorkflow("s1", (w) => {
      w.kb = setKb("full")
    })
    await tools.workflow_advance!.execute({ stage: "prd", action: "enter", developer_confirmed: false } as never, ctx)
    expect(store.get("s1")!.workflow!.stages.prd.status).toBe("in_progress")
    store.close()
  })

  test("force_kb 无 force_reason 被拒（模型不得自行放行）", async () => {
    const { store, tools } = setupReqdocAtEdge()
    store.mutateWorkflow("s1", (w) => {
      w.kb = setKb("none")
    })
    await expect(
      tools.workflow_advance!.execute({ stage: "prd", action: "enter", developer_confirmed: false, force_kb: true } as never, ctx),
    ).rejects.toThrow(/force_reason/)
    store.close()
  })

  test("★ 业务给出理由后可 force 放行", async () => {
    const { store, tools } = setupReqdocAtEdge()
    store.mutateWorkflow("s1", (w) => {
      w.kb = setKb("none")
    })
    await tools.workflow_advance!.execute(
      { stage: "prd", action: "enter", developer_confirmed: false, force_kb: true, force_reason: "业务明确本期不做风控相关字段" } as never,
      ctx,
    )
    expect(store.get("s1")!.workflow!.stages.prd.status).toBe("in_progress")
    store.close()
  })
})
