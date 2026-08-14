/**
 * 人工文件锁 registry(设计文档 5「人工文件锁」、决策记录 D4)。
 * 进程内、按会话的文件锁集合:开发者打开 IDE 手工修改某文件时锁定,
 * 期间 tool.execute.before 拒绝 AI 对该文件的 write/edit/apply_patch,防覆盖。
 * 内存级(daemon 重启即失,与 stuck 短记忆同取舍);dispose 时 clear。
 * 相对路径一律以项目目录为基准 resolve 成绝对路径后比较,保证相对/绝对匹配一致。
 */
import { resolve } from "node:path"

export interface LockRegistry {
  /** 锁定一个文件(幂等:重复锁无副作用)。 */
  lock(sessionID: string, file: string): void
  /** 解锁一个文件(幂等:对未锁文件 no-op 成功)。 */
  unlock(sessionID: string, file: string): void
  /** 该文件是否被锁定。 */
  isLocked(sessionID: string, file: string): boolean
  /** 当前会话锁定的文件列表(绝对路径)。 */
  list(sessionID: string): string[]
  /** 清理某会话的全部锁(会话结束/插件卸载时)。 */
  clear(sessionID: string): void
  /** 清空全部锁(dispose)。 */
  clearAll(): void
}

/**
 * 创建锁 registry。
 * directory 为项目目录:相对路径以它为基准归一化,与 gate 侧(同样以项目目录解析
 * 工具入参)口径一致,保证锁定/拦截两端的相对与绝对路径都能正确匹配。
 */
export function createLockRegistry(directory: string): LockRegistry {
  const locks = new Map<string, Set<string>>()

  const norm = (file: string): string => resolve(directory, file)

  return {
    lock(sessionID, file) {
      const set = locks.get(sessionID) ?? new Set<string>()
      set.add(norm(file))
      locks.set(sessionID, set)
    },
    unlock(sessionID, file) {
      const set = locks.get(sessionID)
      if (!set) return
      set.delete(norm(file))
      if (set.size === 0) locks.delete(sessionID)
    },
    isLocked(sessionID, file) {
      return locks.get(sessionID)?.has(norm(file)) ?? false
    },
    list(sessionID) {
      return [...(locks.get(sessionID) ?? [])]
    },
    clear(sessionID) {
      locks.delete(sessionID)
    },
    clearAll() {
      locks.clear()
    },
  }
}
