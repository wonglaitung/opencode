/**
 * 数据源封装（设计文档 §4.2、§5.2）。
 * 1. 上游 opencode SDK：session.list/messages（cost/tokens）——连运行中的 daemon
 * 2. 收集服务查询客户端：GET {collector_url}/api/stats（组/组织级统计）
 * 3. 本机插件库访问（复用 sm-plugin 的 Store，bun:sqlite）
 */
import { createOpencodeClient, type Session } from "@opencode-ai/sdk"
import { Store } from "sm-plugin/src/db"
import type { Usage } from "sm-plugin/src/report"
import type { Identity } from "sm-shared"

export type OpencodeClient = ReturnType<typeof createOpencodeClient>

/** 打开指定项目目录的插件库（复用 sm-plugin Store；同机 WAL 多进程安全）。 */
export function openPluginStore(directory: string): Store {
  return Store.open(directory)
}

/** 解析 daemon 地址：环境变量 OPENCODE_SM_SERVER 优先；未配置返回 null（退化为仅本机数据）。 */
export function resolveServerUrl(): string | null {
  const url = process.env.OPENCODE_SM_SERVER
  return url && url.trim() !== "" ? url.trim() : null
}

/** 创建上游 SDK 客户端；serverUrl 为 null 时返回 null（调用方据此降级）。 */
export function createClient(serverUrl: string | null): OpencodeClient | null {
  if (!serverUrl) return null
  return createOpencodeClient({ baseUrl: serverUrl })
}

/** 经上游 SDK 汇总会话 cost/tokens（step-finish 分段求和）；不可用时返回空值。 */
export async function sessionUsage(client: OpencodeClient | null, sessionID: string): Promise<Usage> {
  const empty: Usage = { cost: null, tokensInput: null, tokensOutput: null }
  if (!client) return empty
  try {
    const res = await client.session.messages({ path: { id: sessionID } })
    const messages = res.data
    if (!messages) return empty
    let cost = 0
    let input = 0
    let output = 0
    let seen = false
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type !== "step-finish") continue
        seen = true
        cost += part.cost
        input += part.tokens.input
        output += part.tokens.output
      }
    }
    return seen ? { cost, tokensInput: input, tokensOutput: output } : empty
  } catch {
    return empty
  }
}

/** 拉取上游会话列表；不可用时返回空数组。 */
export async function fetchSessions(client: OpencodeClient | null): Promise<Session[]> {
  if (!client) return []
  try {
    const res = await client.session.list()
    return res.data ?? []
  } catch {
    return []
  }
}

export interface CollectorStatsQuery {
  scope: "group" | "org"
  group?: string
  org?: string
  period?: string
}

/** 查询 org 收集服务的组/组织级统计（§5.2 alt 分支二）。 */
export async function collectorQuery(
  identity: Identity,
  query: CollectorStatsQuery,
): Promise<unknown> {
  const params = new URLSearchParams()
  params.set("scope", query.scope)
  if (query.group) params.set("group", query.group)
  if (query.org) params.set("org", query.org)
  if (query.period) params.set("period", query.period)
  const base = identity.collector_url.replace(/\/$/, "")
  const res = await fetch(`${base}/api/stats?${params.toString()}`)
  if (!res.ok) {
    throw new Error(`收集服务查询失败：HTTP ${res.status}`)
  }
  return (await res.json()) as unknown
}
