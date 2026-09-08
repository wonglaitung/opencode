import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createReqdocConventionReviewTool } from "../src/tools/reqdoc-review-conventions"

const tempDir = () => mkdtempSync(join(tmpdir(), "sm-conv-"))

describe("reqdoc_review_conventions（规约初评）", () => {
  test("无初稿 → 提示先导入", async () => {
    const worktree = tempDir()
    const tools = createReqdocConventionReviewTool()
    const out = await tools.reqdoc_review_conventions!.execute({} as never, { sessionID: "s1", worktree } as never)
    expect(out).toContain("尚未导入初稿")
  })

  test("有初稿 → 输出逐规约初评指南", async () => {
    const worktree = tempDir()
    mkdirSync(join(worktree, "00_初稿需求书"), { recursive: true })
    writeFileSync(join(worktree, "00_初稿需求书", "初稿.md"), "原需求内容", "utf8")
    const tools = createReqdocConventionReviewTool()
    const out = await tools.reqdoc_review_conventions!.execute({} as never, { sessionID: "s1", worktree } as never)
    expect(out).toContain("7 份机构规约")
    expect(out).toContain("初稿.md")
  })
})
