import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { createReqdocFeatureTools } from "../src/tools/reqdoc-features"
import { createReqdocKbTools } from "../src/tools/reqdoc-kb-tools"

function setup() {
  const worktree = mkdtempSync(join(tmpdir(), "reqdoc-complete-"))
  const store = Store.memory(() => "reqdoc")
  store.mutateWorkflow("s1", (workflow) => {
    workflow.type = "reqdoc"
    for (const stage of Object.keys(workflow.stages)) workflow.stages[stage].status = "approved"
  })
  return {
    worktree,
    store,
    ctx: { worktree, sessionID: "s1" } as never,
    kb: createReqdocKbTools(store),
    features: createReqdocFeatureTools(store),
  }
}

describe("reqdoc 完成态写入保护", () => {
  test("已完成时拒绝 ingest/answer/assemble/confirm_features/start_scoped_edit", async () => {
    const { store, ctx, kb, features } = setup()
    try {
      await expect(
        kb.reqdoc_ingest!.execute({ slots: [] } as never, ctx),
      ).rejects.toThrow(/工作流已完成.*修改需求槽位/)
      await expect(
        kb.reqdoc_answer!.execute({ address: "3.1", content: "x", source: "文档" } as never, ctx),
      ).rejects.toThrow(/工作流已完成.*修改需求槽位/)
      await expect(kb.reqdoc_assemble!.execute({} as never, ctx)).rejects.toThrow(
        /工作流已完成.*重新组装 PRD/,
      )
      await expect(
        features.reqdoc_confirm_features!.execute({ features: [{ name: "新功能", priority: "high" }] } as never, ctx),
      ).rejects.toThrow(/工作流已完成.*修改功能点清单/)
      await expect(
        kb.reqdoc_start_scoped_edit!.execute({ chapter: 2 } as never, ctx),
      ).rejects.toThrow(/工作流已完成.*开始定点修改/)
    } finally {
      store.close()
    }
  })
})
