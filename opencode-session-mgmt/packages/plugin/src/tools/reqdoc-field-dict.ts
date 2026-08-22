/**
 * reqdoc 字段定义工具（质量飞轮 P2.5 数据字典）。
 * reqdoc_field_dict —— 进 prd 渲染前，对每个功能点输入字段逐一定义（名称/类型/长度/必填/取值/来源系统），
 * 记录进 workflow.fieldDict，并写入 06_需求规格产出/数据字典与库表设计/数据字典.md。
 * 逐字段与业务确认后才调用；字段定义是 material 维度（真实字段/接口证据）的直接来源。
 * 仅 reqdoc 工作流有效（规则 reqdoc-r31）。
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { getDefinition, type ReqdocFieldDef } from "sm-shared"
import type { Store } from "../db"
import { WorkflowOpError } from "../workflow-ops"
import { projectRoot, resolveWithinWorktree } from "../fs-safe"

const z = tool.schema

const DICT_REL = "06_需求规格产出/数据字典与库表设计/数据字典.md"

function dictMarkdown(fields: ReqdocFieldDef[]): string {
  const byFeature = new Map<string, ReqdocFieldDef[]>()
  for (const f of fields) {
    if (!byFeature.has(f.feature)) byFeature.set(f.feature, [])
    byFeature.get(f.feature)!.push(f)
  }
  const parts: string[] = ["# 数据字典", ""]
  for (const [feature, list] of byFeature) {
    parts.push(`## 功能点：${feature}`, "")
    parts.push("| 字段名 | 类型 | 长度/精度 | 必填 | 取值域/约束 | 来源系统/接口 |")
    parts.push("|--------|------|-----------|------|-------------|----------------|")
    for (const f of list) {
      parts.push(
        `| ${f.name} | ${f.type} | ${f.length ?? "—"} | ${f.required ? "是" : "否"} | ${f.values ?? "—"} | ${f.sourceSystem ?? "—"} |`,
      )
    }
    parts.push("")
  }
  return parts.join("\n")
}

export function createReqdocFieldDictTools(store: Store): Record<string, ToolDefinition> {
  const reqdoc_field_dict = tool({
    description:
      "reqdoc 字段定义（数据字典，P2.5）：进 prd 渲染前，对每个功能点输入字段逐一定义——字段名、类型、长度/精度、是否必填、取值域/约束、来源系统/接口——" +
      "与业务确认后调用，记录进 workflow.fieldDict 并写入 06_需求规格产出/数据字典与库表设计/数据字典.md。" +
      "字段定义是 material 维度（真实字段/接口证据）的直接来源，缺失则对应维度扣分。已确认功能点较多时可分批提交，服务端按 feature 合并。" +
      "仅 reqdoc 工作流有效。",
    args: {
      fields: z
        .array(
          z.object({
            feature: z.string().describe("所属功能点（与已确认功能点名称一致）"),
            name: z.string().describe("字段名"),
            type: z.string().describe("类型（如 字符串/数值/日期/枚举）"),
            length: z.string().optional().describe("长度/精度（可选）"),
            required: z.boolean().describe("是否必填"),
            values: z.string().optional().describe("取值域/约束（可选，如枚举值、格式）"),
            sourceSystem: z.string().optional().describe("来源系统/接口（可选，用于 material 维度证据）"),
          }),
        )
        .min(1)
        .describe("本次提交的功能点字段定义（可分批；同 feature+name 以最后一次为准）"),
    },
    async execute(args, context) {
      const saved = store.mutateWorkflow(context.sessionID, (workflow) => {
        const def = getDefinition(workflow.type)
        if (def.type !== "reqdoc") {
          throw new WorkflowOpError(`reqdoc_field_dict 仅用于 reqdoc 工作流（当前为 ${def.type}）`)
        }
        const prev = workflow.fieldDict ?? []
        const merged = new Map<string, ReqdocFieldDef>()
        for (const f of prev) merged.set(`${f.feature} ${f.name}`, f)
        for (const f of args.fields) merged.set(`${f.feature} ${f.name}`, f)
        workflow.fieldDict = [...merged.values()]
      })
      const fields = saved.fieldDict!
      const root = projectRoot(context)
      const abs = resolveWithinWorktree(root, DICT_REL)
      await mkdir(dirname(abs), { recursive: true })
      await Bun.write(abs, dictMarkdown(fields))
      const byFeature = new Set(fields.map((f) => f.feature))
      return (
        `已记录字段定义 ${fields.length} 项（覆盖 ${byFeature.size} 个功能点），数据字典已写入 ${DICT_REL}。` +
        `字段定义是 material 维度（真实字段/接口证据）的直接来源；逐字段与业务确认后再渲染 PRD。`
      )
    },
  })

  return { reqdoc_field_dict }
}
