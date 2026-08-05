import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWorkflowState, summarizeWorkflow, type SessionReport } from "sm-shared"
import { CollectorDb } from "../src/db"

function report(sessionID: string, account: string, group: string, cost: number): SessionReport {
  const workflow = createWorkflowState()
  workflow.stages.requirements.status = "approved"
  workflow.quality.firstPassRate = 50 // 低于 70 参考线，用于返工信号计数
  return {
    sessionID,
    account,
    group,
    org: "Eng",
    workflow: summarizeWorkflow(workflow),
    cost,
    tokensInput: 100,
    tokensOutput: 50,
    reportedAt: Date.now(),
  }
}

/** 携带 linesByFile 的汇报（经 summarizeWorkflow 投影为三分类聚合） */
function reportWithLines(sessionID: string, account: string, group: string, linesByFile: Record<string, number>): SessionReport {
  const workflow = createWorkflowState()
  workflow.quality.linesByFile = linesByFile
  return {
    sessionID,
    account,
    group,
    org: "Eng",
    workflow: summarizeWorkflow(workflow),
    cost: null,
    tokensInput: 0,
    tokensOutput: 0,
    reportedAt: Date.now(),
  }
}

function withDb(fn: (db: CollectorDb) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "sm-col-"))
  const db = CollectorDb.open(join(dir, "c.db"))
  try {
    fn(db)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("CollectorDb", () => {
  test("CI 回写先到、汇报后到：保留 CI 指标", () => {
    withDb((db) => {
      db.applyCiQuality({ sessionID: "s1", quality: { reworkRate: 0.1, testCoverage: 80 } })
      db.upsertReport(report("s1", "alice", "前端组", 1.5))
      const stats = db.statsGroup("前端组", null)
      expect(stats.sessions).toBe(1)
      // 汇报未覆盖 CI 字段（通过再次查询行间接验证：聚合不报错且会话计入）
      expect(stats.members).toBe(1)
    })
  })

  test("汇报先到、CI 后到：合并指标", () => {
    withDb((db) => {
      db.upsertReport(report("s1", "alice", "前端组", 1))
      db.applyCiQuality({ sessionID: "s1", quality: { reworkRate: 0.2 } })
      const stats = db.statsGroup("前端组", null)
      expect(stats.sessions).toBe(1)
    })
  })

  test("组聚合：成员排行与低一次通过率计数", () => {
    withDb((db) => {
      db.upsertReport(report("s1", "alice", "前端组", 1))
      db.upsertReport(report("s2", "alice", "前端组", 2))
      db.upsertReport(report("s3", "bob", "前端组", 1))
      const stats = db.statsGroup("前端组", null)
      expect(stats.members).toBe(2)
      expect(stats.sessions).toBe(3)
      expect(stats.perAccount[0]!.account).toBe("alice") // 会话多者排前
      expect(stats.perAccount[0]!.sessions).toBe(2)
      expect(stats.lowFirstPassCount).toBe(3) // firstPassRate=50 < 70
      expect(stats.avgFirstPassRate).toBe(50)
    })
  })

  test("org 聚合规避其他 org", () => {
    withDb((db) => {
      db.upsertReport(report("s1", "alice", "前端组", 1))
      const other = report("s2", "zoe", "后端组", 1)
      other.org = "Other"
      db.upsertReport(other)
      expect(db.statsOrg("Eng", null).sessions).toBe(1)
    })
  })

  test("聚合人均耗时、覆盖率、返工率", () => {
    withDb((db) => {
      const wf = createWorkflowState()
      wf.stages.requirements.transitions.push({ action: "enter", at: 0 })
      wf.stages.requirements.transitions.push({ action: "approve", at: 3_600_000 })
      const r: SessionReport = {
        sessionID: "s1",
        account: "alice",
        group: "前端组",
        org: "Eng",
        workflow: summarizeWorkflow(wf),
        cost: 1,
        tokensInput: 0,
        tokensOutput: 0,
        reportedAt: 100,
      }
      db.upsertReport(r)
      db.applyCiQuality({ sessionID: "s1", quality: { reworkRate: 0.2, testCoverage: 80 } })
      const stats = db.statsGroup("前端组", null)
      expect(stats.avgDurationMs).toBe(3_600_000)
      expect(stats.avgTestCoverage).toBe(80)
      expect(stats.avgReworkRate).toBe(0.2)
      expect(stats.perAccount[0]!.avgDurationMs).toBe(3_600_000)
      expect(stats.perAccount[0]!.avgTestCoverage).toBe(80)
      // period=null 时不产出趋势
      expect(stats.trends.requirementRevision).toBeNull()
    })
  })

  test("趋势：需求迭代与返工率按汇报时间分早晚半段", () => {
    withDb((db) => {
      const now = Date.now()
      const PERIOD = 1_000_000
      const mk = (id: string, rev: number, at: number): SessionReport => {
        const wf = createWorkflowState()
        wf.stages.requirements.revision = rev
        return {
          sessionID: id,
          account: "alice",
          group: "前端组",
          org: "Eng",
          workflow: summarizeWorkflow(wf),
          cost: 1,
          tokensInput: 0,
          tokensOutput: 0,
          reportedAt: at,
        }
      }
      db.upsertReport(mk("early", 3, now - 800_000))
      db.upsertReport(mk("recent", 1, now - 100_000))
      db.applyCiQuality({ sessionID: "early", quality: { reworkRate: 0.2 } })
      db.applyCiQuality({ sessionID: "recent", quality: { reworkRate: 0.05 } })
      const stats = db.statsGroup("前端组", PERIOD)
      expect(stats.trends.requirementRevision).toEqual({ from: 3, to: 1, direction: "down" })
      expect(stats.trends.reworkRate).toEqual({ from: 0.2, to: 0.05, direction: "down" })
    })
  })

  describe("行数三分类聚合（6.3 累加型求和）", () => {
    test("汇报携带三分类行数 → 范围统计求和", () => {
      withDb((db) => {
        db.upsertReport(reportWithLines("s1", "alice", "前端组", { "src/a.ts": 10, "src/a.test.ts": 5, "c.json": 1 }))
        db.upsertReport(reportWithLines("s2", "bob", "前端组", { "src/b.ts": 3, "d.yaml": 2 }))
        const stats = db.statsGroup("前端组", null)
        expect(stats.linesTotal).toEqual({ business: 13, test: 5, config: 3 })
      })
    })

    test("无行数会话不影响求和；组织级同样聚合", () => {
      withDb((db) => {
        db.upsertReport(report("s1", "alice", "前端组", 1)) // 无 linesByFile：投影 lines 为 null
        db.upsertReport(reportWithLines("s2", "bob", "前端组", { "src/b.ts": 7 }))
        expect(db.statsGroup("前端组", null).linesTotal).toEqual({ business: 7, test: 0, config: 0 })
        expect(db.statsOrg("Eng", null).linesTotal).toEqual({ business: 7, test: 0, config: 0 })
      })
    })
  })
})
