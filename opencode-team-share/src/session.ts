/**
 * 会话与项目的读写。
 *
 * 读：session / message / part 三张表（口径对齐上游 `opencode import`，
 * 见 packages/opencode/src/cli/cmd/import.ts）。
 * 写：单事务；会话行的 project_id 取本机项目，directory/path 用本机值；
 *     已存在则更新标题与时间（接手方看到的是导出时刻的状态）。
 */
import type { Database } from "bun:sqlite"
import { relative } from "node:path"
import { TeamShareError } from "./errors"
import { createSlug, denormalize, normalize, type PathRules } from "./paths"
import type { HandoffFile, HandoffMessage, HandoffSession } from "./handoff"

export type ProjectRow = { id: string; worktree: string; name?: string }

export type SessionSummary = {
  id: string
  title: string
  messages: number
  updatedAt: number
  createdAt: number
  directory: string
  path?: string
  projectID: string
  project?: string
}

export type SessionSnapshot = {
  meta: HandoffSession
  messages: HandoffMessage[]
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || value.trim().length === 0) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

/** 本机已有的项目行（导入时的目标）。 */
export function listProjects(db: Database): ProjectRow[] {
  const rows = db.query("SELECT id, worktree, name FROM project ORDER BY worktree").all() as Array<{
    id: string
    worktree: string
    name?: string
  }>
  return rows.map((row) => ({ id: row.id, worktree: row.worktree, name: row.name }))
}

/** 可交接的会话列表（按最近更新倒序，排除已归档）。 */
export function listSessions(db: Database): SessionSummary[] {
  const rows = db
    .query(
      `SELECT s.id, s.title, s.directory, s.path, s.project_id, s.time_created, s.time_updated,
              p.worktree AS project_worktree,
              (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS message_count
         FROM session s
         LEFT JOIN project p ON p.id = s.project_id
        WHERE s.time_archived IS NULL
        ORDER BY s.time_updated DESC`,
    )
    .all() as Array<{
    id: string
    title: string
    directory: string
    path?: string
    project_id: string
    time_created: number
    time_updated: number
    project_worktree?: string
    message_count: number
  }>
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    messages: numberOr(row.message_count, 0),
    updatedAt: numberOr(row.time_updated, 0),
    createdAt: numberOr(row.time_created, 0),
    directory: row.directory,
    path: row.path ?? undefined,
    projectID: row.project_id,
    project: row.project_worktree ?? undefined,
  }))
}

/** 读一条会话的完整快照（meta + 全部消息与 part）。 */
export function readSession(db: Database, sessionID: string): SessionSnapshot | undefined {
  const row = db
    .query(
      `SELECT s.id, s.title, s.slug, s.parent_id, s.version, s.agent, s.model, s.directory, s.path,
              s.project_id, s.time_created, s.time_updated, s.cost,
              s.tokens_input, s.tokens_output, s.tokens_reasoning, s.tokens_cache_read, s.tokens_cache_write,
              s.summary_additions, s.summary_deletions, s.summary_files,
              p.worktree AS project_worktree
         FROM session s LEFT JOIN project p ON p.id = s.project_id
        WHERE s.id = ?`,
    )
    .get(sessionID) as
    | {
        id: string
        title: string
        slug?: string
        parent_id?: string
        version?: string
        agent?: string
        model?: string
        directory: string
        path?: string
        project_id: string
        time_created: number
        time_updated: number
        cost?: number
        tokens_input?: number
        tokens_output?: number
        tokens_reasoning?: number
        tokens_cache_read?: number
        tokens_cache_write?: number
        summary_additions?: number
        summary_deletions?: number
        summary_files?: number
        project_worktree?: string
      }
    | undefined
  if (!row) return undefined

  const messageRows = db
    .query(
      "SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = ? ORDER BY time_created, id",
    )
    .all(sessionID) as Array<{
    id: string
    session_id: string
    time_created: number
    time_updated: number
    data: string
  }>
  const partRows = db
    .query(
      "SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE session_id = ? ORDER BY time_created, id",
    )
    .all(sessionID) as Array<{
    id: string
    message_id: string
    session_id: string
    time_created: number
    time_updated: number
    data: string
  }>

  const partsByMessage = new Map<string, Record<string, unknown>[]>()
  for (const part of partRows) {
    const data = parseJson(part.data)
    if (!data || typeof data !== "object" || Array.isArray(data)) continue
    const list = partsByMessage.get(part.message_id) ?? []
    list.push({ ...(data as Record<string, unknown>), id: part.id, sessionID: part.session_id, messageID: part.message_id })
    partsByMessage.set(part.message_id, list)
  }

  const messages: HandoffMessage[] = messageRows.map((message) => {
    const data = parseJson(message.data)
    const info = (data && typeof data === "object" && !Array.isArray(data) ? data : {}) as Record<string, unknown>
    return {
      info: { ...info, id: message.id, sessionID: message.session_id },
      parts: partsByMessage.get(message.id) ?? [],
    }
  })

  const meta: HandoffSession = {
    id: row.id,
    title: row.title,
    slug: row.slug,
    parentID: row.parent_id,
    version: row.version,
    agent: row.agent,
    model: parseJson(row.model),
    directory: row.directory,
    path: row.path,
    projectID: row.project_id,
    time: { created: numberOr(row.time_created, Date.now()), updated: numberOr(row.time_updated, Date.now()) },
    cost: numberOr(row.cost, 0),
    tokens: {
      input: numberOr(row.tokens_input, 0),
      output: numberOr(row.tokens_output, 0),
      reasoning: numberOr(row.tokens_reasoning, 0),
      cacheRead: numberOr(row.tokens_cache_read, 0),
      cacheWrite: numberOr(row.tokens_cache_write, 0),
    },
    summary: {
      additions: numberOr(row.summary_additions, 0),
      deletions: numberOr(row.summary_deletions, 0),
      files: numberOr(row.summary_files, 0),
    },
  }
  return { meta, messages }
}

/**
 * 导出的归一化规则：工作区根取项目行的 worktree，目录取会话目录。
 * 非 git 项目（global）的 worktree 是盘符根（"/" 或 "C:/"），不能拿来做替换，退化为会话目录。
 */
export function exportRules(meta: HandoffSession, projectWorktree?: string): PathRules {
  const worktree = projectWorktree && projectWorktree.length >= 4 ? projectWorktree : meta.directory
  return { worktree, directory: meta.directory }
}

/** 把消息与 part 里的绝对路径换成占位符。 */
export function normalizeMessages(messages: HandoffMessage[], rules: PathRules): HandoffMessage[] {
  return messages.map((message) => ({
    info: normalize(message.info, rules) as Record<string, unknown>,
    parts: message.parts.map((part) => normalize(part, rules) as Record<string, unknown>),
  }))
}

/** 把占位符换成本机路径。 */
export function denormalizeMessages(messages: HandoffMessage[], rules: PathRules): HandoffMessage[] {
  return messages.map((message) => ({
    info: denormalize(message.info, rules) as Record<string, unknown>,
    parts: message.parts.map((part) => denormalize(part, rules) as Record<string, unknown>),
  }))
}

/** 导出成交接文件：读会话 → 路径归一化 → 组装 manifest。 */
export function exportHandoff(
  db: Database,
  sessionID: string,
  note: string,
  by: { user: string; machine: string },
): HandoffFile {
  const snapshot = readSession(db, sessionID)
  if (!snapshot) throw new TeamShareError(`找不到会话 ${sessionID}`)
  const project = db.query("SELECT worktree FROM project WHERE id = ?").get(snapshot.meta.projectID ?? "") as
    | { worktree?: string }
    | undefined
  const rules = exportRules(snapshot.meta, project?.worktree)
  return {
    format: "ocshare/1",
    exportedAt: Date.now(),
    exportedBy: by,
    note,
    // meta 里的绝对路径同样要归一化（directory 必换，标题里出现的路径也应一起换）
    session: normalize(snapshot.meta, rules) as HandoffSession,
    messages: normalizeMessages(snapshot.messages, rules),
  }
}

export type ImportScope = {
  /** 本机目标项目 id（project 表主键）。 */
  projectID: string
  /** 本机目标项目的工作区根（还原路径用）。 */
  worktree: string
  /** 本机目标目录（会话落在这里）。 */
  directory: string
}

/**
 * 把交接文件导入本机库。
 * 返回导入结果；会话已存在时按 id 更新，不产生重复会话。
 */
export function importSession(
  db: Database,
  file: HandoffFile,
  scope: ImportScope,
): { sessionID: string; title: string; messages: number; created: boolean } {
  const project = db.query("SELECT id FROM project WHERE id = ?").get(scope.projectID)
  if (!project) {
    throw new TeamShareError(
      `目标项目不存在（project id=${scope.projectID}）。请先在本机用该项目打开一次 opencode。`,
    )
  }

  const rules: PathRules = { worktree: scope.worktree, directory: scope.directory }
  const messages = denormalizeMessages(file.messages, rules)
  const session = file.session
  const existing = db.query("SELECT id FROM session WHERE id = ?").get(session.id)
  const created = !existing

  const sessionValues = {
    id: session.id,
    project_id: scope.projectID,
    parent_id: session.parentID ?? null,
    slug: session.slug ?? createSlug(),
    directory: scope.directory,
    path: session.path ?? relative(scope.worktree, scope.directory).replaceAll("\\", "/"),
    title: session.title,
    version: session.version ?? "unknown",
    agent: session.agent ?? null,
    model: session.model === undefined ? null : JSON.stringify(session.model),
    cost: numberOr(session.cost, 0),
    tokens_input: numberOr(session.tokens?.input, 0),
    tokens_output: numberOr(session.tokens?.output, 0),
    tokens_reasoning: numberOr(session.tokens?.reasoning, 0),
    tokens_cache_read: numberOr(session.tokens?.cacheRead, 0),
    tokens_cache_write: numberOr(session.tokens?.cacheWrite, 0),
    summary_additions: numberOr(session.summary?.additions, 0),
    summary_deletions: numberOr(session.summary?.deletions, 0),
    summary_files: numberOr(session.summary?.files, 0),
    time_created: session.time.created,
    time_updated: session.time.updated,
  }

  const run = db.transaction(() => {
    if (existing) {
      db.query(
        `UPDATE session SET project_id = ?, directory = ?, path = ?, title = ?, agent = ?, model = ?,
                            cost = ?, tokens_input = ?, tokens_output = ?, tokens_reasoning = ?,
                            tokens_cache_read = ?, tokens_cache_write = ?,
                            summary_additions = ?, summary_deletions = ?, summary_files = ?,
                            time_updated = ?
          WHERE id = ?`,
      ).run(
        sessionValues.project_id,
        sessionValues.directory,
        sessionValues.path,
        sessionValues.title,
        sessionValues.agent,
        sessionValues.model,
        sessionValues.cost,
        sessionValues.tokens_input,
        sessionValues.tokens_output,
        sessionValues.tokens_reasoning,
        sessionValues.tokens_cache_read,
        sessionValues.tokens_cache_write,
        sessionValues.summary_additions,
        sessionValues.summary_deletions,
        sessionValues.summary_files,
        sessionValues.time_updated,
        session.id,
      )
    } else {
      db.query(
        `INSERT INTO session (id, project_id, parent_id, slug, directory, path, title, version, agent, model,
                              cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
                              summary_additions, summary_deletions, summary_files, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sessionValues.id,
        sessionValues.project_id,
        sessionValues.parent_id,
        sessionValues.slug,
        sessionValues.directory,
        sessionValues.path,
        sessionValues.title,
        sessionValues.version,
        sessionValues.agent,
        sessionValues.model,
        sessionValues.cost,
        sessionValues.tokens_input,
        sessionValues.tokens_output,
        sessionValues.tokens_reasoning,
        sessionValues.tokens_cache_read,
        sessionValues.tokens_cache_write,
        sessionValues.summary_additions,
        sessionValues.summary_deletions,
        sessionValues.summary_files,
        sessionValues.time_created,
        sessionValues.time_updated,
      )
    }

    for (const message of messages) {
      const { id, sessionID: _sessionID, ...info } = message.info as { id?: string } & Record<string, unknown>
      if (!id) continue
      db.query(
        `INSERT INTO message (id, session_id, time_created, time_updated, data)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, time_updated = excluded.time_updated`,
      ).run(
        id,
        session.id,
        numberOr((message.info["time"] as { created?: number } | undefined)?.created, Date.now()),
        numberOr((message.info["time"] as { updated?: number } | undefined)?.updated, Date.now()),
        JSON.stringify(info),
      )
      for (const part of message.parts) {
        const { id: partID, sessionID: _s, messageID: _m, ...partData } = part as { id?: string } & Record<string, unknown>
        if (!partID) continue
        db.query(
          `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET data = excluded.data, time_updated = excluded.time_updated`,
        ).run(
          partID,
          id,
          session.id,
          numberOr((part["time"] as { created?: number } | undefined)?.created, Date.now()),
          numberOr((part["time"] as { updated?: number } | undefined)?.updated, Date.now()),
          JSON.stringify(partData),
        )
      }
    }
  })

  run()
  return { sessionID: session.id, title: session.title, messages: messages.length, created }
}
