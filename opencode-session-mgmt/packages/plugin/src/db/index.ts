/**
 * 插件 SQLite 初始化与迁移（设计文档 §3.1）。
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

const SELECT_ROW = "SELECT session_id, tags, status, workflow, account_id FROM workflow_session"

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
    const db = new Database(path, { create: false })
    db.exec("PRAGMA journal_mode = WAL;")
    const store = new Store(db)
    store.migrate()
    return store
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

  /** 取或创建会话行（创建时初始化全新 WorkflowState，§7.4 规则 1）。 */
  ensure(sessionID: string): WorkflowSessionRow {
    const existing = this.get(sessionID)
    if (existing) return existing
    this.db
      .query("INSERT INTO workflow_session (session_id, tags, status, workflow, account_id) VALUES (?, '[]', NULL, ?, NULL)")
      .run(sessionID, JSON.stringify(createWorkflowState()))
    return this.get(sessionID)!
  }

  /** 深度合并更新工作流状态（§4.3 增量合并语义），返回合并后的状态。 */
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

  /** 幂等打标：仅当 account_id 为空时写入，返回是否本次写入（§3.1 快照语义）。 */
  stampAccount(sessionID: string, account: string): boolean {
    this.ensure(sessionID)
    const result = this.db
      .query("UPDATE workflow_session SET account_id = ? WHERE session_id = ? AND account_id IS NULL")
      .run(account, sessionID)
    return result.changes > 0
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

  /** 删除孤儿会话（上游已删除者，§3.1）。返回删除条数。 */
  removeSessions(sessionIDs: string[]): number {
    if (sessionIDs.length === 0) return 0
    const stmt = this.db.query("DELETE FROM workflow_session WHERE session_id = ?")
    let removed = 0
    for (const id of sessionIDs) {
      removed += stmt.run(id).changes
    }
    return removed
  }

  // ---- 汇报 outbox（收集服务不可用时的本地缓冲，§2.4 风险与取舍） ----

  enqueueReport(report: SessionReport): void {
    // 同一会话仅保留最新一条待发送汇报（幂等去重，避免每消息堆积，§2.4）
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
