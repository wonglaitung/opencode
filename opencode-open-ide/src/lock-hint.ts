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
        `若开发者已改完，请询问其明确确认（如「改完了/可以继续」）后调用 unlock_file 解锁，` +
        `再重新读取最新文件内容后继续。`,
    )
  }
}
