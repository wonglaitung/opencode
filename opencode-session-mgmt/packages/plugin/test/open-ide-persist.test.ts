/**
 * 人工文件锁持久化测试（open-ide 合并）。
 * 覆盖：Store 锁表读写、锁残留修剪（pruneLocks）、锁表迁移（v4）。
 */
import { describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { pruneLocks } from "../src/startup"

describe("Store 文件锁持久化（file_lock 表）", () => {
  test("lockFile 幂等 + isFileLocked/listLocks", () => {
    const store = Store.memory()
    store.lockFile("s1", "/home/dev/project/src/A.java")
    store.lockFile("s1", "/home/dev/project/src/A.java")
    expect(store.isFileLocked("s1", "/home/dev/project/src/A.java")).toBe(true)
    expect(store.isFileLocked("s2", "/home/dev/project/src/A.java")).toBe(false)
    expect(store.listLocks("s1")).toEqual(["/home/dev/project/src/A.java"])
    store.close()
  })

  test("unlockFile 删除单条，clearLocks 清会话", () => {
    const store = Store.memory()
    store.lockFile("s1", "/a")
    store.lockFile("s1", "/b")
    store.unlockFile("s1", "/a")
    expect(store.isFileLocked("s1", "/a")).toBe(false)
    expect(store.isFileLocked("s1", "/b")).toBe(true)
    store.clearLocks("s1")
    expect(store.listLocks("s1")).toEqual([])
    store.close()
  })

  test("锁跨 Store 实例持久化（同一库文件）", () => {
    const dir = "/tmp/session-mgmt-file-lock-persist-test"
    // 写库
    const s1 = Store.open(dir, () => "sdlc")
    s1.lockFile("s1", "/home/dev/project/src/A.java")
    s1.close()
    // 重开读
    const s2 = Store.open(dir, () => "sdlc")
    expect(s2.isFileLocked("s1", "/home/dev/project/src/A.java")).toBe(true)
    s2.close()
    // 清理测试库
    const { rmSync } = require("node:fs")
    rmSync(`${dir}/.opencode/session-mgmt.db`, { force: true })
    rmSync(`${dir}/.opencode/session-mgmt.db-wal`, { force: true })
    rmSync(`${dir}/.opencode/session-mgmt.db-shm`, { force: true })
    rmSync(`${dir}/.opencode`, { recursive: true, force: true })
  })

  test("listLockedSessions / clearAllLocks", () => {
    const store = Store.memory()
    store.lockFile("s1", "/a")
    store.lockFile("s2", "/b")
    expect(store.listLockedSessions().sort()).toEqual(["s1", "s2"])
    store.clearAllLocks()
    expect(store.listLockedSessions()).toEqual([])
    store.close()
  })
})

describe("pruneLocks（加载时按活动会话修剪）", () => {
  test("剔除已不存在会话的锁，保留活动会话", () => {
    const store = Store.memory()
    store.lockFile("alive", "/a")
    store.lockFile("deleted", "/b")
    store.lockFile("subagent", "/c")
    const removed = pruneLocks(store, [{ id: "alive" }, { id: "subagent" }])
    expect(removed).toBe(1)
    expect(store.isFileLocked("alive", "/a")).toBe(true)
    expect(store.isFileLocked("subagent", "/c")).toBe(true)
    expect(store.isFileLocked("deleted", "/b")).toBe(false)
    store.close()
  })

  test("空会话列表视为上游不可达，不修剪", () => {
    const store = Store.memory()
    store.lockFile("x", "/a")
    const removed = pruneLocks(store, [])
    expect(removed).toBe(0)
    expect(store.isFileLocked("x", "/a")).toBe(true)
    store.close()
  })
})
