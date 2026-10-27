/**
 * P1 汇报持久化护栏：状态变更工具返回前，最新快照必须已写入本地 outbox。
 *
 * 背景：此前只在 chat.message 入队；最后一轮工具（approve/review_submit/task_classify 等）
 * 之后若没有新的用户消息，最终状态永远不会入队。dispose 只 flush 旧快照。
 * 现在 tool.execute.after（上游 await）负责状态变更后的入队；session.status=idle 仅作
 * cost/tokens 的可选刷新。
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Identity, SessionReport } from "sm-shared"
import { Store } from "../src/db"
import { applyTransition } from "../src/workflow-ops"
import { createReporter } from "../src/report"
import { createIdleReportHook, createToolReportHook, shouldReportTool } from "../src/report-trigger"

const identity: Identity = { apiKey: "test", collector_url: "" }
const noUsage = async () => ({ cost: null, tokensInput: null, tokensOutput: null })
const isSubagent = async (sessionID: string) => sessionID.startsWith("sub-")

function setup() {
  const store = Store.memory(() => "task")
  const reporter = createReporter(store, () => identity, noUsage)
  return {
    store,
    reporter,
    toolHook: createToolReportHook(reporter, isSubagent),
    idleHook: createIdleReportHook(reporter, isSubagent),
  }
}

function pending(store: Store): { id: number; payload: SessionReport }[] {
  return store
    .pendingReports()
    .map((row) => ({ id: row.id, payload: JSON.parse(row.payload) as SessionReport }))
}

function startTask(store: Store, sessionID: string, category?: "documentation"): void {
  store.mutateWorkflow(sessionID, (workflow) => {
    applyTransition(workflow, "execute", "enter", 1)
    if (category) workflow.task = { category, source: "model", setAt: 1 }
  })
}

describe("状态变更后的汇报持久化", () => {
  test("工具触发时用最新状态替换旧快照", async () => {
    const { store, reporter, toolHook } = setup()
    try {
      store.mutateWorkflow("s1", () => {}) // chat.message 时的未启动快照
      await reporter.enqueueReport("s1")
      startTask(store, "s1", "documentation") // workflow_start + task_classify 之后的状态

      await toolHook({ tool: "task_classify", sessionID: "s1" })

      const outbox = pending(store)
      expect(outbox).toHaveLength(1)
      expect(outbox[0]!.payload.workflow.stages.execute.status).toBe("in_progress")
      expect(outbox[0]!.payload.workflow.task?.category).toBe("documentation")
    } finally {
      store.close()
    }
  })

  test("只读/非状态工具不刷新 outbox", async () => {
    const { store, reporter, toolHook } = setup()
    try {
      startTask(store, "s1")
      await reporter.enqueueReport("s1")
      const before = pending(store)

      await toolHook({ tool: "read", sessionID: "s1" })
      await toolHook({ tool: "commit_gate_check", sessionID: "s1" })
      await toolHook({ tool: "reqdoc_ingest", sessionID: "s1" })

      const after = pending(store)
      expect(after).toHaveLength(1)
      expect(after[0]!.id).toBe(before[0]!.id)
    } finally {
      store.close()
    }
  })

  test("子代理不因工具后置钩子入队", async () => {
    const { store, toolHook } = setup()
    try {
      startTask(store, "sub-1")
      await toolHook({ tool: "workflow_advance", sessionID: "sub-1" })
      expect(pending(store)).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  test("idle 事件可选刷新：补上最终轮次快照", async () => {
    const { store, idleHook } = setup()
    try {
      startTask(store, "s1", "documentation")
      await idleHook({
        event: {
          type: "session.status",
          properties: { sessionID: "s1", status: { type: "idle" } },
        },
      } as never)

      const outbox = pending(store)
      expect(outbox).toHaveLength(1)
      expect(outbox[0]!.payload.workflow.task?.category).toBe("documentation")
    } finally {
      store.close()
    }
  })

  test("非 idle 状态不触发刷新", async () => {
    const { store, idleHook } = setup()
    try {
      startTask(store, "s1")
      await idleHook({
        event: {
          type: "session.status",
          properties: { sessionID: "s1", status: { type: "busy" } },
        },
      } as never)
      expect(pending(store)).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  test("工具前缀覆盖当前状态变更面，排除只读工具", () => {
    for (const tool of [
      "workflow_start",
      "workflow_advance",
      "workflow_revisit",
      "workflow_baseline",
      "task_classify",
      "review_submit",
      "comprehension_confirm",
      "commit_force_unlock",
    ]) {
      expect(shouldReportTool(tool)).toBe(true)
    }
    for (const tool of ["commit_gate_check", "comprehension_ask", "reqdoc_ingest", "open_ide", "read"]) {
      expect(shouldReportTool(tool)).toBe(false)
    }
  })

  test("插件入口挂载汇报 hooks", () => {
    const src = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8")
    expect(src).toContain("createToolReportHook")
    expect(src).toContain("createIdleReportHook")
  })
})
