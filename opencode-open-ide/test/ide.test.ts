/**
 * ide.ts / config.ts 纯函数层测试(零 mock,直接验证真实实现)。
 * 探测函数注入假探针,不触发真实 which/where。
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadIdeConfig, resolveEntries } from "../src/config"
import { buildOpenArgs, probeBinary, resolveIdeBinary } from "../src/ide"

describe("resolveEntries(config.json 合并预设)", () => {
  test("空配置回退默认顺序 vscode → idea", () => {
    const entries = resolveEntries({})
    expect(entries.map((e) => e.id)).toEqual(["vscode", "idea"])
    expect(entries[0]).toMatchObject({ kind: "vscode" })
    expect(entries[1]).toMatchObject({ kind: "idea" })
  })

  test("order 覆盖探测次序", () => {
    const entries = resolveEntries({ order: ["idea", "vscode"] })
    expect(entries.map((e) => e.id)).toEqual(["idea", "vscode"])
  })

  test("tools 覆盖同 id 的 binary 与 kind", () => {
    const entries = resolveEntries({
      tools: { idea: { binary: "/opt/idea/bin/idea.sh", kind: "idea" } },
    })
    const idea = entries.find((e) => e.id === "idea")
    expect(idea?.candidates).toEqual(["/opt/idea/bin/idea.sh"])
  })

  test("tools 新增未内置 id(cursor 属 vscode kind)并纳入顺序", () => {
    const entries = resolveEntries({
      order: ["cursor", "idea"],
      tools: { cursor: { binary: "cursor", kind: "vscode" } },
    })
    expect(entries.map((e) => e.id)).toEqual(["cursor", "idea"])
    expect(entries[0]).toEqual({ id: "cursor", kind: "vscode", candidates: ["cursor"] })
  })

  test("无效字段被忽略,保留其余有效项", () => {
    const raw = {
      order: "vscode",
      tools: {
        vscode: { binary: "code" }, // 缺 kind → 忽略
        bad: { binary: "", kind: "vscode" }, // 空 binary → 忽略
        ok: { binary: "code-insiders", kind: "vscode" },
      },
    } as unknown
    const entries = resolveEntries(raw as never)
    expect(entries.map((e) => e.id)).toEqual(["vscode", "idea"])
    expect(entries.find((e) => e.id === "vscode")?.kind).toBe("vscode")
  })
})

describe("resolveIdeBinary(探测顺序)", () => {
  const probe =
    (available: Record<string, boolean>): ((c: string) => string | null) =>
    (candidate) => (available[candidate] ? candidate : null)

  test("按 order 取第一个可用的", () => {
    const entries = resolveEntries({})
    const hit = resolveIdeBinary(entries, probe({ idea: true })) // vscode 缺、idea 有
    expect(hit.entry.id).toBe("idea")
    expect(hit.binary).toBe("idea")
  })

  test("vscode 可用时优先 vscode", () => {
    const entries = resolveEntries({})
    const hit = resolveIdeBinary(entries, probe({ code: true, idea: true }))
    expect(hit.entry.id).toBe("vscode")
  })

  test("全部不可用抛中文错误", () => {
    const entries = resolveEntries({})
    expect(() => resolveIdeBinary(entries, probe({}))).toThrow("未找到可用的 IDE")
  })

  test("覆盖后的 binary 参与探测", () => {
    const entries = resolveEntries({
      tools: { idea: { binary: "/opt/idea/bin/idea.sh", kind: "idea" } },
    })
    const hit = resolveIdeBinary(entries, probe({ "/opt/idea/bin/idea.sh": true }))
    expect(hit.entry.id).toBe("idea")
    expect(hit.binary).toBe("/opt/idea/bin/idea.sh")
  })
})

describe("probeBinary(glob 展开,真实 Bun.Glob)", () => {
  test("版本化 glob 命中首个真实路径", () => {
    const base = mkdtempSync(join(tmpdir(), "open-ide-glob-"))
    const dir = join(base, "idea-2024.2")
    mkdirSync(join(dir, "bin"), { recursive: true })
    const exe = join(dir, "bin", "idea.sh")
    writeFileSync(exe, "#!/bin/sh\n")
    try {
      const hit = probeBinary(join(base, "idea-*/bin/idea.sh"))
      expect(hit).toBe(exe)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test("无 * 的绝对路径不存在时返回 null", () => {
    expect(probeBinary("/definitely/not/here/idea.sh")).toBeNull()
  })
})

describe("buildOpenArgs(kind 定位语法)", () => {
  const dir = "/home/dev/project"

  test("vscode 无 file 只开目录", () => {
    expect(buildOpenArgs("vscode", { directory: dir })).toEqual([dir])
  })

  test("vscode 文件定位到行", () => {
    expect(buildOpenArgs("vscode", { directory: dir, file: "src/main/java/A.java", line: 42 })).toEqual([
      "-g",
      `${dir}/src/main/java/A.java:42`,
    ])
  })

  test("vscode 文件定位到行列", () => {
    expect(buildOpenArgs("vscode", { directory: dir, file: "A.java", line: 7, column: 3 })).toEqual([
      "-g",
      `${dir}/A.java:7:3`,
    ])
  })

  test("idea 无 file 只开目录", () => {
    expect(buildOpenArgs("idea", { directory: dir })).toEqual([dir])
  })

  test("idea 文件定位到行", () => {
    expect(buildOpenArgs("idea", { directory: dir, file: "pom.xml", line: 10 })).toEqual([
      "--line",
      "10",
      `${dir}/pom.xml`,
    ])
  })

  test("idea 文件定位到行列", () => {
    expect(buildOpenArgs("idea", { directory: dir, file: "pom.xml", line: 10, column: 5 })).toEqual([
      "--line",
      "10",
      "--column",
      "5",
      `${dir}/pom.xml`,
    ])
  })

  test("绝对路径 file 不再拼接目录", () => {
    expect(buildOpenArgs("vscode", { directory: dir, file: "/abs/A.java", line: 1 })).toEqual([
      "-g",
      "/abs/A.java:1",
    ])
  })
})

describe("loadIdeConfig(JSON 转义陷阱)", () => {
  test("非法转义(\\P)解析失败回退预设并提示", () => {
    const base = mkdtempSync(join(tmpdir(), "open-ide-json-"))
    const origWarn = console.warn
    const warns: string[] = []
    console.warn = (m: unknown) => warns.push(String(m))
    try {
      writeFileSync(join(base, "config.json"), '{ "order": ["vscode"], "tools": { "idea": { "binary": "C:\\Program Files\\x", "kind": "idea" } } }')
      const entries = loadIdeConfig(base)
      expect(entries.map((e) => e.id)).toEqual(["vscode", "idea"])
      expect(warns.some((w) => w.includes("正斜杠"))).toBe(true)
    } finally {
      console.warn = origWarn
      rmSync(base, { recursive: true, force: true })
    }
  })
})
