/**
 * 锁定拦截(设计文档 5「人工文件锁」)。
 * tool.execute.before:对 write/edit/apply_patch 提取目标文件,
 * 任一被锁则 throw 中文错误阻断执行(硬拦截,与提交门禁同哲学)。
 * 上游对所有插件 before hook 统一触发(session/tools.ts:106),故本插件即可拦全部编辑工具。
 */
import type { LockRegistry } from "./lock"
import { extractTargetFiles } from "./patched"

export function createLockGate(registry: LockRegistry, directory: string) {
  return async (input: { tool: string; sessionID: string }, output: { args: unknown }): Promise<void> => {
    const files = extractTargetFiles(input.tool, output.args, directory)
    if (files.length === 0) return
    const locked = files.filter((f) => registry.isLocked(input.sessionID, f))
    if (locked.length === 0) return
    throw new Error(
      `🔒 人工文件锁：以下文件正被开发者锁定（人工修改中），AI 不得修改：${locked.join("、")}。` +
        `请先与开发者确认改完后，调用 unlock_file 解锁，再重新读取最新文件内容后继续。`,
    )
  }
}
