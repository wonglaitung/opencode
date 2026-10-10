/**
 * 工作流工具测试：commit_force_unlock 强制提交授权（3.4 逃生口）、
 * workflow_baseline 基线预估工时录入（6.3）。
 */
import { describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { requiredSlots, reviewRecord } from "sm-shared"
import { createWorkflowTools } from "../src/tools/workflow"
import { extractBaselineHours, applyBaselineProposal } from "../src/tools/baseline-proposal"
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
  // 6.3 防杜撰：developer_confirmed=true 时必须存在开发者给出的工时证据
  // （baselineProposedByDev），否则服务端拒收。测试里手动置证据模拟 hook 捕获。
  function propose(store: Store, hours: number): void {
    store.mutateWorkflow("s1", (w) => {
      w.baselineProposedByDev = { hours, messageID: "t", at: Date.now() }
    })
  }

  test("录入预估工时并记录 setAt", async () => {
    const { store, tools } = setup()
    propose(store, 8)
    await tools.workflow_baseline!.execute({ estimated_hours: 8, developer_confirmed: true } as never, ctx)
    const baseline = store.get("s1")!.workflow!.baseline
    expect(baseline?.estimatedHours).toBe(8)
    expect(typeof baseline?.setAt).toBe("number")
    store.close()
  })

  test("开发者消息经 hook 解析后服务端放行（端到端，防解析回归）", async () => {
    const { store, tools } = setup()
    store.mutateWorkflow("s1", () => {}) // 确保 workflow 状态已建（生产由启动流程保证）
    // 模拟 chat.message hook 捕获开发者原话
    applyBaselineProposal(store, "s1", "预算是 8 小时，开始做吧", "m1")
    expect(store.get("s1")!.workflow!.baselineProposedByDev?.hours).toBe(8)
    // 模型据开发者原话录入 → 服务端放行
    await tools.workflow_baseline!.execute({ estimated_hours: 8, developer_confirmed: true } as never, ctx)
    expect(store.get("s1")!.workflow!.baseline?.estimatedHours).toBe(8)
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

  test("未提供预估不得自行填入（服务端拒收，防数据毒化）", async () => {
    const { store, tools } = setup()
    await expect(
      tools.workflow_baseline!.execute({ estimated_hours: 4, developer_confirmed: true } as never, ctx),
    ).rejects.toThrow(/未检测到开发者|不得自行填入|数字/)
    expect(store.get("s1")?.workflow?.baseline).toBeUndefined()
    store.close()
  })

  test("数值须与开发者给出一致", async () => {
    const { store, tools } = setup()
    propose(store, 8)
    await expect(
      tools.workflow_baseline!.execute({ estimated_hours: 4, developer_confirmed: true } as never, ctx),
    ).rejects.toThrow(/一致|不符|数字/)
    store.close()
  })

  test("重设为幂等覆盖（记最新值）", async () => {
    const { store, tools } = setup()
    propose(store, 8)
    await tools.workflow_baseline!.execute({ estimated_hours: 8, developer_confirmed: true } as never, ctx)
    propose(store, 12)
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

describe("baseline-proposal（6.3 防杜撰解析，对抗加固）", () => {
  test("带估值意图的工时表述被解析", () => {
    expect(extractBaselineHours("预算是 8 小时，开始做吧")).toBe(8)
    expect(extractBaselineHours("手写约 24 小时")).toBe(24)
    expect(extractBaselineHours("大概 2 人天")).toBe(16)
  })

  test("闲聊误捕获被拒绝（无估值意图）", () => {
    expect(extractBaselineHours("昨天会议开了 2 小时")).toBeNull()
    expect(extractBaselineHours("3 天试用期")).toBeNull()
    expect(extractBaselineHours("发布后观察 7 天")).toBeNull()
  })

  test("最新用户消息无工时表述则清空旧证据", () => {
    const store = Store.memory()
    store.mutateWorkflow("s1", (w) => {
      w.baselineProposedByDev = { hours: 8, messageID: "old", at: Date.now() }
    })
    applyBaselineProposal(store, "s1", "好的，继续吧", "m2")
    expect(store.get("s1")?.workflow?.baselineProposedByDev).toBeUndefined()
    store.close()
  })

  test("含工时但无意图的闲聊清空旧证据（不污染为错误值）", () => {
    const store = Store.memory()
    store.mutateWorkflow("s1", (w) => {
      w.baselineProposedByDev = { hours: 8, messageID: "old", at: Date.now() }
    })
    applyBaselineProposal(store, "s1", "刚开了 2 小时会", "m2")
    // 既不清成 2（闲聊数值），也不保留 8（陈旧复用），而是清空
    expect(store.get("s1")?.workflow?.baselineProposedByDev).toBeUndefined()
    store.close()
  })
})

describe("对抗 S1：enter 自动确认须 developer_confirmed，回执披露名单", () => {
  test("无确认 enter 将自动确认前序被拒；带确认放行且回执列出", async () => {
    const { store, tools } = setup()
    store.mutateWorkflow("s1", (w) => {
      w.stages.requirements.status = "in_progress"
    })
    await expect(
      tools.workflow_advance!.execute({ stage: "design", action: "enter", developer_confirmed: false } as never, ctx),
    ).rejects.toThrow(/自动确认/)
    expect(store.get("s1")!.workflow!.stages.requirements.status).toBe("in_progress")
    const out = String(
      await tools.workflow_advance!.execute({ stage: "design", action: "enter", developer_confirmed: true } as never, ctx),
    )
    expect(out).toContain("自动确认：需求分析")
    expect(store.get("s1")!.workflow!.stages.requirements.status).toBe("approved")
    store.close()
  })

  test("无进行中前序的 enter 不要求确认（首阶段）", async () => {
    const { store, tools } = setup()
    const out = String(
      await tools.workflow_advance!.execute({ stage: "requirements", action: "enter", developer_confirmed: false } as never, ctx),
    )
    expect(out).not.toContain("自动确认")
    expect(store.get("s1")!.workflow!.stages.requirements.status).toBe("in_progress")
    store.close()
  })
})

describe("对抗 S3-A：级联触及审查时重置已确认理解片段", () => {
  test("revisit implementation → review 回退且 accepted→pending；revisit review 自身不重置", async () => {
    const { store, tools } = setup()
    store.mutateWorkflow("s1", (w) => {
      for (const n of ["requirements", "design", "implementation", "testing", "review"]) {
        w.stages[n].status = "approved"
      }
      reviewRecord(w).comprehension.push({
        id: "a.ts:1-10",
        explanation: "示例片段",
        decision: "accepted",
        developerConfirmed: true,
        confirmedAt: 1,
        feedback: null,
        rejectedAt: null,
        rewrites: 0,
        resolution: null,
      })
    })
    await tools.workflow_revisit!.execute({ stage: "implementation" } as never, ctx)
    const after = store.get("s1")!.workflow!
    expect(after.stages.review.status).toBe("in_progress")
    expect(reviewRecord(after).comprehension[0]!.decision).toBe("pending")
    expect(reviewRecord(after).comprehension[0]!.developerConfirmed).toBe(false)
    // 重新确认后，revisit 审查自身（代码未变）不重置
    store.mutateWorkflow("s1", (wf) => {
      const c = reviewRecord(wf).comprehension[0]!
      c.decision = "accepted"
      c.developerConfirmed = true
      c.confirmedAt = 2
      wf.stages.review.status = "approved"
    })
    await tools.workflow_revisit!.execute({ stage: "review" } as never, ctx)
    expect(reviewRecord(store.get("s1")!.workflow!).comprehension[0]!.decision).toBe("accepted")
    store.close()
  })
})

describe("对抗 S2-A：sdlc review_submit 须附开发者确认原话", () => {
  test("缺 confirm_note 被拒；附上放行", async () => {
    const { store } = setup()
    store.mutateWorkflow("s1", (w) => {
      for (const n of ["requirements", "design", "implementation", "testing"]) {
        w.stages[n].status = "approved"
      }
    })
    const reviewTools = createReviewTools(store)
    const checklist = { businessIntent: true, logicExplainable: true, behaviorVerifiable: true }
    await expect(reviewTools.review_submit!.execute(checklist as never, ctx)).rejects.toThrow(/confirm_note/)
    const out = String(
      await reviewTools.review_submit!.execute(
        { ...checklist, confirm_note: "四项都没问题，通过" } as never,
        ctx,
      ),
    )
    expect(out).toContain("审查阶段通过")
    store.close()
  })
})
