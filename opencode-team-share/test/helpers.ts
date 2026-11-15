/**
 * 测试夹具：造一个最小 opencode 库（表结构与真实 schema 对齐，只保留用到的列）。
 */
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SCHEMA = `
CREATE TABLE project (
  id TEXT PRIMARY KEY,
  worktree TEXT NOT NULL,
  name TEXT,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  sandboxes TEXT NOT NULL
);
CREATE TABLE session (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workspace_id TEXT,
  parent_id TEXT,
  slug TEXT NOT NULL,
  directory TEXT NOT NULL,
  path TEXT,
  title TEXT NOT NULL,
  version TEXT NOT NULL,
  share_url TEXT,
  summary_additions INTEGER,
  summary_deletions INTEGER,
  summary_files INTEGER,
  summary_diffs TEXT,
  metadata TEXT,
  cost REAL NOT NULL DEFAULT 0,
  tokens_input INTEGER NOT NULL DEFAULT 0,
  tokens_output INTEGER NOT NULL DEFAULT 0,
  tokens_reasoning INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  revert TEXT,
  permission TEXT,
  agent TEXT,
  model TEXT,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  time_compacting INTEGER,
  time_archived INTEGER
);
CREATE TABLE message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE part (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL
);
`

export type TestDb = {
  db: Database
  dir: string
  path: string
  close: () => void
}

export function createDbAt(path: string): Database {
  const db = new Database(path)
  db.exec(SCHEMA)
  return db
}

export function createTestDb(name = "sm-team-share"): TestDb {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`))
  const path = join(dir, "opencode.db")
  const db = createDbAt(path)
  return {
    db,
    dir,
    path,
    close: () => {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export function seedProject(db: Database, id: string, worktree: string, name?: string) {
  db.query(
    "INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, '[]')",
  ).run(id, worktree, name ?? null, 1000, 1000)
}

export type SeedMessage = {
  id: string
  data: Record<string, unknown>
  parts?: Array<{ id: string; data: Record<string, unknown> }>
  timeCreated?: number
}

/** 写一条会话（含消息与 part）。 */
export function seedSession(
  db: Database,
  options: {
    id: string
    projectID: string
    directory: string
    path?: string
    title: string
    slug?: string
    version?: string
    agent?: string
    model?: unknown
    timeCreated?: number
    timeUpdated?: number
    timeArchived?: number | null
    messages: SeedMessage[]
  },
) {
  const created = options.timeCreated ?? 1000
  const updated = options.timeUpdated ?? 2000
  db.query(
    `INSERT INTO session (id, project_id, slug, directory, path, title, version, agent, model,
                          cost, time_created, time_updated, time_archived)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    options.id,
    options.projectID,
    options.slug ?? "quiet-river",
    options.directory,
    options.path ?? null,
    options.title,
    options.version ?? "1.19.4",
    options.agent ?? null,
    options.model === undefined ? null : JSON.stringify(options.model),
    0,
    created,
    updated,
    options.timeArchived ?? null,
  )
  for (const message of options.messages) {
    const timeCreated = message.timeCreated ?? created
    db.query(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    ).run(message.id, options.id, timeCreated, timeCreated, JSON.stringify(message.data))
    for (const part of message.parts ?? []) {
      db.query(
        "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(part.id, message.id, options.id, timeCreated, timeCreated, JSON.stringify(part.data))
    }
  }
}
