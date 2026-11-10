import { describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { createCommitGate } from "../src/gate"
import { createReviewTools } from "../src/tools/review"
import { createWorkflowStartTools } from "../src/tools/workflow-start"
import { createWorkflowTools } from "../src/tools/workflow"

const ctx = { sessionID: "s1" } as never

describe("SDLC 全旅程", () => {
  test("workflow_start → 五阶段 → review_submit → commit gate 放行", async () => {
    const store = Store.memory(() => "sdlc")
    const start = createWorkflowStartTools(store)
    const workflow = createWorkflowTools(store)
    const review = createReviewTools(store)
    try {
      await start.workflow_start!.execute({ type: "sdlc" } as never, ctx)
      store.mutateWorkflow("s1", (wf) => {
        wf.baselineProposedByDev = { hours: 8, messageID: "m1", at: Date.now() }
      })
      await workflow.workflow_baseline!.execute({ estimated_hours: 8, developer_confirmed: true } as never, ctx)

      await workflow.workflow_advance!.execute({ stage: "design", action: "enter", developer_confirmed: true } as never, ctx)
      await workflow.workflow_advance!.execute({ stage: "implementation", action: "enter", developer_confirmed: true } as never, ctx)
      await workflow.workflow_advance!.execute({ stage: "testing", action: "enter", developer_confirmed: true } as never, ctx)
      await workflow.workflow_advance!.execute({ stage: "review", action: "enter", developer_confirmed: true } as never, ctx)

      await review.review_submit!.execute(
        {
          businessIntent: true,
          logicExplainable: true,
          behaviorVerifiable: true,
          confirm_note: "开发者：需求、设计、实现和测试都已确认，可以提交",
        } as never,
        ctx,
      )

      const wf = store.get("s1")!.workflow!
      expect(wf.stages.requirements.status).toBe("approved")
      expect(wf.stages.design.status).toBe("approved")
      expect(wf.stages.implementation.status).toBe("approved")
      expect(wf.stages.testing.status).toBe("approved")
      expect(wf.stages.review.status).toBe("approved")
      expect(wf.commit.status).toBe("allowed")
      await expect(
        workflow.commit_gate_check!.execute({} as never, ctx),
      ).resolves.toContain("允许提交")

      const gate = createCommitGate(store)
      await expect(
        gate({ tool: "bash", sessionID: "s1" }, { args: { command: "git commit -m 'full journey'" } }),
      ).resolves.toBeUndefined()

      await expect(
        workflow.workflow_advance!.execute({ stage: "review", action: "enter", developer_confirmed: true } as never, ctx),
      ).rejects.toThrow(/已 approved/)
    } finally {
      store.close()
    }
  })
})
