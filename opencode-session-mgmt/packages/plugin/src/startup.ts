/**
 * 启动一次性后台任务（3.1 孤儿清理、5.2 标题回填）。
 * 独立成模块以便单测——index.ts 受 legacy 加载器约束不得导出辅助函数。
 * 与主流程解耦：共用一次 session.list，同时完成 孤儿清理 + 存量标题回填，
 * 避免启动时重复全量拉取会话列表（启动慢根因之一）。
 */
import type { PluginInput } from "@opencode-ai/plugin"
import type { Store } from "./db"

/** 启动后台任务延后执行的毫秒数：错开 TUI 首屏会话列表与 daemon 启动竞态。 */
export const STARTUP_DELAY_MS = 2_000

/** 上游会话列表可见的最小形状（本模块仅取这三字段）。 */
interface ListedSession {
  id: string
  title?: string | null
  parentID?: string | null
}

/**
 * 孤儿清理（3.1）：仅主会话（无 parentID）入白名单；子代理与孤儿一并从插件库清理。
 * 返回清理条数。保守策略：空列表可能是上游瞬时不可达的退化结果，不清理，避免误删。
 */
export function cleanupOrphans(store: Store, sessions: readonly ListedSession[]): number {
  if (sessions.length === 0) return 0
  const valid = new Set(sessions.filter((s) => !s.parentID).map((s) => s.id))
  const orphans = store
    .listAll()
    .map((r) => r.session_id)
    .filter((id) => !valid.has(id))
  if (orphans.length > 0) store.removeSessions(orphans)
  return orphans.length
}

/** 存量会话标题回填（5.2）：仅补空标题或占位符（New session - …），不覆盖已有真实标题。返回回填条数。 */
export function backfillSessionTitles(store: Store, sessions: readonly ListedSession[]): number {
  const titles = new Map<string, string>()
  for (const s of sessions) if (s.title) titles.set(s.id, s.title)
  store.backfillTitles(titles)
  return titles.size
}

/** 启动一次性任务：拉一次会话列表，同时完成 孤儿清理 + 标题回填。上游不可达时静默跳过。 */
export async function deferredStartup(store: Store, client: PluginInput["client"]): Promise<void> {
  try {
    const res = await client.session.list()
    const sessions = res.data
    if (!sessions || sessions.length === 0) return
    cleanupOrphans(store, sessions)
    backfillSessionTitles(store, sessions)
  } catch {
    // 上游不可达：跳过本次清理与回填（不影响功能，消息时另有 syncSessionTitle 兜底）
  }
}
