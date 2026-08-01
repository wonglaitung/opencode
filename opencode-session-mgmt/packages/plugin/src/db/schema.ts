/**
 * 插件库表定义（设计文档 §3.1）。
 * 位置：<project>/.opencode/session-mgmt.db，每项目一个，bun:sqlite + WAL。
 * 只有一张表：workflow_session（以核心 sessionID 为主键）。
 */
import type { WorkflowState } from "sm-shared"

export interface WorkflowSessionRow {
  session_id: string // 上游 SessionTable.id
  tags: string[]
  status: string | null
  workflow: WorkflowState | null
  account_id: string | null // 会话首次活动时取自 identity.json
}

// TODO: CREATE TABLE 语句与 drizzle 定义
// TODO: outbox 表（汇报缓冲，见 report.ts）
