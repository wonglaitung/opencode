import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { consumeIntent, INTENT_TTL_MS, intentCandidates, parseIntent } from "../src/intent"

const dirs: string[] = []

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "collab-intent-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("parseIntent", () => {
  test("接受 host", () => {
    expect(parseIntent('{"mode":"host"}')).toEqual({ mode: "host" })
  })

  test("接受 join", () => {
    expect(parseIntent('{"mode":"join","invite":"ws://1.2.3.4:1?token=t","name":" Bob "}')).toEqual({
      mode: "join",
      invite: "ws://1.2.3.4:1?token=t",
      name: "Bob",
    })
  })

  test("拒绝坏输入", () => {
    expect(parseIntent("not json")).toBeUndefined()
    expect(parseIntent("[]")).toBeUndefined()
    expect(parseIntent('{"mode":"join"}')).toBeUndefined()
    expect(parseIntent('{"mode":"join","invite":"ws://x","name":""}')).toBeUndefined()
    expect(parseIntent('{"mode":"other"}')).toBeUndefined()
  })
})

describe("intentCandidates", () => {
  test("去重且包含目录与 cwd", () => {
    expect(intentCandidates({ directory: "/a", cwd: "/a" })).toEqual([path.join("/a", ".opencode", "collab-room.json")])
    expect(intentCandidates({ directory: "/a", cwd: "/b" })).toHaveLength(2)
  })
})

describe("consumeIntent", () => {
  test("读取后删除", async () => {
    const dir = await tempDir()
    const file = path.join(dir, ".opencode", "collab-room.json")
    await Bun.write(file, JSON.stringify({ mode: "host" }))

    const consumed = await consumeIntent([file])
    expect(consumed?.intent).toEqual({ mode: "host" })
    expect(await Bun.file(file).exists()).toBe(false)
  })

  test("过期文件删除但不返回", async () => {
    const dir = await tempDir()
    const file = path.join(dir, "collab-room.json")
    await writeFile(file, JSON.stringify({ mode: "host" }))
    const old = new Date(Date.now() - INTENT_TTL_MS - 1_000)
    await utimes(file, old, old)

    expect(await consumeIntent([file])).toBeUndefined()
    expect(await Bun.file(file).exists()).toBe(false)
  })

  test("没有文件返回空", async () => {
    const dir = await tempDir()
    expect(await consumeIntent([path.join(dir, "collab-room.json")])).toBeUndefined()
  })

  test("坏文件删除并继续查找下一个候选", async () => {
    const dir = await tempDir()
    const broken = path.join(dir, "a.json")
    const good = path.join(dir, "b.json")
    await writeFile(broken, "{oops")
    await writeFile(good, JSON.stringify({ mode: "host" }))

    const consumed = await consumeIntent([broken, good])
    expect(consumed?.path).toBe(good)
    expect(await Bun.file(broken).exists()).toBe(false)
    expect(await Bun.file(good).exists()).toBe(false)
  })
})
