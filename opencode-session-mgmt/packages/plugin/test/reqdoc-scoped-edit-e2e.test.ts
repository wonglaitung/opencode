/**
 * 定点修订（乙）端到端验证：用真实插件工具走完整链路（无模型、确定性）。
 * 覆盖：start_scoped_edit 冻结快照并限定派生、export diff/chapter 产出差异+单向提醒+
 * 跨章影响、越界拒收、无锁时 diff 报错。对照 docs/reqdoc-scoped-edit.md。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join as pjoin } from "node:path"
import { Store } from "../src/db"
import { createReqdocKbTools } from "../src/tools/reqdoc-kb-tools"
import { createReqdocExportTool } from "../src/tools/reqdoc-export"

const dirs: string[] = []
function setup() {
  const store = Store.memory(() => "reqdoc" as const)
  const worktree = mkdtempSync(pjoin(tmpdir(), "sm-scope-e2e-"))
  dirs.push(worktree)
  const tools = createReqdocKbTools(store)
  const exTools = createReqdocExportTool(store)
  const ctx = { sessionID: "r1", worktree } as never
  return { store, tools, exTools, ctx, worktree }
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const ingest = (tools: ReturnType<typeof createReqdocKbTools>, args: unknown, ctx: never) =>
  tools.reqdoc_ingest!.execute(args as never, ctx)
const answer = (tools: ReturnType<typeof createReqdocKbTools>, args: unknown, ctx: never) =>
  tools.reqdoc_answer!.execute(args as never, ctx)
const startEdit = (tools: ReturnType<typeof createReqdocKbTools>, chapter: number, ctx: never) =>
  tools.reqdoc_start_scoped_edit!.execute({ chapter } as never, ctx)
const endEdit = (tools: ReturnType<typeof createReqdocKbTools>, ctx: never) =>
  tools.reqdoc_end_scoped_edit!.execute({} as never, ctx)

describe("定点修订 · 端到端链路（乙）", () => {
  test("start_scoped_edit 冻结编辑前快照，并限定派生只出该章", async () => {
    const { store, tools, ctx } = setup()
    await ingest(tools, { features: [{ name: "名单排查", priority: "high" }], slots: [
      { address: "3.1", kind: "prose", content: "原稿内容", source: "文档" },
      { address: "4.1.CRD", kind: "term", content: "信贷审批部", source: "文档" },
    ] }, ctx)
    const out = String(await startEdit(tools, 3, ctx))
    expect(out).toContain("已进入定点修订")
    const kb = store.get("r1")!.workflow!.kb!
    expect(kb.editScope?.active).toBe(true)
    expect(kb.editScope?.chapter).toBe(3)
    expect(kb.editScope?.snapshotBefore.length).toBe(kb.slots.length)
    // 派生范围被限定：本轮该填只列第 3 章地址（不含第 4 章术语）
    const ingestOut = String(await ingest(tools, { slots: [{ address: "3.1", kind: "prose", content: "修订", source: "问答" }] }, ctx))
    expect(ingestOut).toContain("3.1")
    expect(ingestOut).not.toContain("4.1")
    store.close()
  })

  test("export diff 产出差异+单向提醒；export chapter 产出整章；无锁时 diff 报错", async () => {
    const { store, tools, exTools, ctx, worktree } = setup()
    await ingest(tools, { features: [{ name: "名单排查", priority: "high" }], slots: [
      { address: "3.1", kind: "prose", content: "原稿内容", source: "文档" },
      { address: "3.2", kind: "prose", content: "原稿第二节", source: "文档" },
      { address: "4.1.CRD", kind: "term", content: "信贷审批部", source: "文档" },
    ] }, ctx)
    await startEdit(tools, 3, ctx)
    // 章内改写一处（问答）
    await answer(tools, { address: "3.1", content: "修订后内容", source: "问答" }, ctx)

    const diffOut = String(await exTools.reqdoc_export!.execute({ mode: "diff", chapter: 3 } as never, ctx))
    expect(diffOut).toContain("定点修订")
    const diffMdPath = pjoin(worktree, "07_需求规格产出", "定点修订_第3章_差异.md")
    expect(existsSync(diffMdPath)).toBe(true)
    const diffMd = readFileSync(diffMdPath, "utf8")
    expect(diffMd).toContain("单向提醒") // 单向提醒在导出产物内（TUI 不渲染工具回执，须转述）
    expect(diffMd).toContain("第三章")
    expect(diffMd).toContain("修订后内容") // 本次 ch3 改写
    expect(diffMd).not.toContain("信贷审批部") // ch4 未动，不进差异

    const chapterOut = String(await exTools.reqdoc_export!.execute({ mode: "chapter", chapter: 3 } as never, ctx))
    expect(chapterOut).toContain("整章")
    const chapterMdPath = pjoin(worktree, "07_需求规格产出", "定点修订_第3章_整章.md")
    expect(existsSync(chapterMdPath)).toBe(true)
    expect(readFileSync(chapterMdPath, "utf8")).toContain("原稿第二节") // 整章含未改动内容

    // 释放锁后 diff 应报错（须先进入定点修订）
    await endEdit(tools, ctx)
    await expect(
      exTools.reqdoc_export!.execute({ mode: "diff", chapter: 3 } as never, ctx),
    ).rejects.toThrow(/定点修订/)
    store.close()
  })

  test("完整链路：锁定只改 ch3，越界写被拒，导出只含 ch3 改动", async () => {
    const { store, tools, exTools, ctx, worktree } = setup()
    await ingest(tools, { features: [{ name: "名单排查", priority: "high" }], slots: [
      { address: "3.1", kind: "prose", content: "原稿第一节", source: "文档" },
      { address: "4.1.CRD", kind: "term", content: "信贷审批部", source: "文档" },
    ] }, ctx)
    await startEdit(tools, 3, ctx)
    // 越界写 ch4 被拒
    await expect(
      answer(tools, { address: "4.1.CRD", content: "改了", source: "问答" }, ctx),
    ).rejects.toThrow(/已进入定点修订/)
    // 章内写 allowed
    await answer(tools, { address: "3.1", content: "修订第一节", source: "问答" }, ctx)
    const out = String(await exTools.reqdoc_export!.execute({ mode: "diff", chapter: 3 } as never, ctx))
    expect(out).toContain("定点修订")
    const diffMd = readFileSync(pjoin(worktree, "07_需求规格产出", "定点修订_第3章_差异.md"), "utf8")
    expect(diffMd).toContain("单向提醒")
    expect(diffMd).not.toContain("信贷审批部") // 越界 ch4 被拒，未进差异
    store.close()
  })

  test("对抗 F：空内容清空 >50% 须 confirmClear，非修订态不受限", async () => {
    const { store, tools, ctx } = setup()
    await ingest(tools, { features: [{ name: "名单排查", priority: "high" }], slots: [
      { address: "3.1", kind: "prose", content: "甲", source: "文档" },
      { address: "3.2", kind: "prose", content: "乙", source: "文档" },
      { address: "3.3", kind: "prose", content: "丙", source: "文档" },
    ] }, ctx)
    for (const a of ["3.1", "3.2", "3.3"]) {
      await answer(tools, { address: a, content: `内容${a}`, source: "问答" }, ctx)
    }
    // 非修订态：空内容允许（守卫只管定点修订）
    await answer(tools, { address: "3.3", content: "", source: "问答" }, ctx)
    // 进入修订锁 ch3：3.3 已空=1/3；写空 3.2 → 2/3 >50% 被拒
    await startEdit(tools, 3, ctx)
    await expect(
      answer(tools, { address: "3.2", content: "", source: "问答" }, ctx),
    ).rejects.toThrow(/清空/)
    // 带业务确认放行
    const out = String(await answer(tools, { address: "3.2", content: "", source: "问答", confirmClear: true }, ctx))
    expect(out).toContain("已确认")
    store.close()
  })
})
