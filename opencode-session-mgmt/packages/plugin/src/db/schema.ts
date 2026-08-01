/**
 * 插件库表定义（设计文档 §3.1）。
 * 位置：<project>/.opencode/session-mgmt.db，每项目一个，bun:sqlite + WAL。
 * 两张表：workflow_session（会话工作流数据，以核心 sessionID 为主键）、
 *         outbox（汇报缓冲，收集服务不可用时暂存，见 report.ts）。
 */
import type { WorkflowState } from "sm-shared"

export interface WorkflowSessionRow {
  session_id: string // 上游 SessionTable.id
  tags: string[]
  status: string | null
  workflow: WorkflowState | null
  account_id: string | null // 会话首次活动时取自 identity.json
}

export interface OutboxRow {
  id: number
  payload: string
  created_at: number
  sent: number // 0 未送达 / 1 已送达
}

/** 数据库中存储的原始行（JSON 字段为字符串）。 */
export interface WorkflowSessionRaw {
  session_id: string
  tags: string
  status: string | null
  workflow: string | null
  account_id: string | null
}

/** 版本化迁移语句，按序执行；SCHEMA_VERSION 记入 meta 表。 */
export const MIGRATIONS: string[] = [
  // v1：初始 schema
  `CREATE TABLE IF NOT EXISTS workflow_session (
    session_id TEXT PRIMARY KEY,
    tags TEXT NOT NULL DEFAULT '[]',
    status TEXT,
    workflow TEXT,
    account_id TEXT
  );
  CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    sent INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_outbox_sent ON outbox(sent);`,
]

export const SCHEMA_VERSION = MIGRATIONS.length

export function rowFromRaw(raw: WorkflowSessionRaw): WorkflowSessionRow {
  return {
    session_id: raw.session_id,
    tags: raw.tags ? (JSON.parse(raw.tags) as string[]) : [],
    status: raw.status,
    workflow: raw.workflow ? (JSON.parse(raw.workflow) as WorkflowState) : null,
    account_id: raw.account_id,
  }
}
