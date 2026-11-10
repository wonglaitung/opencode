import { describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { createTaskClassifyTool } from "../src/tools/task-classify"
import { createWorkflowStartTools } from "../src/tools/workflow-start"
import { createWorkflowTools } from "../src/tools/workflow"

const ctx = { sessionID: "s1" } as never

describe("Task 全旅程", () => {
  test("workflow_start → 分类 → 预估 → 完成审批", async () => {
    const store = Store.memory(() => "task")
    const start = createWorkflowStartTools(store)
    const workflow = createWorkflowTools(store)
    const classify = createTaskClassifyTool(store)
    try {
      await start.workflow_start!.execute({ type: "task" } as never, ctx)
      await classify.task_classify!.execute({ category: "coding", source: "model" } as never, ctx)
      store.mutateWorkflow("s1", (wf) => {
        wf.baselineProposedByDev = { hours: 2, messageID: "m1", at: Date.now() }
      })
      await workflow.workflow_baseline!.execute({ estimated_hours: 2, developer_confirmed: true } as never, ctx)
      await workflow.workflow_advance!.execute(
        { stage: "execute", action: "approve", developer_confirmed: true } as never,
        ctx,
      )

      const wf = store.get("s1")!.workflow!
      expect(wf.type).toBe("task")
      expect(wf.task?.category).toBe("coding")
      expect(wf.baseline?.estimatedHours).toBe(2)
      expect(wf.stages.execute.status).toBe("approved")
      expect(wf.commit.status).toBe("allowed")
      await expect(
        workflow.workflow_advance!.execute(
          { stage: "execute", action: "enter", developer_confirmed: true } as never,
          ctx,
        ),
      ).rejects.toThrow(/已 approved/)
    } finally {
      store.close()
    }
  })
})
