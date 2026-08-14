/**
 * 插件入口(设计文档 2、3.2)。
 * 铁律:入口文件只允许 default export 插件函数——
 * 上游 legacy loader 会遍历模块全部导出,其他命名导出会导致加载失败。
 * 注册 open_ide 工具:按 config.json 顺序探测可用 IDE,拉起进程打开目录/定位文件行。
 */
import { tool, type Plugin } from "@opencode-ai/plugin"
import { loadIdeConfig } from "./config"
import { buildOpenArgs, launchIde, resolveIdeBinary, type OpenTarget } from "./ide"

const z = tool.schema

const OpenIdePlugin: Plugin = async (input) => {
  // config.json 位于插件目录根(本文件上溯一层),用户在此自定义次序与工具
  const entries = loadIdeConfig(import.meta.dir)

  const openIde = tool({
    description:
      "打开本机 IDE(默认按 config.json 顺序探测 VS Code → IntelliJ IDEA),供开发者人工查看/修改代码。" +
      "可打开项目目录,或用 file+line 定位到指定文件的指定行(column 可选)。" +
      "适合开发者对 AI 生成代码不满意、想手工改写时使用。",
    args: {
      file: z.string().optional().describe("要打开的文件路径(相对项目目录或绝对路径)"),
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
      const targetText = target.file
        ? `${target.file}${target.line !== undefined ? `:${target.line}${target.column !== undefined ? `:${target.column}` : ""}` : ""}`
        : target.directory
      return `🖐 已用 ${entry.id} 打开 ${targetText}。请在 IDE 中人工修改,改完回到对话中继续。`
    },
  })

  return {
    tool: {
      open_ide: openIde,
    },
  }
}

export default OpenIdePlugin
