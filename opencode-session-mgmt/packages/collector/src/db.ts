/**
 * 聚合库（设计文档 §3.1）。
 * reports 表按 session_id 主键：接收各机器汇报快照（account/group/org +
 * 阶段时间戳 + cost/tokens + 会话内质量），与 CI 回写指标按 session 合并。
 * 组/组织结构由各人汇报自然形成，GROUP BY group_name / org_name 即得。
 */
import { Database } from "bun:sqlite"
import type { CiQualityReport, SessionReport } from "sm-shared"

interface ReportRaw {
  session_id: string
  account: string | null
  group_name: string | null
  org_name: string | null
  workflow: string | null
  cost: number | null
  tokens_input: number | null
  tokens_output: number | null
  rework_rate: number | null
  test_coverage: number | null
  reported_at: number | null
}

export interface AccountAggregate {
  account: string
  sessions: number
  completed: number
  completionRate: number
  cost: number
  avgAcceptanceRate: number | null
  overAcceptanceThreshold: number
  hitIterationLimit: number
}

export interface ScopeStats {
  scope: "group" | "org"
  name: string
  members: number
  sessions: number
  completed: number
  completionRate: number
  totalCost: number
  avgAcceptanceRate: number | null
  overAcceptanceThreshold: number
  hitIterationLimit: number
  perAccount: AccountAggregate[]
}

const ACCEPTANCE_WARN_THRESHOLD = 45
const ITERATION_LIMIT = 3

export class CollectorDb {
  private constructor(private db: Database) {}

  static open(path: string): CollectorDb {
    const db = new Database(path, { create: true })
    db.exec("PRAGMA journal_mode = WAL;")
    db.exec(`CREATE TABLE IF NOT EXISTS reports (
      session_id TEXT PRIMARY KEY,
      account TEXT,
      group_name TEXT,
      org_name TEXT,
      workflow TEXT,
      cost REAL,
      tokens_input INTEGER,
      tokens_output INTEGER,
      rework_rate REAL,
      test_coverage REAL,
      reported_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_reports_group ON reports(group_name);
    CREATE INDEX IF NOT EXISTS idx_reports_org ON reports(org_name);`)
    return new CollectorDb(db)
  }

  /** 合并一条插件汇报：更新快照字段，保留既有 CI 回写指标（rework/coverage）。 */
  upsertReport(report: SessionReport): void {
    this.db
      .query(
        `INSERT INTO reports (session_id, account, group_name, org_name, workflow, cost, tokens_input, tokens_output, reported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           account = excluded.account,
           group_name = excluded.group_name,
           org_name = excluded.org_name,
           workflow = excluded.workflow,
           cost = excluded.cost,
           tokens_input = excluded.tokens_input,
           tokens_output = excluded.tokens_output,
           reported_at = excluded.reported_at`,
      )
      .run(
        report.sessionID,
        report.account,
        report.group,
        report.org,
        JSON.stringify(report.workflow),
        report.cost,
        report.tokensInput,
        report.tokensOutput,
        report.reportedAt,
      )
  }

  /** 合并 CI 回写：仅写 reworkRate/testCoverage；会话尚无汇报时先建行。 */
  applyCiQuality(report: CiQualityReport): void {
    this.db
      .query(
        `INSERT INTO reports (session_id, rework_rate, test_coverage)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           rework_rate = COALESCE(excluded.rework_rate, reports.rework_rate),
           test_coverage = COALESCE(excluded.test_coverage, reports.test_coverage)`,
      )
      .run(report.sessionID, report.quality.reworkRate ?? null, report.quality.testCoverage ?? null)
  }

  private rowsFor(where: string, params: string[], sinceCutoff: number | null): ReportRaw[] {
    let sql = `SELECT session_id, account, group_name, org_name, workflow, cost, tokens_input, tokens_output, rework_rate, test_coverage, reported_at FROM reports WHERE ${where}`
    const bound: Array<string | number> = [...params]
    if (sinceCutoff !== null) {
      sql += " AND (reported_at IS NULL OR reported_at >= ?)"
      bound.push(sinceCutoff)
    }
    return this.db.query(sql).all(...bound) as ReportRaw[]
  }

  statsGroup(group: string, periodMs: number | null): ScopeStats {
    const since = periodMs === null ? null : Date.now() - periodMs
    const rows = this.rowsFor("group_name = ?", [group], since)
    return this.aggregate("group", group, rows)
  }

  statsOrg(org: string, periodMs: number | null): ScopeStats {
    const since = periodMs === null ? null : Date.now() - periodMs
    const rows = this.rowsFor("org_name = ?", [org], since)
    return this.aggregate("org", org, rows)
  }

  private aggregate(scope: "group" | "org", name: string, rows: ReportRaw[]): ScopeStats {
    interface WorkflowLite {
      quality?: { acceptanceRate?: number | null; iterationCount?: number | null }
      commit?: { status?: string }
    }
    const byAccount = new Map<string, ReportRaw[]>()
    for (const row of rows) {
      const key = row.account ?? "(unknown)"
      const list = byAccount.get(key) ?? []
      list.push(row)
      byAccount.set(key, list)
    }
    const perAccount: AccountAggregate[] = []
    let completed = 0
    let totalCost = 0
    const acceptances: number[] = []
    let overThreshold = 0
    let hitLimit = 0
    for (const [account, list] of byAccount) {
      let accCompleted = 0
      let accCost = 0
      const accAcceptances: number[] = []
      let accOver = 0
      let accLimit = 0
      for (const row of list) {
        const workflow = row.workflow ? (JSON.parse(row.workflow) as WorkflowLite) : {}
        if (workflow.commit?.status === "allowed") accCompleted++
        accCost += row.cost ?? 0
        const rate = workflow.quality?.acceptanceRate ?? null
        if (rate !== null && rate !== undefined) {
          accAcceptances.push(rate)
          if (rate > ACCEPTANCE_WARN_THRESHOLD) accOver++
        }
        const iter = workflow.quality?.iterationCount ?? null
        if (iter !== null && iter !== undefined && iter >= ITERATION_LIMIT) accLimit++
      }
      completed += accCompleted
      totalCost += accCost
      acceptances.push(...accAcceptances)
      overThreshold += accOver
      hitLimit += accLimit
      perAccount.push({
        account,
        sessions: list.length,
        completed: accCompleted,
        completionRate: list.length > 0 ? accCompleted / list.length : 0,
        cost: accCost,
        avgAcceptanceRate:
          accAcceptances.length > 0 ? accAcceptances.reduce((a, b) => a + b, 0) / accAcceptances.length : null,
        overAcceptanceThreshold: accOver,
        hitIterationLimit: accLimit,
      })
    }
    perAccount.sort((a, b) => b.sessions - a.sessions)
    return {
      scope,
      name,
      members: byAccount.size,
      sessions: rows.length,
      completed,
      completionRate: rows.length > 0 ? completed / rows.length : 0,
      totalCost,
      avgAcceptanceRate:
        acceptances.length > 0 ? acceptances.reduce((a, b) => a + b, 0) / acceptances.length : null,
      overAcceptanceThreshold: overThreshold,
      hitIterationLimit: hitLimit,
      perAccount,
    }
  }

  close(): void {
    this.db.close()
  }
}
