/**
 * 插件 SQLite 初始化与迁移（设计文档 3.1）。
 * 插件启动时自动建表，迁移由插件自管，与上游 schema 演进互不影响。
 * 对外暴露 Store：工作流状态、标签、身份打标的类型化读写 + 汇报 outbox。
 * 统一使用 `?` 位置绑定（bun:sqlite）。
 */
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import {
  createWorkflowState,
  deepMerge,
  type DeepPartial,
  type SessionReport,
  type WorkflowState,
} from "sm-shared"
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  rowFromRaw,
  type OutboxRow,
  type WorkflowSessionRaw,
  type WorkflowSessionRow,
} from "./schema"

/**
 * opencode 会话默认占位标题：建会话未生成真实标题时为 `New session - <ISO>` / `Child session - <ISO>`。
 * 判断与上游 packages/app/src/utils/session-title.ts 一致。占位标题视为「未同步」，
 * 标题同步逻辑应照常刷新它，否则会一直停留在过期占位符（5.2 曾踩坑）。
 */
const PLACEHOLDER_TITLE = /^(New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function isPlaceholderTitle(title: string | null | undefined): boolean {
  return typeof title === "string" && PLACEHOLDER_TITLE.test(title)
}

const SELECT_ROW = "SELECT session_id, title, tags, status, workflow, account_id FROM workflow_session"

export class Store {
  private constructor(private db: Database) {}

  /** 打开/创建 <directory>/.opencode/session-mgmt.db（WAL 模式），并完成迁移。 */
  static open(directory: string): Store {
    mkdirSync(join(directory, ".opencode"), { recursive: true })
    const db = new Database(join(directory, ".opencode", "session-mgmt.db"), { create: true })
    db.exec("PRAGMA journal_mode = WAL;")
    const store = new Store(db)
    store.migrate()
    return store
  }

  /** 供测试使用：内存库。 */
  static memory(): Store {
    const db = new Database(":memory:")
    const store = new Store(db)
    store.migrate()
    return store
  }

  /** 仅当 <directory>/.opencode/session-mgmt.db 已存在时打开（不创建）；否则返回 null。供只读跨项目查看。 */
  static openIfExists(directory: string): Store | null {
    const path = join(directory, ".opencode", "session-mgmt.db")
    if (!existsSync(path)) return null
    // 只读打开（4.3 --project 只读语义）：readonly 既不在任意目录创建库，也不产生 WAL 写。
    // 不用 {create:false}：bun 1.3.14 下该组合退化为 open flags 0，抛 SQLITE_MISUSE；
    // 只读连接也无法执行迁移写入——本库 schema 由插件侧自管，读侧按现有结构直读即可。
    const db = new Database(path, { readonly: true })
    return new Store(db)
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
    const row = this.db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | null
    const current = row ? Number.parseInt(row.value, 10) : 0
    for (let version = current; version < MIGRATIONS.length; version++) {
      this.db.exec(MIGRATIONS[version]!)
    }
    this.db
      .query("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(SCHEMA_VERSION))
  }

  /** 取会话行；不存在返回 null。 */
  get(sessionID: string): WorkflowSessionRow | null {
    const raw = this.db.query(`${SELECT_ROW} WHERE session_id = ?`).get(sessionID) as
      | WorkflowSessionRaw
      | null
    return raw ? rowFromRaw(raw) : null
  }

  /** 取或创建会话行（创建时初始化全新 WorkflowState，7.4 规则 1）。 */
  ensure(sessionID: string): WorkflowSessionRow {
    const existing = this.get(sessionID)
    if (existing) return existing
    this.db
      .query("INSERT INTO workflow_session (session_id, title, tags, status, workflow, account_id) VALUES (?, NULL, '[]', NULL, ?, NULL)")
      .run(sessionID, JSON.stringify(createWorkflowState()))
    return this.get(sessionID)!
  }

  /** 深度合并更新工作流状态（4.3 增量合并语义），返回合并后的状态。 */
  updateWorkflow(sessionID: string, patch: DeepPartial<WorkflowState>): WorkflowState {
    const row = this.ensure(sessionID)
    const base = row.workflow ?? createWorkflowState()
    const next = deepMerge(base, patch)
    this.db.query("UPDATE workflow_session SET workflow = ? WHERE session_id = ?").run(
      JSON.stringify(next),
      sessionID,
    )
    return next
  }

  /**
   * 命令式读-改-写：取出工作流（确保存在），交给 fn 原地修改后整体写回，返回最新状态。
   * 用于阶段转换等涉及数组追加/计数的操作（deepMerge 对数组是整体替换，不适用）。
   */
  mutateWorkflow(sessionID: string, fn: (workflow: WorkflowState) => void): WorkflowState {
    const row = this.ensure(sessionID)
    const workflow = row.workflow ?? createWorkflowState()
    fn(workflow)
    this.db.query("UPDATE workflow_session SET workflow = ? WHERE session_id = ?").run(
      JSON.stringify(workflow),
      sessionID,
    )
    return workflow
  }

  /** 幂等打标：仅当 account_id 为空时写入，返回是否本次写入（3.1 快照语义）。 */
  stampAccount(sessionID: string, account: string): boolean {
    this.ensure(sessionID)
    const result = this.db
      .query("UPDATE workflow_session SET account_id = ? WHERE session_id = ? AND account_id IS NULL")
      .run(account, sessionID)
    return result.changes > 0
  }

  /** 写入会话标题（上游自动生成，插件经 SDK 同步）。仅当 title 非空时写入，空字符串不覆盖。 */
  setTitle(sessionID: string, title: string): void {
    if (!title) return
    this.db.query("UPDATE workflow_session SET title = ? WHERE session_id = ?").run(title, sessionID)
  }

  /** 批量回填标题：仅更新空标题或占位标题（New session - …），不覆盖已有真实标题（启动一次性回填，5.2）。 */
  backfillTitles(titles: ReadonlyMap<string, string>): void {
    const rows = this.db.query("SELECT session_id, title FROM workflow_session").all() as {
      session_id: string
      title: string | null
    }[]
    const current = new Map(rows.map((r) => [r.session_id, r.title]))
    const stmt = this.db.query("UPDATE workflow_session SET title = ? WHERE session_id = ?")
    for (const [id, title] of titles) {
      if (!title) continue
      const cur = current.get(id)
      // 只在当前为空或占位符（未同步）时覆盖；已有真实标题不动。
      if (cur !== undefined && cur !== null && cur !== "" && !isPlaceholderTitle(cur)) continue
      stmt.run(title, id)
    }
  }

  getTags(sessionID: string): string[] {
    return this.ensure(sessionID).tags
  }

  setTags(sessionID: string, tags: string[]): void {
    this.ensure(sessionID)
    this.db.query("UPDATE workflow_session SET tags = ? WHERE session_id = ?").run(
      JSON.stringify([...new Set(tags)]),
      sessionID,
    )
  }

  setStatus(sessionID: string, status: string | null): void {
    this.ensure(sessionID)
    this.db.query("UPDATE workflow_session SET status = ? WHERE session_id = ?").run(status, sessionID)
  }

  /** 列出所有会话行（供孤儿清理与项目级统计）。 */
  listAll(): WorkflowSessionRow[] {
    const rows = this.db.query(SELECT_ROW).all() as WorkflowSessionRaw[]
    return rows.map(rowFromRaw)
  }

  /** 删除孤儿会话（上游已删除者，3.1）。返回删除条数。 */
  removeSessions(sessionIDs: string[]): number {
    if (sessionIDs.length === 0) return 0
    const stmt = this.db.query("DELETE FROM workflow_session WHERE session_id = ?")
    let removed = 0
    for (const id of sessionIDs) {
      removed += stmt.run(id).changes
    }
    return removed
  }

  // ---- 汇报 outbox（收集服务不可用时的本地缓冲，2.4 风险与取舍） ----

  enqueueReport(report: SessionReport): void {
    // 同一会话仅保留最新一条待发送汇报（幂等去重，避免每消息堆积，2.4）
    this.db.query("DELETE FROM outbox WHERE session_id = ? AND sent = 0").run(report.sessionID)
    this.db
      .query("INSERT INTO outbox (session_id, payload, created_at, sent) VALUES (?, ?, ?, 0)")
      .run(report.sessionID, JSON.stringify(report), Date.now())
  }

  pendingReports(): OutboxRow[] {
    return this.db
      .query("SELECT id, payload, created_at, sent FROM outbox WHERE sent = 0 ORDER BY id ASC")
      .all() as OutboxRow[]
  }

  markSent(id: number): void {
    this.db.query("DELETE FROM outbox WHERE id = ?").run(id)
  }

  close(): void {
    this.db.close()
  }
}
