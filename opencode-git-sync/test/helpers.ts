import { Database } from "bun:sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { MessageWithParts, OpencodeClient, SessionInfo } from "../src/types"

/**
 * 把插件状态目录（本地 clone / state.db / 日志）隔离到临时目录，
 * 避免测试污染 ~/.local/share/opencode/git-sync。
 */
export function useTempStateDir(): string {
  const dir = tempDir("git-sync-state-")
  process.env["OPENCODE_GIT_SYNC_DIR"] = dir
  // 同时隔离默认口令文件目录，避免测试读到用户真实的 ~/.config/opencode/git-sync.key
  process.env["XDG_CONFIG_HOME"] = path.join(dir, "config")
  return dir
}

/**
 * 复位状态目录到新的临时目录。
 * 测试中途不能 `delete` 这个变量：插件会回落到用户真实目录，把数据写进去。
 */
export function resetStateDir(): string {
  const dir = tempDir("git-sync-state-")
  process.env["OPENCODE_GIT_SYNC_DIR"] = dir
  return dir
}

/** 临时目录，测试结束自动清理。 */
export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return dir
}

/** 建一个最小 opencode 数据库（session / message / part 三表）。 */
export function createOpencodeDb(file: string): Database {
  const db = new Database(file, { create: true })
  db.run(
    `CREATE TABLE IF NOT EXISTS \`session\` (
      \`id\` text PRIMARY KEY,
      \`project_id\` text NOT NULL,
      \`workspace_id\` text,
      \`parent_id\` text,
      \`slug\` text NOT NULL,
      \`directory\` text NOT NULL,
      \`path\` text,
      \`title\` text NOT NULL,
      \`version\` text NOT NULL,
      \`share_url\` text,
      \`summary_additions\` integer,
      \`summary_deletions\` integer,
      \`summary_files\` integer,
      \`summary_diffs\` text,
      \`metadata\` text,
      \`cost\` real NOT NULL DEFAULT 0,
      \`tokens_input\` integer NOT NULL DEFAULT 0,
      \`tokens_output\` integer NOT NULL DEFAULT 0,
      \`tokens_reasoning\` integer NOT NULL DEFAULT 0,
      \`tokens_cache_read\` integer NOT NULL DEFAULT 0,
      \`tokens_cache_write\` integer NOT NULL DEFAULT 0,
      \`revert\` text,
      \`permission\` text,
      \`agent\` text,
      \`model\` text,
      \`time_created\` integer NOT NULL,
      \`time_updated\` integer NOT NULL,
      \`time_compacting\` integer,
      \`time_archived\` integer
    );`,
  )
  db.run(
    `CREATE TABLE IF NOT EXISTS \`message\` (
      \`id\` text PRIMARY KEY,
      \`session_id\` text NOT NULL,
      \`time_created\` integer NOT NULL,
      \`time_updated\` integer NOT NULL,
      \`data\` text NOT NULL
    );`,
  )
  db.run(
    `CREATE TABLE IF NOT EXISTS \`part\` (
      \`id\` text PRIMARY KEY,
      \`message_id\` text NOT NULL,
      \`session_id\` text NOT NULL,
      \`time_created\` integer NOT NULL,
      \`time_updated\` integer NOT NULL,
      \`data\` text NOT NULL
    );`,
  )
  return db
}

export type FakeSession = {
  info: SessionInfo
  messages: MessageWithParts[]
}

/** 假的上游 client：返回固定会话数据。 */
export function fakeClient(sessions: Record<string, FakeSession>): OpencodeClient {
  return {
    session: {
      async get({ path }) {
        return { data: sessions[path.id]?.info }
      },
      async messages({ path }) {
        return { data: sessions[path.id]?.messages ?? [] }
      },
      async update({ path, body }) {
        const session = sessions[path.id]
        if (!session) return {}
        if (body.title !== undefined) session.info = { ...session.info, title: body.title }
        return { data: session.info }
      },
    },
  }
}
