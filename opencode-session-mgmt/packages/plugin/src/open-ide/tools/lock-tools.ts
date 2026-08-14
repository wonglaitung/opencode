/**
 * 人工文件锁工具(设计文档 5)。
 * lock_file             —— 开发者声明某文件由人工接管,AI 不得修改
 * unlock_file           —— 解锁;须开发者明确确认(developer_confirmed=true)
 * list_locked_files     —— 查看当前会话锁定清单
 * 锁定/解锁均在服务端校验,不依赖 LLM 自觉。
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { LockRegistry } from "../lock"
import { OpenIdeError } from "../errors"

const z = tool.schema

export function createLockTools(registry: LockRegistry): Record<string, ToolDefinition> {
  const lock_file = tool({
    description:
      "人工文件锁：开发者声明指定文件由自己手工接管，AI 不得对其 write/edit/apply_patch。" +
      "通常由 open_ide 打开文件时自动加锁；也可手动调用本工具锁定。",
    args: {
      file: z.string().describe("要锁定的文件路径（相对项目目录或绝对路径）"),
    },
    async execute(args, context) {
      registry.lock(context.sessionID, args.file)
      return `🔒 已锁定 ${args.file}。锁定期间 AI 不得修改该文件；改完请开发者确认后调用 unlock_file 解锁。`
    },
  })

  const unlock_file = tool({
    description:
      "人工文件锁：解锁指定文件。须开发者明确确认已改完（developer_confirmed=true）才生效。" +
      "解锁后 AI 应重新读取最新文件内容再继续编辑。",
    args: {
      file: z.string().describe("要解锁的文件路径（相对项目目录或绝对路径）"),
      developer_confirmed: z
        .boolean()
        .describe("必须为 true，表示开发者已明确确认改完该文件（如说「改完了/可以继续」）"),
    },
    async execute(args, context) {
      if (args.developer_confirmed !== true) {
        throw new OpenIdeError("解锁需开发者明确确认：developer_confirmed 必须为 true")
      }
      registry.unlock(context.sessionID, args.file)
      return `🔓 已解锁 ${args.file}。请先重新读取最新文件内容，再基于新内容继续。`
    },
  })

  const list_locked_files = tool({
    description: "查看当前会话被人工锁定的文件清单。",
    args: {},
    async execute(_args, context) {
      const locked = registry.list(context.sessionID)
      if (locked.length === 0) return "当前无人工锁定的文件。"
      return `🔒 当前锁定：\n${locked.map((f) => `- ${f}`).join("\n")}`
    },
  })

  return { lock_file, unlock_file, list_locked_files }
}
