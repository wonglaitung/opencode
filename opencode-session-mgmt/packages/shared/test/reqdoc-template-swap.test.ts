/**
 * 换模板端到端验证（阶段 B 的兑现用例）。
 *
 * 前面两组测试各证一件事：解析器读得对、生产口径与解析口径逐条一致。本组补上
 * 最后一块——**换模板只改 md**。做法是拿一份结构完全不同的模板（功能点从第五章
 * 挪到第三章、章节重编号、只留 7 个子节、术语容器从 4.1 挪到 2.2）跑一遍
 * 全套派生逻辑，逐项断言它自动跟随。
 *
 * 这组用例是本方案存在的理由：阶段 A 的「零差异」只能证明没改坏，
 * 这里证明的是**以后换模板不必改代码**。
 */
import { describe, expect, test } from "bun:test"
import {
  assembleOf,
  docSectionAddrsOf,
  featureAddrOf,
  featureContainerAbs,
  isContainerAddrOf,
  parseOf,
  parseTemplateSchema,
  requiredContainersOf,
  requiredSlotsOf,
  skeletonOf,
} from "./helpers/reqdoc-template-harness"

/**
 * 异构模板：机构 B 的模板。
 * 与现状模板的差异——功能点章 5→3；章内小节编号整体重编；子节从 15 个减到 7 个
 * （去掉银行专属的清算/差错/数据存贮/附件/提示信息等）；术语容器 4.1→2.2。
 */
const HETERO = [
  "# 某某系统需求说明书模板",
  "",
  "## 第一章 项目信息",
  "",
  "| 标题 |  |",
  "",
  "## 第二章 需求概述",
  "",
  "### 2.1 需求类型",
  "",
  "- ● 新增功能　○ 更改功能",
  "",
  "### 2.2 术语定义",
  "",
  "- ○ 涉及　● 不涉及",
  "",
  "### 2.3 业务规则",
  "",
  "- ○ 涉及　● 不涉及",
  "",
  "## 第三章 需求功能详述",
  "",
  "> 编号规则：功能点 k 的标题为 ### 3.k。",
  "",
  "### 3.1 功能点名称",
  "",
  "- 功能点编号：1",
  "- 功能名称：XXXX",
  "- 优先级：○ 高　○ 中　● 低",
  "",
  "#### 3.1.1 输入要素",
  "",
  "##### 3.1.1.1 简要概述",
  "",
  "XXXX",
  "",
  "##### 3.1.1.2 控制要求",
  "",
  "- ○ 涉及　● 不涉及",
  "",
  "#### 3.1.2 处理要求",
  "",
  "##### 3.1.2.1 输入要素的检查",
  "",
  "- ○ 涉及　● 不涉及",
  "",
  "##### 3.1.2.3 异常处理要求",
  "",
  "- ○ 适用　● 不适用",
  "",
  "##### 3.1.2.8 交易安全性",
  "",
  "- ○ 适用　● 不适用",
  "",
  "##### 3.1.2.13 流程图",
  "",
  "- ○ 涉及　● 不涉及",
  "",
  "### 3.2 功能点名称",
  "",
  "- 功能点编号：2",
  "",
  "#### 3.2.1 输入要素",
  "",
  "##### 3.2.1.1 简要概述",
  "",
  "XXXX",
  "",
  "##### 3.2.1.2 控制要求",
  "",
  "- ○ 涉及　● 不涉及",
  "",
  "#### 3.2.2 处理要求",
  "",
  "##### 3.2.2.1 输入要素的检查",
  "",
  "- ○ 涉及　● 不涉及",
  "",
  "##### 3.2.2.3 异常处理要求",
  "",
  "- ○ 适用　● 不适用",
  "",
  "##### 3.2.2.8 交易安全性",
  "",
  "- ○ 适用　● 不适用",
  "",
  "##### 3.2.2.13 流程图",
  "",
  "- ○ 涉及　● 不涉及",
  "",
  "## 第四章 非功能需求",
  "",
  "### 4.1 性能与容量",
  "",
  "XXXX",
].join("\n")

describe("换模板端到端：只改 md，派生全部跟随", () => {
  const h = parseTemplateSchema(HETERO)

  test("功能点章号跟随（5 → 3）", () => {
    expect(h.featureChapter).toBe(3)
  })

  test("术语容器地址跟随（4.1 → 2.2）", () => {
    expect(h.chapterContainers).toEqual(["2.2"])
    expect(featureContainerAbs(h, 0)).toBe("3.1.2.1")
  })

  test("必填叶子按新模板收缩（15 个子节里政策命中 5 个）", () => {
    // 政策没变、模板变了 → 必填集跟着变。清算/差错等 5 项在机构 B 的模板里
    // 不存在，故不列入——同时它们会被报成 unresolvedPolicy（见下）。
    expect(h.requiredSubRels).toEqual(["1.1", "1.2", "2.3", "2.8", "2.13"])
  })

  test("政策未命中的小节被报出来（提醒人工确认制度口径，而非静默少问）", () => {
    expect(h.unresolvedPolicy).toEqual(
      expect.arrayContaining(["清算处理", "差错处理", "数据存贮和清理", "接口与数据源", "权限与最小授权"]),
    )
  })

  test("功能点绝对地址用新章号", () => {
    expect(featureAddrOf(h, 0, "2.3")).toBe("3.1.2.3")
    expect(featureAddrOf(h, 1, "2.3")).toBe("3.2.2.3")
  })

  test("容器判定在新编号下成立，且不误判同位置的普通子节", () => {
    expect(isContainerAddrOf(h, "2.2")).toBe(true) // 术语容器
    expect(isContainerAddrOf(h, "3.1.2.1")).toBe(true) // 字段容器
    expect(isContainerAddrOf(h, "3.1.2.3")).toBe(false) // 异常处理要求不是容器
    expect(isContainerAddrOf(h, "2.1")).toBe(false) // 需求类型不是容器
  })

  test("章内必填小节按新编号派生，且排除容器", () => {
    expect([...docSectionAddrsOf(h)]).toEqual(["2.1", "2.3", "4.1"])
  })

  test("骨架生成：新模板一个功能点块即可（不再要求写死第 2 个样例块）", () => {
    // 机构 B 的模板只有 3.1 一个样例块——旧实现会因找不到第二个块而返回 null。
    const md = skeletonOf(HETERO, [{ no: 1, name: "名单排查", priority: "high", confirmedAt: 1 }], h)
    expect(md).not.toBeNull()
    expect(md).toContain("### 3.1 名单排查")
    expect(md).toContain("##### 3.1.2.3 异常处理要求")
    expect(md).toContain("## 第四章 非功能需求")
    // 模板里 3.2 是第二个样例块，投影后不应残留
    expect(md).not.toContain("### 3.2 功能点名称")
  })

  test("骨架生成：两个功能点时编号各自独立且块内子节编号同步", () => {
    const md = skeletonOf(
      HETERO,
      [
        { no: 1, name: "名单排查", priority: "high", confirmedAt: 1 },
        { no: 2, name: "报表导出", priority: "low", confirmedAt: 1 },
      ],
      h,
    )!
    expect(md).toContain("### 3.1 名单排查")
    expect(md).toContain("### 3.2 报表导出")
    // 第 2 块的子节编号必须是 3.2.*：取第 2 块正文逐行核对，
    // 不能对整篇做 not.toContain——第 1 块本来就该含 3.1.2.3。
    const [, block2] = md.split("### 3.2 报表导出")
    expect(block2).toBeDefined()
    expect(block2).toContain("##### 3.2.2.3 异常处理要求")
    expect(block2).toContain("##### 3.2.1.1 简要概述")
    expect(block2).not.toMatch(/^#{1,6}\s+3\.1\./m)
  })

  test("生产必填集在新模板下自动重编（唯一新增断言：requiredSlots 本体）", () => {
    const feats = [{ no: 1, name: "名单排查", priority: "high" as const, confirmedAt: 1 }]
    // 章内必填按新编号（2.1/2.3/4.1，去掉术语容器 2.2），功能点块插在第三章位置
    expect(requiredSlotsOf(h, feats)).toEqual([
      "2.1", "2.3",
      "3.1.1.1", "3.1.1.2", "3.1.2.3", "3.1.2.8", "3.1.2.13",
      "4.1",
    ])
    expect(requiredContainersOf(h, feats)).toEqual(["2.2", "3.1.2.1"])
  })

  test("槽位投影：新模板下组装出的是新骨架，容器留空可整节省略", () => {
    const feats = [{ no: 1, name: "名单排查", priority: "high" as const, confirmedAt: 1 }]
    const slots = [
      { kind: "prose" as const, address: "2.1", content: "新增功能", source: "问答" as const, status: "confirmed" as const },
      { kind: "prose" as const, address: "3.1.1.1", content: "本功能点把名单推送到审批人待办。", source: "问答" as const, status: "confirmed" as const },
      // 术语与字段容器均未填且声明可为空 → 两节都应从产物里消失
    ]
    const r = assembleOf(slots, feats, HETERO, h, {
      "2.2": { required: false, reason: "本次无术语" },
      "3.1.2.1": { required: false, reason: "无结构化字段" },
    })
    expect(r).not.toBeNull()
    expect(r!.md).toContain("## 第二章 需求概述")
    expect(r!.md).toContain("## 第三章 需求功能详述")
    expect(r!.md).toContain("### 3.1 名单排查")
    expect(r!.md).toContain("本功能点把名单推送到审批人待办。")
    expect(r!.md).not.toContain("## 第五章")
    expect(r!.omittedContainers).toEqual(["2.2", "3.1.2.1"])
  })

  test("结构校验：在新模板产物上按新骨架判定为达标", () => {
    const md = skeletonOf(HETERO, [{ no: 1, name: "名单排查", priority: "high", confirmedAt: 1 }], h)!
    const s = parseOf(md, h)
    // 章节齐全、顺序正确、无缺小节；功能点块子节齐全——
    // 这些判定在阶段 B 全部改由新模板的结构驱动。
    expect(s.missing).toEqual([])
    expect(s.outOfOrder).toEqual([])
    expect(s.featureOk).toBe(true)
    expect(s.featureCount).toBe(1)
  })
})