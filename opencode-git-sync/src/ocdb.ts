import { Database } from "bun:sqlite"
import type { MessageInfo, PartInfo } from "./types"
import type { SessionMeta } from "./payload"

/**
 * 直接读写 opencode 主数据库（session / message / part 三张表）。
 *
 * 说明：这是「不动上游」前提下唯一能实现「跨机导入历史」的通道，
 * 写入口径对齐上游 `opencode import`（packages/opencode/src/cli/cmd/import.ts）：
 *   - session 行补齐本地 project_id / directory / path（跨机身份）；
 *   - message.data 去掉 id / sessionID，part.data 去掉 id / sessionID / messageID。
 *
 * 列名按当前表结构动态取交集，避免上游 schema 演进出错。
 */

export type LocalSessionScope = { projectID: string; directory: string; path: string }

/** sqlite 绑定值。 */
type BindValue = string | number | null

export class OpencodeDb {
  private db: Database
  private sessionColumns = new Set<string>()
  private messageColumns = new Set<string>()
  private partColumns = new Set<string>()

  constructor(file: string) {
    // 注意：bun 1.3.x 下 { create: false } 会抛 SQLITE_MISUSE，这里用默认只读存在性由调用方保证。
    this.db = new Database(file)
    this.db.run("PRAGMA busy_timeout = 5000;")
    this.sessionColumns = this.columns("session")
    this.messageColumns = this.columns("message")
    this.partColumns = this.columns("part")
  }

  private columns(table: string): Set<string> {
    try {
      const rows = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      return new Set(rows.map((row) => row.name))
    } catch {
      return new Set()
    }
  }

  hasSession(sessionID: string): boolean {
    const row = this.db.query("SELECT id FROM session WHERE id = ?").get(sessionID)
    return row !== null && row !== undefined
  }

  sessionUpdatedAt(sessionID: string): number | undefined {
    const row = this.db.query("SELECT time_updated FROM session WHERE id = ?").get(sessionID) as
      | { time_updated?: number }
      | null
    return typeof row?.time_updated === "number" ? row.time_updated : undefined
  }

  /**
   * 写入（或更新）会话元信息。
   * 返回 true 表示数据库内容发生了变化（用于触发前端列表刷新）。
   */
  upsertSession(meta: SessionMeta, scope: LocalSessionScope): boolean {
    const existing = this.db.query("SELECT time_updated, title FROM session WHERE id = ?").get(meta.id) as
      | { time_updated?: number; title?: string }
      | null
    const localUpdated = typeof existing?.time_updated === "number" ? existing.time_updated : undefined
    const remoteUpdated = meta.time.updated
    if (existing && localUpdated !== undefined && remoteUpdated <= localUpdated) return false

    const row: Record<string, unknown> = {
      id: meta.id,
      project_id: scope.projectID,
      directory: scope.directory,
      path: scope.path,
      title: meta.title,
      slug: meta.slug ?? slugFallback(meta.id),
      version: meta.version ?? "unknown",
      parent_id: meta.parentID ?? null,
      time_created: meta.time.created,
      time_updated: remoteUpdated,
    }
    if (meta.agent !== undefined) row["agent"] = meta.agent
    if (meta.model !== undefined) row["model"] = JSON.stringify(meta.model)
    if (meta.cost !== undefined) row["cost"] = meta.cost
    if (meta.summary !== undefined) row["summary_additions"] = numberField(meta.summary, "additions")
    if (meta.tokens !== undefined) {
      row["tokens_input"] = numberField(meta.tokens, "input")
      row["tokens_output"] = numberField(meta.tokens, "output")
      row["tokens_reasoning"] = numberField(meta.tokens, "reasoning")
    }

    if (!existing) {
      const columns = Object.keys(row).filter((key) => this.sessionColumns.size === 0 || this.sessionColumns.has(key))
      const sql = `INSERT OR IGNORE INTO session (${columns.join(", ")}) VALUES (${columns
        .map((column) => `$${column}`)
        .join(", ")})`
      this.db.run(
        sql,
        columns.map((column) => (row[column] ?? null) as BindValue),
      )
      return true
    }

    // 已存在：只更新「远端拥有」的字段，本地身份字段保持不变。
    const updatable: Record<string, unknown> = {
      title: meta.title,
      time_updated: remoteUpdated,
    }
    if (meta.agent !== undefined) updatable["agent"] = meta.agent
    if (meta.model !== undefined) updatable["model"] = JSON.stringify(meta.model)
    const columns = Object.keys(updatable).filter((key) => this.sessionColumns.has(key))
    if (columns.length === 0) return false
    this.db.run(
      `UPDATE session SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`,
      [...columns.map((column) => updatable[column] as BindValue), meta.id],
    )
    return true
  }

  /** 写入一条消息及其 parts；内容有变化时覆盖。 */
  upsertMessage(sessionID: string, info: MessageInfo, parts: PartInfo[]): boolean {
    const { id: messageID, sessionID: _sessionID, ...messageData } = info
    const timeCreated = typeof info.time?.created === "number" ? info.time.created : Date.now()
    const data = JSON.stringify(messageData)
    const existing = this.db.query("SELECT data FROM message WHERE id = ?").get(messageID) as
      | { data?: string }
      | null
    const changed = !existing || existing.data !== data

    if (!existing) {
      const columns = ["id", "session_id", "time_created", "time_updated", "data"].filter(
        (column) => this.messageColumns.size === 0 || this.messageColumns.has(column),
      )
      this.db.run(
        `INSERT OR IGNORE INTO message (${columns.join(", ")}) VALUES (${columns.map((c) => `$${c}`).join(", ")})`,
        columns.map((column) =>
          (
            column === "id"
              ? messageID
              : column === "session_id"
                ? sessionID
                : column === "time_created"
                  ? timeCreated
                  : column === "time_updated"
                    ? timeCreated
                    : data
          ) as BindValue,
        ),
      )
    } else if (changed) {
      this.db.run("UPDATE message SET data = ?, time_updated = ? WHERE id = ?", [data, Date.now(), messageID])
    }

    let partsChanged = false
    for (const part of parts) {
      const { id: partID, sessionID: _s, messageID: _m, ...partData } = part
      const partJson = JSON.stringify(partData)
      const existingPart = this.db.query("SELECT data FROM part WHERE id = ?").get(partID) as { data?: string } | null
      if (!existingPart) {
        const columns = ["id", "message_id", "session_id", "time_created", "time_updated", "data"].filter(
          (column) => this.partColumns.size === 0 || this.partColumns.has(column),
        )
        this.db.run(
          `INSERT OR IGNORE INTO part (${columns.join(", ")}) VALUES (${columns.map((c) => `$${c}`).join(", ")})`,
          columns.map((column) =>
            (
              column === "id"
                ? partID
                : column === "message_id"
                  ? messageID
                  : column === "session_id"
                    ? sessionID
                    : column === "time_created"
                      ? timeCreated
                      : column === "time_updated"
                        ? timeCreated
                        : partJson
            ) as BindValue,
          ),
        )
        partsChanged = true
      } else if (existingPart.data !== partJson) {
        this.db.run("UPDATE part SET data = ?, time_updated = ? WHERE id = ?", [partJson, Date.now(), partID])
        partsChanged = true
      }
    }
    return changed || partsChanged
  }

  close() {
    try {
      this.db.close()
    } catch {
      // ignore
    }
  }
}

function slugFallback(sessionID: string): string {
  return sessionID.slice(-8)
}

function numberField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === "number" ? field : undefined
}
