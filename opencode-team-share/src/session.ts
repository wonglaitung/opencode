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
import { newId } from "./ids"
import { createSlug, denormalize, normalize, usableWorktree, type PathRules } from "./paths"
import type { HandoffFile, HandoffMessage, HandoffSession, HandoffWorkflow } from "./handoff"

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
  // 内置 global 项目的 worktree 是文件系统根：导入目标落在这里会把会话写到盘符根，
  // 而且启动器只能显示一个 "/"，所以不作为可导入项目列出。
  return rows
    .filter((row) => usableWorktree(row.worktree) !== undefined)
    .map((row) => ({ id: row.id, worktree: row.worktree, name: row.name }))
}

/** 可交接的会话列表（默认只列主会话，按最近更新倒序，排除已归档）。 */
export type SessionSort = "updated" | "created" | "messages"

export type ListSessionsOptions = {
  /** 标题/目录关键词（大小写不敏感） */
  search?: string
  /** 只看某个项目 */
  projectID?: string
  /** 只列该时刻之后更新过的会话（epoch ms） */
  since?: number
  /** 默认 false：task 子代理会为每次分派建一条子会话，混进列表会让主会话找不着 */
  includeChildren?: boolean
  sort?: SessionSort
  /** 每页条数，默认 50；上限 200 */
  limit?: number
  /** 上一页返回的 nextCursor（客户端不解析） */
  cursor?: string
}

export type SessionPage = {
  items: SessionSummary[]
  /** 还有下一页时给出；直接回传给 list-sessions --cursor */
  nextCursor?: string
  /** 当前筛选条件下的总数（不受分页影响） */
  total: number
}

const SORT_COLUMN: Record<SessionSort, string> = {
  updated: "time_updated",
  created: "time_created",
  messages: "message_count",
}

/** LIKE 里的通配符要转义，否则搜 `%` 会匹配全部。 */
function likeTerm(value: string): string {
  return `%${value.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
}

/**
 * 会话分页查询。
 *
 * 为什么不是「全量返回 + 前端过滤」：本机 230 条时后端只要 15ms，但传输与 DOM 是线性的——
 * 5000 条就是约 1.4MB JSON + 2 万个节点，而且每次输入/点选都重建整表。这里把「筛选 +
 * 分页」下推到 SQL，前端只拿一页。
 *
 * 消息数用**相关子查询**而不是 JOIN+GROUP BY：message 表很大（本机库 18GB），
 * 按页聚合 50 行实测 14–22ms，而相关子查询只对输出行求值，约 1ms。
 */
export function listSessions(db: Database, options: ListSessionsOptions = {}): SessionPage {
  const limit = Math.min(Math.max(Number(options.limit ?? 50) || 50, 1), 200)
  const sort: SessionSort = options.sort === "created" || options.sort === "messages" ? options.sort : "updated"
  const cursor = options.cursor ? decodeCursor(options.cursor) : undefined

  const where: string[] = ["s.time_archived IS NULL"]
  const params: Array<string | number> = []
  if (!options.includeChildren) where.push("s.parent_id IS NULL")
  if (options.projectID) {
    where.push("s.project_id = ?")
    params.push(options.projectID)
  }
  if (options.since !== undefined) {
    where.push("s.time_updated >= ?")
    params.push(options.since)
  }
  if (options.search && options.search.trim() !== "") {
    where.push("(s.title LIKE ? ESCAPE '\\' OR s.directory LIKE ? ESCAPE '\\')")
    const term = likeTerm(options.search.trim())
    params.push(term, term)
  }

  const total = numberOr(
    (
      db
        .query(`SELECT COUNT(*) AS n FROM session s WHERE ${where.join(" AND ")}`)
        .get(...params) as { n?: number } | null
    )?.n,
    0,
  )

  const select = `SELECT s.id, s.title, s.directory, s.path, s.project_id, s.time_created, s.time_updated,
            p.worktree AS project_worktree,
            (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS message_count
       FROM session s
       LEFT JOIN project p ON p.id = s.project_id
      WHERE ${where.join(" AND ")}`
  // 外层把子查询包成 t，排序与游标都必须用 t.*（用 s.* 会 "no such column"）
  const order = `t.${SORT_COLUMN[sort]} DESC, t.id DESC`

  // 游标条件与排序键同列同向：翻页期间新增/更新的会话不会把已看过的行挤回来。
  let pageWhere = ""
  const pageParams: Array<string | number> = []
  if (cursor) {
    const column = SORT_COLUMN[sort]
    pageWhere = ` WHERE (t.${column} < ? OR (t.${column} = ? AND t.id < ?))`
    pageParams.push(cursor.value, cursor.value, cursor.id)
  }

  const rows = db
    .query(`SELECT * FROM (${select}) t${pageWhere} ORDER BY ${order} LIMIT ?`)
    .all(...params, ...pageParams, limit) as Array<{
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

  const items = rows.map((row) => ({
    id: row.id,
    title: row.title,
    messages: numberOr(row.message_count, 0),
    updatedAt: numberOr(row.time_updated, 0),
    createdAt: numberOr(row.time_created, 0),
    directory: row.directory,
    path: row.path ?? undefined,
    projectID: row.project_id,
    // 非 git 会话的 project_worktree 是 "/" 或 "C:/"：显示会话真实目录，否则启动器只能显示 "/"
    project: usableWorktree(row.project_worktree) ?? row.directory,
  }))

  const last = rows.at(-1)
  return {
    items,
    total,
    nextCursor:
      rows.length === limit && last
        ? encodeCursor({
            value:
              sort === "messages"
                ? numberOr(last.message_count, 0)
                : numberOr(last[sort === "created" ? "time_created" : "time_updated"], 0),
            id: last.id,
          })
        : undefined,
  }
}

function encodeCursor(cursor: { value: number; id: string }): string {
  return `${cursor.value}:${cursor.id}`
}

function decodeCursor(raw: string): { value: number; id: string } | undefined {
  const index = raw.indexOf(":")
  if (index <= 0) return undefined
  const value = Number(raw.slice(0, index))
  const id = raw.slice(index + 1)
  if (!Number.isFinite(value) || id === "") return undefined
  return { value, id }
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
  const worktree = usableWorktree(projectWorktree) ?? meta.directory
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

/** 会话所属项目的工作区根（用于路径归一化与工作流状态定位）。 */
export function sessionWorktree(db: Database, sessionID: string): string | undefined {
  const row = db
    .query(
      `SELECT p.worktree AS worktree, s.directory AS directory
         FROM session s LEFT JOIN project p ON p.id = s.project_id WHERE s.id = ?`,
    )
    .get(sessionID) as { worktree?: string; directory?: string } | undefined
  // global 项目的 worktree 是 "/"，工作流状态必须按会话目录找
  return usableWorktree(row?.worktree) ?? row?.directory
}

/** 导出成交接文件：读会话 → 路径归一化 → 组装 manifest。 */
export function exportHandoff(
  db: Database,
  sessionID: string,
  note: string,
  by: { user: string; machine: string },
  workflow?: HandoffWorkflow,
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
    ...(workflow
      ? {
          workflow: {
            state: normalize(workflow.state, rules) as Record<string, unknown>,
            tags: workflow.tags,
            status: workflow.status,
          },
        }
      : {}),
  }
}

/** 导入会话的标题前缀：一眼看出是交接来的，便于在会话列表里找到。 */
export const HANDOFF_TITLE_PREFIX = "[交接] "

/** 加前缀（幂等：已有前缀不再重复加）。 */
export function withHandoffPrefix(title: string): string {
  return title.startsWith(HANDOFF_TITLE_PREFIX) ? title : `${HANDOFF_TITLE_PREFIX}${title}`
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
export type ImportMode = "handoff" | "reference"

/** 参考副本的标题前缀，与「接手继续」区分开。 */
export const REFERENCE_TITLE_PREFIX = "[参考] "

export function withReferencePrefix(title: string): string {
  return title.startsWith(REFERENCE_TITLE_PREFIX) ? title : `${REFERENCE_TITLE_PREFIX}${title}`
}

export type ImportResult = {
  sessionID: string
  title: string
  messages: number
  created: boolean
  mode: ImportMode
}

/**
 * 把交接文件导入本机库。
 *
 * - `handoff`（默认）：接手继续做。保留原会话 ID，写回工作流状态（由调用方完成）。
 * - `reference`：仅参考。复制成**新会话**（新 session/msg/part id）、清 parentID、
 *   不带成本与 Token 统计、标题加 `[参考]`。目的是不与发送方共享主键，
 *   避免收集端按 sessionID upsert 时把发送方的工作量改写成本机归属。
 */
export function importSession(
  db: Database,
  file: HandoffFile,
  scope: ImportScope,
  options: { mode?: ImportMode } = {},
): ImportResult {
  const mode = options.mode ?? "handoff"
  const reference = mode === "reference"
  const project = db.query("SELECT id FROM project WHERE id = ?").get(scope.projectID)
  if (!project) {
    throw new TeamShareError(
      `目标项目不存在（project id=${scope.projectID}）。请先在本机用该项目打开一次 opencode。`,
    )
  }

  const rules: PathRules = { worktree: scope.worktree, directory: scope.directory }
  const messages = denormalizeMessages(file.messages, rules)
  const session = file.session

  const sessionID = reference ? newId("ses") : session.id
  const title = reference ? withReferencePrefix(session.title) : withHandoffPrefix(session.title)
  const existing = reference ? undefined : db.query("SELECT id FROM session WHERE id = ?").get(session.id)
  const created = !existing

  const sessionValues = {
    id: sessionID,
    project_id: scope.projectID,
    parent_id: reference ? null : (session.parentID ?? null),
    slug: reference ? createSlug() : (session.slug ?? createSlug()),
    directory: scope.directory,
    path: session.path ?? relative(scope.worktree, scope.directory).replaceAll("\\", "/"),
    title,
    version: session.version ?? "unknown",
    agent: session.agent ?? null,
    model: session.model === undefined ? null : JSON.stringify(session.model),
    // 参考副本不携带原会话的成本/Token：否则本机报表会把发送方的消耗记到自己名下
    cost: reference ? 0 : numberOr(session.cost, 0),
    tokens_input: reference ? 0 : numberOr(session.tokens?.input, 0),
    tokens_output: reference ? 0 : numberOr(session.tokens?.output, 0),
    tokens_reasoning: reference ? 0 : numberOr(session.tokens?.reasoning, 0),
    tokens_cache_read: reference ? 0 : numberOr(session.tokens?.cacheRead, 0),
    tokens_cache_write: reference ? 0 : numberOr(session.tokens?.cacheWrite, 0),
    summary_additions: numberOr(session.summary?.additions, 0),
    summary_deletions: numberOr(session.summary?.deletions, 0),
    summary_files: numberOr(session.summary?.files, 0),
    time_created: session.time.created,
    // 参考副本是今天新建的本地会话：置为当前时间，便于在列表顶部找到
    time_updated: reference ? Date.now() : session.time.updated,
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
        sessionID,
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
      const sourceID = (message.info as { id?: string }).id
      if (!sourceID) continue
      const messageID = reference ? newId("msg") : sourceID
      const { id: _id, sessionID: _sessionID, ...info } = message.info as { id?: string } & Record<string, unknown>
      db.query(
        `INSERT INTO message (id, session_id, time_created, time_updated, data)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, time_updated = excluded.time_updated`,
      ).run(
        messageID,
        sessionID,
        numberOr((message.info["time"] as { created?: number } | undefined)?.created, Date.now()),
        numberOr((message.info["time"] as { updated?: number } | undefined)?.updated, Date.now()),
        JSON.stringify(info),
      )
      for (const part of message.parts) {
        const sourcePartID = (part as { id?: string }).id
        if (!sourcePartID) continue
        const partID = reference ? newId("prt") : sourcePartID
        const { id: _p, sessionID: _s, messageID: _m, ...partData } = part as { id?: string } & Record<string, unknown>
        db.query(
          `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET data = excluded.data, time_updated = excluded.time_updated`,
        ).run(
          partID,
          messageID,
          sessionID,
          numberOr((part["time"] as { created?: number } | undefined)?.created, Date.now()),
          numberOr((part["time"] as { updated?: number } | undefined)?.updated, Date.now()),
          JSON.stringify(partData),
        )
      }
    }
  })

  run()
  return { sessionID, title, messages: messages.length, created, mode }
}
