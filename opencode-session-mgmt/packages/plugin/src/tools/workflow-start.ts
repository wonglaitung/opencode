/**
 * workflow_start 工具（设计文档 session-management.md 7.4）。
 * 确定性启动工作流：将当前会话工作流的第一阶段置为 in_progress。
 * 触发语义写在工具 description 中（开发者说「启动/开始 X 工作流」即调用），
 * 比自由文本解析可靠；global 规则 sdlc-r1/reqdoc-r1 同步指向本工具，规则条数不变。
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { getDefinition } from "sm-shared"
import type { Store } from "../db"
import { WorkflowOpError, applyTransition } from "../workflow-ops"

const z = tool.schema

export function createWorkflowStartTools(store: Store): Record<string, ToolDefinition> {
  const workflow_start = tool({
    description:
      "启动当前会话的工作流，将第一阶段置为进行中。" +
      "开发者说「启动/开始 X 工作流」（如「启动SDLC工作流」）时必须立即调用本工具，不要仅用文字回复。" +
      "SDLC 第一阶段为 requirements（需求分析），reqdoc 为 goal（目标与场景）。",
    args: {
      type: z
        .enum(["sdlc", "reqdoc"])
        .optional()
        .describe("要启动的工作流类型；缺省取当前会话已定的工作流类型（由 identity.workflowType 决定，默认 sdlc）"),
    },
    async execute(args, context) {
      const saved = store.mutateWorkflow(context.sessionID, (workflow) => {
        if (args.type && args.type !== workflow.type) {
          throw new WorkflowOpError(
            `本会话工作流类型已是 ${workflow.type}，无法启动 ${args.type}；如需切换请开新会话重新初始化。`,
          )
        }
        const def = getDefinition(workflow.type)
        const first = def.stages[0]!
        const status = workflow.stages[first].status
        // 已启动（in_progress/approved）：幂等跳过，避免 applyTransition 走 revisit/报错路径
        if (status === "in_progress" || status === "approved") return
        applyTransition(workflow, first, "enter", Date.now(), "开发者启动工作流")
      })
      const def = getDefinition(saved.type)
      const first = def.stages[0]!
      const st = saved.stages[first]
      const label = def.labels[first] ?? first
      if (st.status === "in_progress" || st.status === "approved") {
        return `✅ ${def.type} 工作流已启动，第一阶段「${label}」状态 ${st.status === "in_progress" ? "进行中" : "已通过"}。请按阶段化规则继续推进。`
      }
      return `✅ 已启动 ${def.type} 工作流，第一阶段「${label}」进入进行中。`
    },
  })

  return { workflow_start }
}
