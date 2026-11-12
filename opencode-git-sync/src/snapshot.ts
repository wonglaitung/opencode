import type { OpencodeClient, SessionInfo } from "./types"
import { normalize, toMessagePayload, toSessionMeta, type MessagePayload, type PathRules, type SessionMeta } from "./payload"

/** 从上游 API 抓取一个会话的快照（meta + 全部消息）。 */
export async function captureSession(
  client: OpencodeClient,
  sessionID: string,
  rules: PathRules,
): Promise<{ meta: SessionMeta; messages: MessagePayload[] } | undefined> {
  const session = await client.session.get({ path: { id: sessionID } })
  const info = session.data
  if (!info) return undefined
  const meta = toSessionMeta(info as SessionInfo)
  const response = await client.session.messages({ path: { id: sessionID } })
  const messages = (response.data ?? []).map((message) => toMessagePayload(message))
  return {
    meta: normalize(meta, rules) as SessionMeta,
    messages: messages.map((message) => normalize(message, rules) as MessagePayload),
  }
}
