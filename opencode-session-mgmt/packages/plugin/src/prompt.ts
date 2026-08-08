/**
 * system prompt 注入（设计文档 7.1、7.4）。
 * experimental.chat.system.transform hook 的实现：
 * 从插件库读当前会话 WorkflowState，将规则全文 + 状态压缩 JSON 追加到 output.system。
 */
import { getDefinition, reviewRecord, type WorkflowState } from "sm-shared"
import type { Store } from "./db"
import { getStuckFiles } from "./tools/quality"

/** 将当前工作流压缩为注入片段：规则 + 阶段进度 + 质量指标 + stuck 警告。 */
export function buildSystemFragment(workflow: WorkflowState, stuck: Record<string, number> = {}): string {
  const def = getDefinition(workflow.type)
  const lines: string[] = []
  for (const name of def.stages) {
    const stage = workflow.stages[name]
    lines.push(`- ${def.labels[name] ?? name}(${name}): ${stage.status}，revision=${stage.revision}`)
  }
  const review = reviewRecord(workflow)
  const confirmed = review.comprehension.filter((c) => c.developerConfirmed).length
  const iteration = workflow.quality.iterationCount ?? 0
  // 最热文件（迭代轮次来源，3.2 按文件计数）
  const byFile = Object.entries(workflow.quality.iterationByFile ?? {})
  const hottest = byFile.sort((a, b) => b[1] - a[1])[0]
  const parts = [
    def.rules,
    "",
    "## 当前 WorkflowState",
    "```json",
    JSON.stringify(
      {
        stages: Object.fromEntries(def.stages.map((name) => [name, workflow.stages[name].status])),
        commit: workflow.commit,
        quality: workflow.quality,
        // 基线（预估工时）：让 Agent 知道是否已录入，避免重复询问（13）
        baseline: workflow.baseline ?? null,
        review: {
          checklist: review.checklist,
          comprehension: `${confirmed}/${review.comprehension.length} 已确认`,
        },
      },
      null,
      2,
    ),
    "```",
    "",
    `迭代轮次：${iteration}${hottest ? `（最热文件 ${hottest[0]} ×${hottest[1]}）` : ""}`,
    `提交门禁：${workflow.commit.status}${
      workflow.commit.blocked_by.length > 0 ? `（未完成：${workflow.commit.blocked_by.join("、")}）` : ""
    }`,
  ]
  const stuckEntries = Object.entries(stuck)
  if (stuckEntries.length > 0) {
    const details = stuckEntries.map(([f, n]) => `${f}（${n} 次）`).join("、")
    parts.push("", `⚠ 检测到重复编辑模式：${details}，建议审查是否陷入无效循环，考虑人工介入修改。`)
  }
  if (workflow.commit.status === "allowed") {
    parts.push("", "⚑ SDLC 已完成，请提醒开发者执行 /new 开始下一个需求（保持统计隔离）。")
  }
  return parts.join("\n")
}

/** 生成 experimental.chat.system.transform 处理器（闭包持有 store）。 */
export function createSystemTransform(store: Store) {
  return async (
    input: { sessionID?: string },
    output: { system: string[] },
  ): Promise<void> => {
    if (!input.sessionID) return
    const row = store.ensure(input.sessionID)
    const workflow = row.workflow
    if (!workflow) return
    output.system.push(buildSystemFragment(workflow, getStuckFiles(input.sessionID)))
  }
}
