/**
 * 定位并打开 opencode 的主数据库。
 *
 * 路径规则与上游一致（packages/core/src/global.ts + database.ts）：
 * - 数据目录 = XDG_DATA_HOME || ~/.local/share，再拼 opencode；
 * - 库名 = opencode.db（非 latest/beta/prod 通道会用 opencode-<channel>.db）。
 * 这里不依赖通道命名细节：候选列表按最近修改排序，取第一个能读到 session 表的。
 */
import { Database } from "bun:sqlite"
import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { TeamShareError } from "./errors"

/** opencode 的数据目录。 */
export function dataDir(): string {
  const xdg = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share")
  return join(xdg, "opencode")
}

/**
 * 候选库文件（按优先级）：
 * 1. 显式 OPENCODE_DB；
 * 2. opencode.db —— 发布通道（latest/beta/prod）的库，启动器装的正是这个通道；
 * 3. 其它 opencode*.db（如 opencode-dev.db）按最近修改倒序兜底。
 *
 * 不能只按 mtime 排序：打开数据库会更新 mtime，导出与导入分两次调用时可能选中不同的库。
 */
export function dbCandidates(): string[] {
  const explicit = process.env["OPENCODE_DB"]
  if (explicit) {
    if (explicit === ":memory:") return []
    return [isAbsolute(explicit) ? explicit : join(dataDir(), explicit)]
  }
  const dir = dataDir()
  const preferred = join(dir, "opencode.db")
  let others: string[] = []
  try {
    others = readdirSync(dir)
      .filter((name) => name.startsWith("opencode") && name.endsWith(".db") && name !== "opencode.db")
      .map((name) => join(dir, name))
      .sort((a, b) => {
        try {
          return statSync(b).mtimeMs - statSync(a).mtimeMs
        } catch {
          return 0
        }
      })
  } catch {
    // 数据目录还不存在（opencode 还没跑过）→ 下面按「找不到」处理。
  }
  return [preferred, ...others].filter((file) => existsSync(file))
}

/** 表是否存在。 */
export function tableExists(db: Database, name: string): boolean {
  try {
    const row = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name)
    return row !== null && row !== undefined
  } catch {
    return false
  }
}

/** 定位可用的库文件；找不到时抛出可读错误。显式传 path 时只用它。 */
export function resolveDbPath(explicit?: string): string {
  const candidates = explicit ? [explicit] : dbCandidates()
  if (candidates.length === 0) {
    throw new TeamShareError(
      `找不到 opencode 数据库（尝试过 ${dataDir()}）。请先打开一次 opencode 再试。`,
    )
  }
  const problems: string[] = []
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      problems.push(`${candidate}：文件不存在`)
      continue
    }
    let db: Database | undefined
    try {
      // 只读探测：避免打开动作更新 mtime，进而影响后续选择。
      db = new Database(candidate, { readonly: true })
      if (tableExists(db, "session")) return candidate
      problems.push(`${candidate}：没有 session 表`)
    } catch (error) {
      problems.push(`${candidate}：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      db?.close()
    }
  }
  throw new TeamShareError(`找不到可用的 opencode 数据库：${problems.join("；")}`)
}

/** 打开数据库；只读命令用 readonly，避免无谓的 WAL 检查点。 */
export function openDb(path: string, options: { readonly?: boolean } = {}): Database {
  try {
    return options.readonly ? new Database(path, { readonly: true }) : new Database(path)
  } catch (error) {
    throw new TeamShareError(
      `无法打开数据库 ${path}：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** 写库前备份：同目录 .bak-<时间戳>，返回备份路径。 */
export function backupDb(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backup = `${path}.bak-${stamp}`
  try {
    copyFileSync(path, backup)
  } catch (error) {
    throw new TeamShareError(
      `备份数据库失败（${path}）：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return backup
}
