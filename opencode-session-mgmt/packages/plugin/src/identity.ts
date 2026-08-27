/**
 * 会话身份解析（设计文档 session-management.md 3.1）。
 * chat.message hook：会话首次活动时，从全局 identity.json 读取身份，供汇报上送。
 * account_id 打标已移除——身份改为以 api_key 哈希标识，由收集端据哈希解析归属。
 */
import { readIdentity, type Identity } from "sm-shared"

/**
 * 读取全局身份；缺失时返回 null（退化为不上送身份相关字段，12）。
 * 仅读不写；不再写 workflow_session.account_id（身份以 api_key 哈希标识）。
 */
export function resolveIdentity(): Identity | null {
  return readIdentity()
}
