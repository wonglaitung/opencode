/**
 * reqdoc 功能点拆解工具（重构核心：prd 前置功能点拆解 + 业务确认）。
 * reqdoc_confirm_features —— AI 综合 goal/rules/edge 收集的信息拟功能点清单，
 * 向业务展示确认后调用本工具记录（写入 **kb.features**，功能点单一事实源），
 * 并在 06_功能点 下为每个功能点建子目录（N_名称/）作为渲染来源区。
 *
 * 事实源说明：槽位地址 `5.{序号}.*`、kbGate、组装、review 全部从 `kb.features` 派生
 * （见 reqdoc-kb-tools.readKb）。历史缺陷：本工具曾写入 `workflow.features`，而
 * `reqdoc_ingest(features:)` 写入 `kb.features` —— kb 建立后本工具的写入对地址体系无效，
 * 却仍按新列表重建 06/07 目录，造成目录、槽位地址、门禁三者不一致。
 */
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { getDefinition, featuresAppendViolation, hasFeatureScopedSlots, type ReqdocFeature } from "sm-shared"
import type { Store } from "../db"
import { WorkflowOpError } from "../workflow-ops"
import { sanitizeDirName } from "./reqdoc-dirs"
import { readKb } from "./reqdoc-kb-tools"
import { projectRoot } from "../fs-safe"

const z = tool.schema

export function createReqdocFeatureTools(store: Store): Record<string, ToolDefinition> {
  const reqdoc_confirm_features = tool({
    description:
      "reqdoc prd 阶段：功能点拆解确认。AI 已向业务展示拟定的功能点清单（编号/名称/优先级），" +
      "业务明确确认后调用本工具记录清单，并为每个功能点在 06_功能点 下建子目录（N_名称/）" +
      "作为后续按模版渲染的来源区。**prd 门禁：进入 prd 前必须先调用本工具确认功能点清单**（功能点是槽位派生必填项的来源，未确认则知识库无法覆盖）。" +
      "**本工具是「整体替换」语义**（清单按序重编号），而已确认槽位的功能点地址（形如 `<功能点章号>.<序号>.*`）是按序号索引的：因此" +
      "**已有功能点要加新功能时必须传入「原清单 + 末尾追加的新功能」，不得插在中间、不得删除或改名**——" +
      "插入/删除/改名会让既有槽位地址漂移、内容错位，门禁判成未填导致业务被要求重述整份需求，且不会报错说明原因。" +
      "仅 reqdoc 工作流有效。",
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
        const kb = readKb(workflow)
        // 纯追加校验放在写入之前：地址按序号索引，重排会让既有槽位地址漂移（静默大面积重问）
        const violation = featuresAppendViolation(kb.features, records, hasFeatureScopedSlots(kb.slots))
        if (violation) throw new WorkflowOpError(violation)
        kb.features = records
        kb.updatedAt = Date.now()
        workflow.kb = kb
        // 清掉顶层遗留列表：全仓唯一的读者是 readKb 的「kb 尚未建立」兜底，kb 一旦建立就不可达。
        // 留着它等于埋一份日后可能被误读的旧列表——本缺陷正是两份各写各的造成的。
        delete workflow.features
      })
      // 目录与回执一律读 kb.features——与槽位地址、门禁、组装同源
      const features = saved.kb?.features ?? []
      // 为每个功能点在 06_功能点 下建子目录（AI 工作区，幂等不覆盖），并预建 07_需求规格产出 同名子目录
      // （模板外成果落盘位：附_流程图/、测试用例/、界面草图/ 与最终 PRD，见 reqdoc-r20 归档要求）。
      let created = 0
      const root = projectRoot(context)
      for (const f of features) {
        const dir = join(root, "06_功能点", `${f.no}_${sanitizeDirName(f.name)}`)
        await mkdir(dir, { recursive: true })
        await writeFile(
          join(dir, "来源摘录.md"),
          `# 功能点 ${f.no}：${f.name}\n\n- 优先级：${f.priority}\n- 业务确认时间：${new Date(f.confirmedAt).toISOString()}\n\n渲染时从本目录来源摘录 + 问答补全填充模版第三章（逐字段标 [文档]/[问答]/[缺省]）。\n`,
        )
        await mkdir(join(root, "07_需求规格产出", `${f.no}_${sanitizeDirName(f.name)}`), { recursive: true })
        created++
      }
      const list = features
        .map((f) => `  ${f.no}. ${f.name}（${f.priority === "high" ? "高" : f.priority === "medium" ? "中" : "低"}）`)
        .join("\n")
      return `✅ 已确认 ${created} 个功能点（写入 06_功能点 目录，并预建 07_需求规格产出 同名子目录）：\n${list}\n接下来按《业务需求说明书》模板逐功能点生成文档，内容来源标注 [文档]/[问答]/[缺省]。`
    },
  })

  return { reqdoc_confirm_features }
}
