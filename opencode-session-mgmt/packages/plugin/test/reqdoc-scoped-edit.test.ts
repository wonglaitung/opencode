/**
 * 定点修订（乙）服务端硬不变量集成测试：editScope 越界拒收 + confirmRetire 守卫。
 * 对照实现见 docs/reqdoc-scoped-edit.md 对抗审查 B/I/G/C/D/F。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Store } from "../src/db"
import { createReqdocKbTools } from "../src/tools/reqdoc-kb-tools"

const dirs: string[] = []
function setup() {
  const store = Store.memory(() => "reqdoc" as const)
  const worktree = mkdtempSync(join(tmpdir(), "sm-scope-"))
  dirs.push(worktree)
  const tools = createReqdocKbTools(store)
  const ctx = { sessionID: "r1", worktree } as never
  return { store, tools, ctx }
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
const recall = (tools: ReturnType<typeof createReqdocKbTools>, args: unknown, ctx: never) =>
  tools.reqdoc_memory_recall!.execute(args as never, ctx)

describe("定点修订 · 服务端硬不变量", () => {
  test("★ 锁定第3章后，越界 ingest/answer 被拒收，释放后恢复", async () => {
    const { store, tools, ctx } = setup()
    await ingest(tools, { features: [{ name: "名单排查", priority: "high" }], slots: [{ address: "3.1", kind: "prose", content: "原稿内容", source: "文档" }] }, ctx)
    await startEdit(tools, 3, ctx)
    // 越界 ingest（第4章术语）
    await expect(
      ingest(tools, { slots: [{ address: "4.1.CRD", kind: "term", content: "信贷审批部", source: "问答" }] }, ctx),
    ).rejects.toThrow(/已进入定点修订/)
    // 越界 answer
    await expect(
      answer(tools, { address: "4.1.CRD", content: "信贷审批部", source: "问答" }, ctx),
    ).rejects.toThrow(/已进入定点修订/)
    // 章内写入仍允许
    await expect(answer(tools, { address: "3.1", content: "修订后内容", source: "问答" }, ctx)).resolves.toBeDefined()
    // 释放锁后越界可写
    await endEdit(tools, ctx)
    await expect(
      ingest(tools, { slots: [{ address: "4.1.CRD", kind: "term", content: "信贷审批部", source: "问答" }] }, ctx),
    ).resolves.toBeDefined()
    store.close()
  })

  test("★ 锁定章内拟 retire 超 50% 须 confirmRetire，否则拒收", async () => {
    const { store, tools, ctx } = setup()
    await ingest(tools, { features: [{ name: "名单排查", priority: "high" }], slots: [
      { address: "3.1", kind: "prose", content: "a", source: "文档" },
      { address: "3.2", kind: "prose", content: "b", source: "文档" },
    ] }, ctx)
    await startEdit(tools, 3, ctx)
    // 退役第3章全部 2 个槽位（100%）未确认 → 拒收
    await expect(
      recall(tools, { facts: [], retire_slots: ["3.1", "3.2"] }, ctx),
    ).rejects.toThrow(/占比/)
    // 带 confirmRetire → 放行，槽位转为 retired
    await recall(tools, { facts: [], retire_slots: ["3.1", "3.2"], confirmRetire: true }, ctx)
    const kb = store.get("r1")!.workflow!.kb!
    expect(kb.slots.filter((s) => s.status === "retired").length).toBe(2)
    store.close()
  })

  test("★ 非锁定态下 retire 不受 confirmRetire 约束", async () => {
    const { store, tools, ctx } = setup()
    await ingest(tools, { features: [{ name: "名单排查", priority: "high" }], slots: [
      { address: "3.1", kind: "prose", content: "a", source: "文档" },
      { address: "3.2", kind: "prose", content: "b", source: "文档" },
    ] }, ctx)
    await expect(recall(tools, { facts: [], retire_slots: ["3.1", "3.2"] }, ctx)).resolves.toBeDefined()
    store.close()
  })
})
