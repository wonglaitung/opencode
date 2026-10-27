/**
 * outbox 替换原子性护栏：删旧 + 插新必须同事物。
 * 用第二个 SQLite 连接建 BEFORE INSERT 触发器模拟插入失败，验证旧 pending 不被删。
 */
import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWorkflowState, summarizeWorkflow, type SessionReport } from "sm-shared"
import { Store } from "../src/db"

function report(sessionID: string, cost: number): SessionReport {
  return {
    sessionID,
    apiKey: "hash",
    workflow: summarizeWorkflow(createWorkflowState("sdlc")),
    cost,
    tokensInput: null,
    tokensOutput: null,
    reportedAt: 1,
  }
}

describe("outbox 替换原子性", () => {
  test("插入失败时旧 pending 仍在（删旧+插新同一事务）", () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-outbox-tx-"))
    const store = Store.open(dir, () => "sdlc")
    const db2 = new Database(join(dir, ".opencode", "session-mgmt.db"))
    try {
      store.enqueueReport(report("s1", 1))
      expect(store.pendingReports()).toHaveLength(1)

      db2.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'boom'); END;")
      expect(() => store.enqueueReport(report("s1", 2))).toThrow()

      db2.exec("DROP TRIGGER fail_outbox")
      const pending = store.pendingReports()
      expect(pending).toHaveLength(1)
      expect((JSON.parse(pending[0]!.payload) as SessionReport).cost).toBe(1)
    } finally {
      db2.close()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
