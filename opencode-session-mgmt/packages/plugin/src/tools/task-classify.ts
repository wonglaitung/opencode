import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { TASK_CATEGORY_KEYS, taskCategoryLabel } from "sm-shared"
import type { Store } from "../db"
import { WorkflowOpError } from "../workflow-ops"

const z = tool.schema

export function createTaskClassifyTool(store: Store): Record<string, ToolDefinition> {
  const task_classify = tool({
    description:
      "记录本次一般任务的类型，仅用于统计，不改变流程，也不要写入 note。" +
      "可选：documentation 编写文档 / testing 运行测试 / debugging 排查错误 / " +
      "coding 代码修改 / research 调研分析 / environment 配置环境 / other 其他。" +
      "须先由 workflow_start 启动任务；一般任务首轮应先调用本工具归类，不要只追问；无法判断用 other；可重复调用覆盖。",
    args: {
      category: z.enum(TASK_CATEGORY_KEYS).describe("任务类型枚举码；无法判断用 other"),
    },
    async execute(args, context) {
      // 未启动不得归类：先读后写，避免 task_classify 自己经 ensure 建出一条未启动的行
      // （子代理或模型抢先调用时会留下只有分类的半成品）。
      const current = store.get(context.sessionID)?.workflow
      if (!current) {
        throw new WorkflowOpError("一般任务尚未启动：请先调用 workflow_start 启动后再归类。")
      }
      if (current.type !== "task") {
        throw new WorkflowOpError("task_classify 仅适用于一般任务工作流")
      }
      if (current.stages.execute?.status === "not_started") {
        throw new WorkflowOpError(
          "一般任务尚未启动：请先调用 workflow_start（开发者说「启动一般任务」或直接描述任务）后再归类。",
        )
      }
      const saved = store.mutateWorkflow(context.sessionID, (workflow) => {
        if (workflow.type !== "task") {
          throw new WorkflowOpError("task_classify 仅适用于一般任务工作流")
        }
        if (workflow.task?.category === args.category && workflow.task.source === "model") return
        workflow.task = { category: args.category, source: "model", setAt: Date.now() }
      })
      return `✅ 已记录任务分类：${taskCategoryLabel(saved.task?.category)}（仅统计）`
    },
  })

  return { task_classify }
}
