/**
 * reqdoc_field_dict 字段定义工具测试（质量飞轮 P2.5 数据字典）。
 * 覆盖：记录进 workflow.fieldDict（按 feature+name 合并）、写入数据字典 md、
 * 仅 reqdoc 可用（sdlc 拒绝）。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Store } from "../src/db"
import { createReqdocFieldDictTools } from "../src/tools/reqdoc-field-dict"

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sm-fielddict-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(type: "reqdoc" | "sdlc") {
  const store = Store.memory(() => type)
  const worktree = tempDir()
  const ctx = { sessionID: "r1", worktree } as never
  return { store, worktree, ctx }
}

const DICT_REL = "06_需求规格产出/数据字典与库表设计/数据字典.md"

describe("reqdoc_field_dict", () => {
  test("记录字段进 workflow.fieldDict，并按 feature+name 合并去重", async () => {
    const { store, ctx } = setup("reqdoc")
    const tools = createReqdocFieldDictTools(store)
    await tools.reqdoc_field_dict!.execute({
      fields: [
        { feature: "功能点 1", name: "客户号", type: "字符串", required: true, sourceSystem: "核心系统" },
        { feature: "功能点 1", name: "客户号", type: "字符串", required: true, length: "19" },
      ],
    } as never, ctx)
    const fd = store.get("r1")!.workflow!.fieldDict!
    expect(fd.length).toBe(1)
    expect(fd[0].feature).toBe("功能点 1")
    expect(fd[0].name).toBe("客户号")
    expect(fd[0].length).toBe("19")
  })

  test("分批提交按 feature 合并，并写入数据字典 md", async () => {
    const { store, worktree, ctx } = setup("reqdoc")
    const tools = createReqdocFieldDictTools(store)
    await tools.reqdoc_field_dict!.execute({
      fields: [{ feature: "功能点 1", name: "客户号", type: "字符串", required: true }],
    } as never, ctx)
    await tools.reqdoc_field_dict!.execute({
      fields: [{ feature: "功能点 2", name: "额度", type: "数值", required: true, values: "0~999999" }],
    } as never, ctx)
    const fd = store.get("r1")!.workflow!.fieldDict!
    expect(fd.length).toBe(2)
    const abs = join(worktree, DICT_REL)
    const md = readFileSync(abs, "utf8")
    expect(md).toContain("功能点：功能点 1")
    expect(md).toContain("功能点：功能点 2")
    expect(md).toContain("| 客户号 |")
    expect(md).toContain("| 额度 |")
  })

  test("sdlc 工作流拒绝", async () => {
    const { store, ctx } = setup("sdlc")
    const tools = createReqdocFieldDictTools(store)
    await expect(
      tools.reqdoc_field_dict!.execute({
        fields: [{ feature: "x", name: "y", type: "字符串", required: false }],
      } as never, ctx),
    ).rejects.toThrow(/仅用于 reqdoc/)
  })
})
