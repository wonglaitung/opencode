/**
 * opencode-sm workflow <sessionID> [checklist|comprehension|stats]
 * 工作流状态外部查看（设计文档 5.1）。只读本机插件库。
 */
import { STAGE_LABELS, STAGE_ORDER, type StageName } from "sm-shared"
import { openPluginStore } from "../api"
import type { ParsedArgs } from "../index"

export async function runWorkflow(args: ParsedArgs): Promise<void> {
  const sessionID = args.positionals[0]
  const sub = args.positionals[1]
  if (!sessionID) {
    process.stderr.write("用法: opencode-sm workflow <sessionID> [checklist|comprehension|stats]\n")
    process.exitCode = 1
    return
  }
  const store = openPluginStore(process.cwd())
  try {
    const row = store.get(sessionID)
    if (!row || !row.workflow) {
      process.stdout.write(`会话 ${sessionID} 无工作流数据（可能未被插件追踪）。\n`)
      return
    }
    const workflow = row.workflow
    if (sub === "checklist") {
      const c = workflow.stages.review.checklist
      const lines = [
        `businessIntent:     ${mark(c.businessIntent)}`,
        `logicExplainable:   ${mark(c.logicExplainable)}`,
        `behaviorVerifiable: ${mark(c.behaviorVerifiable)}`,
        `designRationale:    ${mark(c.designRationale)}`,
      ]
      process.stdout.write(`审查清单（${sessionID}）\n${lines.join("\n")}\n`)
      return
    }
    if (sub === "comprehension") {
      let records = workflow.stages.review.comprehension
      if (args.flags.unconfirmed) records = records.filter((r) => !r.developerConfirmed)
      if (records.length === 0) {
        process.stdout.write("无理解确认记录。\n")
        return
      }
      for (const r of records) {
        process.stdout.write(
          `${r.developerConfirmed ? "✅" : "⬜"} ${r.codeSegmentId}（${r.file}:${r.lines[0]}-${r.lines[1]}）\n`,
        )
      }
      return
    }
    if (sub === "stats") {
      const q = workflow.quality
      const review = workflow.stages.review
      const confirmed = review.comprehension.filter((c) => c.developerConfirmed).length
      process.stdout.write(
        `质量指标（${sessionID}）\n` +
          `  一次通过率: ${fmtPct(q.firstPassRate)}  迭代轮次: ${q.iterationCount ?? "N/A"}/3\n` +
          `  返工率: ${fmtPct(q.reworkRate)}  测试覆盖率: ${fmtPct(q.testCoverage)}\n` +
          `  理解确认: ${confirmed}/${review.comprehension.length}\n`,
      )
      return
    }
    // 默认：阶段进度总览
    const lines = STAGE_ORDER.map((name) => {
      const stage = workflow.stages[name as StageName]
      return `  ${STAGE_LABELS[name as StageName].padEnd(6, " ")} ${stage.status.padEnd(12)} revision=${stage.revision}`
    })
    const force = workflow.commit.force
    const forceLine = force
      ? `\n强制提交授权: ${force.used ? "已使用" : "待使用"}（原因: ${force.reason}）`
      : ""
    process.stdout.write(
      `工作流（${sessionID}）\n${lines.join("\n")}\n提交门禁: ${workflow.commit.status}` +
        (workflow.commit.blocked_by.length ? `（未完成: ${workflow.commit.blocked_by.join("、")}）` : "") +
        forceLine +
        "\n",
    )
  } finally {
    store.close()
  }
}

function mark(ok: boolean): string {
  return ok ? "✓" : "✗"
}

function fmtPct(v: number | null): string {
  return v === null ? "N/A" : `${v}%`
}
