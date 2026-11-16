import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Database } from "bun:sqlite"
import { State } from "../src/state"
import { tempDir } from "./helpers"

function makeState(): State {
  return new State(path.join(tempDir("state-db-"), "state.db"))
}

function readMeta(file: string, key: string): string | undefined {
  const db = new Database(file)
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value?: string } | null
  db.close()
  return row?.value
}

function writeMeta(file: string, key: string, value: string) {
  const db = new Database(file)
  db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  )
  db.close()
}

describe("机器名解析", () => {
  test("首次生成 <hostname>-<hex> 并持久化", () => {
    const state = makeState()
    const first = state.resolveMachine("laptop")
    expect(first.machine).toMatch(/^laptop-[0-9a-f]{6}$/)
    expect(first.renamedFrom).toBeUndefined()
    expect(readMeta(state.dbPath, "machine_id")).toBe(first.machine)
    expect(readMeta(state.dbPath, "machine_hostname")).toBe("laptop")

    expect(state.resolveMachine("laptop").machine).toBe(first.machine)
    state.close()
  })

  test("主机名变化时生成新 id、保留随机后缀并给出 renamedFrom", () => {
    const state = makeState()
    const first = state.resolveMachine("old-box")
    const suffix = first.machine.slice(-6)

    const renamed = state.resolveMachine("new-box")
    expect(renamed.machine).toBe(`new-box-${suffix}`)
    expect(renamed.hostname).toBe("new-box")
    expect(renamed.renamedFrom).toBe(first.machine)

    // 未 confirmMachine 前不落库：下次启动仍然识别为待迁移。
    expect(readMeta(state.dbPath, "machine_id")).toBe(first.machine)
    expect(readMeta(state.dbPath, "machine_hostname")).toBe("old-box")
    expect(state.resolveMachine("new-box").renamedFrom).toBe(first.machine)

    state.confirmMachine(renamed.machine, renamed.hostname)
    expect(readMeta(state.dbPath, "machine_id")).toBe(`new-box-${suffix}`)
    expect(readMeta(state.dbPath, "machine_hostname")).toBe("new-box")
    expect(state.resolveMachine("new-box").renamedFrom).toBeUndefined()
    state.close()
  })

  test("升级前状态库（无 hostname）能识别改名", () => {
    const state = makeState()
    writeMeta(state.dbPath, "machine_id", "old-box-abc123")
    const renamed = state.resolveMachine("new-box")
    expect(renamed.machine).toBe("new-box-abc123")
    expect(renamed.renamedFrom).toBe("old-box-abc123")
    state.close()
  })

  test("升级前状态库只能回填主机名、不改非标准 id", () => {
    const state = makeState()
    writeMeta(state.dbPath, "machine_id", "my-custom-machine")
    const resolved = state.resolveMachine("new-box")
    expect(resolved.machine).toBe("my-custom-machine")
    expect(resolved.renamedFrom).toBeUndefined()
    expect(readMeta(state.dbPath, "machine_hostname")).toBe("new-box")
    state.close()
  })
})
