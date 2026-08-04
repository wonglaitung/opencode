/**
 * 质量指标工具与迭代计数（设计文档 3.2、4.3、7.4 规则 15-20）。
 * quality_report —— Agent 上报 acceptanceRate，增量合并写 workflow.quality
 * 迭代计数 —— tool.execute.after 统计代码编辑轮次，达 3 轮由 system prompt 提示人工介入
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { Store } from "../db"

const z = tool.schema

/**
 * 视为"AI 代码编辑"的上游工具名（计入迭代轮次）。
 * 上游 packages/opencode/src/tool/ 实际注册的代码编辑工具为 write / edit / apply_patch
 * （shell 工具名是 "bash"，read/grep 等只读工具不计）。
 */
export const CODE_EDIT_TOOLS = new Set(["write", "edit", "apply_patch"])

/** 业界健康采纳率上限；超过则提示可能未充分审查（7.4 规则 16）。 */
export const ACCEPTANCE_WARN_THRESHOLD = 45

export function createQualityTools(store: Store): Record<string, ToolDefinition> {
  const quality_report = tool({
    description:
      "上报会话内质量指标（acceptanceRate 采纳率 0-100），增量合并写入 workflow.quality。" +
      "迭代轮次 iterationCount 由插件按文件自动计数（tool.execute.after），不通过本工具设置。",
    args: {
      acceptanceRate: z.number().min(0).max(100).optional().describe("代码建议采纳率（%）"),
    },
    async execute(args, context) {
      const patch: { quality: { acceptanceRate?: number } } = { quality: {} }
      if (args.acceptanceRate !== undefined) patch.quality.acceptanceRate = args.acceptanceRate
      const saved = store.updateWorkflow(context.sessionID, patch)
      const rate = saved.quality.acceptanceRate
      const warning =
        rate !== null && rate > ACCEPTANCE_WARN_THRESHOLD
          ? `\n⚠ 采纳率 ${rate}% 超过健康阈值（${ACCEPTANCE_WARN_THRESHOLD}%），请逐段回顾变更，确认能独立解释其原理。`
          : ""
      return `已记录质量指标：acceptanceRate=${rate ?? "N/A"}，iterationCount=${saved.quality.iterationCount ?? "N/A"}${warning}`
    },
  })

  return { quality_report }
}

/**
 * 从工具入参提取文件键：write/edit 携带 filePath；无单一文件路径的工具
 * （如 apply_patch，入参为 patchText）归入 "(<工具名>)" 工具级桶。
 */
function fileKey(toolName: string, args: unknown): string {
  if (typeof args === "object" && args !== null) {
    const a = args as Record<string, unknown>
    const p = a.filePath ?? a.file_path ?? a.path
    if (typeof p === "string" && p !== "") return p
  }
  return `(${toolName})`
}

/**
 * 生成 tool.execute.after 处理器：按文件累计 AI 代码编辑轮次（统计用）+
 * 重复模式检测（stuck 检测，内存级）。
 *
 * 统计语义（3.2）：iterationByFile 按文件路径分桶计数，iterationCount 取最大值。
 * 此数据仅用于统计展示，不影响 AI 行为。
 *
 * 重复模式检测（内存级，不持久化）：
 * - 信号 A：同一文件连续 3 次以上使用相同参数编辑（streak）→ 重试循环
 * - 信号 B：同一文件在近期 20 次调用中出现 6 次以上（frequency）→ 振荡循环
 * 检测到的 stuck 文件通过 getStuckFiles() 供 system prompt 注入警告。
 */
export function createIterationCounter(store: Store) {
  return async (input: { tool: string; sessionID: string; args?: unknown }): Promise<void> => {
    if (!CODE_EDIT_TOOLS.has(input.tool)) return
    const key = fileKey(input.tool, input.args)
    const argsHash = extractArgsHash(input.tool, input.args)

    // 1. 统计计数（持久化到 WorkflowState）
    store.mutateWorkflow(input.sessionID, (workflow) => {
      const byFile = workflow.quality.iterationByFile ?? {}
      byFile[key] = (byFile[key] ?? 0) + 1
      workflow.quality.iterationByFile = byFile
      workflow.quality.iterationCount = Math.max(...Object.values(byFile))
    })

    // 2. 内存短记忆 + 重复模式检测
    const calls = recentCalls.get(input.sessionID) ?? []
    calls.push({ tool: input.tool, file: key, argsHash, at: Date.now() })
    if (calls.length > RECENT_LIMIT) calls.shift()
    recentCalls.set(input.sessionID, calls)

    const streak = computePerFileStreak(calls, key)
    const freq = computePerFileFrequency(calls, key)
    const sessionStuck = stuckFilesMap.get(input.sessionID) ?? new Map<string, number>()

    if (streak >= STREAK_THRESHOLD) {
      sessionStuck.set(key, streak)
    } else if (freq >= FREQUENCY_THRESHOLD) {
      sessionStuck.set(key, freq)
    } else {
      sessionStuck.delete(key)
    }

    if (sessionStuck.size > 0) stuckFilesMap.set(input.sessionID, sessionStuck)
    else stuckFilesMap.delete(input.sessionID)
  }
}

// ---- 重复模式检测（内存级，不持久化） ----

/** 近期调用记录。 */
interface RecentCall {
  tool: string
  file: string
  argsHash: string
  at: number
}

/** 短记忆上限（每个 session 保留最近 N 次代码编辑调用）。 */
const RECENT_LIMIT = 20

/** 连续相同操作触发 stuck 的阈值。 */
const STREAK_THRESHOLD = 3

/** 同文件编辑总次数触发 stuck 的频率阈值（捕获振荡 A→B→A→B）。 */
const FREQUENCY_THRESHOLD = 6

/** 插件进程级内存状态。 */
const recentCalls = new Map<string, RecentCall[]>() // sessionID → last N calls
const stuckFilesMap = new Map<string, Map<string, number>>() // sessionID → file → streak/freq

/** djb2 哈希：快速、非加密、足够区分参数差异。 */
function simpleHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return h.toString(36)
}

/** 从工具参数提取指纹哈希（区分"重试同一操作" vs "不同目的的编辑"）。 */
function extractArgsHash(tool: string, args: unknown): string {
  if (typeof args !== "object" || args === null) return simpleHash(tool)
  const a = args as Record<string, unknown>
  switch (tool) {
    case "edit":
      return simpleHash(String(a.oldString ?? "") + "|" + String(a.newString ?? ""))
    case "write":
      return simpleHash(String(a.content ?? ""))
    case "apply_patch":
      return simpleHash(String(a.patchText ?? ""))
    default:
      return simpleHash(JSON.stringify(args))
  }
}

/** 取该文件在 short memory 中的子序列，计算末尾连续相同 argsHash 的 streak。 */
function computePerFileStreak(calls: RecentCall[], file: string): number {
  const fileEntries = calls.filter((c) => c.file === file)
  if (fileEntries.length === 0) return 0
  let streak = 1
  const last = fileEntries[fileEntries.length - 1]!.argsHash
  for (let i = fileEntries.length - 2; i >= 0; i--) {
    if (fileEntries[i]!.argsHash === last) streak++
    else break
  }
  return streak
}

/** 取该文件在 short memory 中的编辑总次数。 */
function computePerFileFrequency(calls: RecentCall[], file: string): number {
  return calls.filter((c) => c.file === file).length
}

/** 供 prompt.ts 读取当前 session 的 stuck 文件列表。 */
export function getStuckFiles(sessionID: string): Record<string, number> {
  const m = stuckFilesMap.get(sessionID)
  if (!m) return {}
  return Object.fromEntries(m)
}

/** 供测试使用：重置内存状态。 */
export function resetStuckState(): void {
  recentCalls.clear()
  stuckFilesMap.clear()
}
