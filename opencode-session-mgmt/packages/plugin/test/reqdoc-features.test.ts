/**
 * reqdoc_confirm_features 功能点拆解工具测试（重构核心：prd 前置功能点拆解确认）。
 * 覆盖：记录 features 到 kb.features（功能点单一事实源）、kb 已存在时不与
 * workflow.features 分叉、建 06_功能点 子目录、仅 reqdoc 可用、参数校验。
 */
import { mkdtempSync } from "node:fs"
import { readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { deriveQuestions } from "sm-shared"
import { Store } from "../src/db"
import { createReqdocFeatureTools } from "../src/tools/reqdoc-features"
import { createReqdocKbTools } from "../src/tools/reqdoc-kb-tools"

function setup(worktree: string) {
  const store = Store.memory(() => "reqdoc")
  const tools = createReqdocFeatureTools(store)
  const ctx = { worktree, sessionID: "s1" } as never
  return { store, tools, ctx }
}

describe("reqdoc_confirm_features", () => {
  test("记录功能点到 kb.features（编号按序、优先级映射）", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "reqdoc-feat-"))
    const { store, tools, ctx } = setup(worktree)
    const out = await tools.reqdoc_confirm_features!.execute(
      { features: [{ name: "名单排查", priority: "high" }, { name: "模型打分", priority: "low", note: "二期" }] } as never,
      ctx,
    )
    expect(String(out)).toContain("2 个功能点")
    const features = store.get("s1")!.workflow!.kb!.features
    expect(features).toHaveLength(2)
    expect(features[0]).toMatchObject({ no: 1, name: "名单排查", priority: "high" })
    expect(features[1]).toMatchObject({ no: 2, name: "模型打分", priority: "low", note: "二期" })
    expect(typeof features[0].confirmedAt).toBe("number")
    store.close()
  })

  test("kb 已存在时仍写 kb.features：不得与 workflow.features 分叉", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "reqdoc-feat-"))
    const { store, tools, ctx } = setup(worktree)
    // 模拟历史库：旧版本把功能点写进了 workflow.features，kb 已带着 slots 建立
    store.mutateWorkflow("s1", (w) => {
      w.features = [{ no: 1, name: "旧功能", priority: "high", confirmedAt: 1 }]
      w.kb = { slots: [], features: [{ no: 1, name: "旧功能", priority: "high", confirmedAt: 1 }], containers: {}, askCounts: {}, updatedAt: 0 }
    })
    await tools.reqdoc_confirm_features!.execute(
      { features: [{ name: "新功能", priority: "medium" }] } as never,
      ctx,
    )
    const wf = store.get("s1")!.workflow!
    // 事实源是 kb.features：地址体系、门禁、组装全部按它派生
    expect(wf.kb!.features.map((f) => f.name)).toEqual(["新功能"])
    // workflow.features 不再被单独改写（避免两处各写一份、日后各读一份）
    expect(wf.features).toBeUndefined()
    // 目录按 kb.features 建，与地址体系同源
    expect(readdirSync(join(worktree, "06_功能点"))).toEqual(["1_新功能"])
    store.close()
  })

  test("为每个功能点在 06_功能点 下建子目录与来源摘录", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "reqdoc-feat-"))
    const { store, tools, ctx } = setup(worktree)
    await tools.reqdoc_confirm_features!.execute(
      { features: [{ name: "名单排查", priority: "high" }] } as never,
      ctx,
    )
    const dir = join(worktree, "06_功能点", "1_名单排查")
    expect(readdirSync(dir)).toContain("来源摘录.md")
    expect(readFileSync(join(dir, "来源摘录.md"), "utf8")).toContain("功能点 1")
    // 重构：同时预建 07_需求规格产出/N_名称/（模板外成果落盘位，reqdoc-r20 归档要求）
    expect(readdirSync(join(worktree, "07_需求规格产出", "1_名单排查"))).toEqual([])
    store.close()
  })

  test("端到端：ingest 与 confirm_features 功能点同源——必填地址与 06/07 目录随之同变", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "reqdoc-feat-"))
    const store = Store.memory(() => "reqdoc")
    const ctx = { worktree, sessionID: "s1" } as never
    // 先经 ingest 建 kb 并写入 1 个功能点（kb 建立后的真实形态）
    await createReqdocKbTools(store).reqdoc_ingest!.execute(
      {
        slots: [{ address: "3.1", kind: "prose", content: "按 CLD 过滤名单", source: "文档" }],
        features: [{ name: "名单排查", priority: "high" }],
      } as never,
      ctx,
    )
    // 再用 confirm_features 追加第 2 个功能点（只能追加末尾，见 Step 3 护栏）
    await createReqdocFeatureTools(store).reqdoc_confirm_features!.execute(
      { features: [{ name: "名单排查", priority: "high" }, { name: "模型打分", priority: "low" }] } as never,
      ctx,
    )
    const kb = store.get("s1")!.workflow!.kb!
    expect(kb.features.map((f) => f.name)).toEqual(["名单排查", "模型打分"])
    // 必填叶子随功能点数走：5.2.1.1 是第 2 个功能点的必填项，修复前 confirm_features 写了另一个位置故此处不变
    expect(deriveQuestions(kb.features, { slots: kb.slots }).all.map((q) => q.address)).toContain("5.2.1.1")
    // 06/07 目录与地址体系同源
    expect(readdirSync(join(worktree, "06_功能点")).sort()).toEqual(["1_名单排查", "2_模型打分"])
    expect(readdirSync(join(worktree, "07_需求规格产出")).sort()).toEqual(["1_名单排查", "2_模型打分"])
    store.close()
  })

  test("仅 reqdoc 工作流可用（sdlc 拒绝）", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "reqdoc-feat-"))
    const store = Store.memory(() => "sdlc")
    const tools = createReqdocFeatureTools(store)
    const ctx = { worktree, sessionID: "s1" } as never
    await expect(
      tools.reqdoc_confirm_features!.execute({ features: [{ name: "x", priority: "high" }] } as never, ctx),
    ).rejects.toThrow(/仅用于 reqdoc/)
    store.close()
  })

  // ---- 纯追加护栏（Step 3）----
  const F = (name: string, priority: "high" | "medium" | "low" = "high") => ({ name, priority })

  /** 建「已有 2 个功能点、且 5.1.1.1 已有槽位」的迭代态（此时重排已有实际后果）。 */
  async function iterativeState() {
    const worktree = mkdtempSync(join(tmpdir(), "reqdoc-feat-iter-"))
    const store = Store.memory(() => "reqdoc")
    const ctx = { worktree, sessionID: "s1" } as never
    await createReqdocKbTools(store).reqdoc_ingest!.execute(
      {
        features: [F("名单排查"), F("模型打分", "low")],
        slots: [{ address: "5.1.1.1", kind: "prose", content: "输入：客户号、证件号", source: "文档" }],
      } as never,
      ctx,
    )
    return { worktree, store, ctx, tools: createReqdocFeatureTools(store) }
  }

  test("已有功能点槽位时：把新功能插到中间 → 拒绝，且清单原样不动", async () => {
    const { store, ctx, tools } = await iterativeState()
    await expect(
      tools.reqdoc_confirm_features!.execute({ features: [F("名单排查"), F("批量导出"), F("模型打分", "low")] } as never, ctx),
    ).rejects.toThrow(/必须纯追加/)
    // 关键：拒绝必须发生在写入之前——否则「报错但已改」等于没护栏
    expect(store.get("s1")!.workflow!.kb!.features.map((f) => f.name)).toEqual(["名单排查", "模型打分"])
    store.close()
  })

  test("已有功能点槽位时：改名 / 删减 / 重排一律拒绝（三种都试，防只挡一种）", async () => {
    const { store, ctx, tools } = await iterativeState()
    await expect(
      tools.reqdoc_confirm_features!.execute({ features: [F("名单排查"), F("模型打分2", "low")] } as never, ctx),
    ).rejects.toThrow(/第 2 项期望/)
    await expect(
      tools.reqdoc_confirm_features!.execute({ features: [F("名单排查")] } as never, ctx),
    ).rejects.toThrow(/清单被截断/)
    await expect(
      tools.reqdoc_confirm_features!.execute({ features: [F("模型打分", "low"), F("名单排查")] } as never, ctx),
    ).rejects.toThrow(/必须纯追加/)
    expect(store.get("s1")!.workflow!.kb!.features.map((f) => f.name)).toEqual(["名单排查", "模型打分"])
    store.close()
  })

  test("已有功能点槽位时：末尾追加放行，且新增功能点真的进了必填地址与目录", async () => {
    const { worktree, store, ctx, tools } = await iterativeState()
    await tools.reqdoc_confirm_features!.execute(
      { features: [F("名单排查"), F("模型打分", "low"), F("批量导出", "medium")] } as never,
      ctx,
    )
    const kb = store.get("s1")!.workflow!.kb!
    expect(kb.features.map((f) => f.name)).toEqual(["名单排查", "模型打分", "批量导出"])
    // 新功能点带来新的必填地址，且旧地址不动（这才是「只追加」的真实含义）
    const addrs = deriveQuestions(kb.features, { slots: kb.slots }).all.map((q) => q.address)
    expect(addrs).toContain("5.3.1.1")
    expect(kb.slots.some((s) => s.address === "5.1.1.1" && s.content.includes("客户号"))).toBe(true)
    expect(readdirSync(join(worktree, "06_功能点")).sort()).toEqual(["1_名单排查", "2_模型打分", "3_批量导出"])
    store.close()
  })

  test("拆解阶段（尚无功能点槽位）仍可任意重排——否则 prd 前的正常调整会被卡死", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "reqdoc-feat-"))
    const store = Store.memory(() => "reqdoc")
    const ctx = { worktree, sessionID: "s1" } as never
    await createReqdocKbTools(store).reqdoc_ingest!.execute(
      {
        features: [F("名单排查"), F("模型打分")],
        slots: [{ address: "3.1", kind: "prose", content: "背景", source: "文档" }],
      } as never,
      ctx,
    )
    await createReqdocFeatureTools(store).reqdoc_confirm_features!.execute(
      { features: [F("模型打分"), F("名单排查")] } as never,
      ctx,
    )
    expect(store.get("s1")!.workflow!.kb!.features.map((f) => f.name)).toEqual(["模型打分", "名单排查"])
    store.close()
  })
})
