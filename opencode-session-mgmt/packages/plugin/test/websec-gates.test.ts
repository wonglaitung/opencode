import { afterEach, describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { createWorkflowTools } from "../src/tools/workflow"

const ctx = { sessionID: "s1" } as never
const stores: Store[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function setup(evidenceSource?: "edge") {
  const store = Store.memory(() => "websec")
  stores.push(store)
  store.ensure("s1")
  store.mutateWorkflow("s1", (wf) => {
    wf.stages.scope.status = "approved"
    wf.stages.surface.status = "in_progress"
    wf.websec = {
      testMode: "normal",
      edge: { started: true, finished: true },
      scope: {
        target: "http://127.0.0.1:18086",
        environment: "test",
        accounts: [{ name: "u1", role: "普通用户" }],
        stopConditions: ["异常即停"],
        confirmedAt: 1000,
      },
      evidence: evidenceSource
        ? [
            {
              id: "edge-1",
              url: "http://127.0.0.1:18086/api/tasks",
              method: "GET",
              source: evidenceSource,
              phase: "single",
              hash: "a".repeat(64),
              bodyPresent: true,
            },
          ]
        : [],
    }
  })
  return createWorkflowTools(store)
}

describe("websec 阶段触发条件", () => {
  test("自动确认 surface 时也不能绕过 Edge 证据门禁", async () => {
    const tools = setup()
    await expect(
      tools.workflow_advance!.execute(
        { stage: "checks", action: "enter", developer_confirmed: true } as never,
        ctx,
      ),
    ).rejects.toThrow(/Edge/)
  })

  test("有 Edge 证据后可自动确认 surface 并进入 checks", async () => {
    const tools = setup("edge")
    const output = String(
      await tools.workflow_advance!.execute(
        { stage: "checks", action: "enter", developer_confirmed: true } as never,
        ctx,
      ),
    )
    expect(output).toContain("自动确认")
    expect(output).toContain("安全检查")
  })
})
