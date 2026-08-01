/**
 * org 级收集服务（设计文档 §2.4、§4.3、§10.1）。每组织部署一个，仅内网可达。
 * 三个端点：
 *   POST /api/report       —— 插件汇报会话摘要（sm-shared 的 SessionReport）
 *   POST /api/ci-quality   —— CI 按 sessionID 回写 reworkRate/testCoverage
 *   GET  /api/stats        —— opencode-sm 组/组织级统计查询（scope=group&group=组名 / scope=org）
 * 使用 Bun.serve（零外部依赖）。
 */
import type { CiQualityReport, SessionReport } from "sm-shared"
import { CollectorDb } from "./db"

const DB_PATH = process.env.OPENCODE_SM_COLLECTOR_DB ?? "./collector.db"
const PORT = Number.parseInt(process.env.PORT ?? "8787", 10)

const db = CollectorDb.open(DB_PATH)

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function parsePeriodMs(period: string | null): number | null {
  if (!period) return null
  const match = /^(\d+)d$/.exec(period)
  if (!match) return null
  return Number.parseInt(match[1]!, 10) * 24 * 60 * 60 * 1000
}

function isSessionReport(value: unknown): value is SessionReport {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.sessionID === "string" &&
    typeof v.account === "string" &&
    typeof v.group === "string" &&
    typeof v.org === "string" &&
    typeof v.workflow === "object" &&
    v.workflow !== null
  )
}

function isCiQuality(value: unknown): value is CiQualityReport {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.sessionID === "string" && typeof v.quality === "object" && v.quality !== null
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/api/report" && req.method === "POST") {
      const body: unknown = await req.json().catch(() => null)
      if (!isSessionReport(body)) return json({ error: "非法的汇报 payload" }, 400)
      db.upsertReport(body)
      return json({ ok: true })
    }
    if (url.pathname === "/api/ci-quality" && req.method === "POST") {
      const body: unknown = await req.json().catch(() => null)
      if (!isCiQuality(body)) return json({ error: "非法的 CI 回写 payload" }, 400)
      db.applyCiQuality(body)
      return json({ ok: true })
    }
    if (url.pathname === "/api/stats" && req.method === "GET") {
      const scope = url.searchParams.get("scope")
      const period = parsePeriodMs(url.searchParams.get("period"))
      if (scope === "group") {
        const group = url.searchParams.get("group")
        if (!group) return json({ error: "缺少 group 参数" }, 400)
        return json(db.statsGroup(group, period))
      }
      if (scope === "org") {
        const org = url.searchParams.get("org")
        if (!org) return json({ error: "缺少 org 参数" }, 400)
        return json(db.statsOrg(org, period))
      }
      return json({ error: "scope 必须为 group 或 org" }, 400)
    }
    if (url.pathname === "/healthz") {
      return json({ ok: true })
    }
    return json({ error: "not found" }, 404)
  },
})

// 优雅关闭：落库后退出
process.on("SIGINT", () => {
  db.close()
  server.stop()
  process.exit(0)
})

console.log(`opencode-sm-collector 已启动：http://127.0.0.1:${server.port}（库：${DB_PATH}）`)
