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
    expect(out).toContain("7 项检查标准")
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

  test("稿子在工作区外 → 不抛错，回执给出可转达的复制指引（含参考件命名）", async () => {
    const worktree = tempDir()
    const outside = mkdtempSync(join(tmpdir(), "sm-outside-"))
    writeFileSync(join(outside, "别家的需求.docx"), "x", "utf8")
    const tools = createReqdocImportTool()
    // 回执而非 throw：业务给的是绝对路径，若当异常抛出会被当成「工具坏了」而无人转达
    const out = String(
      await tools.reqdoc_import!.execute({ path: join(outside, "别家的需求.docx") } as never, {
        sessionID: "s1",
        worktree,
      } as never),
    )
    expect(out).toContain("读取被拒绝")
    expect(out).toContain("转达给业务")
    expect(out).toContain(join(worktree, "00_初稿需求书"))
    expect(out).toContain("参考_")
    // 越界不得有任何文件被落盘
    expect(existsSync(join(worktree, "00_初稿需求书"))).toBe(false)
  })
})
