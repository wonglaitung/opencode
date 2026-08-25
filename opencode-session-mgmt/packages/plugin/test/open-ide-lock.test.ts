/**
 * 人工文件锁测试(零 mock,open-ide 合并)。
 * 覆盖:registry 幂等/归一化、工具入参目标文件提取、锁定拦截判定、system.transform 注入内容。
 * 锁后端为 SQLite(Store.file_lock 表):registry 经 Store.memory() 构造。
 */
import { describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { createLockRegistry } from "../src/open-ide/lock"
import { createLockGate } from "../src/open-ide/lock-gate"
import { createLockHintTransform } from "../src/open-ide/lock-hint"
import { extractTargetFiles, patchedFilesOf } from "../src/open-ide/patched"

const DIR = "/home/dev/project"

function makeRegistry() {
  const store = Store.memory()
  const r = createLockRegistry(DIR, store)
  return { store, r }
}

describe("createLockRegistry", () => {
  test("lock 后 isLocked 为 true,list 含该文件", () => {
    const { store, r } = makeRegistry()
    r.lock("s1", "src/A.java")
    expect(r.isLocked("s1", "src/A.java")).toBe(true)
    expect(r.list("s1")).toEqual(["/home/dev/project/src/A.java"])
    store.close()
  })

  test("路径归一化:相对/绝对等价", () => {
    const { store, r } = makeRegistry()
    r.lock("s1", "/home/dev/project/src/A.java")
    expect(r.isLocked("s1", "src/A.java")).toBe(true)
    expect(r.isLocked("s1", "/home/dev/project/src/A.java")).toBe(true)
    store.close()
  })

  test("锁是会话隔离的", () => {
    const { store, r } = makeRegistry()
    r.lock("s1", "src/A.java")
    expect(r.isLocked("s2", "src/A.java")).toBe(false)
    store.close()
  })

  test("重复 lock 幂等", () => {
    const { store, r } = makeRegistry()
    r.lock("s1", "src/A.java")
    r.lock("s1", "src/A.java")
    expect(r.list("s1")).toEqual(["/home/dev/project/src/A.java"])
    store.close()
  })

  test("unlock 幂等:未锁文件解锁成功 no-op", () => {
    const { store, r } = makeRegistry()
    r.unlock("s1", "src/A.java")
    expect(r.isLocked("s1", "src/A.java")).toBe(false)
    store.close()
  })

  test("unlock 后清除;clear 与 clearAll", () => {
    const { store, r } = makeRegistry()
    r.lock("s1", "src/A.java")
    r.unlock("s1", "src/A.java")
    expect(r.list("s1")).toEqual([])
    r.lock("s1", "src/A.java")
    r.lock("s2", "src/B.java")
    r.clear("s1")
    expect(r.list("s1")).toEqual([])
    expect(r.list("s2")).toHaveLength(1)
    r.clearAll()
    expect(r.list("s2")).toEqual([])
    store.close()
  })

  test("锁持久化:同一 store 重建 registry 后锁仍在", () => {
    const { store, r } = makeRegistry()
    r.lock("s1", "src/A.java")
    const r2 = createLockRegistry(DIR, store)
    expect(r2.isLocked("s1", "src/A.java")).toBe(true)
    expect(r2.list("s1")).toEqual(["/home/dev/project/src/A.java"])
    store.close()
  })
})

describe("extractTargetFiles(工具入参提取)", () => {
  test("write 取 filePath", () => {
    expect(extractTargetFiles("write", { filePath: "src/A.java", content: "x" }, DIR)).toEqual([
      "/home/dev/project/src/A.java",
    ])
  })

  test("edit 取 filePath", () => {
    expect(extractTargetFiles("edit", { filePath: "src/B.java", oldString: "a", newString: "b" }, DIR)).toEqual([
      "/home/dev/project/src/B.java",
    ])
  })

  test("apply_patch 解析多文件", () => {
    const patch =
      "*** Begin Patch\n" +
      "*** Update File: src/A.java\n@@ ... @@\n-old\n+new\n" +
      "*** Add File: src/C.java\n@@\n+hello\n"
    expect(extractTargetFiles("apply_patch", { patchText: patch }, DIR)).toEqual([
      "/home/dev/project/src/A.java",
      "/home/dev/project/src/C.java",
    ])
  })

  test("非编辑工具返回空", () => {
    expect(extractTargetFiles("read", { filePath: "src/A.java" }, DIR)).toEqual([])
    expect(extractTargetFiles("bash", { command: "git status" }, DIR)).toEqual([])
  })

  test("入参畸形返回空", () => {
    expect(extractTargetFiles("write", null, DIR)).toEqual([])
    expect(extractTargetFiles("write", {}, DIR)).toEqual([])
    expect(extractTargetFiles("apply_patch", { patchText: "" }, DIR)).toEqual([])
  })

  test("patchedFilesOf:Move to 不重置,Begin/End 重置", () => {
    const patch =
      "*** Update File: a.txt\n@@\n-x\n+y\n" +
      "*** Move to: a2.txt\n" +
      "*** End Patch\n"
    expect(patchedFilesOf(patch)).toEqual(["a.txt"])
  })
})

describe("createLockGate(拦截判定)", () => {
  test("锁定文件被编辑 → 抛中文错误", async () => {
    const { store, r } = makeRegistry()
    r.lock("s1", "src/A.java")
    const gate = createLockGate(r, DIR)
    await expect(
      gate({ tool: "write", sessionID: "s1" }, { args: { filePath: "src/A.java", content: "x" } }),
    ).rejects.toThrow("人工文件锁")
    store.close()
  })

  test("未锁文件放行", async () => {
    const { store, r } = makeRegistry()
    const gate = createLockGate(r, DIR)
    await expect(gate({ tool: "write", sessionID: "s1" }, { args: { filePath: "src/B.java" } })).resolves.toBeUndefined()
    store.close()
  })

  test("解锁后放行", async () => {
    const { store, r } = makeRegistry()
    r.lock("s1", "src/A.java")
    const gate = createLockGate(r, DIR)
    await expect(gate({ tool: "edit", sessionID: "s1" }, { args: { filePath: "src/A.java" } })).rejects.toThrow()
    r.unlock("s1", "src/A.java")
    await expect(gate({ tool: "edit", sessionID: "s1" }, { args: { filePath: "src/A.java" } })).resolves.toBeUndefined()
    store.close()
  })

  test("apply_patch 含锁定文件 → 拦截;非编辑工具不拦", async () => {
    const { store, r } = makeRegistry()
    r.lock("s1", "src/A.java")
    const gate = createLockGate(r, DIR)
    const patch = "*** Update File: src/A.java\n@@\n-x\n+y\n"
    await expect(
      gate({ tool: "apply_patch", sessionID: "s1" }, { args: { patchText: patch } }),
    ).rejects.toThrow()
    await expect(gate({ tool: "bash", sessionID: "s1" }, { args: { command: "echo hi" } })).resolves.toBeUndefined()
    store.close()
  })
})

describe("createLockHintTransform(注入)", () => {
  test("无锁跳过", async () => {
    const { store, r } = makeRegistry()
    const t = createLockHintTransform(r)
    const out = { system: [] as string[] }
    await t({ sessionID: "s1" }, out)
    expect(out.system).toEqual([])
    store.close()
  })

  test("无 sessionID 跳过", async () => {
    const { store, r } = makeRegistry()
    r.lock("s1", "src/A.java")
    const t = createLockHintTransform(r)
    const out = { system: [] as string[] }
    await t({}, out)
    expect(out.system).toEqual([])
    store.close()
  })

  test("有锁注入锁定提示", async () => {
    const { store, r } = makeRegistry()
    r.lock("s1", "src/A.java")
    const t = createLockHintTransform(r)
    const out = { system: [] as string[] }
    await t({ sessionID: "s1" }, out)
    expect(out.system[0]).toContain("人工文件锁")
    expect(out.system[0]).toContain("src/A.java")
    expect(out.system[0]).toContain("unlock_file")
    store.close()
  })

  test("多文件锁提示逐个确认解锁,不擅自解锁未提及文件", async () => {
    const { store, r } = makeRegistry()
    r.lock("s1", "src/A.java")
    r.lock("s1", "src/B.java")
    const t = createLockHintTransform(r)
    const out = { system: [] as string[] }
    await t({ sessionID: "s1" }, out)
    expect(out.system[0]).toContain("A.java")
    expect(out.system[0]).toContain("B.java")
    expect(out.system[0]).toContain("可能只改完其中一个")
    expect(out.system[0]).toContain("未明确提及的文件保持锁定")
    store.close()
  })
})
