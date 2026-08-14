/**
 * open_ide 工具（open-ide 合并，4）。独立成模块以便 index.ts 仅 default export 插件工厂。
 * 探测可用 IDE 拉起进程打开目录/定位文件行；带 file 时自动锁定该文件（防 AI 覆盖）。
 */
import { tool } from "@opencode-ai/plugin"
import type { IdeEntry } from "./config"
import { buildOpenArgs, launchIde, resolveIdeBinary, type OpenTarget } from "./ide"
import type { LockRegistry } from "./lock"

const z = tool.schema

export function createOpenIdeTool(entries: IdeEntry[], registry: LockRegistry) {
  return tool({
    description:
      "打开本机 IDE(默认按 config.json 顺序探测 VS Code → IntelliJ IDEA),供开发者人工查看/修改代码。" +
      "可打开项目目录,或用 file+line 定位到指定文件的指定行(column 可选)。" +
      "指定 file 时会自动锁定该文件(AI 不得修改,防覆盖手工改动);" +
      "适合开发者对 AI 生成代码不满意、想手工改写时使用。",
    args: {
      file: z.string().optional().describe("要打开的文件路径(相对项目目录或绝对路径);指定后自动锁定"),
      line: z.number().int().optional().describe("定位到指定行(配合 file 使用)"),
      column: z.number().int().optional().describe("定位列号(配合 file+line 使用,可选)"),
      ide: z
        .string()
        .optional()
        .describe("强制指定 IDE id(config.json 中存在的 id,如 vscode / idea;缺省按配置顺序取第一个可用的)"),
    },
    async execute(args, context) {
      const { ide, ...rest } = args
      const target: OpenTarget = {
        directory: context.directory,
        ...(rest.file !== undefined ? { file: rest.file } : {}),
        ...(rest.line !== undefined ? { line: rest.line } : {}),
        ...(rest.column !== undefined ? { column: rest.column } : {}),
      }
      const pool = ide ? entries.filter((e) => e.id === ide) : entries
      const { entry, binary } = resolveIdeBinary(pool)
      const openArgs = buildOpenArgs(entry.kind, target)
      launchIde(binary, openArgs, context.directory)
      // 带 file 打开 → 自动锁定该文件(5)。锁由开发者确认后 unlock_file 解除。
      if (target.file !== undefined) {
        registry.lock(context.sessionID, target.file)
      }
      const targetText = target.file
        ? `${target.file}${target.line !== undefined ? `:${target.line}${target.column !== undefined ? `:${target.column}` : ""}` : ""}`
        : target.directory
      return (
        `🖐 已用 ${entry.id} 打开 ${targetText}。` +
        (target.file !== undefined
          ? `该文件已锁定，AI 不会修改它。改完后请告诉开发者说「改完了」，由 AI 调用 unlock_file 解锁后继续。`
          : `请在 IDE 中人工修改，改完回到对话中继续。`)
      )
    },
  })
}
