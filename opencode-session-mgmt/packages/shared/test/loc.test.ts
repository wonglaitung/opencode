/**
 * AI 代码行数纯函数测试（设计文档 session-management.md 3.2「AI 代码行数统计」）。
 * countLines 物理行口径、classifyFile 三分类优先级、sumLinesByCategory 逐文件 clamp、
 * parsePatchLines 补丁扫描（格式依据上游 packages/core/src/patch.ts）。
 */
import { describe, expect, test } from "bun:test"
import { classifyFile, countLines, parsePatchLines, sumLinesByCategory } from "../src/index"

describe("countLines 物理行数", () => {
  test("空串计 0 行", () => {
    expect(countLines("")).toBe(0)
  })

  test("单行无尾换行计 1 行", () => {
    expect(countLines("a")).toBe(1)
  })

  test("末尾换行不多计一行", () => {
    expect(countLines("a\nb\n")).toBe(2)
    expect(countLines("a\nb")).toBe(2)
  })

  test("中间空行计入", () => {
    expect(countLines("a\n\nb")).toBe(3)
  })
})

describe("classifyFile 三分类（优先级 测试 → 配置 → 业务）", () => {
  test("*.test.* / *.spec.* 归测试", () => {
    expect(classifyFile("src/a.test.ts")).toBe("test")
    expect(classifyFile("src/a.spec.tsx")).toBe("test")
  })

  test("*_test.* / *_spec.* / test_*.* 归测试", () => {
    expect(classifyFile("src/a_test.go")).toBe("test")
    expect(classifyFile("src/a_spec.rb")).toBe("test")
    expect(classifyFile("src/test_utils.py")).toBe("test")
  })

  test("test/tests/__tests__ 目录段归测试", () => {
    expect(classifyFile("src/__tests__/x.ts")).toBe("test")
    expect(classifyFile("src/tests/x.ts")).toBe("test")
    expect(classifyFile("test/x.go")).toBe("test")
  })

  test("大小写不敏感", () => {
    expect(classifyFile("src/A.TEST.TS")).toBe("test")
    expect(classifyFile("TESTS/x.ts")).toBe("test")
    expect(classifyFile("TSConfig.JSON")).toBe("config")
    expect(classifyFile("ops/DOCKERFILE")).toBe("config")
  })

  test("basename 为 test.ts / tests.ts 归业务（不命中测试命名模式）", () => {
    expect(classifyFile("src/test.ts")).toBe("business")
    expect(classifyFile("src/tests.ts")).toBe("business")
  })

  test("配置扩展名归配置", () => {
    expect(classifyFile("tsconfig.json")).toBe("config")
    expect(classifyFile("deploy/app.yaml")).toBe("config")
    expect(classifyFile("conf/app.conf")).toBe("config")
    expect(classifyFile(".env")).toBe("config")
  })

  test("配置 basename 归配置", () => {
    expect(classifyFile(".npmrc")).toBe("config")
    expect(classifyFile("ops/Dockerfile")).toBe("config")
    expect(classifyFile("build/makefile")).toBe("config")
  })

  test("其余归业务", () => {
    expect(classifyFile("src/index.ts")).toBe("business")
    expect(classifyFile("README.md")).toBe("business")
    expect(classifyFile("src/main.go")).toBe("business")
  })

  test("测试优先于配置：config.test.json 归测试", () => {
    expect(classifyFile("config.test.json")).toBe("test")
  })
})

describe("sumLinesByCategory 分类汇总", () => {
  test("分类累加", () => {
    expect(sumLinesByCategory({ "src/a.ts": 10, "src/a.test.ts": 5, "c.json": 3 })).toEqual({
      business: 10,
      test: 5,
      config: 3,
    })
  })

  test("逐文件 clamp ≥0：净删除文件不产生负贡献", () => {
    expect(sumLinesByCategory({ "src/a.ts": -8, "src/b.ts": 3 })).toEqual({ business: 3, test: 0, config: 0 })
  })

  test("空明细三分类为零", () => {
    expect(sumLinesByCategory({})).toEqual({ business: 0, test: 0, config: 0 })
  })
})

describe("parsePatchLines 补丁扫描器", () => {
  test("Add File 段数 + 行", () => {
    const patch = ["*** Begin Patch", "*** Add File: src/new.ts", "+line1", "+line2", "*** End Patch"].join("\n")
    expect(parsePatchLines(patch)).toEqual({ "src/new.ts": 2 })
  })

  test("Update File 仅 @@ hunk 内 + 行加、- 行减", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@ -1,3 +1,4 @@",
      " context",
      "-old",
      "+new1",
      "+new2",
      "*** End Patch",
    ].join("\n")
    expect(parsePatchLines(patch)).toEqual({ "src/a.ts": 1 })
  })

  test("Move to（改名）不中断 Update 段计数、不计行数", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "*** Move to: src/b.ts",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n")
    expect(parsePatchLines(patch)).toEqual({ "src/a.ts": 0 })
  })

  test("Delete File 无正文不计行数", () => {
    const patch = ["*** Begin Patch", "*** Delete File: src/gone.ts", "*** End Patch"].join("\n")
    expect(parsePatchLines(patch)).toEqual({})
  })

  test("混合多文件逐文件累计", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+a",
      "+b",
      "*** Update File: src/a.ts",
      "@@ -1,2 +1,3 @@",
      "-x",
      "+y",
      "+z",
      "*** Delete File: src/gone.ts",
      "*** End Patch",
    ].join("\n")
    expect(parsePatchLines(patch)).toEqual({ "src/new.ts": 2, "src/a.ts": 1 })
  })

  test("CRLF 归一化", () => {
    expect(parsePatchLines("*** Begin Patch\r\n*** Add File: a.ts\r\n+x\r\n*** End Patch")).toEqual({ "a.ts": 1 })
  })

  test("畸形输入从宽跳过不抛错", () => {
    expect(parsePatchLines("garbage")).toEqual({})
    expect(parsePatchLines("*** Add File: a.ts\nnot-plus-line")).toEqual({})
    expect(parsePatchLines("")).toEqual({})
  })
})
