/**
 * reqdoc 目录骨架工具测试（设计文档 workflow-reqdoc.md 4 章 reqdoc-r8）。
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { createReqdocInitTool } from "../src/tools/reqdoc-dirs"
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

describe("reqdoc_init 目录骨架 + README", () => {
  test("为每个 01~06 目录写入 README.md，并附根目录总览", async () => {
    const root = mkdtempSync(join(tmpdir(), "reqdoc-init-"))
    const tools = createReqdocInitTool()
    const out = await tools.reqdoc_init!.execute({} as never, { directory: root, sessionID: "s1" } as never)
    expect(String(out)).toContain("README.md")
    for (const dir of REQDOC_DIRS) {
      const readme = join(root, dir, "README.md")
      expect(existsSync(readme)).toBe(true)
      expect(readFileSync(readme, "utf8")).toContain(dir)
    }
    expect(existsSync(join(root, "需求资料目录说明.md"))).toBe(true)
  })

  test("幂等：重复调用不覆盖业务已编辑的 README", async () => {
    const root = mkdtempSync(join(tmpdir(), "reqdoc-init-"))
    const tools = createReqdocInitTool()
    await tools.reqdoc_init!.execute({} as never, { directory: root, sessionID: "s1" } as never)
    const edited = join(root, "01_背景与目标", "README.md")
    const mark = "\n<!-- 业务补充：此处放背景材料清单 -->"
    writeFileSync(edited, readFileSync(edited, "utf8") + mark)
    await tools.reqdoc_init!.execute({} as never, { directory: root, sessionID: "s1" } as never)
    // 业务补充未被覆盖，且原骨架说明仍在
    const after = readFileSync(edited, "utf8")
    expect(after).toContain(mark)
    expect(after).toContain("# 01_背景与目标")
  })
})
