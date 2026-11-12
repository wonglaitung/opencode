import { Database } from "bun:sqlite"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { stateDbPath } from "./paths"

/**
 * 插件自有状态（不碰上游库）：
 * - machine id：每台机器一个，用于分支命名 ocsync/<machine>
 * - repoId / salt：内容密钥派生参数（缓存在本地，避免无网时也要读远端）
 * - 消息指纹：用于增量写入（只写变化过的消息）
 */
export class State {
  private db: Database
  /** 状态库路径（排查用）。 */
  readonly dbPath: string

  constructor(file: string = stateDbPath()) {
    this.dbPath = file
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new Database(file, { create: true })
    this.db.run("PRAGMA journal_mode = WAL;")
    this.db.run("PRAGMA busy_timeout = 5000;")
    this.db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
    this.db.run(
      `CREATE TABLE IF NOT EXISTS message_fingerprint (session_id TEXT NOT NULL, message_id TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (session_id, message_id));`,
    )
    this.db.run(`CREATE TABLE IF NOT EXISTS session_fingerprint (session_id TEXT PRIMARY KEY, hash TEXT NOT NULL);`)
  }

  private get(key: string): string | undefined {
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value?: string } | null
    return row?.value
  }

  private set(key: string, value: string) {
    this.db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      key,
      value,
    )
  }

  /** 机器标识（首次调用时生成并持久化）。 */
  machineID(): string {
    const existing = this.get("machine_id")
    if (existing) return existing
    const generated = `${osHostname()}-${crypto.randomBytes(3).toString("hex")}`
    this.set("machine_id", generated)
    return generated
  }

  repoId(): string | undefined {
    return this.get("repo_id")
  }

  setRepoId(value: string) {
    this.set("repo_id", value)
  }

  salt(): string | undefined {
    return this.get("salt")
  }

  setSalt(value: string) {
    this.set("salt", value)
  }

  lastSyncAt(): number | undefined {
    const value = this.get("last_sync_at")
    return value ? Number(value) : undefined
  }

  setLastSyncAt(value: number) {
    this.set("last_sync_at", String(value))
  }

  messageHash(sessionID: string, messageID: string): string | undefined {
    const row = this.db
      .query("SELECT hash FROM message_fingerprint WHERE session_id = ? AND message_id = ?")
      .get(sessionID, messageID) as { hash?: string } | null
    return row?.hash
  }

  setMessageHash(sessionID: string, messageID: string, hash: string) {
    this.db
      .query(
        "INSERT INTO message_fingerprint (session_id, message_id, hash) VALUES (?, ?, ?) ON CONFLICT(session_id, message_id) DO UPDATE SET hash = excluded.hash",
      )
      .run(sessionID, messageID, hash)
  }

  sessionHash(sessionID: string): string | undefined {
    const row = this.db.query("SELECT hash FROM session_fingerprint WHERE session_id = ?").get(sessionID) as
      | { hash?: string }
      | null
    return row?.hash
  }

  setSessionHash(sessionID: string, hash: string) {
    this.db
      .query(
        "INSERT INTO session_fingerprint (session_id, hash) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET hash = excluded.hash",
      )
      .run(sessionID, hash)
  }

  close() {
    try {
      this.db.close()
    } catch {
      // ignore
    }
  }
}

function osHostname(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("node:os").hostname().split(".")[0] ?? "machine"
  } catch {
    return "machine"
  }
}
