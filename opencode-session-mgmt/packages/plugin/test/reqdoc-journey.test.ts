import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { requiredContainers, requiredSlots } from "sm-shared"
import { Store } from "../src/db"
import { createReqdocFeatureTools } from "../src/tools/reqdoc-features"
import { createReqdocKbTools } from "../src/tools/reqdoc-kb-tools"
import { createReviewTools } from "../src/tools/review"
import { createWorkflowStartTools } from "../src/tools/workflow-start"
import { createWorkflowTools } from "../src/tools/workflow"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("Reqdoc 全旅程", () => {
  test("workflow_start → 五阶段 → assemble → review_submit → 完成态写入被拒", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "reqdoc-journey-"))
    dirs.push(worktree)
    const ctx = { sessionID: "r1", worktree } as never
    const store = Store.memory(() => "reqdoc")
    const start = createWorkflowStartTools(store)
    const workflow = createWorkflowTools(store)
    const kb = createReqdocKbTools(store)
    const features = createReqdocFeatureTools(store)
    const review = createReviewTools(store)
    try {
      await start.workflow_start!.execute({ type: "reqdoc" } as never, ctx)
      store.mutateWorkflow("r1", (wf) => {
        wf.baselineProposedByDev = { hours: 12, messageID: "m1", at: Date.now() }
      })
      await workflow.workflow_baseline!.execute({ estimated_hours: 12, developer_confirmed: true } as never, ctx)

      await workflow.workflow_advance!.execute({ stage: "rules", action: "enter", developer_confirmed: true } as never, ctx)
      await workflow.workflow_advance!.execute({ stage: "edge", action: "enter", developer_confirmed: true } as never, ctx)

      await features.reqdoc_confirm_features!.execute(
        { features: [{ name: "公告发布", priority: "medium" }] } as never,
        ctx,
      )
      const confirmed = store.get("r1")!.workflow!.kb!.features
      const addresses = requiredSlots(confirmed)
      const containers = Object.fromEntries(
        requiredContainers(confirmed).map((address) => [address, { required: false, reason: "本次无内容" }]),
      )
      await kb.reqdoc_ingest!.execute(
        {
          slots: addresses.map((address) => ({
            address,
            kind: "prose",
            content: `${address} 的业务内容`,
            source: "文档",
          })),
          containers,
        } as never,
        ctx,
      )
      for (const address of addresses) {
        await kb.reqdoc_answer!.execute(
          { address, content: `${address} 已确认内容`, source: "文档" } as never,
          ctx,
        )
      }

      await workflow.workflow_advance!.execute({ stage: "prd", action: "enter", developer_confirmed: true } as never, ctx)
      await kb.reqdoc_assemble!.execute({} as never, ctx)
      expect(existsSync(join(worktree, "07_需求规格产出", "1_公告发布", "PRD.md"))).toBe(true)

      await workflow.workflow_advance!.execute({ stage: "review", action: "enter", developer_confirmed: true } as never, ctx)
      await review.comprehension_add!.execute(
        { codeSegmentId: "目标与场景", explanation: "面向业务人员发布公告，减少线下流转" } as never,
        ctx,
      )
      await review.comprehension_confirm!.execute(
        {
          codeSegmentId: "目标与场景",
          sourceLabel: "对话第 1 轮业务原话",
          sourceQuote: "公告现在线下流转太慢",
        } as never,
        ctx,
      )
      await review.review_submit!.execute(
        { completeness: true, clarity: true, edgeCoverage: true, resolution: true } as never,
        ctx,
      )

      const wf = store.get("r1")!.workflow!
      expect(wf.stages.goal.status).toBe("approved")
      expect(wf.stages.rules.status).toBe("approved")
      expect(wf.stages.edge.status).toBe("approved")
      expect(wf.stages.prd.status).toBe("approved")
      expect(wf.stages.review.status).toBe("approved")
      expect(wf.commit.status).toBe("allowed")

      await expect(kb.reqdoc_assemble!.execute({} as never, ctx)).rejects.toThrow(/工作流已完成.*重新组装 PRD/)
      await expect(
        kb.reqdoc_answer!.execute({ address: addresses[0]!, content: "事后修改", source: "问答" } as never, ctx),
      ).rejects.toThrow(/工作流已完成.*修改需求槽位/)
    } finally {
      store.close()
    }
  })
})
