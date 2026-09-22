/**
 * reqdoc 追问探针记录工具（质量飞轮 P1 追问可测化）。
 * reqdoc_probe —— 每轮追问结束后调用，记录「本轮问过的探针 + 仍缺口的探针 + 轮次」，
 * 写入 workflow.probes。让纯规则文本驱动的追问过程变成结构化、可评测、可在状态条/门禁处可见。
 * 柔性门禁：不强制记录；但一旦记录了缺口，缺口探针对应打分卡维度不得打满分
 * （probeGapViolations，workflow_advance 进 prd 与 review_submit 两处拦截）。
 * 仅 reqdoc 工作流有效。
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import {
  REQDOC_PROBES,
  getDefinition,
  type ReqdocProbes,
} from "sm-shared"
import type { Store } from "../db"
import { WorkflowOpError } from "../workflow-ops"

const z = tool.schema

const PROBE_IDS = REQDOC_PROBES.map((p) => p.id) as [string, ...string[]]

export function createReqdocProbeTools(store: Store): Record<string, ToolDefinition> {
  const reqdoc_probe = tool({
    description:
      "reqdoc 追问探针：每轮追问结束后调用，记录本轮问过与仍缺口的探针（探针清单与追问口径同 reqdoc-r11，单点事实源）。" +
      "asked = 本轮新问的探针 id（服务端按轮追加去重，含历史轮次）；gaps = 问过后仍缺口的探针 id（未问或未得全）。" +
      "round = 本轮次（1-3，缺省自动取上一轮 +1）。" +
      "材料已全覆盖、无追问时可调用一次（asked/gaps 可为空）标记覆盖完成；**进入 prd 前必须已调用本工具记录探针（P0.1 强制前置，workflow_advance(enter prd) 未记录即拦截）**。" +
      "仅 reqdoc 工作流有效。",
    args: {
      asked: z
        .array(z.enum(PROBE_IDS).describe("探针 id（探针清单之一）"))
        .default([])
        .describe("本轮新问过的探针 id（可空；服务端按轮追加去重）"),
      gaps: z
        .array(z.enum(PROBE_IDS).describe("探针 id（探针清单之一）"))
        .default([])
        .describe("问过后仍缺口的探针 id（可空；进入 prd 前如仍缺口须在 reqdoc_score 中如实扣分）"),
      round: z.number().int().min(1).max(3).optional().describe("当前追问轮次（1-3；缺省自动取上一轮 +1）"),
      businessDefault: z
        .boolean()
        .optional()
        .describe("本轮业务是否全部选择默认推荐（惰性确认）；为 true 时累计 defaultRounds，用于 review 阶段软提示需求真实性（reqdoc-r27）"),
    },
    async execute(args, context) {
      const saved = store.mutateWorkflow(context.sessionID, (workflow) => {
        const def = getDefinition(workflow.type)
        if (def.type !== "reqdoc") {
          throw new WorkflowOpError(`reqdoc_probe 仅用于 reqdoc 工作流（当前为 ${def.type}）`)
        }
        const prev = workflow.probes
        const asked = [...new Set([...(prev?.asked ?? []), ...args.asked])]
        const gaps = [...new Set(args.gaps)]
        const round = Math.min(args.round ?? (prev?.round ?? 0) + 1, 3)
        const defaultRounds = (prev?.defaultRounds ?? 0) + (args.businessDefault ? 1 : 0)
        workflow.probes = {
          asked,
          gaps,
          round,
          defaultRounds,
          updatedAt: Date.now(),
        }
      })
      return formatProbeCard(saved.probes!)
    },
  })

  return { reqdoc_probe }
}

/** 把覆盖记录格式化为工具返回文本：已确认 X/Y、缺口、轮次、10 格覆盖进度条。 */
function formatProbeCard(probes: ReqdocProbes): string {
  const total = REQDOC_PROBES.length
  const askedLabels = REQDOC_PROBES.filter((p) => probes.asked.includes(p.id))
    .map((p) => p.label)
    .join("、")
  const gapLines = probes.gaps.length
    ? REQDOC_PROBES.filter((p) => probes.gaps.includes(p.id))
        .map((p) => `  - ${p.label}`)
        .join("\n")
    : "  （无缺口）"
  const barLen = 10
  const filled = Math.round((probes.asked.length / total) * barLen)
  const bar = "▓".repeat(filled) + "░".repeat(barLen - filled)
  return (
    `📋 已记录信息覆盖（第 ${probes.round} 轮）：\n` +
    `已确认 ${probes.asked.length}/${total} 项：${askedLabels || "（无）"}\n` +
    `缺口项：\n${gapLines}\n` +
    `覆盖进度：[${bar}] ${Math.round((probes.asked.length / total) * 100)}%\n` +
    `→ 缺口项需在质量评分中如实扣分；补齐缺口后可重新评分，达标后可进入需求规格书阶段。`
  )
}
