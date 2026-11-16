import { Database } from "bun:sqlite"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { stateDbPath } from "./paths"

/**
 * 插件自有状态（不碰上游库）：
 * - machine id：每台机器一个，用于分支命名 ocsync/<machine>
 * - hostname：最近一次确认的机器名，用来发现「电脑改名」并迁移分支
 * - repoId / salt：内容密钥派生参数（缓存在本地，避免无网时也要读远端）
 * - 消息指纹：用于增量写入（只写变化过的消息）
 */

/** 机器解析结果：`renamedFrom` 表示主机名变了，需要把旧分支迁到新名字。 */
export type MachineResolution = {
  machine: string
  hostname: string
  renamedFrom?: string
}
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

  /**
   * 解析本机用于分支命名的 machine id。
   *
   * 主机名变化时返回新的 machine id（沿用原随机后缀）并给出 renamedFrom，
   * 但不落库；调用方把远端分支改名成功后再 confirmMachine()，
   * 这样离线/改名失败时下次启动还能重试。
   */
  resolveMachine(hostname: string = osHostname()): MachineResolution {
    const existing = this.get("machine_id")
    if (!existing) {
      const machine = machineID(hostname)
      this.set("machine_id", machine)
      this.set("machine_hostname", hostname)
      return { machine, hostname }
    }

    const recorded = this.get("machine_hostname")
    if (recorded === hostname) return { machine: existing, hostname }

    if (recorded === undefined) {
      // 升级前的状态库没有记录主机名：旧 id 形如 <host>-<hex>，能解析才算改名。
      const inferred = inferHostname(existing)
      if (inferred && inferred !== hostname) {
        return { machine: machineID(hostname, machineSuffix(existing)), hostname, renamedFrom: existing }
      }
      this.set("machine_hostname", hostname)
      return { machine: existing, hostname }
    }

    return { machine: machineID(hostname, machineSuffix(existing)), hostname, renamedFrom: existing }
  }

  /** 确认改名完成：把新 machine id / 主机名落库，后续启动不再迁移。 */
  confirmMachine(machine: string, hostname: string) {
    this.set("machine_id", machine)
    this.set("machine_hostname", hostname)
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

/** 机器 id = 主机名 + 随机后缀；后缀跨改名保留，便于识别为同一台机器。 */
function machineID(hostname: string, suffix = crypto.randomBytes(3).toString("hex")): string {
  return `${hostname}-${suffix}`
}

/** 取出自动生成 id 的随机后缀（6 位小写十六进制）。 */
function machineSuffix(id: string): string | undefined {
  return /-([0-9a-f]{6})$/.exec(id)?.[1]
}

/** 从自动生成的 id 里还原主机名；不是该格式时返回 undefined。 */
function inferHostname(id: string): string | undefined {
  return /^(.+)-[0-9a-f]{6}$/.exec(id)?.[1]
}
