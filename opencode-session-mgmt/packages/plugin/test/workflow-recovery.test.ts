import { describe, expect, test } from "bun:test"
import { createWorkflowState, getDefinition } from "sm-shared"
import { Store } from "../src/db"
import { finishTask } from "../src/task-lifecycle"
import { createWorkflowTools } from "../src/tools/workflow"
import { applyTransition } from "../src/workflow-ops"

const ctx = { sessionID: "s1" } as never

for (const type of ["sdlc", "reqdoc", "websec"] as const) {
  describe(`${type} 自动确认与恢复`, () => {
    test("自动确认前序阶段须开发者确认，确认后只确认 in_progress 前序", async () => {
      const store = Store.memory(() => type)
      const tools = createWorkflowTools(store)
      const def = getDefinition(type)
      const last = def.stages.at(-1)!
      try {
        store.mutateWorkflow("s1", (workflow) => {
          for (const stage of def.stages.slice(0, -1)) workflow.stages[stage]!.status = "in_progress"
          if (type === "websec") {
            workflow.websec = {
              evidence: [
                {
                  id: "edge-1",
                  url: "http://127.0.0.1:18086/api/settings",
                  method: "GET",
                  source: "edge",
                  phase: "single",
                  hash: "a".repeat(64),
                  bodyPresent: true,
                },
              ],
              testMode: "normal",
              edge: { started: true, finished: true },
            }
          }
        })

        await expect(
          tools.workflow_advance!.execute(
            { stage: last, action: "enter", developer_confirmed: false } as never,
            ctx,
          ),
        ).rejects.toThrow(/自动确认/)

        const output = String(
          await tools.workflow_advance!.execute(
            { stage: last, action: "enter", developer_confirmed: true } as never,
            ctx,
          ),
        )
        expect(output).toContain("自动确认")

        const workflow = store.get("s1")!.workflow!
        for (const stage of def.stages.slice(0, -1)) {
          expect(workflow.stages[stage]!.status).toBe("approved")
        }
        expect(workflow.stages[last]!.status).toBe("in_progress")
      } finally {
        store.close()
      }
    })
  })
}

describe("审查阶段门禁矩阵", () => {
  for (const type of ["sdlc", "reqdoc", "websec"] as const) {
    test(`${type} 审查阶段不能 workflow_advance approve`, async () => {
      const store = Store.memory(() => type)
      const tools = createWorkflowTools(store)
      const reviewStage = getDefinition(type).reviewStage!
      try {
        store.mutateWorkflow("s1", (workflow) => {
          workflow.stages[reviewStage]!.status = "in_progress"
        })
        await expect(
          tools.workflow_advance!.execute(
            { stage: reviewStage, action: "approve", developer_confirmed: true } as never,
            ctx,
          ),
        ).rejects.toThrow(/review_submit/)
      } finally {
        store.close()
      }
    })
  }

  test("task 未录基线时不能 approve", async () => {
    const store = Store.memory(() => "task")
    const tools = createWorkflowTools(store)
    try {
      store.mutateWorkflow("s1", (workflow) => {
        workflow.stages.execute.status = "in_progress"
      })
      await expect(
        tools.workflow_advance!.execute(
          { stage: "execute", action: "approve", developer_confirmed: true } as never,
          ctx,
        ),
      ).rejects.toThrow(/预估工时/)
    } finally {
      store.close()
    }
  })
})

describe("revisit 恢复", () => {
  test("重复 revisit 持续递增 revision，不回到 not_started", () => {
    const state = createWorkflowState("sdlc")
    applyTransition(state, "requirements", "enter", 1)
    applyTransition(state, "requirements", "approve", 2)
    applyTransition(state, "requirements", "revisit", 3)
    applyTransition(state, "requirements", "revisit", 4)

    expect(state.stages.requirements.status).toBe("in_progress")
    expect(state.stages.requirements.revision).toBe(2)
    expect(state.stages.requirements.transitions.map((transition) => transition.action)).toEqual([
      "enter",
      "approve",
      "revisit",
      "revisit",
    ])
  })

  test("重复 enter 同一阶段保持幂等，不污染转换记录", () => {
    for (const type of ["task", "sdlc", "reqdoc", "websec"] as const) {
      const state = createWorkflowState(type)
      const stage = getDefinition(type).stages[0]!
      applyTransition(state, stage, "enter", 1)
      applyTransition(state, stage, "enter", 2)
      expect(state.stages[stage]!.status).toBe("in_progress")
      expect(state.stages[stage]!.transitions).toHaveLength(1)
    }
  })
})

describe("task 重复完成恢复", () => {
  test("workflow_advance 重复 approve 幂等，不追加转换", async () => {
    const store = Store.memory(() => "task")
    const tools = createWorkflowTools(store)
    try {
      store.mutateWorkflow("s1", (workflow) => {
        workflow.stages.execute.status = "in_progress"
        workflow.baseline = { estimatedHours: 2, setAt: 1 }
      })

      await tools.workflow_advance!.execute(
        { stage: "execute", action: "approve", developer_confirmed: true } as never,
        ctx,
      )
      const transitions = store.get("s1")!.workflow!.stages.execute.transitions.length

      await expect(
        tools.workflow_advance!.execute(
          { stage: "execute", action: "approve", developer_confirmed: true } as never,
          ctx,
        ),
      ).resolves.toContain("approved")

      expect(store.get("s1")!.workflow!.stages.execute.status).toBe("approved")
      expect(store.get("s1")!.workflow!.stages.execute.transitions).toHaveLength(transitions)
    } finally {
      store.close()
    }
  })

  test("自动收口重复触发不重复 approve", () => {
    const store = Store.memory(() => "task")
    try {
      store.mutateWorkflow("s1", (workflow) => {
        workflow.stages.execute.status = "in_progress"
        workflow.baseline = { estimatedHours: 2, setAt: 1 }
      })

      expect(finishTask(store, "s1", "本次任务已完成")).toBe(true)
      const transitions = store.get("s1")!.workflow!.stages.execute.transitions.length
      expect(finishTask(store, "s1", "本次任务已完成")).toBe(false)
      expect(store.get("s1")!.workflow!.stages.execute.transitions).toHaveLength(transitions)
    } finally {
      store.close()
    }
  })
})
