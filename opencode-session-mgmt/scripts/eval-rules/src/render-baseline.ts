/**
 * baseline 注入渲染:镜像改造前的 packages/plugin/src/prompt.ts 逻辑——
 * 规则全文(fixtures 快照)+ 冗长 WorkflowState JSON + 迭代/门禁行。
 * 快照在改造前冻结,保证 baseline 可复现、与 new 可对等比较。
 */
import { getDefinition, reviewRecord, type WorkflowState } from "sm-shared"

const FIXTURES: Record<string, string> = {
  sdlc: "../fixtures/baseline/sdlc-rules.txt",
  reqdoc: "../fixtures/baseline/reqdoc-rules.txt",
}

export async function renderBaseline(workflow: WorkflowState): Promise<string> {
  const def = getDefinition(workflow.type)
  const rules = await Bun.file(new URL(FIXTURES[workflow.type], import.meta.url).pathname).text()

  const lines: string[] = []
  for (const name of def.stages) {
    const stage = workflow.stages[name]
    lines.push(`- ${def.labels[name] ?? name}(${name}): ${stage.status}，revision=${stage.revision}`)
  }
  const review = reviewRecord(workflow)
  const confirmed = review.comprehension.filter((c) => c.developerConfirmed).length
  const iteration = workflow.quality.iterationCount ?? 0
  const byFile = Object.entries(workflow.quality.iterationByFile ?? {})
  const hottest = byFile.sort((a, b) => b[1] - a[1])[0]

  const parts = [
    rules,
    "",
    "## 当前 WorkflowState",
    "```json",
    JSON.stringify(
      {
        stages: Object.fromEntries(def.stages.map((name) => [name, workflow.stages[name].status])),
        commit: workflow.commit,
        quality: workflow.quality,
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
  return parts.join("\n")
}
