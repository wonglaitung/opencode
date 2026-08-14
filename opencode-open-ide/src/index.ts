/**
 * 插件入口(设计文档 2、3.2、5)。
 * 铁律:入口文件只允许 default export 插件函数——
 * 上游 legacy loader 会遍历模块全部导出,其他命名导出会导致加载失败。
 * 注册:
 *   - open_ide               按 config.json 顺序探测可用 IDE,拉起进程打开目录/定位文件行;
 *                            带 file 时自动加人工锁,防 AI 覆盖手工改动
 *   - lock_file/unlock_file/list_locked_files   人工文件锁工具(5)
 *   - tool.execute.before    锁定拦截(5):write/edit/apply_patch 目标被锁则抛错阻断
 *   - experimental.chat.system.transform        锁定状态注入(5):提醒 AI 勿改锁定文件
 */
import { tool, type Plugin } from "@opencode-ai/plugin"
import { loadIdeConfig } from "./config"
import { buildOpenArgs, launchIde, resolveIdeBinary, type OpenTarget } from "./ide"
import { createLockRegistry } from "./lock"
import { createLockGate } from "./lock-gate"
import { createLockHintTransform } from "./lock-hint"
import { createLockTools } from "./tools/lock-tools"

const z = tool.schema

const OpenIdePlugin: Plugin = async (input) => {
  // config.json 位于插件目录根(本文件上溯一层),用户在此自定义次序与工具
  const entries = loadIdeConfig(import.meta.dir)
  const registry = createLockRegistry(input.directory)

  const openIde = tool({
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
      // 带 file 打开 → 自动锁定该文件(设计文档 5)。锁由开发者确认后 unlock_file 解除。
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

  return {
    tool: {
      open_ide: openIde,
      ...createLockTools(registry),
    },
    "tool.execute.before": createLockGate(registry, input.directory),
    "experimental.chat.system.transform": createLockHintTransform(registry),
    dispose: async () => {
      registry.clearAll()
    },
  }
}

export default OpenIdePlugin
