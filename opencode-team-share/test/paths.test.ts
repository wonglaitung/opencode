import { describe, expect, test } from "bun:test"
import {
  createSlug,
  defaultHandoffFileName,
  denormalize,
  normalize,
  PROJECT_PLACEHOLDER,
  safeFileName,
  WORKSPACE_PLACEHOLDER,
} from "../src/paths"

const rules = { worktree: "/home/a/proj", directory: "/home/a/proj/sub" }

describe("路径归一化", () => {
  test("绝对路径换成占位符", () => {
    const out = normalize({ text: "改的是 /home/a/proj/main.ts" }, rules) as { text: string }
    expect(out.text).toBe(`改的是 ${WORKSPACE_PLACEHOLDER}/main.ts`)
  })

  test("占位符还原成本机路径", () => {
    const out = denormalize({ text: `改的是 ${WORKSPACE_PLACEHOLDER}/main.ts` }, rules) as { text: string }
    expect(out.text).toBe("改的是 /home/a/proj/main.ts")
  })

  test("长路径优先：directory 是 worktree 子目录时不被吃掉", () => {
    const out = normalize({ text: "/home/a/proj/sub/x.ts" }, rules) as { text: string }
    expect(out.text).toBe(`${PROJECT_PLACEHOLDER}/x.ts`)
  })

  test("嵌套结构里的字符串也会替换", () => {
    const out = normalize({ a: ["x", { b: "/home/a/proj/y.ts" }] }, rules) as { a: unknown[] }
    expect(JSON.stringify(out)).toContain(WORKSPACE_PLACEHOLDER)
  })

  test("非字符串值原样保留", () => {
    const out = normalize({ n: 1, b: true, z: null }, rules) as Record<string, unknown>
    expect(out).toEqual({ n: 1, b: true, z: null })
  })
})

describe("文件名", () => {
  test("去掉 Windows 非法字符", () => {
    expect(safeFileName("支付/网关:重构?")).toBe("支付_网关_重构_")
  })

  test("空标题有兜底", () => {
    expect(safeFileName("   ")).toBe("session")
  })

  test("默认交接文件名带日期", () => {
    const name = defaultHandoffFileName("支付网关重构", new Date(2026, 10, 15))
    expect(name).toBe("会话交接-支付网关重构-2026-11-15.ocsave")
  })

  test("slug 是形容词-名词", () => {
    expect(createSlug()).toMatch(/^[a-z]+-[a-z]+$/)
  })
})
