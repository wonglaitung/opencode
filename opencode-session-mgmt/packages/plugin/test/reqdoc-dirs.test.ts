/**
 * reqdoc 目录骨架工具测试（设计文档 workflow-reqdoc.md 4 章 reqdoc-r8）。
 */
import { describe, expect, test } from "bun:test"
import { REQDOC_DIRS, sanitizeDirName } from "../src/tools/reqdoc-dirs"

describe("sanitizeDirName", () => {
  test("过滤 Windows 非法字符", () => {
    expect(sanitizeDirName("a:b*c?")).toBe("a_b_c_")
    expect(sanitizeDirName('foo"bar<baz>')).toBe("foo_bar_baz_")
    expect(sanitizeDirName("x/y\\z")).toBe("x_y_z")
  })

  test("去除尾随点号与空格，保留中间", () => {
    expect(sanitizeDirName("名单排查. ")).toBe("名单排查")
    expect(sanitizeDirName(" 中间 .txt ")).toBe("中间 .txt")
  })

  test("Windows 设备名加后缀", () => {
    expect(sanitizeDirName("CON")).toBe("CON_")
    expect(sanitizeDirName("nul")).toBe("nul_")
    expect(sanitizeDirName("COM1")).toBe("COM1_")
  })

  test("空名兜底为下划线", () => {
    expect(sanitizeDirName("")).toBe("_")
    expect(sanitizeDirName("   ")).toBe("_")
  })

  test("合法中文名原样保留", () => {
    expect(sanitizeDirName("名单排查")).toBe("名单排查")
    expect(REQDOC_DIRS.every((d) => sanitizeDirName(d) === d)).toBe(true)
  })
})
