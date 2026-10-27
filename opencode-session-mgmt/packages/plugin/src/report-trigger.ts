/**
 * 状态变更工具执行后立即入队汇报（P1：保证最终状态落盘）。
 *
 * 上游 tool.execute.after 是 await 的（plugin.trigger），因此 enqueue 会在工具返回前完成；
 * 助手随后立刻退出也不会丢，下次启动补推。reqdoc_* 不进汇报投影，故不触发；
 * commit_gate_check / comprehension_ask 不改变汇报摘要，也排除。
 *
 * session.status=idle 的入队仅作 cost/tokens 的 best-effort 刷新：上游 event hook 不 await，
 * 不能作为“不丢最终状态”的保证。
 */
import type { Event } from "@opencode-ai/sdk"
import type { Reporter } from "./report"

const REPORT_TOOL_PREFIXES = ["workflow_", "task_", "review_", "comprehension_", "commit_"] as const
const NO_REPORT_TOOLS = new Set(["commit_gate_check", "comprehension_ask"])

export function shouldReportTool(tool: string): boolean {
  if (NO_REPORT_TOOLS.has(tool)) return false
  return REPORT_TOOL_PREFIXES.some((prefix) => tool.startsWith(prefix))
}

/** 汇报失败只告警，不影响工具结果或会话收尾。 */
export async function enqueueReportSafe(reporter: Reporter, sessionID: string, reason: string): Promise<void> {
  await reporter.enqueueReport(sessionID).catch((error) => {
    console.warn(
      `[session-mgmt] 汇报入队失败（${reason}）：${error instanceof Error ? error.message : String(error)}`,
    )
  })
}

/** tool.execute.after：状态变更工具返回前把最新快照写进本地 outbox。 */
export function createToolReportHook(
  reporter: Reporter,
  isSubagent: (sessionID: string) => Promise<boolean>,
): (input: { tool: string; sessionID: string }) => Promise<void> {
  return async (input) => {
    if (!shouldReportTool(input.tool)) return
    if (await isSubagent(input.sessionID)) return
    await enqueueReportSafe(reporter, input.sessionID, input.tool)
  }
}

/** session.status=idle：可选刷新，补上最终轮次的 cost/tokens（best-effort）。 */
export function createIdleReportHook(
  reporter: Reporter,
  isSubagent: (sessionID: string) => Promise<boolean>,
): (input: { event: Event }) => Promise<void> {
  return async ({ event }) => {
    if (event.type !== "session.status" || event.properties.status.type !== "idle") return
    const sessionID = event.properties.sessionID
    if (await isSubagent(sessionID)) return
    await enqueueReportSafe(reporter, sessionID, "session.idle")
  }
}
