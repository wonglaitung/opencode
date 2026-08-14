/**
 * 锁定状态注入(设计文档 5「人工文件锁」)。
 * experimental.chat.system.transform:有锁定文件时向 output.system push 一段提示,
 * 让 AI 知道哪些文件正被人工修改、不得编辑,并引导询问开发者确认后 unlock_file。
 * 与 session-mgmt 各自独立向 output.system push,互不覆盖(上游按序调用各 hook)。
 * 判空 sessionID、无锁时直接跳过(零开销)。
 */
import type { LockRegistry } from "./lock"

export function createLockHintTransform(registry: LockRegistry) {
  return async (input: { sessionID?: string }, output: { system: string[] }): Promise<void> => {
    if (!input.sessionID) return
    const locked = registry.list(input.sessionID)
    if (locked.length === 0) return
    output.system.push(
      `## 人工文件锁\n⚠ 当前被开发者锁定的人工修改文件：${locked.join("、")}。` +
        `锁定期间不得对这些文件执行 write/edit/apply_patch（服务端会拒绝）。` +
        `开发者说「改完了/可以继续」时，须先确认其指的是哪一个文件` +
        `（可能只改完其中一个），再为每个已确认的文件单独调用 unlock_file；` +
        `未明确提及的文件保持锁定，不得擅自解锁。` +
        `解锁后重新读取该文件最新内容再继续。`,
    )
  }
}
