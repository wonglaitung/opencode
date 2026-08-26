/**
 * opencode-sm stats [<sessionID>] [--project <dir>] [--period <nd>] [--workflow <type>] [--json]
 * 会话级/项目级统计：本机插件库 + 上游 SDK 组合（5.2）。
 * 组/组织级聚合由收集服务（外部项目 performance_dashboard）提供，CLI 不再负责。
 * --project 省略时从 CWD 自动检测（1.4）。
 */
import { statSync } from "node:fs"
import { basename, resolve } from "node:path"
import { resolveWorkflowType } from "sm-shared"
import type { WorkflowSessionRow } from "sm-plugin/src/db/schema"
import { HIGH_ITERATION_THRESHOLD, LOW_FIRST_PASS_THRESHOLD, aggregateProject, sessionStats, type SessionStats } from "sm-plugin/src/stats"
import {
  createClient,
  openPluginStore,
  openPluginStoreIfExists,
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

function isExistingDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

interface ProjectInfo {
  /** 插件库所在项目目录 */
  dir: string
  /** 展示用项目名 */
  label: string
  /** 需要向用户说明的退化提示（无则 null） */
  note: string | null
  /** --project 是否解析为一个明确的项目目录（是则只读打开、不创建库） */
  explicit: boolean
}

/**
 * 解析 --project（1.4、4.3）。本地插件库按项目目录存放，故：
 * - 缺省：按当前工作目录（CWD）聚合；
 * - 给的是已存在的目录：只读打开该目录的插件库（跨项目查看，不创建库）；
 * - 给的是名称但非目录：无法据此定位目录，退化为 CWD 聚合，仅作展示标签并提示。
 */
export function resolveProjectInfo(projectFlag: string | undefined): ProjectInfo {
  const cwd = process.cwd()
  if (!projectFlag) return { dir: cwd, label: basename(cwd), note: null, explicit: false }
  if (isExistingDir(projectFlag)) {
    const dir = resolve(projectFlag)
    return { dir, label: basename(dir), note: null, explicit: true }
  }
  return {
    dir: cwd,
    label: projectFlag,
    note: "本地插件库按项目目录存放，未匹配到该目录时按当前工作目录聚合（可改传项目目录路径）。",
    explicit: false,
  }
}

export async function runStats(args: ParsedArgs): Promise<void> {
  const json = Boolean(args.flags.json)
  const period = typeof args.flags.period === "string" ? args.flags.period : undefined
  const workflowType = typeof args.flags.workflow === "string" ? resolveWorkflowType(args.flags.workflow) : undefined

  // 会话级/项目级：本机插件库 + 上游 SDK（5.2）
  // --project 可给项目目录路径（本地插件库按项目存放，1.4）；缺省按 CWD。
  const projectFlag = typeof args.flags.project === "string" ? args.flags.project : undefined
  const projInfo = resolveProjectInfo(projectFlag)
  // 明确的 --project 目录只读打开（不在任意目录创建库）；CWD 则照常打开
  const store = projInfo.explicit ? openPluginStoreIfExists(projInfo.dir) : openPluginStore(projInfo.dir)
  if (!store) {
    process.stdout.write(`项目 "${projInfo.label}" 尚无会话管理数据库（${projInfo.dir}）。\n`)
    return
  }
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

    // 项目级（CWD 自动聚合，1.4）
    const cutoff = parsePeriodMs(period)
    let rows = store.listAll()
    if (cutoff !== null) {
      const since = Date.now() - cutoff
      rows = rows.filter((r) => {
        const at = firstTransitionAt(r)
        return at !== null && at >= since
      })
    }
    // 6 分区管道：按工作流类型过滤，两条流程指标绝不混算
    if (workflowType !== undefined) {
      rows = rows.filter((r) => r.workflow?.type === workflowType)
    }
    // cost/tokens 需异步取数：先逐会话补齐（客户端不可用时为空值），再聚合
    const usageCache = new Map<string, Awaited<ReturnType<typeof sessionUsage>>>()
    for (const r of rows) {
      usageCache.set(r.session_id, await sessionUsage(client, r.session_id))
    }
    const usageOf = (id: string) =>
      usageCache.get(id) ?? { cost: null, tokensInput: null, tokensOutput: null }
    const project = aggregateProject(rows, usageOf)
    const sessionDetails = rows
      .map((r) => sessionStats(r, usageOf(r.session_id)))
      .filter((s): s is SessionStats => s !== null)
    if (json) {
      process.stdout.write(JSON.stringify({ ...project, perSession: sessionDetails }, null, 2) + "\n")
    } else {
      printProjectStats(project, projInfo.label, projInfo.note, sessionDetails)
    }
  } finally {
    store.close()
  }
}

/** 标题展示：空为 N/A，超 24 字截断加省略号（逐会话明细表列宽）。 */
export function fmtTitle(title: string | null): string {
  if (!title) return "N/A"
  return title.length > 24 ? title.slice(0, 24) + "…" : title
}

function printSessionStats(s: SessionStats): void {
  const stageLines = s.stages
    .map((st) => `  ${st.label.padEnd(6, " ")} ${st.status.padEnd(12)} ${fmtDuration(st.durationMs)} (revision ${st.revision})`)
    .join("\n")
  process.stdout.write(
    `📋 会话 ${s.sessionID}\n` +
      `工作流类型: ${s.type}  标题: ${fmtTitle(s.title)}\n` +
      `开发者: ${s.account ?? "N/A"}  周期: ${fmtDuration(s.durationMs)}  ${s.complete ? "✓ 已完成" : s.currentStage ? `进行中（${s.currentStage}）` : "进行中"}\n\n` +
      `工作流:\n${stageLines}\n\n` +
      `质量:\n` +
      `  一次通过率: ${fmtPct(s.firstPassRate)}  迭代轮次: ${fmtIterations(s.iterationCount)}  覆盖率: ${fmtPct(s.testCoverage)}\n` +
      `  ${fmtLinesCategory(s.lines)}\n` +
      `  ${fmtBaselineLine(s.baselineHours, s.durationMs, s.efficiency)}\n` +
      `  返工率: ${fmtPct(s.reworkRate)}  审查清单: ${s.checklistPassed}/4  理解确认: ${s.comprehension.confirmed}/${s.comprehension.total}\n` +
      (s.score ? `  PRD 评分: ${s.score.total}/100${s.score.confirmed ? "（已业务确认）" : "（未确认）"}\n` : "") +
      `\nAI 使用: ${s.cost === null ? "$N/A" : `$${s.cost.toFixed(4)}`} | ${fmtTokens(s.tokensInput)} in / ${fmtTokens(s.tokensOutput)} out\n`,
  )
}

function printProjectStats(
  p: ReturnType<typeof aggregateProject>,
  label: string,
  note: string | null,
  sessions: SessionStats[],
): void {
  const lines: string[] = [
    `📊 项目 "${label}" 统计`,
    ...(note ? [`（${note}）`] : []),
    `会话: ${p.sessions} | 完成率: ${(p.completionRate * 100).toFixed(0)}% | 平均周期: ${fmtDuration(p.avgDurationMs)}`,
    `费用: ${p.hasCostData ? `$${p.totalCost.toFixed(4)} 总计` : "N/A（daemon 不可达或未配置 OPENCODE_SM_SERVER）"}`,
    `质量:`,
    `  平均一次通过率: ${fmtPct(p.avgFirstPassRate)}  一次通过率过低会话(<${LOW_FIRST_PASS_THRESHOLD}%): ${p.lowFirstPassCount}/${p.sessions}`,
    `  ${p.hasLinesData ? fmtLinesCategory(p.linesTotal) : "AI 净增行数: N/A"}`,
    p.avgEfficiency === null
      ? `  AI 提效: N/A（无基线会话）`
      : `  平均 AI 提效: ${fmtEfficiency(p.avgEfficiency)}（基线会话 ${p.baselineCount}/${p.sessions}）`,
    `  高迭代会话(≥${HIGH_ITERATION_THRESHOLD}轮): ${p.highIterationCount}`,
  ]

  // 逐会话明细表
  if (sessions.length > 0) {
    lines.push("")
    lines.push("逐会话明细:")
    // 会话 ID 列宽随最长 ID 自适应，保证完整显示、可直接复制进 stats <sessionID>
    const idWidth = Math.max(12, ...sessions.map((s) => s.sessionID.length))
    // 状态列：进行中会话标注当前阶段（如「编码中」），列宽随最长值自适应
    const statusOf = (s: SessionStats) =>
      s.complete ? "✓完成" : s.currentStage ? `${s.currentStage}中` : s.status ?? "进行中"
    const statusWidth = Math.max(8, ...sessions.map((s) => statusOf(s).length))
    // 表头
    lines.push(
      `  ${"会话ID".padEnd(idWidth)} ${"状态".padEnd(statusWidth)} ${"周期".padStart(6)} ${"一次通过率".padStart(6)} ${"迭代".padStart(4)} ${"费用".padStart(8)} ${"标题".padEnd(24)}`,
    )
    lines.push(`  ${"─".repeat(idWidth)} ${"─".repeat(statusWidth)} ${"─".repeat(6)} ${"─".repeat(6)} ${"─".repeat(4)} ${"─".repeat(8)} ${"─".repeat(24)}`)
    for (const s of sessions) {
      const id = s.sessionID
      const status = statusOf(s)
      const dur = fmtDuration(s.durationMs)
      const acc = fmtPct(s.firstPassRate)
      const iter =
        s.iterationCount === null
          ? "N/A"
          : s.iterationCount >= HIGH_ITERATION_THRESHOLD
            ? `${s.iterationCount}⚠`
            : `${s.iterationCount}`
      const cost = s.cost === null ? "N/A" : `$${s.cost.toFixed(4)}`
      lines.push(
        `  ${id.padEnd(idWidth)} ${status.padEnd(statusWidth)} ${dur.padStart(6)} ${acc.padStart(6)} ${iter.padStart(4)} ${cost.padStart(8)} ${fmtTitle(s.title).padEnd(24)}`,
      )
    }
    lines.push("")
    lines.push("  迭代 = 单文件被 AI 编辑的最高次数（⚠ 表示迭代较高；不是全会话编辑总数）")
    lines.push("  查看单个会话详情：opencode-sm stats <sessionID>")
  }

  process.stdout.write(lines.join("\n") + "\n")
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

/** 迭代轮次：AI 对单个文件的最大编辑次数（按文件分桶取最大值，非全会话总数）。 */
function fmtIterations(v: number | null): string {
  if (v === null) return "N/A"
  const warn = v >= HIGH_ITERATION_THRESHOLD ? "，迭代较高，建议审查是否陷入无效循环" : ""
  return `${v} 轮（单文件被 AI 编辑的最高次数${warn}）`
}

function fmtTokens(v: number | null): string {
  if (v === null) return "N/A"
  if (v >= 1000) return `${(v / 1000).toFixed(0)}K`
  return String(v)
}

/** 行数展示：≥1000 以 K 计（保留一位小数、去尾零），对齐 6.2 示例 5.8K/62K。 */
function fmtLines(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, "")}K`
  return String(v)
}

/** 三分类行数行（6.2）：「AI 净增行数: 业务 X / 测试 Y / 配置 Z（合计 N）」；无数据显示 N/A。 */
export function fmtLinesCategory(lines: { business: number; test: number; config: number } | null): string {
  if (!lines) return "AI 净增行数: N/A"
  const total = lines.business + lines.test + lines.config
  return `AI 净增行数: 业务 ${fmtLines(lines.business)} / 测试 ${fmtLines(lines.test)} / 配置 ${fmtLines(lines.config)}（合计 ${fmtLines(total)}）`
}

/** 提效率展示（6.3）：比率 → 百分比整数（四舍五入），负数保留符号（仅展示）。 */
export function fmtEfficiency(v: number | null): string {
  if (v === null) return "N/A"
  return `${Math.round(v * 100)}%`
}

/** 基线对比行（6.3）：「基线对比: 预估 8h / 实际 1.7h → AI 提效 79%」；未录入基线显示 N/A。 */
export function fmtBaselineLine(baselineHours: number | null, durationMs: number, efficiency: number | null): string {
  if (baselineHours === null) return "基线对比: N/A（未录入预估工时）"
  if (efficiency === null) return `基线对比: 预估 ${baselineHours}h（暂无有效周期）`
  return `基线对比: 预估 ${baselineHours}h / 实际 ${fmtDuration(durationMs)} → AI 提效 ${fmtEfficiency(efficiency)}`
}
