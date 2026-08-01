/**
 * opencode-sm stats [<sessionID>] [--project <name>] [--group "组名"] [--org] [--period <nd>] [--json]
 * 会话级/项目级：本机插件库 + 上游 SDK 组合（§5.2 alt 分支一）
 * 组级/组织级：查 org 收集服务（§5.2 alt 分支二）
 * --project 省略时从 CWD 自动检测（§1.4）。
 */
import { readIdentity } from "sm-shared"
import type { WorkflowSessionRow } from "sm-plugin/src/db/schema"
import { aggregateProject, sessionStats, type SessionStats } from "sm-plugin/src/stats"
import {
  collectorQuery,
  createClient,
  openPluginStore,
  resolveServerUrl,
  sessionUsage,
} from "../api"
import type { ParsedArgs } from "../index"

/** 解析 "7d"/"30d" 为毫秒；无法解析返回 null（不过滤）。 */
export function parsePeriodMs(period: string | undefined): number | null {
  if (!period) return null
  const match = /^(\d+)d$/.exec(period)
  if (!match) return null
  return Number.parseInt(match[1]!, 10) * 24 * 60 * 60 * 1000
}

function firstTransitionAt(row: WorkflowSessionRow): number | null {
  const times: number[] = []
  const workflow = row.workflow
  if (!workflow) return null
  for (const stage of Object.values(workflow.stages)) {
    for (const t of stage.transitions) times.push(t.at)
  }
  return times.length > 0 ? Math.min(...times) : null
}

export async function runStats(args: ParsedArgs): Promise<void> {
  const json = Boolean(args.flags.json)
  const period = typeof args.flags.period === "string" ? args.flags.period : undefined

  // 组/组织级：查收集服务（§5.2 alt 分支二）
  if (args.flags.group || args.flags.org) {
    const identity = readIdentity()
    if (!identity) {
      process.stderr.write("组/组织级统计需先 opencode-sm init 配置身份与收集服务地址。\n")
      process.exitCode = 1
      return
    }
    const scope = args.flags.org ? "org" : "group"
    const result = await collectorQuery(identity, {
      scope,
      group: typeof args.flags.group === "string" ? args.flags.group : undefined,
      org: args.flags.org ? identity.org : undefined,
      period,
    })
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    return
  }

  // 会话级/项目级：本机插件库 + 上游 SDK（§5.2 alt 分支一）
  const store = openPluginStore(process.cwd())
  const client = createClient(resolveServerUrl())
  try {
    const sessionID = args.positionals[0]
    if (sessionID) {
      const row = store.get(sessionID)
      if (!row) {
        process.stdout.write(`会话 ${sessionID} 无工作流数据。\n`)
        return
      }
      const stats = sessionStats(row, await sessionUsage(client, sessionID))
      if (!stats) {
        process.stdout.write(`会话 ${sessionID} 无工作流数据。\n`)
        return
      }
      if (json) {
        process.stdout.write(JSON.stringify(stats, null, 2) + "\n")
      } else {
        printSessionStats(stats)
      }
      return
    }

    // 项目级（CWD 自动聚合，§1.4）
    const cutoff = parsePeriodMs(period)
    let rows = store.listAll()
    if (cutoff !== null) {
      const since = Date.now() - cutoff
      rows = rows.filter((r) => {
        const at = firstTransitionAt(r)
        return at !== null && at >= since
      })
    }
    // cost/tokens 需异步取数：先逐会话补齐（客户端不可用时为空值），再聚合
    const usageCache = new Map<string, Awaited<ReturnType<typeof sessionUsage>>>()
    for (const r of rows) {
      usageCache.set(r.session_id, await sessionUsage(client, r.session_id))
    }
    const project = aggregateProject(rows, (id) =>
      usageCache.get(id) ?? { cost: null, tokensInput: null, tokensOutput: null },
    )
    if (json) {
      process.stdout.write(JSON.stringify(project, null, 2) + "\n")
    } else {
      printProjectStats(project)
    }
  } finally {
    store.close()
  }
}

function printSessionStats(s: SessionStats): void {
  const stageLines = s.stages
    .map((st) => `  ${st.label.padEnd(6, " ")} ${st.status.padEnd(12)} ${fmtDuration(st.durationMs)} (revision ${st.revision})`)
    .join("\n")
  process.stdout.write(
    `📋 会话 ${s.sessionID}\n` +
      `开发者: ${s.account ?? "N/A"}  周期: ${fmtDuration(s.durationMs)}  ${s.complete ? "✓ 已完成" : "进行中"}\n\n` +
      `工作流:\n${stageLines}\n\n` +
      `质量:\n` +
      `  采纳率: ${fmtPct(s.acceptanceRate)}  迭代轮次: ${s.iterationCount ?? "N/A"}/3  覆盖率: ${fmtPct(s.testCoverage)}\n` +
      `  返工率: ${fmtPct(s.reworkRate)}  审查清单: ${s.checklistPassed}/4  理解确认: ${s.comprehension.confirmed}/${s.comprehension.total}\n\n` +
      `AI 使用: $${(s.cost ?? 0).toFixed(4)} | ${fmtTokens(s.tokensInput)} in / ${fmtTokens(s.tokensOutput)} out\n`,
  )
}

function printProjectStats(p: ReturnType<typeof aggregateProject>): void {
  process.stdout.write(
    `📊 项目级统计（CWD）\n` +
      `会话: ${p.sessions} | 完成率: ${(p.completionRate * 100).toFixed(0)}% | 平均周期: ${fmtDuration(p.avgDurationMs)}\n` +
      `费用: $${p.totalCost.toFixed(4)} 总计\n` +
      `质量:\n` +
      `  平均采纳率: ${fmtPct(p.avgAcceptanceRate)}  超阈值(>45%)会话: ${p.overAcceptanceThreshold}/${p.sessions}\n` +
      `  触达迭代上限(3轮): ${p.hitIterationLimit} 会话\n`,
  )
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return "0m"
  const hours = ms / 3_600_000
  if (hours >= 24) return `${(hours / 24).toFixed(1)}d`
  if (hours >= 1) return `${hours.toFixed(1)}h`
  return `${Math.round(ms / 60_000)}m`
}

function fmtPct(v: number | null): string {
  return v === null ? "N/A" : `${v}%`
}

function fmtTokens(v: number | null): string {
  if (v === null) return "N/A"
  if (v >= 1000) return `${(v / 1000).toFixed(0)}K`
  return String(v)
}
