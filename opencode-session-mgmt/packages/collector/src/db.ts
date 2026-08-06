/**
 * 聚合库（设计文档 3.1）。
 * reports 表按 session_id 主键：接收各机器汇报快照（account/group/org +
 * 阶段时间戳 + cost/tokens + 会话内质量），与 CI 回写指标按 session 合并。
 * 组/组织结构由各人汇报自然形成，GROUP BY group_name / org_name 即得。
 */
import { Database } from "bun:sqlite"
import { efficiencyRatio, type CiQualityReport, type LinesCategory, type SessionReport } from "sm-shared"

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
  avgFirstPassRate: number | null
  /** 平均增量测试覆盖率（CI 回写，0-100；无数据为 null） */
  avgTestCoverage: number | null
  /** 平均会话耗时（毫秒，由汇报携带的阶段时间戳推算，6.1） */
  avgDurationMs: number
  lowFirstPassCount: number
  highIterationCount: number
}

/** 单一指标在统计窗口内「早半段 → 近半段」的走向。 */
export interface Trend {
  from: number
  to: number
  direction: "up" | "down" | "flat"
}

export interface ScopeTrends {
  /** 需求阶段平均 revision（需求质量） */
  requirementRevision: Trend | null
  /** 平均返工率 */
  reworkRate: Trend | null
  /** 平均 AI 提效率（6.3） */
  efficiency: Trend | null
}

export interface ScopeStats {
  scope: "group" | "org"
  name: string
  members: number
  sessions: number
  completed: number
  completionRate: number
  totalCost: number
  avgFirstPassRate: number | null
  /** 平均增量测试覆盖率（CI 回写，0-100；无数据为 null） */
  avgTestCoverage: number | null
  /** 平均返工率（CI 回写，0-1 分数；无数据为 null） */
  avgReworkRate: number | null
  /** 平均会话耗时（毫秒） */
  avgDurationMs: number
  lowFirstPassCount: number
  highIterationCount: number
  /** AI 净增行数三分类对各会话求和（累加型指标，不做平均，6.3；无数据时为 0） */
  linesTotal: LinesCategory
  /** 是否有任何会话上报行数数据（无数据时展示侧应示 N/A 而非 0，同项目级 hasLinesData） */
  hasLinesData: boolean
  /** 平均 AI 提效率（比率型，对「有基线且有有效周期」的会话求均值，6.3）；无数据为 null */
  avgEfficiency: number | null
  /** 已录入基线预估工时的会话数（提效曲线覆盖率参考） */
  baselineSessions: number
  trends: ScopeTrends
  perAccount: AccountAggregate[]
}

/** 一次通过率偏低参考线：低于此值标记返工信号（仅展示，非硬阈值/告警）。 */
const LOW_FIRST_PASS_THRESHOLD = 70
const HIGH_ITERATION_THRESHOLD = 5

/** reports.workflow JSON 的读侧投影（仅取聚合所需字段）。 */
interface WorkflowLite {
  stages?: Partial<
    Record<
      "requirements" | "design" | "implementation" | "testing" | "review",
      { revision?: number; transitions?: Array<{ at: number }> }
    >
  >
  quality?: {
    firstPassRate?: number | null
    iterationCount?: number | null
    /** 汇报投影携带的三分类行数聚合（插件已剥离文件路径，12） */
    lines?: Partial<LinesCategory> | null
  }
  commit?: { status?: string }
  /** 基线预估工时（6.3）；旧版汇报可能缺失该字段，缺省按未录入处理 */
  baseline?: { estimatedHours?: number } | null
}

function parseWorkflow(json: string | null): WorkflowLite {
  if (!json) return {}
  try {
    return JSON.parse(json) as WorkflowLite
  } catch {
    return {}
  }
}

/** 会话耗时：全部阶段转换时间戳的最早到最晚（6.1 时间戳即数据源）。 */
function workflowDurationMs(wf: WorkflowLite): number {
  const times: number[] = []
  for (const stage of Object.values(wf.stages ?? {})) {
    for (const t of stage?.transitions ?? []) {
      if (typeof t?.at === "number") times.push(t.at)
    }
  }
  return times.length > 0 ? Math.max(...times) - Math.min(...times) : 0
}

function avg(values: number[]): number | null {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null
}

function makeTrend(from: number | null, to: number | null): Trend | null {
  if (from === null || to === null) return null
  return { from, to, direction: to > from ? "up" : to < from ? "down" : "flat" }
}

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
    return this.aggregate("group", group, rows, since, periodMs)
  }

  statsOrg(org: string, periodMs: number | null): ScopeStats {
    const since = periodMs === null ? null : Date.now() - periodMs
    const rows = this.rowsFor("org_name = ?", [org], since)
    return this.aggregate("org", org, rows, since, periodMs)
  }

  private aggregate(
    scope: "group" | "org",
    name: string,
    rows: ReportRaw[],
    since: number | null,
    periodMs: number | null,
  ): ScopeStats {
    const byAccount = new Map<string, ReportRaw[]>()
    for (const row of rows) {
      const key = row.account ?? "(unknown)"
      const list = byAccount.get(key) ?? []
      list.push(row)
      byAccount.set(key, list)
    }

    // 趋势窗口：period 给定时按 reported_at 分早/近半段（mid = since + period/2）
    const mid = since !== null && periodMs !== null ? since + periodMs / 2 : null

    const perAccount: AccountAggregate[] = []
    let completed = 0
    let totalCost = 0
    const firstPasses: number[] = []
    const coverages: number[] = []
    const reworks: number[] = []
    const durations: number[] = []
    let lowCount = 0
    let hitLimit = 0
    // 行数为累加型指标：对会话三分类求和（不做平均，6.3）
    const linesTotal: LinesCategory = { business: 0, test: 0, config: 0 }
    let hasLinesData = false
    // 提效率为比率型指标：对「有基线且有有效周期」的会话求均值（6.3）
    const efficiencies: number[] = []
    let baselineSessions = 0
    const revEarly: number[] = []
    const revRecent: number[] = []
    const reworkEarly: number[] = []
    const reworkRecent: number[] = []
    const effEarly: number[] = []
    const effRecent: number[] = []

    for (const [account, list] of byAccount) {
      let accCompleted = 0
      let accCost = 0
      const accFirstPasses: number[] = []
      const accCoverages: number[] = []
      const accDurations: number[] = []
      let accLow = 0
      let accLimit = 0
      for (const row of list) {
        const workflow = parseWorkflow(row.workflow)
        if (workflow.commit?.status === "allowed") accCompleted++
        accCost += row.cost ?? 0
        const durationMs = workflowDurationMs(workflow)
        accDurations.push(durationMs)

        const rate = workflow.quality?.firstPassRate ?? null
        if (rate !== null && rate !== undefined) {
          accFirstPasses.push(rate)
          if (rate < LOW_FIRST_PASS_THRESHOLD) accLow++
        }
        const iter = workflow.quality?.iterationCount ?? null
        if (iter !== null && iter !== undefined && iter >= HIGH_ITERATION_THRESHOLD) accLimit++

        const lines = workflow.quality?.lines
        if (lines) {
          hasLinesData = true
          linesTotal.business += lines.business ?? 0
          linesTotal.test += lines.test ?? 0
          linesTotal.config += lines.config ?? 0
        }

        // 基线对比（6.3）：统计基线会话数并计算提效率（无基线/无周期为 null，不参与均值）
        const estimated = workflow.baseline?.estimatedHours
        if (typeof estimated === "number" && estimated > 0) baselineSessions++
        const eff = efficiencyRatio(estimated, durationMs)
        if (eff !== null) efficiencies.push(eff)

        if (row.test_coverage !== null && row.test_coverage !== undefined) accCoverages.push(row.test_coverage)
        if (row.rework_rate !== null && row.rework_rate !== undefined) reworks.push(row.rework_rate)

        // 趋势取样（需有汇报时间）
        if (mid !== null && typeof row.reported_at === "number") {
          const rev = workflow.stages?.requirements?.revision ?? 0
          if (row.reported_at < mid) {
            revEarly.push(rev)
            if (row.rework_rate !== null && row.rework_rate !== undefined) reworkEarly.push(row.rework_rate)
            if (eff !== null) effEarly.push(eff)
          } else {
            revRecent.push(rev)
            if (row.rework_rate !== null && row.rework_rate !== undefined) reworkRecent.push(row.rework_rate)
            if (eff !== null) effRecent.push(eff)
          }
        }
      }
      completed += accCompleted
      totalCost += accCost
      firstPasses.push(...accFirstPasses)
      coverages.push(...accCoverages)
      durations.push(...accDurations)
      lowCount += accLow
      hitLimit += accLimit
      perAccount.push({
        account,
        sessions: list.length,
        completed: accCompleted,
        completionRate: list.length > 0 ? accCompleted / list.length : 0,
        cost: accCost,
        avgFirstPassRate: avg(accFirstPasses),
        avgTestCoverage: avg(accCoverages),
        avgDurationMs: avg(accDurations) ?? 0,
        lowFirstPassCount: accLow,
        highIterationCount: accLimit,
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
      avgFirstPassRate: avg(firstPasses),
      avgTestCoverage: avg(coverages),
      avgReworkRate: avg(reworks),
      avgDurationMs: avg(durations) ?? 0,
      lowFirstPassCount: lowCount,
      highIterationCount: hitLimit,
      linesTotal,
      hasLinesData,
      avgEfficiency: avg(efficiencies),
      baselineSessions,
      trends: {
        requirementRevision: makeTrend(avg(revEarly), avg(revRecent)),
        reworkRate: makeTrend(avg(reworkEarly), avg(reworkRecent)),
        efficiency: makeTrend(avg(effEarly), avg(effRecent)),
      },
      perAccount,
    }
  }

  close(): void {
    this.db.close()
  }
}
