/**
 * 模板送达测试：loadReqdocTemplate 从插件自身目录相对路径读到仓库 docs/ 下的
 * docs/reqdoc-prd-template.md（部署后 bundle 根同样有 docs/，相对解析一致）。
 */
import { describe, expect, test } from "bun:test"
import { loadReqdocTemplate } from "../src/template"

describe("loadReqdocTemplate（模板送达）", () => {
  test("能从插件相对路径读到真实模板全文", () => {
    const tpl = loadReqdocTemplate()
    expect(tpl).not.toBeNull()
    // 模板标题 + 章节标记（真实 docs/reqdoc-prd-template.md 内容）
    expect(tpl).toContain("# 业务需求说明书模板")
    expect(tpl).toContain("## 一、项目信息")
  })

  test("返回的是全文且已去除首尾空白", () => {
    const tpl = loadReqdocTemplate()
    expect(tpl).not.toBeNull()
    const text = tpl!
    expect(text.startsWith("# 业务需求说明书模板")).toBe(true)
    expect(text.trim()).toBe(text)
  })

  test("重复调用命中模块级缓存（同一内容）", () => {
    expect(loadReqdocTemplate()).toBe(loadReqdocTemplate())
  })
})
