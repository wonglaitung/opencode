/**
 * 换模板告警的**接线**护栏（待决 1 + 2）。
 *
 * `template-drift.test.ts` 验的是纯函数；本文件验的是「告警真的到了人和模型眼前」——
 * 函数写对了但忘接到回执/状态条上，是这类改动最常见的失败方式
 * （本仓已有先例：force_reason 不落状态、状态条口径与回执不一致）。
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { requireTemplateSchema, schemaAddressSpace } from "sm-shared"
import { Store } from "../src/db"
import { createReqdocKbTools } from "../src/tools/reqdoc-kb-tools"
import { createReqdocFeatureTools } from "../src/tools/reqdoc-features"
import { createWorkflowTools } from "../src/tools/workflow"
import { createReviewTools } from "../src/tools/review"

function setup(worktree: string) {
  const store = Store.memory(() => "reqdoc")
  const kb = createReqdocKbTools(store)
  const feat = createReqdocFeatureTools(store)
  const ctx = { worktree, sessionID: "s1" } as never
  return { store, kb, feat, ctx }
}

/** 建库并确认一个功能点，使 kb 进入有内容的真实状态。 */
async function seed(store: ReturnType<typeof Store.memory>, feat: ReturnType<typeof createReqdocFeatureTools>, ctx: never) {
  await feat.reqdoc_confirm_features!.execute(
    { features: [{ name: "名单排查", priority: "high" }] } as never,
    ctx,
  )
}

describe("换模板告警接线", () => {
  test("ingest 回执在模板一致时不报漂移（不制造噪声）", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "reqdoc-drift-ok-"))
    const { store, kb, feat, ctx } = setup(worktree)
    await seed(store, feat, ctx)
    const out = String(
      await kb.reqdoc_ingest!.execute(
        {
          slots: [{ address: "3.6", kind: "prose", content: "本功能点对逾期名单做批量标记。", source: "问答" }],
        } as never,
        ctx,
      ),
    )
    expect(out).not.toContain("模板结构已更换")
    expect(store.get("s1")!.workflow!.kb!.templateAddressSpace).toBeTruthy()
    store.close()
  })

  test("ingest 回执在指纹不匹配时把漂移告警放在**第一行**（先说最要紧的）", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "reqdoc-drift-hit-"))
    const { store, kb, feat, ctx } = setup(worktree)
    await seed(store, feat, ctx)
    // 模拟换模板：把 kb 里记录的指纹改掉（等价于磁盘上的模板被换过）
    store.mutateWorkflow("s1", (w) => {
      if (w.kb) w.kb.templateAddressSpace = "fc=99|leaf=9.9|cont=9.9|sub=9.9"
    })
    const out = String(
      await kb.reqdoc_ingest!.execute(
        {
          slots: [{ address: "3.6", kind: "prose", content: "内容", source: "问答" }],
        } as never,
        ctx,
      ),
    )
    expect(out.split("\n")[0]).toContain("模板结构已更换")
    expect(out).toContain("开新会话")
    store.close()
  })

  test("assemble 回执在指纹不匹配时也报漂移", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "reqdoc-drift-asm-"))
    const { store, kb, feat, ctx } = setup(worktree)
    await seed(store, feat, ctx)
    store.mutateWorkflow("s1", (w) => {
      if (w.kb) w.kb.templateAddressSpace = "fc=99|leaf=9.9|cont=9.9|sub=9.9"
    })
    const out = String(await kb.reqdoc_assemble!.execute({} as never, ctx))
    expect(out).toContain("模板结构已更换")
    store.close()
  })

  test("readKb 只在首次记指纹，后续不自我抹平漂移", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "reqdoc-drift-once-"))
    const { store, kb, feat, ctx } = setup(worktree)
    await seed(store, feat, ctx)
    const first = store.get("s1")!.workflow!.kb!.templateAddressSpace
    expect(first).toBeTruthy()
    // 手工改成别的值后再跑一次 ingest —— 不应被 readKb 改回真实指纹
    store.mutateWorkflow("s1", (w) => {
      if (w.kb) w.kb.templateAddressSpace = "fc=98|leaf=8.8|cont=8.8|sub=8.8"
    })
    await kb.reqdoc_ingest!.execute(
      { slots: [{ address: "3.6", kind: "prose", content: "x", source: "问答" }] } as never,
      ctx,
    )
    expect(store.get("s1")!.workflow!.kb!.templateAddressSpace).toBe("fc=98|leaf=8.8|cont=8.8|sub=8.8")
    store.close()
  })

  test("记录的是当前模板的真实指纹（而非占位值）", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "reqdoc-drift-real-"))
    const { store, feat, ctx } = setup(worktree)
    await seed(store, feat, ctx)
    const recorded = store.get("s1")!.workflow!.kb!.templateAddressSpace
    expect(recorded).toBe(schemaAddressSpace(requireTemplateSchema()))
    store.close()
  })
})

/**
 * 门禁真因前置：**模板已更换**与**模板不可读**是同一类死路，必须先说真因。
 *
 * 回归：`workflow_advance` 的 prd 门禁早就为「模板不可读」备了真因文案，
 * 「模板已更换」却是同一段代码形状里的漏网之鱼——此时必填集按新模板算，
 * 已确认的旧地址一条都不计入覆盖率，而默认文案仍让模型「用 reqdoc_ingest /
 * reqdoc_answer 补齐」。补齐旧地址服务端照收（isValidSlotAddr 对已入库地址留了
 * 后门）、覆盖率却不动，于是模型反复补齐反复撞墙，比直接报错更难查。
 */
describe("门禁真因前置（模板已更换）", () => {
  /** 造一个「已漂移」的知识库：地址空间改成一个当前模板里不存在的编号集。 */
  function seedDrifted(store: ReturnType<typeof Store.memory>, features: { no: number; name: string; priority: "high"; confirmedAt: number }[]) {
    store.mutateWorkflow("s1", (w) => {
      w.kb = {
        slots: [
          { kind: "prose", address: "3.1", content: "信贷审批部（CRD）流程优化", source: "文档", status: "confirmed" },
        ],
        features,
        containers: {},
        candidates: {},
        askCounts: {},
        updatedAt: 1,
        // 与当前模板必填集不相交 → 必判漂移
        templateAddressSpace: "fc=9|leaf=9.1,9.2|cont=9.3|sub=1.1",
      }
    })
  }

  test("workflow_advance 进 prd：报模板已更换，而不是让模型去补齐", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "reqdoc-drift-gate-"))
    const store = Store.memory(() => "reqdoc")
    seedDrifted(store, [{ no: 1, name: "名单排查", priority: "high", confirmedAt: 1000 }])
    const wf = createWorkflowTools(store)
    const ctx = { worktree, sessionID: "s1" } as never
    store.mutateWorkflow("s1", (w) => {
      w.stages.goal!.status = "approved"
      w.stages.rules!.status = "approved"
      w.stages.edge!.status = "approved"
    })
    let msg = ""
    try {
      await wf.workflow_advance!.execute({ stage: "prd", action: "enter" } as never, ctx)
    } catch (e) {
      msg = String(e)
    }
    // 真因前置 + 不给死路指令
    expect(msg).toMatch(/模板结构已更换/)
    expect(msg).not.toMatch(/reqdoc_ingest 补齐槽位/)
    // 覆盖率算式单独出现时毫无意义，必须同时说明「补旧地址也不涨」
    expect(msg).toMatch(/不会提高覆盖率|不计入必填覆盖率/)
    store.close()
  })

  test("review_submit 定稿：同样先说模板已更换", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "reqdoc-drift-submit-"))
    const store = Store.memory(() => "reqdoc")
    seedDrifted(store, [{ no: 1, name: "名单排查", priority: "high", confirmedAt: 1000 }])
    store.mutateWorkflow("s1", (w) => {
      for (const n of ["goal", "rules", "edge", "prd"]) w.stages[n]!.status = "approved"
    })
    const ctx = { worktree, sessionID: "s1" } as never
    let msg = ""
    try {
      await createReviewTools(store).review_submit!.execute(
        {
          checklist: [],
          comprehension: [],
          self_check: { hallucination: false, scope_creep: false, unverified: false },
        } as never,
        ctx,
      )
    } catch (e) {
      msg = String(e)
    }
    expect(msg).toMatch(/模板结构已更换/)
    expect(msg).not.toMatch(/请用 reqdoc_answer 补齐/)
    store.close()
  })
})
