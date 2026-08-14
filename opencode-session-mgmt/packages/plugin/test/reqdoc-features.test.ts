/**
 * reqdoc_confirm_features 功能点拆解工具测试（重构核心：prd 前置功能点拆解确认）。
 * 覆盖：记录 features 到 workflow、建 05_功能点 子目录、仅 reqdoc 可用、参数校验。
 */
import { mkdtempSync } from "node:fs"
import { readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { createReqdocFeatureTools } from "../src/tools/reqdoc-features"

function setup(worktree: string) {
  const store = Store.memory(() => "reqdoc")
  const tools = createReqdocFeatureTools(store)
  const ctx = { worktree, sessionID: "s1" } as never
  return { store, tools, ctx }
}

describe("reqdoc_confirm_features", () => {
  test("记录功能点到 workflow.features（编号按序、优先级映射）", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "reqdoc-feat-"))
    const { store, tools, ctx } = setup(worktree)
    const out = await tools.reqdoc_confirm_features!.execute(
      { features: [{ name: "名单排查", priority: "high" }, { name: "模型打分", priority: "low", note: "二期" }] } as never,
      ctx,
    )
    expect(String(out)).toContain("2 个功能点")
    const wf = store.get("s1")!.workflow!
    expect(wf.features).toHaveLength(2)
    expect(wf.features![0]).toMatchObject({ no: 1, name: "名单排查", priority: "high" })
    expect(wf.features![1]).toMatchObject({ no: 2, name: "模型打分", priority: "low", note: "二期" })
    expect(typeof wf.features![0].confirmedAt).toBe("number")
    store.close()
  })

  test("为每个功能点在 05_功能点 下建子目录与来源摘录", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "reqdoc-feat-"))
    const { store, tools, ctx } = setup(worktree)
    await tools.reqdoc_confirm_features!.execute(
      { features: [{ name: "名单排查", priority: "high" }] } as never,
      ctx,
    )
    const dir = join(worktree, "05_功能点", "1_名单排查")
    expect(readdirSync(dir)).toContain("来源摘录.md")
    expect(readFileSync(join(dir, "来源摘录.md"), "utf8")).toContain("功能点 1")
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
})
