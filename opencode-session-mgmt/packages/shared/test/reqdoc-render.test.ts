/**
 * reqdoc 渲染结构校验纯函数测试（质量飞轮 P2）。
 * 覆盖 parseRenderStructure：齐全/缺章节/乱序/第一章第二章缺小节/功能点块数/每块子小节缺失/
 * 来源标注提取（标题行与内容里两种写法）/缺省提取；renderStructureViolations 与 renderGapViolations。
 */
import { describe, expect, test } from "bun:test"
import {
  REQDOC_TEMPLATE_CHAPTERS,
  REQDOC_TEMPLATE_FIELDS,
  parseRenderStructure,
  renderGapViolations,
  renderStructureViolations,
  type ReqdocRender,
} from "../src/reqdoc-render"
import type { ReqdocScore } from "../src/workflow"

/** 一份结构齐全的 PRD md：5 章、第一章 1.1-1.6、第二章 2.1/2.2、2 个功能点块、映射字段全标来源。 */
function fullPrd(): string {
  const block = (no: number) => `
### 功能点 ${no}
#### 1. 功能点输入要素
##### 1.1 简要概述 [文档]
##### 1.2 控制要求 [文档]
#### 2. 功能点处理要求
##### 2.1 输入要素的检查 [文档]
##### 2.2 系统处理过程 [文档]
##### 2.3 异常处理要求 [文档]
##### 2.4 提示信息 [文档]
##### 2.5 其他要求 [文档]
##### 2.6 清算处理 [文档]
##### 2.7 差错处理 [文档]
##### 2.8 交易安全性 [文档]
##### 2.9 数据存贮和清理 [文档]
##### 2.10 附件 [文档]`
  return (
    `## 一、项目信息\n` +
    `## 二、文档变更过程\n` +
    `## 第一章 需求概述\n` +
    `### 1.1 需求类型\n### 1.2 属于流程优化项目\n### 1.3 涉及跨部门项目\n### 1.4 涉及总行开发\n### 1.5 希望完成时间\n### 1.6 需求提出原因及功能概述\n` +
    `## 第二章 术语定义与业务规则\n### 2.1 术语定义\n### 2.2 业务规则\n` +
    `## 第三章 需求功能详述${block(1)}${block(2)}`
  )
}

/** 构造带 expectedFeatures 的 ReqdocRender（violations/gaps 测试直接构造，不依赖 md 解析）。 */
function renderOf(partial: Partial<ReqdocRender>): ReqdocRender {
  return {
    source: "06_需求规格产出/1_测试/需求规格书.md",
    checkedAt: 1000,
    expectedFeatures: 1,
    ok: true,
    chaptersPresent: REQDOC_TEMPLATE_CHAPTERS.map((c) => c.title),
    missing: [],
    outOfOrder: [],
    missingSections: [],
    featureCount: 1,
    featureOk: true,
    missingFeatureSections: [],
    covered: Object.fromEntries(REQDOC_TEMPLATE_FIELDS.map((f) => [f.key, 1])),
    defaults: Object.fromEntries(REQDOC_TEMPLATE_FIELDS.map((f) => [f.key, 0])),
    ...partial,
  }
}

describe("parseRenderStructure", () => {
  test("齐全：5 章齐全且顺序正确、2 个功能点块、每块子小节齐全、映射字段全标来源", () => {
    const s = parseRenderStructure(fullPrd())
    expect(s.ok).toBe(true)
    expect(s.missing).toEqual([])
    expect(s.outOfOrder).toEqual([])
    expect(s.missingSections).toEqual([])
    expect(s.featureCount).toBe(2)
    expect(s.featureOk).toBe(true)
    expect(s.missingFeatureSections).toEqual([])
    for (const f of REQDOC_TEMPLATE_FIELDS) expect(s.covered[f.key]).toBe(2)
    for (const f of REQDOC_TEMPLATE_FIELDS) expect(s.defaults[f.key]).toBe(0)
  })

  test("缺章节：去掉第二章，missing 含其标题", () => {
    const md = fullPrd().replace("## 第二章 术语定义与业务规则\n### 2.1 术语定义\n### 2.2 业务规则\n", "")
    const s = parseRenderStructure(md)
    expect(s.missing).toContain("第二章 术语定义与业务规则")
    expect(s.ok).toBe(false)
  })

  test("乱序：第一章与第二章调换，outOfOrder 非空", () => {
    const md = fullPrd().replace(
      "## 第一章 需求概述",
      "## 第二章 术语定义与业务规则\n### 2.1 术语定义\n### 2.2 业务规则\n## 第一章 需求概述",
    )
    // 现在第二章出现在第一章前：第一章缺失、第二章之后（原位置）再出现一次 → 乱序
    const s = parseRenderStructure(md)
    expect(s.outOfOrder.length).toBeGreaterThan(0)
    expect(s.ok).toBe(false)
  })

  test("第一章缺小节：去掉 1.3，missingSections 含「第一章 需求概述 1.3 涉及跨部门项目」", () => {
    const md = fullPrd().replace("### 1.3 涉及跨部门项目\n", "")
    const s = parseRenderStructure(md)
    expect(s.missingSections).toContain("第一章 需求概述 1.3 涉及跨部门项目")
    expect(s.ok).toBe(false)
  })

  test("功能点块子小节缺失：去掉块 1 的 2.3，missingFeatureSections 含「功能点 1 缺 2.3 异常处理要求」", () => {
    const md = fullPrd().replace("##### 2.3 异常处理要求 [文档]\n", "")
    const s = parseRenderStructure(md)
    expect(s.missingFeatureSections).toContain("功能点 1 缺 2.3 异常处理要求")
    expect(s.featureOk).toBe(false)
  })

  test("功能点块数 = ### 功能点 N 标题数", () => {
    const s = parseRenderStructure(fullPrd())
    expect(s.featureCount).toBe(2)
  })

  test("来源标注在标题下内容里也能提取（模板规范写法）", () => {
    const md = fullPrd()
      .replace("##### 2.1 输入要素的检查 [文档]\n", "##### 2.1 输入要素的检查\n\n校验卡号与余额 [文档]\n")
      .replace("##### 1.2 控制要求 [文档]\n", "##### 1.2 控制要求\n\n留痕双人复核 [问答]\n")
    const s = parseRenderStructure(md)
    expect(s.covered["2.1"]).toBe(2)
    expect(s.covered["1.2"]).toBe(2)
  })

  test("[缺省] 提取：某字段标缺省则 defaults 计数，且仍计入 covered（[缺省] 也是来源标注）", () => {
    const md = fullPrd().replace("##### 2.3 异常处理要求 [文档]\n", "##### 2.3 异常处理要求 [缺省]\n")
    const s = parseRenderStructure(md)
    expect(s.defaults["2.3"]).toBe(1)
    expect(s.covered["2.3"]).toBe(2)
  })

  test("空白差异不影响标题匹配（全角空格/多余空格）", () => {
    const md = fullPrd().replace("## 第三章 需求功能详述", "## 第三章 需求功能详述  ")
    const s = parseRenderStructure(md)
    expect(s.missing).toEqual([])
  })
})

describe("renderStructureViolations", () => {
  test("结构合规（缺省无违规）", () => {
    const s = parseRenderStructure(fullPrd())
    const r = renderOf({ ...s, expectedFeatures: 2 })
    expect(renderStructureViolations(r)).toEqual([])
  })

  test("功能点块数 ≠ 已确认功能点数 → 违规", () => {
    const s = parseRenderStructure(fullPrd())
    const r = renderOf({ ...s, expectedFeatures: 3 }) // 渲染 2 块但确认 3 个功能点
    const v = renderStructureViolations(r)
    expect(v.some((x) => x.includes("功能点块数 2 ≠ 已确认功能点 3"))).toBe(true)
  })

  test("映射字段漏标来源 → 违规（逐字段条数）", () => {
    const s = parseRenderStructure(fullPrd().replaceAll("##### 2.8 交易安全性 [文档]\n", "##### 2.8 交易安全性\n"))
    const r = renderOf({ ...s, expectedFeatures: 2 })
    const v = renderStructureViolations(r)
    expect(v.some((x) => x.includes("字段 2.8 交易安全性"))).toBe(true)
  })

  test("无 render（未记录）→ 返回空（柔性放行）", () => {
    expect(renderStructureViolations(undefined)).toEqual([])
  })
})

describe("renderGapViolations", () => {
  const score = (edgeControl: number): ReqdocScore => ({
    dims: {
      businessValue: { score: 15, max: 15 },
      flowClosure: { score: 25, max: 25 },
      edgeControl: { score: edgeControl, max: 30 },
      compliance: { score: 10, max: 20 },
      authority: { score: 10, max: 10 },
    },
    deductions: [],
    total: 85,
    confirmed: true,
    confirmedAt: 1000,
    updatedAt: 1000,
  })

  test("[缺省] 字段对应维度打满分 → 违规（自评矛盾）", () => {
    // 2.3 异常处理要求 → edgeControl；标 [缺省] 但 edgeControl 打满分 30/30
    const r = renderOf({ defaults: { ...renderOf({}).defaults, "2.3": 1 } })
    const v = renderGapViolations(r, score(30))
    expect(v.some((x) => x.includes("字段 2.3 异常处理要求"))).toBe(true)
    expect(v.some((x) => x.includes("edgeControl"))).toBe(true)
  })

  test("[缺省] 字段对应维度未打满分 → 放行", () => {
    const r = renderOf({ defaults: { ...renderOf({}).defaults, "2.3": 1 } })
    expect(renderGapViolations(r, score(25))).toEqual([])
  })

  test("无 [缺省] → 无违规（即使有满分维度）", () => {
    const r = renderOf({}) // defaults 全 0
    expect(renderGapViolations(r, score(30))).toEqual([])
  })

  test("无 render 或无 score → 空（柔性放行）", () => {
    expect(renderGapViolations(undefined, score(30))).toEqual([])
    expect(renderGapViolations(renderOf({}), undefined)).toEqual([])
  })
})
