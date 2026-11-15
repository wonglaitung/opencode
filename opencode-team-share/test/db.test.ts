import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveDbPath } from "../src/db"
import { createDbAt } from "./helpers"

const dirs: string[] = []
const prevXdg = process.env["XDG_DATA_HOME"]

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (prevXdg === undefined) delete process.env["XDG_DATA_HOME"]
  else process.env["XDG_DATA_HOME"] = prevXdg
})

function dataRoot() {
  const root = mkdtempSync(join(tmpdir(), "team-share-data-"))
  dirs.push(root)
  const dir = join(root, "opencode")
  mkdirSync(dir, { recursive: true })
  process.env["XDG_DATA_HOME"] = root
  return dir
}

describe("数据库定位", () => {
  test("优先 opencode.db，即使 dev 库更新", () => {
    const dir = dataRoot()
    createDbAt(join(dir, "opencode.db")).close()
    createDbAt(join(dir, "opencode-dev.db")).close()
    // 把 dev 库的 mtime 调新，模拟「最近用过 dev」
    const future = new Date(Date.now() + 60_000)
    utimesSync(join(dir, "opencode-dev.db"), future, future)
    expect(resolveDbPath()).toBe(join(dir, "opencode.db"))
  })

  test("没有 opencode.db 时回退到通道库", () => {
    const dir = dataRoot()
    createDbAt(join(dir, "opencode-dev.db")).close()
    expect(resolveDbPath()).toBe(join(dir, "opencode-dev.db"))
  })

  test("没有 session 表的库不被采用", () => {
    const dir = dataRoot()
    createDbAt(join(dir, "opencode-dev.db")).close()
    const empty = new Database(join(dir, "opencode.db"))
    empty.exec("CREATE TABLE unrelated (id TEXT)")
    empty.close()
    expect(resolveDbPath()).toBe(join(dir, "opencode-dev.db"))
  })

  test("显式指定路径优先", () => {
    const dir = dataRoot()
    createDbAt(join(dir, "opencode.db")).close()
    createDbAt(join(dir, "custom.db")).close()
    expect(resolveDbPath(join(dir, "custom.db"))).toBe(join(dir, "custom.db"))
  })

  test("找不到库时给出可读错误", () => {
    dataRoot()
    expect(() => resolveDbPath()).toThrow(/找不到 opencode 数据库/)
  })
})
