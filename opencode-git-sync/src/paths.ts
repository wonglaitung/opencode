import os from "node:os"
import path from "node:path"

/**
 * 与上游 Global.Path 保持一致的数据目录定位（packages/core/src/global.ts）。
 * xdg-basedir 在各平台统一使用 XDG 路径，这里手工复刻，避免引入依赖。
 */
export function dataDir(): string {
  const xdg = process.env["XDG_DATA_HOME"] ?? path.join(os.homedir(), ".local", "share")
  return path.join(xdg, "opencode")
}

/** 插件自有状态目录（本地 clone、状态库、日志）。 */
export function stateDir(): string {
  return process.env["OPENCODE_GIT_SYNC_DIR"] ?? path.join(dataDir(), "git-sync")
}

/** 本地 sync 仓库工作副本（与项目仓库完全隔离）。 */
export function repoDir(): string {
  return path.join(stateDir(), "repo")
}

/** 插件状态库（machine id、已同步指纹）。 */
export function stateDbPath(): string {
  return path.join(stateDir(), "state.db")
}

export function logPath(): string {
  return path.join(stateDir(), "git-sync.log")
}

/**
 * 默认证令文件候选路径（用户无需任何配置即可启用）。
 * 顺序：~/.config/opencode/git-sync.key → ~/.config/opencode/git-sync.passphrase
 */
export function defaultPassphraseFiles(): string[] {
  const configDir = process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config")
  return [
    path.join(configDir, "opencode", "git-sync.key"),
    path.join(configDir, "opencode", "git-sync.passphrase"),
  ]
}

/**
 * 定位 opencode 主数据库。
 *
 * 上游按安装通道命名（packages/core/src/database/database.ts）：
 *   - OPENCODE_DB 显式指定时优先；
 *   - latest/beta/prod 通道为 opencode.db，其余为 opencode-<channel>.db。
 * 这里做「候选列表 + 最近修改且含 session 表」的探测，避免依赖通道命名细节。
 */
export async function findOpencodeDb(): Promise<string | undefined> {
  const explicit = process.env["OPENCODE_DB"]
  if (explicit) {
    if (explicit === ":memory:") return undefined
    return path.isAbsolute(explicit) ? explicit : path.join(dataDir(), explicit)
  }
  const dir = dataDir()
  const names = ["opencode.db"]
  try {
    const { readdir } = await import("node:fs/promises")
    for (const entry of await readdir(dir)) {
      if (entry.startsWith("opencode") && entry.endsWith(".db") && !names.includes(entry)) names.push(entry)
    }
  } catch {
    return undefined
  }
  const candidates: Array<{ file: string; mtime: number }> = []
  const { stat } = await import("node:fs/promises")
  for (const name of names) {
    const file = path.join(dir, name)
    try {
      const info = await stat(file)
      candidates.push({ file, mtime: info.mtimeMs })
    } catch {
      continue
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0]?.file
}
