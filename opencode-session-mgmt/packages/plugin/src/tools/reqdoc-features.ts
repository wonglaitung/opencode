/**
 * reqdoc 功能点拆解工具（重构核心：prd 前置功能点拆解 + 业务确认）。
 * reqdoc_confirm_features —— AI 综合 goal/rules/edge 收集的信息拟功能点清单，
 * 向业务展示确认后调用本工具记录（写入 workflow.features，随汇报上行），
 * 并在 05_功能点 下为每个功能点建子目录（N_名称/）作为渲染来源区。
 */
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { getDefinition, type ReqdocFeature } from "sm-shared"
import type { Store } from "../db"
import { WorkflowOpError } from "../workflow-ops"

const z = tool.schema

export function createReqdocFeatureTools(store: Store): Record<string, ToolDefinition> {
  const reqdoc_confirm_features = tool({
    description:
      "reqdoc prd 阶段：功能点拆解确认。AI 已向业务展示拟定的功能点清单（编号/名称/优先级），" +
      "业务明确确认后调用本工具记录清单，并为每个功能点在 05_功能点 下建子目录（N_名称/）" +
      "作为后续按模版渲染的来源区。仅 reqdoc 工作流有效。",
    args: {
      features: z
        .array(
          z.object({
            name: z.string().describe("功能点名称（如：名单排查）"),
            priority: z.enum(["high", "medium", "low"]).describe("优先级：high 高 / medium 中 / low 低"),
            note: z.string().optional().describe("备注（可选，业务补充说明）"),
          }),
        )
        .min(1)
        .describe("业务已确认的功能点清单（至少一个）"),
    },
    async execute(args, context) {
      const saved = store.mutateWorkflow(context.sessionID, (workflow) => {
        const def = getDefinition(workflow.type)
        if (def.type !== "reqdoc") {
          throw new WorkflowOpError(`reqdoc_confirm_features 仅用于 reqdoc 工作流（当前为 ${def.type}）`)
        }
        const records: ReqdocFeature[] = args.features.map((f, i) => ({
          no: i + 1,
          name: f.name,
          priority: f.priority,
          confirmedAt: Date.now(),
          note: f.note,
        }))
        workflow.features = records
      })
      // 为每个功能点在 05_功能点 下建子目录（AI 工作区，幂等不覆盖）
      let created = 0
      for (const f of saved.features ?? []) {
        const dir = join(context.worktree, "05_功能点", `${f.no}_${f.name}`)
        await mkdir(dir, { recursive: true })
        await writeFile(
          join(dir, "来源摘录.md"),
          `# 功能点 ${f.no}：${f.name}\n\n- 优先级：${f.priority}\n- 业务确认时间：${new Date(f.confirmedAt).toISOString()}\n\n渲染时从本目录来源摘录 + 问答补全填充模版第三章（逐字段标 [文档]/[问答]/[缺省]）。\n`,
        )
        created++
      }
      const list = (saved.features ?? [])
        .map((f) => `  ${f.no}. ${f.name}（${f.priority === "high" ? "高" : f.priority === "medium" ? "中" : "低"}）`)
        .join("\n")
      return `✅ 已确认 ${created} 个功能点（写入 05_功能点 目录）：\n${list}\n接下来按《业务需求说明书》模板逐功能点渲染，内容来源标注 [文档]/[问答]/[缺省]。`
    },
  })

  return { reqdoc_confirm_features }
}
