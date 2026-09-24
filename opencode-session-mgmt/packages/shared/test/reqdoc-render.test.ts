/**
 * reqdoc 渲染结构校验纯函数测试（质量飞轮 P2）。
 * 覆盖 parseRenderStructure：齐全/缺章节/乱序/第一章第二章缺小节/功能点块数/每块子小节缺失/
 * 来源标注提取（标题行与内容里两种写法）/缺省提取；renderStructureViolations 与 renderGapViolations。
 */
import { describe, expect, test } from "bun:test"
import {
  REQDOC_TEMPLATE_CHAPTERS,
  REQDOC_TEMPLATE_FIELDS,
  MAPPED_FIELD_KEYS,
  buildPrdSkeleton,
  canonicalSourceTag,
  consistencyViolations,
  coverageFromProvenance,
  isMappedFieldSection,
  missingDefaultReasonViolations,
  noDocumentSupportViolation,
  parseRenderStructure,
  patchSectionBody,
  renderGapViolations,
  renderStructureViolations,
  renderTargetDigest,
  type ReqdocRender,
  type ReqdocProvenance,
} from "../src/reqdoc-render"
import type { ReqdocFeature, ReqdocScore } from "../src/workflow"

/** 一份结构齐全的 PRD md：7 章、第三章 3.1-3.6、第四章 4.1/4.2、2 个功能点块（新格式：5.1/5.2）、映射字段全标来源。 */
function fullPrd(): string {
  const block = (k: number) => {
    return `
### 5.${k} 功能点${k}
#### 5.${k}.1 功能点输入要素
##### 5.${k}.1.1 简要概述 [文档]
##### 5.${k}.1.2 控制要求 [文档]
#### 5.${k}.2 功能点处理要求
##### 5.${k}.2.1 输入要素的检查 [文档]
##### 5.${k}.2.2 系统处理过程 [文档]
##### 5.${k}.2.3 异常处理要求 [文档]
##### 5.${k}.2.4 提示信息 [文档]
##### 5.${k}.2.5 其他要求 [文档]
##### 5.${k}.2.6 清算处理 [文档]
##### 5.${k}.2.7 差错处理 [文档]
##### 5.${k}.2.8 交易安全性 [文档]
##### 5.${k}.2.9 数据存贮和清理 [文档]
##### 5.${k}.2.10 附件 [文档]
##### 5.${k}.2.11 接口与数据源 [文档]
##### 5.${k}.2.12 权限与最小授权 [文档]
##### 5.${k}.2.13 流程图 [文档]\n`
  }
  return (
    `## 第一章 项目信息\n` +
    `## 第二章 文档变更过程\n` +
    `## 第三章 需求概述\n` +
    `### 3.1 需求类型\n### 3.2 属于流程优化项目\n### 3.3 涉及跨部门项目\n### 3.4 涉及总行开发\n### 3.5 希望完成时间\n### 3.6 需求提出原因及功能概述\n` +
    `## 第四章 术语定义与业务规则\n### 4.1 术语定义\n### 4.2 业务规则\n` +
    `## 第五章 需求功能详述${block(1)}${block(2)}` +
    `## 第六章 非功能需求\n### 6.1 性能与容量\n### 6.2 可用性与可靠性\n### 6.3 安全与信创\n### 6.4 数据主权与合规\n` +
    `## 第七章 验收标准\n### 7.1 功能点验收指标\n### 7.2 量化验收口径\n`
  )
}

/** 构造带 expectedFeatures 的 ReqdocRender（violations/gaps 测试直接构造，不依赖 md 解析）。 */
function renderOf(partial: Partial<ReqdocRender>): ReqdocRender {
  return {
    source: "07_需求规格产出/1_测试/需求规格书.md",
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
    docBlocks: 1,
    docCount: REQDOC_TEMPLATE_FIELDS.length,
    qaCount: 0,
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

  test("缺章节：去掉第四章，missing 含其标题", () => {
    const md = fullPrd().replace("## 第四章 术语定义与业务规则\n### 4.1 术语定义\n### 4.2 业务规则\n", "")
    const s = parseRenderStructure(md)
    expect(s.missing).toContain("第四章 术语定义与业务规则")
    expect(s.ok).toBe(false)
  })

  test("乱序：第三章与第四章调换，outOfOrder 非空", () => {
    const md = fullPrd().replace(
      "## 第三章 需求概述",
      "## 第四章 术语定义与业务规则\n### 4.1 术语定义\n### 4.2 业务规则\n## 第三章 需求概述",
    )
    // 现在第四章出现在第三章前：第三章缺失、第四章之后（原位置）再出现一次 → 乱序
    const s = parseRenderStructure(md)
    expect(s.outOfOrder.length).toBeGreaterThan(0)
    expect(s.ok).toBe(false)
  })

  test("第三章缺小节：去掉 3.3，missingSections 含「第三章 需求概述 3.3 涉及跨部门项目」", () => {
    const md = fullPrd().replace("### 3.3 涉及跨部门项目\n", "")
    const s = parseRenderStructure(md)
    expect(s.missingSections).toContain("第三章 需求概述 3.3 涉及跨部门项目")
    expect(s.ok).toBe(false)
  })

  test("功能点块子小节缺失：去掉块 1 的 5.1.2.3，missingFeatureSections 含「功能点 1 缺 5.1.2.3 异常处理要求」", () => {
    const md = fullPrd().replace("##### 5.1.2.3 异常处理要求 [文档]\n", "")
    const s = parseRenderStructure(md)
    expect(s.missingFeatureSections).toContain("功能点 1 缺 5.1.2.3 异常处理要求")
    expect(s.featureOk).toBe(false)
  })

  test("功能点块数 = ### 5.N 标题数", () => {
    const s = parseRenderStructure(fullPrd())
    expect(s.featureCount).toBe(2)
  })

  test("功能点标题带名称也能识别（r13/r14 渲染编号/名称，模型常写名称进标题）", () => {
    const md = fullPrd()
      .replace("### 5.1 功能点1", "### 5.1 功能点1：名单排查")
      .replace("### 5.2 功能点2", "### 5.2 功能点2 额度管控")
    const s = parseRenderStructure(md)
    expect(s.featureCount).toBe(2)
    expect(s.featureOk).toBe(true)
    expect(s.missingFeatureSections).toEqual([])
  })

  test("功能点标题用 N_名称 目录约定也能识别（与 reqdoc_confirm_features 建档名一致）", () => {
    const md = fullPrd()
      .replace("### 5.1 功能点1", "### 1_故障应急智能检索（双入口）")
      .replace("### 5.2 功能点2", "### 2_额度管控与熔断")
    const s = parseRenderStructure(md)
    expect(s.featureCount).toBe(2)
    expect(s.featureOk).toBe(true)
    expect(s.missingFeatureSections).toEqual([])
  })

  test("功能点标题带序号和点号（### 1. 名称）也能识别", () => {
    const md = fullPrd().replace("### 5.1 功能点1", "### 1. 故障应急智能检索")
    const s = parseRenderStructure(md)
    expect(s.featureCount).toBe(2)
  })

  test("非三级标题或非 N_/功能点 前缀不识别为块", () => {
    const md = fullPrd().replace("### 5.1 功能点1", "## 功能点 1").replace("### 5.2 功能点2", "#### 2_额度管控")
    const s = parseRenderStructure(md)
    expect(s.featureCount).toBe(0)
  })

  test("来源标注在标题下内容里也能提取（模板规范写法）", () => {
    const md = fullPrd()
      .replace("##### 5.1.2.1 输入要素的检查 [文档]\n", "##### 5.1.2.1 输入要素的检查\n\n校验卡号与余额 [文档]\n")
      .replace("##### 5.1.1.2 控制要求 [文档]\n", "##### 5.1.1.2 控制要求\n\n留痕双人复核 [问答]\n")
    const s = parseRenderStructure(md)
    expect(s.covered["2.1"]).toBe(2)
    expect(s.covered["1.2"]).toBe(2)
  })

  test("[缺省] 提取：某字段标缺省则 defaults 计数，且仍计入 covered（[缺省] 也是来源标注）", () => {
    const md = fullPrd().replace("##### 5.1.2.3 异常处理要求 [文档]\n", "##### 5.1.2.3 异常处理要求 [缺省]\n")
    const s = parseRenderStructure(md)
    expect(s.defaults["2.3"]).toBe(1)
    expect(s.covered["2.3"]).toBe(2)
  })

  test("块内子项层级不拘（三级标题亦可识别，修复弱模型多级排版失败）", () => {
    // 模板规范用 ####/#####；弱模型常用 ### 起头。把主小节与子小节全降为三级，应仍识别为完整块且来源覆盖。
    const md = fullPrd().replace(/#### /g, "### ").replace(/##### /g, "### ")
    const s = parseRenderStructure(md)
    expect(s.featureCount).toBe(2)
    expect(s.featureOk).toBe(true)
    expect(s.missingFeatureSections).toEqual([])
    for (const f of REQDOC_TEMPLATE_FIELDS) expect(s.covered[f.key]).toBe(2)
  })

  test("来源标签包全角括号（### 5.1.2.1 输入要素的检查（[问答]））也能识别——修复 0/42 主因", () => {
    // 弱模型常把 [文档]/[问答] 用全角括号包裹；归一化须剥 【】 才能命中小节标题。
    const md = fullPrd()
      .replace("##### 5.1.2.1 输入要素的检查 [文档]", "##### 5.1.2.1 输入要素的检查（[文档]）")
      .replace("##### 5.1.1.2 控制要求 [文档]", "##### 5.1.1.2 控制要求（[问答]）")
      .replace("##### 5.1.2.3 异常处理要求 [文档]", "##### 5.1.2.3 异常处理要求（[文档]+[问答]）")
    const s = parseRenderStructure(md)
    expect(s.featureOk).toBe(true)
    expect(s.covered["2.1"]).toBe(2)
    expect(s.covered["1.2"]).toBe(2)
    expect(s.covered["2.3"]).toBe(2)
  })

  test("主分组标题为纯文本（无 #）亦可——修复弱模型写为普通文字", () => {
    // 弱模型把「5.1.1 功能点输入要素」「5.1.2 功能点处理要求」写成普通文字而非标题；主分组为可选分组标签。
    const md = fullPrd()
      .replace("#### 5.1.1 功能点输入要素", "5.1.1 功能点输入要素")
      .replace("#### 5.1.2 功能点处理要求", "5.1.2 功能点处理要求")
    const s = parseRenderStructure(md)
    expect(s.featureOk).toBe(true)
    expect(s.missingFeatureSections).toEqual([])
    for (const f of REQDOC_TEMPLATE_FIELDS) expect(s.covered[f.key]).toBe(2)
  })

  test("空白差异不影响标题匹配（全角空格/多余空格）", () => {
    const md = fullPrd().replace("## 第五章 需求功能详述", "## 第五章 需求功能详述  ")
    const s = parseRenderStructure(md)
    expect(s.missing).toEqual([])
  })

  test("docBlocks/docCount/qaCount：字段均标 [文档] 时 docBlocks 全满、docCount 正确", () => {
    const s = parseRenderStructure(fullPrd())
    expect(s.docBlocks).toBe(2)
    expect(s.docCount).toBeGreaterThan(0)
    expect(s.qaCount).toBe(0)
  })

  test("docBlocks：字段全标 [问答] 时 docBlocks=0、qaCount>0", () => {
    const md = fullPrd().split("[文档]").join("[问答]")
    const s = parseRenderStructure(md)
    expect(s.docBlocks).toBe(0)
    expect(s.qaCount).toBeGreaterThan(0)
    expect(s.docCount).toBe(0)
  })
})

describe("noDocumentSupportViolation（来源真实性门禁，reqdoc-r30）", () => {
  test("有 [文档] 支撑 → 无违规", () => {
    expect(noDocumentSupportViolation(renderOf({ docBlocks: 1, docCount: 7, qaCount: 0 }))).toEqual([])
  })

  test("≥2 功能点有真实素材 → 无违规（较松条件一，即便占比低）", () => {
    expect(noDocumentSupportViolation(renderOf({ docBlocks: 2, docCount: 2, qaCount: 20 }))).toEqual([])
  })

  test("[文档] 占比 ≥30% → 无违规（较松条件二）", () => {
    expect(noDocumentSupportViolation(renderOf({ docBlocks: 1, docCount: 5, qaCount: 10 }))).toEqual([])
  })

  test("全 [问答] 无 [文档] 支撑 → 违规", () => {
    const v = noDocumentSupportViolation(renderOf({ docBlocks: 0, docCount: 0, qaCount: 7 }))
    expect(v.length).toBe(1)
    expect(v[0]).toContain("书面材料支撑不足")
  })

  test("仅 1 功能点有素材且占比<30% → 违规", () => {
    const v = noDocumentSupportViolation(renderOf({ docBlocks: 1, docCount: 1, qaCount: 10 }))
    expect(v.length).toBe(1)
    expect(v[0]).toContain("书面材料支撑不足")
  })

  test("无 render → 空（柔性放行）", () => {
    expect(noDocumentSupportViolation(undefined)).toEqual([])
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
    const s = parseRenderStructure(fullPrd().replaceAll("##### 5.1.2.8 交易安全性 [文档]\n", "##### 5.1.2.8 交易安全性\n"))
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
      businessValue: { score: 12, max: 12 },
      flowClosure: { score: 20, max: 20 },
      edgeControl: { score: edgeControl, max: 22 },
      compliance: { score: 16, max: 16 },
      authority: { score: 8, max: 8 },
      material: { score: 8, max: 8 },
      nfr: { score: 7, max: 7 },
      acceptability: { score: 7, max: 7 },
    },
    deductions: [],
    total: 85,
    confirmed: true,
    confirmedAt: 1000,
    updatedAt: 1000,
  })

  test("[缺省] 字段对应维度打满分 → 违规（自评矛盾）", () => {
    // 2.3 异常处理要求 → edgeControl；标 [缺省] 但 edgeControl 打满分 22/22
    const r = renderOf({ defaults: { ...renderOf({}).defaults, "2.3": 1 } })
    const v = renderGapViolations(r, score(22))
    expect(v.some((x) => x.includes("字段 2.3 异常处理要求"))).toBe(true)
    expect(v.some((x) => x.includes("edgeControl"))).toBe(true)
  })

  test("[缺省] 字段对应维度未打满分 → 放行", () => {
    const r = renderOf({ defaults: { ...renderOf({}).defaults, "2.3": 1 } })
    expect(renderGapViolations(r, score(16))).toEqual([])
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

describe("missingDefaultReasonViolations（完整性门禁）", () => {
  test("裸 [缺省]（defaults 有计数）→ 违规", () => {
    const r = renderOf({ defaults: { ...renderOf({}).defaults, "2.11": 1, "2.12": 1 } })
    const v = missingDefaultReasonViolations(r)
    expect(v.length).toBe(2)
    expect(v.join("；")).toContain("2.11 接口与数据源")
    expect(v.join("；")).toContain("2.12 权限与最小授权")
  })

  test("[缺省：理由] 不计入裸 [缺省] → 无违规", () => {
    // 解析器对 [缺省：理由] 不计入 [缺省] 标签，故 defaults 全 0
    const r = renderOf({ defaults: { ...renderOf({}).defaults } })
    expect(missingDefaultReasonViolations(r)).toEqual([])
  })

  test("无 render → 空（柔性放行）", () => {
    expect(missingDefaultReasonViolations(undefined)).toEqual([])
  })
})

describe("consistencyViolations（一致性门禁）", () => {
  const changePrd = (overview: string) =>
    `## 第三章 需求概述\n### 3.1 需求类型\n- ● 更改功能　○ 新增功能\n### 3.6 需求提出原因及功能概述\n${overview}\n` +
    `## 第四章 术语定义与业务规则\n### 4.1 术语定义\n### 4.2 业务规则\n`

  test("更改功能但概述未点明改造 → 违规", () => {
    const md = changePrd("本需求为新增一类业务查询，支持客户自助查看余额。")
    const v = consistencyViolations(md)
    expect(v.length).toBe(1)
    expect(v[0]).toContain("更改功能")
  })

  test("更改功能且概述点明改造 → 无违规", () => {
    const md = changePrd("在现有余额查询功能基础上改造，新增客户自助渠道，调整原有授权校验逻辑。")
    expect(consistencyViolations(md)).toEqual([])
  })

  test("新增功能 → 不查概述（跳过）", () => {
    const md = `## 第三章 需求概述\n### 3.1 需求类型\n- ○ 更改功能　● 新增功能\n### 3.6 需求提出原因及功能概述\n新增一类查询。\n`
    expect(consistencyViolations(md)).toEqual([])
  })
})

// ---- P1 骨架生成 / P2 增量填充 / P3 结构摘要 ----

/** 最小模板（含 buildPrdSkeleton 所需锚点：封面 / 第一章 / 第三章 / 第五章 5.1 块 / 第六章）。 */
function miniTemplate(): string {
  const subs = [
    "##### 5.1.1.1 简要概述",
    "XXXX",
    "##### 5.1.1.2 控制要求",
    "- ○ 涉及　● 不涉及",
    "##### 5.1.2.1 输入要素的检查",
    "- ○ 涉及　● 不涉及",
    "##### 5.1.2.2 系统处理过程",
    "- ○ 涉及　● 不涉及",
    "##### 5.1.2.3 异常处理要求",
    "- ○ 适用　● 不适用",
    "##### 5.1.2.4 提示信息",
    "- ○ 适用　● 不适用",
    "##### 5.1.2.5 其他要求",
    "- ○ 适用　● 不适用",
    "##### 5.1.2.6 清算处理",
    "- ○ 适用　● 不适用",
    "##### 5.1.2.7 差错处理",
    "- ○ 适用　● 不适用",
    "##### 5.1.2.8 交易安全性",
    "- ○ 适用　● 不适用",
    "##### 5.1.2.9 数据存贮和清理",
    "- ○ 适用　● 不适用",
    "##### 5.1.2.10 附件",
    "- ○ 涉及　● 不涉及",
    "##### 5.1.2.11 接口与数据源",
    "- ○ 涉及　● 不涉及",
    "##### 5.1.2.12 权限与最小授权",
    "- ○ 涉及　● 不涉及",
    "##### 5.1.2.13 流程图",
    "- ○ 涉及　● 不涉及",
  ]
  return [
    "# 业务需求说明书模板",
    "> 说明行（不应进入 PRD 正文）",
    "",
    "XXXX（项目全称）",
    "业务需求说明书",
    "",
    "日期：YYYY-MM",
    "",
    "## 第一章 项目信息",
    "| 标题 |  |",
    "",
    "## 第二章 文档变更过程",
    "| 版本号 | 修改内容 |",
    "",
    "## 第三章 需求概述",
    "### 3.1 需求类型",
    "- ● 新增功能　○ 更改功能",
    "### 3.2 属于流程优化项目",
    "- ○ 是　● 否",
    "",
    "## 第四章 术语定义与业务规则",
    "### 4.1 术语定义",
    "- ○ 涉及　● 不涉及",
    "### 4.2 业务规则",
    "- ○ 涉及　● 不涉及",
    "",
    "## 第五章 需求功能详述",
    "> 编号规则：功能点 k 的标题为 ### 5.k。",
    "",
    "### 5.1 功能点名称",
    "- 功能点编号：1",
    "- 功能名称：XXXX",
    "- 优先级：○ 高　○ 中　● 低",
    "",
    ...subs,
    "",
    "### 5.2 功能点名称",
    "- 功能点编号：2",
    "",
    "## 第六章 非功能需求",
    "### 6.1 性能与容量",
    "XXXX",
    "",
    "## 第七章 验收标准",
    "### 7.1 功能点验收指标",
    "XXXX",
  ].join("\n")
}

const features = (names: string[], priority: ReqdocFeature["priority"] = "high"): ReqdocFeature[] =>
  names.map((name, i) => ({ no: i + 1, name, priority, confirmedAt: 1 }))

describe("buildPrdSkeleton（P1 服务端生成骨架）", () => {
  test("生成含封面/章节/功能点块的骨架，且结构合规", () => {
    const md = buildPrdSkeleton(miniTemplate(), features(["知识入库管理", "报表导出"]))
    expect(md).not.toBeNull()
    const text = md!
    expect(text).toContain("XXXX（项目全称）") // 封面
    expect(text).toContain("## 第一章 项目信息")
    expect(text).toContain("## 第三章 需求概述")
    expect(text).toContain("## 第五章 需求功能详述")
    expect(text).toContain("## 第六章 非功能需求")
    expect(text).toContain("## 第七章 验收标准")
    expect(text).toContain("### 5.1 知识入库管理")
    expect(text).toContain("### 5.2 报表导出")
    // 编号全局连续：功能点 2 的末子小节为 5.2.2.13
    expect(text).toContain("##### 5.2.2.13 流程图")
    expect(text).toContain("功能点编号：2")
    expect(text).toContain("● 高")
    // 说明性引用不进正文
    expect(text).not.toContain("说明行（不应进入 PRD 正文）")
    const structure = parseRenderStructure(text)
    expect(structure.missing).toEqual([])
    expect(structure.outOfOrder).toEqual([])
    expect(structure.featureOk).toBe(true)
    expect(structure.featureCount).toBe(2)
  })

  test("模板为 null 或功能点为空 → null", () => {
    expect(buildPrdSkeleton(null, features(["A"]))).toBeNull()
    expect(buildPrdSkeleton(miniTemplate(), [])).toBeNull()
  })
})

describe("patchSectionBody（P2 服务端按编号填充）", () => {
  test("填充功能点子小节：保留标题、替换正文、其它小节不动", () => {
    const md = buildPrdSkeleton(miniTemplate(), features(["知识入库管理"]))!
    const result = patchSectionBody(md, "5.1.2.3", "- 网络超时重试 3 次 [文档]\n- 重复提交幂等去重 [问答]")
    expect(result.ok).toBe(true)
    expect(result.md).toContain("##### 5.1.2.3 异常处理要求")
    expect(result.md).toContain("网络超时重试 3 次 [文档]")
    expect(result.md).toContain("##### 5.1.2.4 提示信息") // 下一小节标题保留
    expect(result.md).toContain("##### 5.1.2.2 系统处理过程") // 上一小节标题保留
  })

  test("填充章内小节 3.1：替换到下一同级标题前", () => {
    const md = buildPrdSkeleton(miniTemplate(), features(["知识入库管理"]))!
    const result = patchSectionBody(md, "3.1", "- ● 新增功能　○ 更改功能 [问答]")
    expect(result.ok).toBe(true)
    expect(result.md).toContain("### 3.1 需求类型")
    expect(result.md).toContain("[问答]")
    expect(result.md).toContain("### 3.2 属于流程优化项目")
  })

  test("未知小节键 / 未找到标题 → 报错且不改动 md", () => {
    const md = buildPrdSkeleton(miniTemplate(), features(["知识入库管理"]))!
    const bad = patchSectionBody(md, "5.1", "x")
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain("未知小节键")
    expect(bad.md).toBe(md)
    const missing = patchSectionBody(md, "3.6", "x")
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain("未找到小节 3.6")
  })
})

describe("renderTargetDigest（P3 结构摘要）", () => {
  test("含章节骨架 / 子小节 / 映射字段，且远小于模板全文", () => {
    const digest = renderTargetDigest()
    expect(digest).toContain("章节骨架")
    expect(digest).toContain("2.13 流程图")
    expect(digest).toContain("映射字段须逐功能点标来源")
    expect(digest.length).toBeLessThan(miniTemplate().length)
  })
})

// ---- Option A: 来源记账（P3.10）----

describe("canonicalSourceTag", () => {
  test("文档 → [文档]", () => {
    expect(canonicalSourceTag("文档")).toBe("[文档]")
  })

  test("问答 → [问答]", () => {
    expect(canonicalSourceTag("问答")).toBe("[问答]")
  })

  test("缺省 + reason → [缺省：理由]", () => {
    expect(canonicalSourceTag("缺省", "本次无清算处理")).toBe("[缺省：本次无清算处理]")
  })

  test("缺省无 reason → [缺省]", () => {
    expect(canonicalSourceTag("缺省")).toBe("[缺省]")
  })
})

describe("isMappedFieldSection", () => {
  test("5.1.1.2 控制要求 → true", () => {
    expect(isMappedFieldSection("5.1.1.2")).toBe(true)
  })

  test("5.1.2.1 输入要素的检查 → true", () => {
    expect(isMappedFieldSection("5.1.2.1")).toBe(true)
  })

  test("5.1.2.13 流程图 → true", () => {
    expect(isMappedFieldSection("5.1.2.13")).toBe(true)
  })

  test("3.1 需求类型 → false（非功能点小节）", () => {
    expect(isMappedFieldSection("3.1")).toBe(false)
  })

  test("5.1.2.2 系统处理过程 → false（不在 MAPPED_FIELD_KEYS 中）", () => {
    expect(isMappedFieldSection("5.1.2.2")).toBe(false)
  })

  test("5.1.2.4 提示信息 → false（不在 MAPPED_FIELD_KEYS 中）", () => {
    expect(isMappedFieldSection("5.1.2.4")).toBe(false)
  })
})

describe("coverageFromProvenance", () => {
  test("全 [文档] → docCount>0, qaCount=0, defaults 全 0", () => {
    const prov: Record<string, ReqdocProvenance> = {}
    for (const f of REQDOC_TEMPLATE_FIELDS) {
      prov[`5.1.${f.key}`] = { tag: "文档", at: 1000 }
    }
    const cov = coverageFromProvenance(prov, 1)
    expect(cov.docCount).toBe(REQDOC_TEMPLATE_FIELDS.length)
    expect(cov.qaCount).toBe(0)
    for (const f of REQDOC_TEMPLATE_FIELDS) {
      expect(cov.defaults[f.key]).toBe(0)
    }
  })

  test("全 [缺省：理由] → defaults 全 1", () => {
    const prov: Record<string, ReqdocProvenance> = {}
    for (const f of REQDOC_TEMPLATE_FIELDS) {
      prov[`5.1.${f.key}`] = { tag: "缺省", reason: "不适用", at: 1000 }
    }
    const cov = coverageFromProvenance(prov, 1)
    for (const f of REQDOC_TEMPLATE_FIELDS) {
      expect(cov.defaults[f.key]).toBe(1)
    }
  })

  test("混合 → docCount/qaCount/defaults 各计其数", () => {
    const prov: Record<string, ReqdocProvenance> = {
      "5.1.1.2": { tag: "文档", at: 1000 },
      "5.1.2.1": { tag: "问答", at: 1000 },
      "5.1.2.3": { tag: "缺省", reason: "不适用", at: 1000 },
    }
    const cov = coverageFromProvenance(prov, 1)
    expect(cov.docCount).toBe(1)
    expect(cov.qaCount).toBe(1)
    expect(cov.defaults["2.3"]).toBe(1)
    expect(cov.defaults["1.2"]).toBe(0)
  })

  test("空记账 → 全 0", () => {
    const cov = coverageFromProvenance({}, 1)
    expect(cov.docCount).toBe(0)
    expect(cov.qaCount).toBe(0)
    for (const f of REQDOC_TEMPLATE_FIELDS) {
      expect(cov.defaults[f.key]).toBe(0)
    }
  })
})

describe("parseRenderStructure（[缺省：理由] 标签解析）", () => {
  test("[缺省：理由] → 计入 covered 不计入 defaults（非裸缺省）", () => {
    const md = fullPrd().replace("##### 5.1.2.3 异常处理要求 [文档]\n", "##### 5.1.2.3 异常处理要求 [缺省：本次无异常]\n")
    const s = parseRenderStructure(md)
    expect(s.covered["2.3"]).toBe(2)
    expect(s.defaults["2.3"]).toBe(0) // 不是裸 [缺省]
  })

  test("[缺省：理由] 全角冒号 → 同样不计入 defaults", () => {
    const md = fullPrd().replace("##### 5.1.2.3 异常处理要求 [文档]\n", "##### 5.1.2.3 异常处理要求 [缺省：本次无异常]\n")
    const s = parseRenderStructure(md)
    expect(s.defaults["2.3"]).toBe(0)
  })

  test("半角括号 () 包裹的 [文档] → 仍计入 covered", () => {
    const md = fullPrd()
      .replace("##### 5.1.2.1 输入要素的检查 [文档]", "##### 5.1.2.1 输入要素的检查 ([文档])")
      .replace("##### 5.1.1.2 控制要求 [文档]", "##### 5.1.1.2 控制要求 ([文档])")
    const s = parseRenderStructure(md)
    expect(s.covered["2.1"]).toBe(2)
    expect(s.covered["1.2"]).toBe(2)
  })
})

describe("patchSectionBody（source_tag 写入标题行）", () => {
  test("写入 [文档] → 标题行出现 [文档]", () => {
    const md = buildPrdSkeleton(miniTemplate(), features(["测试"]))!
    const result = patchSectionBody(md, "5.1.2.3", "- 测试内容", "文档")
    expect(result.ok).toBe(true)
    expect(result.md).toContain("##### 5.1.2.3 异常处理要求 [文档]")
    expect(result.md).toContain("- 测试内容")
  })

  test("写入 [缺省：理由] → 标题行出现 [缺省：理由]", () => {
    const md = buildPrdSkeleton(miniTemplate(), features(["测试"]))!
    const result = patchSectionBody(md, "5.1.2.3", "- 不适用", "缺省", "本次无异常")
    expect(result.ok).toBe(true)
    expect(result.md).toContain("##### 5.1.2.3 异常处理要求 [缺省：本次无异常]")
  })

  test("保留标题行原始空白（cleanHeading 不丢空格）", () => {
    const md = buildPrdSkeleton(miniTemplate(), features(["测试"]))!
    const result = patchSectionBody(md, "5.1.2.3", "- 内容", "文档")
    expect(result.ok).toBe(true)
    // 标题编号与名称之间有空格
    expect(result.md).toContain("##### 5.1.2.3 异常处理要求 [文档]")
  })

  test("content 含 Markdown 标题行 → 拒绝", () => {
    const md = buildPrdSkeleton(miniTemplate(), features(["测试"]))!
    const result = patchSectionBody(md, "5.1.2.3", "### 注入标题\n- 内容", "文档")
    expect(result.ok).toBe(false)
    expect(result.error).toContain("content 不得包含 Markdown 标题行")
  })
})
