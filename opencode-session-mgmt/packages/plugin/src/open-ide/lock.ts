/**
 * 人工文件锁 registry（open-ide 合并，5）。
 * 接口与 open-ide 原版一致（lock/unlock/isLocked/list/clear/clearAll），
 * 后端从内存 Map 改为 SQLite（Store.file_lock 表，v4 迁移）：
 * 锁按会话隔离、磁盘持久化，daemon 重启自动恢复（合并决策）。
 * 相对路径一律以项目目录为基准 resolve 成绝对路径后比较，保证相对/绝对匹配一致。
 */
import { resolve } from "node:path"
import type { Store } from "../db"

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
export function createLockRegistry(directory: string, store: Store): LockRegistry {
  const norm = (file: string): string => resolve(directory, file)

  return {
    lock(sessionID, file) {
      store.lockFile(sessionID, norm(file))
    },
    unlock(sessionID, file) {
      store.unlockFile(sessionID, norm(file))
    },
    isLocked(sessionID, file) {
      return store.isFileLocked(sessionID, norm(file))
    },
    list(sessionID) {
      return store.listLocks(sessionID)
    },
    clear(sessionID) {
      store.clearLocks(sessionID)
    },
    clearAll() {
      store.clearAllLocks()
    },
  }
}
