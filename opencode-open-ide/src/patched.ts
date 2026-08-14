/**
 * 从代码编辑工具入参提取目标文件(设计文档 5「人工文件锁」)。
 * 拦截点:tool.execute.before 收到本次调用完整入参 output.args,
 * 需从其中识别 AI 想改哪些文件,再与锁集合比对。纯函数,便于单测。
 * 三个工具的数据来源(与上游定义核对,见下):
 *   write / edit —— 入参 filePath(上游保证为绝对路径,edit.ts:48 注释原话)
 *   apply_patch  —— 入参仅 patchText,目标文件在 `*** Add/Update/Delete File:` 头部
 *                   (格式与 sm-shared/loc.ts 解析口径一致:Move to 不重置,其余 *** 标记重置)
 * 入参缺失/畸形 → 空数组(宁漏勿误拦,同 gate.ts 哲学)。
 */
import { resolve } from "node:path"

/** 视为「代码编辑」并参与锁拦截的上游工具名(与 quality.ts 口径一致)。 */
export const CODE_EDIT_TOOLS = new Set(["write", "edit", "apply_patch"])

/** 从入参提取单个文件路径(write/edit);缺失返回 null。 */
function filePathOf(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null
  const a = args as Record<string, unknown>
  const p = a.filePath
  return typeof p === "string" && p.trim() !== "" ? p : null
}

/** 从 apply_patch 的 patchText 提取目标文件列表(相对项目目录,调用方负责 resolve)。 */
export function patchedFilesOf(patchText: string): string[] {
  const files: string[] = []
  const seen = new Set<string>()
  const lines = patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
  let file: string | null = null
  const add = (name: string | null) => {
    if (name !== null && name !== "" && !seen.has(name)) {
      seen.add(name)
      files.push(name)
    }
  }
  for (const line of lines) {
    if (line.startsWith("*** Add File:") || line.startsWith("*** Update File:") || line.startsWith("*** Delete File:")) {
      file = line.slice(line.indexOf(":") + 1).trim()
      add(file)
      continue
    }
    // Move to 为改名,不重置当前文件;其余 *** 标记(Begin/End Patch)重置
    if (line.startsWith("*** Move to:")) continue
    if (line.startsWith("***")) {
      file = null
      continue
    }
  }
  return files
}

/**
 * 提取本次工具调用涉及的目标文件(绝对路径)。
 * write/edit 取 filePath;apply_patch 解析 patchText 各 File 头,resolve 成绝对路径。
 * 未知工具或入参不完整 → 空数组。
 */
export function extractTargetFiles(toolName: string, args: unknown, directory: string): string[] {
  if (!CODE_EDIT_TOOLS.has(toolName)) return []
  if (typeof args !== "object" || args === null) return []
  if (toolName === "apply_patch") {
    const a = args as Record<string, unknown>
    const patchText = typeof a.patchText === "string" ? a.patchText : ""
    if (patchText === "") return []
    return patchedFilesOf(patchText).map((f) => resolve(directory, f))
  }
  const file = filePathOf(args)
  if (file === null) return []
  // 上游 filePath 已是绝对路径,resolve 幂等;保险起见对目录缺失的相对路径兜底
  return [resolve(directory, file)]
}
