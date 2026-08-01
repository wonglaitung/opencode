/**
 * 会话打标（设计文档 §3.1）。
 * chat.message hook：会话首次活动时，从全局 identity.json 读 account 写入
 * workflow_session.account_id。不读上游数据库。
 */
import { readIdentity, type Identity } from "sm-shared"
import type { Store } from "./db"

/**
 * 幂等打标：仅会话首次活动写入 account_id；identity.json 缺失时静默跳过
 * （退化为不打标，不影响其他功能，§12）。返回当前身份（供汇报复用）或 null。
 */
export function stampSessionAccount(store: Store, sessionID: string): Identity | null {
  const identity = readIdentity()
  if (!identity) return null
  store.stampAccount(sessionID, identity.account)
  return identity
}
