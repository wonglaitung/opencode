/**
 * reqdoc 渲染结构校验纯函数测试（质量飞轮 P2）。
 * 覆盖 parseRenderStructure：齐全/缺章节/乱序/第一章第二章缺小节/功能点块数/每块子小节缺失/
 * 来源标注提取（标题行与内容里两种写法）/缺省提取；renderStructureViolations 与 renderGapViolations。
 */
import { describe, expect, test } from "bun:test"
import {
  buildPrdSkeleton,
  parseRenderStructure,
  reqdocTaggedFields,
} from "../src/reqdoc-render"
import type { ReqdocFeature } from "../src/workflow"

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
    for (const f of reqdocTaggedFields()) expect(s.covered[f.key]).toBe(2)
    for (const f of reqdocTaggedFields()) expect(s.defaults[f.key]).toBe(0)
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
    for (const f of reqdocTaggedFields()) expect(s.covered[f.key]).toBe(2)
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
    for (const f of reqdocTaggedFields()) expect(s.covered[f.key]).toBe(2)
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

// ---- Option A: 来源记账（P3.10）----

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
