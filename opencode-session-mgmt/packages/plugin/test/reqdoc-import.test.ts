import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createReqdocImportTool } from "../src/tools/reqdoc-import"

const tempDir = () => mkdtempSync(join(tmpdir(), "sm-import-"))

describe("reqdoc_import（基于初稿完善）", () => {
  test("导入文件 → 落盘 00_初稿需求书/ 并产出规约初评", async () => {
    const worktree = tempDir()
    const draftPath = join(worktree, "初稿.txt")
    writeFileSync(draftPath, "原需求：客户自助查询余额。", "utf8")
    const tools = createReqdocImportTool()
    const out = await tools.reqdoc_import!.execute({ path: "初稿.txt" } as never, { sessionID: "s1", worktree } as never)
    expect(out).toContain("已导入初稿")
    expect(out).toContain("7 份机构规约")
    const draftDir = join(worktree, "00_初稿需求书")
    expect(existsSync(draftDir)).toBe(true)
    const files = readdirSync(draftDir).filter((f) => f.startsWith("初稿_"))
    expect(files.length).toBe(1)
    expect(readFileSync(join(draftDir, files[0]), "utf8")).toContain("客户自助查询余额")
  })

  test("路径不存在 → 抛错", async () => {
    const worktree = tempDir()
    const tools = createReqdocImportTool()
    await expect(
      tools.reqdoc_import!.execute({ path: "不存在.md" } as never, { sessionID: "s1", worktree } as never),
    ).rejects.toThrow()
  })
})
