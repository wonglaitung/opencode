import fs from "node:fs"
import path from "node:path"
import { logPath, stateDir } from "./paths"

/**
 * 插件日志：写本地文件 + 关键级别同时输出到 stderr。
 * 上游要求外部调用静默化，因此默认级别为 warn。
 */
type Level = "debug" | "info" | "warn" | "error"

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

let threshold: number = LEVELS[process.env["OPENCODE_GIT_SYNC_LOG"] as Level] ?? LEVELS.warn

export function setLevel(level: Level) {
  threshold = LEVELS[level]
}

function write(level: Level, message: string) {
  if (LEVELS[level] < threshold) return
  const line = `${new Date().toISOString()} [${level}] ${message}`
  try {
    fs.mkdirSync(stateDir(), { recursive: true })
    fs.appendFileSync(logPath(), line + "\n")
  } catch {
    // ignore：日志失败不能影响主流程
  }
  if (level === "error" || level === "warn") console.error(`[git-sync] ${message}`)
}

export const log = {
  debug: (message: string) => write("debug", message),
  info: (message: string) => write("info", message),
  warn: (message: string) => write("warn", message),
  error: (message: string) => write("error", message),
}
