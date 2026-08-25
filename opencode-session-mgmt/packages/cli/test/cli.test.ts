import { describe, expect, test } from "bun:test"
import { asStringArray, parseArgs } from "../src/index"
import { fmtTitle, parsePeriodMs } from "../src/commands/stats"

describe("parseArgs", () => {
  test("位置参数与键值", () => {
    const parsed = parseArgs(["sess1", "--add", "feature", "--add", "auth", "--json"])
    expect(parsed.positionals).toEqual(["sess1"])
    expect(asStringArray(parsed.flags.add)).toEqual(["feature", "auth"])
    expect(parsed.flags.json).toBe(true)
  })

  test("--key=value 形式", () => {
    const parsed = parseArgs(["--group=前端组"])
    expect(parsed.flags.group).toBe("前端组")
  })
})

describe("parsePeriodMs", () => {
  test("解析 Nd", () => {
    expect(parsePeriodMs("7d")).toBe(7 * 24 * 60 * 60 * 1000)
    expect(parsePeriodMs(undefined)).toBeNull()
    expect(parsePeriodMs("bad")).toBeNull()
  })
})

describe("fmtTitle", () => {
  test("空标题示 N/A", () => {
    expect(fmtTitle(null)).toBe("N/A")
    expect(fmtTitle("")).toBe("N/A")
  })

  test("超 24 字截断加省略号", () => {
    const short = "使用Edge浏览器打开雅虎网站"
    expect(fmtTitle(short)).toBe(short)
    const long = "很长的会话语义标题用于验证截断行为是否超出表格列宽限制与展示"
    const out = fmtTitle(long)
    expect(out.endsWith("…")).toBe(true)
    expect(out.length).toBe(25)
  })
})
