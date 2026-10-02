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