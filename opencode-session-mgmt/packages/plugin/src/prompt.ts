/**
 * system prompt 注入（设计文档 §7.1、§7.4）。
 * experimental.chat.system.transform hook 的实现：
 * 从插件库读当前会话 WorkflowState，将规则全文 + 状态压缩 JSON 追加到 output.system。
 */
import { STAGE_LABELS, STAGE_ORDER, type StageName, type WorkflowState } from "sm-shared"
import type { Store } from "./db"

const RULES = `# Workflow Agent 规则

## 阶段推进
1. 会话开始时初始化 workflow（所有阶段 not_started）。
2. 阶段可能完成时，先输出摘要并询问确认；开发者明确确认后才可调用 workflow_advance 标记 approved。
3. 开发者说"回到XX"时，立即调用 workflow_revisit。
4. 绝不自行判断阶段已完成——阶段转换的唯一来源是开发者的明确操作。
5. 要求提交时先调用 commit_gate_check，检查全部五个阶段（含审查）。

## 审查阶段（理解保障，核心）
6. 审查是唯一不可由 AI 自行推进的阶段，目标是确保开发者真正理解代码。
7. 进入审查后，将每个 AI 生成的代码变更拆分为可理解片段，逐段输出自然语言解释
   （做了什么、为什么这样写、被放弃的替代方案、潜在风险）。
8. 开发者必须逐段确认：comprehension_confirm 单次只接受一个 codeSegmentId。
9. 开发者追问时详细解释，并将问答追加到该片段的 explanation（comprehension_ask）。
10. 全部片段确认后才可 review_submit；清单四项须全为 true，否则回到编码/测试。

## 采纳率与迭代上限
11. 跟踪 acceptanceRate；单会话 >45% 时提醒开发者可能未充分审查。
12. 同一段代码 AI 生成-修改循环达 3 轮时，拒绝继续生成，提示人工重写。`

/** 将当前工作流压缩为注入片段：规则 + 阶段进度 + 质量指标 + 剩余额度。 */
export function buildSystemFragment(workflow: WorkflowState): string {
  const lines: string[] = []
  for (const name of STAGE_ORDER) {
    const stage = workflow.stages[name as StageName]
    lines.push(`- ${STAGE_LABELS[name as StageName]}(${name}): ${stage.status}，revision=${stage.revision}`)
  }
  const review = workflow.stages.review
  const confirmed = review.comprehension.filter((c) => c.developerConfirmed).length
  const iteration = workflow.quality.iterationCount ?? 0
  const parts = [
    RULES,
    "",
    "## 当前 WorkflowState",
    "```json",
    JSON.stringify(
      {
        stages: Object.fromEntries(
          STAGE_ORDER.map((name) => [name, workflow.stages[name as StageName].status]),
        ),
        commit: workflow.commit,
        quality: workflow.quality,
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
    `迭代轮次：${iteration}/3${iteration >= 3 ? "（已达上限，需人工重写，勿再生成）" : ""}`,
    `提交门禁：${workflow.commit.status}${
      workflow.commit.blocked_by.length > 0 ? `（未完成：${workflow.commit.blocked_by.join("、")}）` : ""
    }`,
  ]
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
    output.system.push(buildSystemFragment(workflow))
  }
}
