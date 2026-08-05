/**
 * 汇报 outbox 补推策略测试（设计文档 §2.4 风险与取舍）。
 * - 2xx 成功出队；
 * - 5xx/网络错误保留待补推；
 * - 4xx 为永久失败，丢弃以免堵塞队列（防毒消息）。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { createWorkflowState, summarizeWorkflow, type Identity, type SessionReport } from "sm-shared"
import { Store } from "../src/db"
import { buildReport, createReporter } from "../src/report"

const identity: Identity = {
  account: "alice@example.com",
  group: "前端组",
  org: "Engineering",
  collector_url: "http://collector.test",
}

const report: SessionReport = {
  sessionID: "s1",
  account: identity.account,
  group: identity.group,
  org: identity.org,
  workflow: summarizeWorkflow(createWorkflowState()),
  cost: null,
  tokensInput: null,
  tokensOutput: null,
  reportedAt: 0,
}

const noUsage = async () => ({ cost: null, tokensInput: null, tokensOutput: null })

const origFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = origFetch
})

function stubFetch(status: number): void {
  globalThis.fetch = (async () => new Response("{}", { status })) as unknown as typeof fetch
}

describe("flushOutbox 补推策略", () => {
  test("2xx 成功并出队", async () => {
    const store = Store.memory()
    store.enqueueReport(report)
    stubFetch(200)
    const sent = await createReporter(store, () => identity, noUsage).flushOutbox()
    expect(sent).toBe(1)
    expect(store.pendingReports().length).toBe(0)
  })

  test("5xx 保留待下次补推", async () => {
    const store = Store.memory()
    store.enqueueReport(report)
    stubFetch(500)
    const sent = await createReporter(store, () => identity, noUsage).flushOutbox()
    expect(sent).toBe(0)
    expect(store.pendingReports().length).toBe(1)
  })

  test("4xx 丢弃坏汇报，不堵塞队列", async () => {
    const store = Store.memory()
    store.enqueueReport(report)
    stubFetch(400)
    const sent = await createReporter(store, () => identity, noUsage).flushOutbox()
    expect(sent).toBe(0)
    expect(store.pendingReports().length).toBe(0) // 永久失败，已丢弃
  })

  test("无 collector_url 时退化为本机（不推送）", async () => {
    const store = Store.memory()
    store.enqueueReport(report)
    stubFetch(200)
    const sent = await createReporter(store, () => ({ ...identity, collector_url: "" }), noUsage).flushOutbox()
    expect(sent).toBe(0)
    expect(store.pendingReports().length).toBe(1)
  })

  test("同一会话多次汇报仅保留最新一条待发送（去重）", () => {
    const store = Store.memory()
    store.enqueueReport(report)
    store.enqueueReport({ ...report, cost: 5 })
    const pending = store.pendingReports()
    expect(pending.length).toBe(1)
    expect((JSON.parse(pending[0]!.payload) as SessionReport).cost).toBe(5)
  })
})

describe("行数汇报投影（3.2、12）", () => {
  const emptyUsage = { cost: null, tokensInput: null, tokensOutput: null }

  test("行数只上行三分类聚合，文件路径不出本机", () => {
    const store = Store.memory()
    store.mutateWorkflow("s9", (wf) => {
      wf.quality.linesByFile = { "secret/path/a.ts": 10, "secret/path/a.test.ts": -3, "c.json": 2 }
    })
    const built = buildReport(store.get("s9")!, identity, emptyUsage)!
    expect(built.workflow.quality.lines).toEqual({ business: 10, test: 0, config: 2 })
    expect(JSON.stringify(built)).not.toContain("secret/path")
    expect(JSON.stringify(built.workflow.quality)).not.toContain("linesByFile")
  })

  test("无 linesByFile 时行数为 null（纯讨论会话）", () => {
    const store = Store.memory()
    store.ensure("s10")
    const built = buildReport(store.get("s10")!, identity, emptyUsage)!
    expect(built.workflow.quality.lines).toBeNull()
  })
})
