/**
 * opencode-sm list [--status <s>] [--tag <t>] [--json]
 * 上游 session.list 结果叠加本机插件库 status/tag 过滤（设计文档 5.1）。
 * 上游不可达时退化为本机插件库已追踪的会话。
 */
import { createClient, fetchSessions, openPluginStore, resolveServerUrl } from "../api"
import type { ParsedArgs } from "../index"

interface ListEntry {
  id: string
  title: string
  status: string | null
  tags: string[]
  updated: number | null
}

export async function runList(args: ParsedArgs): Promise<void> {
  const store = openPluginStore(process.cwd())
  const client = createClient(resolveServerUrl())
  try {
    const rows = store.listAll()
    const rowById = new Map(rows.map((r) => [r.session_id, r]))
    const upstream = await fetchSessions(client)

    let entries: ListEntry[]
    if (upstream.length > 0) {
      entries = upstream.map((s) => {
        const row = rowById.get(s.id)
        return {
          id: s.id,
          title: s.title,
          status: row?.status ?? null,
          tags: row?.tags ?? [],
          updated: s.time.updated,
        }
      })
    } else {
      // 上游不可达：仅列本机已追踪会话（12 退化）
      entries = rows.map((r) => ({
        id: r.session_id,
        title: "(上游不可达，标题略)",
        status: r.status,
        tags: r.tags,
        updated: null,
      }))
    }

    const statusFilter = typeof args.flags.status === "string" ? args.flags.status : undefined
    const tagFilter = typeof args.flags.tag === "string" ? args.flags.tag : undefined
    if (statusFilter) entries = entries.filter((e) => e.status === statusFilter)
    if (tagFilter) entries = entries.filter((e) => e.tags.includes(tagFilter))

    if (args.flags.json) {
      process.stdout.write(JSON.stringify(entries, null, 2) + "\n")
      return
    }
    if (entries.length === 0) {
      process.stdout.write("无匹配的会话。\n")
      return
    }
    for (const e of entries) {
      const tags = e.tags.length > 0 ? ` [${e.tags.join(",")}]` : ""
      const status = e.status ? ` (${e.status})` : ""
      process.stdout.write(`${e.id}  ${e.title}${status}${tags}\n`)
    }
  } finally {
    store.close()
  }
}
