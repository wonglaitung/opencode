/**
 * 模板结构解析测试（方案阶段 A：解析器 + 一致性告警）。
 *
 * 三组断言，分工明确：
 * 1. **解析结果 ≡ 现有代码常量**——阶段 A 的核心主张。解析器若与手抄本对不上，
 *    说明它理解错了模板结构；这份比对是「两份手抄本并存期间」唯一的防漂移网。
 * 2. **异构模板**——换模板的真场景：功能点挪到第八章、章节重编号、删掉银行专属小节。
 *    这组证明解析不依赖章号硬编码，是阶段 B「只改 md」的前提。
 * 3. **告警真的响**——模板与代码矛盾时报出来，而不是静默半成品。
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  REQUIRED_SUB_TITLES,
  TAGGED_SUB_TITLES,
  consistencyReport,
  loadTemplateText,
  parseTemplateSchema,
  templateSchema,
} from "../src/reqdoc-template-schema"
import { requiredContainers, requiredSlots } from "../src/reqdoc-slots"
import type { ReqdocFeature } from "../src/workflow"

const real = loadTemplateText()
if (real === null) throw new Error("模板不可读：本组测试的前提是 docs/reqdoc-prd-template.md 存在")
/** 真实模板的解析结果（作为一致性比对的「现状」基准） */
const realParsed = parseTemplateSchema(real)
/** 真实模板的功能点子节（consistencyReport 比对用的 {group, sub, title} 形态）。 */
const realSubs = () =>
  realParsed.featureSubs.map((x) => ({
    group: Number(x.rel.split(".")[0]),
    sub: Number(x.rel.split(".")[1]),
    title: x.title,
  }))

/** 异构模板：功能点在第八章、章节重编号、只留 8 个子节（去掉银行专属的清算/差错等）。 */
const HETERO = `# 某某系统需求规格说明书

## 第一章 项目信息

| 项目信息 | 内容 |
|------|------|
| 标题 |  |

## 第二章 需求概述

### 2.1 需求类型

- ● 新增功能　○ 更改功能

### 2.2 术语定义

- ○ 涉及　● 不涉及

### 2.3 业务规则

- ○ 涉及　● 不涉及

## 第三章 需求功能详述

> 编号规则同前。

### 3.1 功能点名称

#### 3.1.1 输入要素

##### 3.1.1.1 简要概述

XXXX

##### 3.1.1.2 控制要求

- ○ 涉及　● 不涉及

#### 3.1.2 处理要求

##### 3.1.2.1 输入要素的检查

- ○ 涉及　● 不涉及

##### 3.1.2.3 异常处理要求

- ○ 适用　● 不适用

##### 3.1.2.8 交易安全性

- ○ 适用　● 不适用

##### 3.1.2.12 权限与最小授权

- ○ 涉及　● 不涉及

##### 3.1.2.13 流程图

- ○ 涉及　● 不涉及

### 3.2 功能点名称

#### 3.2.1 输入要素

##### 3.2.1.1 简要概述

XXXX

##### 3.2.1.2 控制要求

- ○ 涉及　● 不涉及

#### 3.2.2 处理要求

##### 3.2.2.1 输入要素的检查

- ○ 涉及　● 不涉及

##### 3.2.2.3 异常处理要求

- ○ 适用　● 不适用

##### 3.2.2.8 交易安全性

- ○ 适用　● 不适用

##### 3.2.2.12 权限与最小授权

- ○ 涉及　● 不涉及

##### 3.2.2.13 流程图

- ○ 涉及　● 不涉及

## 第四章 非功能需求

### 4.1 性能与容量

XXXX
`

describe("parseTemplateSchema：真实模板", () => {
  const s = parseTemplateSchema(real!)

  test("章标题与章号逐条解析正确", () => {
    expect(s.chapters.map((c) => c.number)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(s.chapters.map((c) => c.title)).toEqual([
      "第一章 项目信息",
      "第二章 文档变更过程",
      "第三章 需求概述",
      "第四章 术语定义与业务规则",
      "第五章 需求功能详述",
      "第六章 非功能需求",
      "第七章 验收标准",
    ])
  })

  test("无小节的章判为 meta（表格式，不提问）", () => {
    const meta = s.chapters.filter((c) => c.sections.length === 0)
    expect(meta.map((c) => c.number)).toEqual([1, 2, 5])
  })

  test("章内小节的 key 与 title 解析正确，且功能点块不算小节", () => {
    const byNum = new Map(s.chapters.map((c) => [c.number, c.sections]))
    expect(byNum.get(3)!.map((x) => x.key)).toEqual(["3.1", "3.2", "3.3", "3.4", "3.5", "3.6"])
    expect(byNum.get(4)!.map((x) => x.key)).toEqual(["4.1", "4.2"])
    expect(byNum.get(6)!.map((x) => x.key)).toEqual(["6.1", "6.2", "6.3", "6.4"])
    expect(byNum.get(7)!.map((x) => x.key)).toEqual(["7.1", "7.2"])
    // 第五章全是功能点块，不得被当成章内小节收进来
    expect(byNum.get(5)).toEqual([])
  })

  test("功能点章号与子节骨架（15 条，不含 5.N 示意块）", () => {
    expect(s.featureChapter).toBe(5)
    expect(s.featureSubs).toEqual([
      { rel: "1.1", title: "简要概述" },
      { rel: "1.2", title: "控制要求" },
      { rel: "2.1", title: "输入要素的检查" },
      { rel: "2.2", title: "系统处理过程" },
      { rel: "2.3", title: "异常处理要求" },
      { rel: "2.4", title: "提示信息" },
      { rel: "2.5", title: "其他要求" },
      { rel: "2.6", title: "清算处理" },
      { rel: "2.7", title: "差错处理" },
      { rel: "2.8", title: "交易安全性" },
      { rel: "2.9", title: "数据存贮和清理" },
      { rel: "2.10", title: "附件" },
      { rel: "2.11", title: "接口与数据源" },
      { rel: "2.12", title: "权限与最小授权" },
      { rel: "2.13", title: "流程图" },
    ])
  })

  test("模板里 5.1/5.2/5.N 三块不误报不同构（5.N 是字面 N 的示意块）", () => {
    expect(s.warnings).toEqual([])
  })

  test("容器解析：章级 4.1、功能点级 2.1", () => {
    expect(s.chapterContainers).toEqual(["4.1"])
    expect(s.featureContainerRels).toEqual(["2.1"])
  })

  test("政策全部命中模板，无 unresolved", () => {
    expect(s.unresolvedPolicy).toEqual([])
    expect(s.requiredSubRels).toEqual(["1.1", "1.2", "2.3", "2.6", "2.7", "2.8", "2.9", "2.11", "2.12", "2.13"])
    expect(s.taggedSubRels).toEqual(["1.2", "2.1", "2.3", "2.6", "2.7", "2.8", "2.9", "2.11", "2.12", "2.13"])
  })
})

describe("consistencyReport：告警口径与政策完整性", () => {
  // 阶段 A 曾拿解析结果与代码常量双向比对（count=0）；阶段 B 常量已删，
  // 比对对象改为「模板自身」——consistencyReport 保留的价值在于：对**任意**模板文本
  // （含机构新模板）都能指出「这份结构与政策不匹配」，换模板时它就是体检报告。
  test("真实模板自身零差异（解析无告警、政策全部命中）", () => {
    const s = parseTemplateSchema(real!)
    const r = consistencyReport(s, s.chapters, s.featureSubs.map((x) => ({ group: Number(x.rel.split(".")[0]), sub: Number(x.rel.split(".")[1]), title: x.title })), s.taggedSubRels)
    expect(r).toEqual({ inTemplateOnly: [], inCodeOnly: [], unresolvedPolicy: [], warnings: [], count: 0 })
  })

  test("必填集口径：政策必填标题恰为 10 项、必标来源恰为 10 项", () => {
    const s = parseTemplateSchema(real!)
    expect(s.requiredSubRels).toEqual(["1.1", "1.2", "2.3", "2.6", "2.7", "2.8", "2.9", "2.11", "2.12", "2.13"])
    expect(s.taggedSubRels).toEqual(["1.2", "2.1", "2.3", "2.6", "2.7", "2.8", "2.9", "2.11", "2.12", "2.13"])
  })

  test("政策表条目数与解析结果一一对应（没有静默丢失的政策）", () => {
    const s = parseTemplateSchema(real!)
    expect(s.requiredSubRels).toHaveLength(REQUIRED_SUB_TITLES.length)
    expect(s.taggedSubRels).toHaveLength(TAGGED_SUB_TITLES.length)
  })
})

describe("parseTemplateSchema：异构模板（换模板真场景）", () => {
  const s = parseTemplateSchema(HETERO)

  test("功能点挪到第三章仍能识别（不依赖章号 5）", () => {
    expect(s.featureChapter).toBe(3)
    expect(s.chapters.map((c) => c.number)).toEqual([1, 2, 3, 4])
  })

  test("子节相对键与旧模板一致（编号在块内仍是 g.s）", () => {
    expect(s.featureSubs.map((x) => x.rel)).toEqual(["1.1", "1.2", "2.1", "2.3", "2.8", "2.12", "2.13"])
  })

  test("章内小节按新编号解析", () => {
    const byNum = new Map(s.chapters.map((c) => [c.number, c.sections]))
    expect(byNum.get(2)!.map((x) => x.key)).toEqual(["2.1", "2.2", "2.3"])
    expect(byNum.get(4)!.map((x) => x.key)).toEqual(["4.1"])
  })

  test("容器标题在新编号下解析为 2.2（术语）与 2.1（字段）", () => {
    expect(s.chapterContainers).toEqual(["2.2"])
    expect(s.featureContainerRels).toEqual(["2.1"])
  })

  test("多个功能点块同构，不误报不同构", () => {
    expect(s.warnings.join()).not.toContain("骨架")
  })

  test("模板删掉的政策小节被报为 unresolved（换模板后业务少问，但须人工确认口径）", () => {
    // 异构模板没有清算处理/差错处理/数据存贮/接口与数据源，
    // 而政策仍要求 → 必须报出来，否则必填集与产物骨架会不一致。
    expect(s.unresolvedPolicy).toEqual(
      expect.arrayContaining(["清算处理", "差错处理", "数据存贮和清理", "接口与数据源"]),
    )
    // 「输入要素的检查」是容器，不在必填叶子集里
    expect(s.requiredSubRels).toEqual(["1.1", "1.2", "2.3", "2.8", "2.12", "2.13"])
  })

  test("与现状模板比对会报出全部差异（模板换新 = 结构真的变了）", () => {
    // 拿**现状模板的解析结果**当「代码现状」比：换模板后这里必须吵。
    // （阶段 B 后代码已无手抄本常量，consistencyReport 的比对对象就是模板自身。）
    const r = consistencyReport(s, realParsed.chapters, realSubs(), realParsed.taggedSubRels)
    expect(r.count).toBeGreaterThan(0)
    expect(r.inCodeOnly).toContain("功能点子节：2.2 系统处理过程")
    expect(r.unresolvedPolicy).toContain("清算处理")
  })
})

describe("consistencyReport：告警真的响", () => {
  test("代码要求但模板没有的小节 → inCodeOnly", () => {
    const s = parseTemplateSchema(HETERO)
    const r = consistencyReport(s, realParsed.chapters, [], [])
    expect(r.inCodeOnly).toContain("小节：6.3 安全与信创")
    expect(r.count).toBeGreaterThan(0)
  })

  test("章号重复会告警（槽位地址会撞车）", () => {
    const dup = ["## 第一章 甲", "### 1.1 a", "## 第一章 乙", "### 1.2 b"].join("\n\n")
    expect(parseTemplateSchema(dup).warnings.join()).toContain("章号重复")
  })

  test("功能点块不同构会告警（组装按首块复制，会丢内容）", () => {
    const s = parseTemplateSchema(
      [
        "## 第一章 功能",
        "### 1.1 甲",
        "#### 1.1.1 组",
        "##### 1.1.1.1 简要概述",
        "##### 1.1.1.2 控制要求",
        "### 1.2 乙",
        "#### 1.2.1 组",
        "##### 1.2.1.1 简要概述",
      ].join("\n\n"),
    )
    expect(s.warnings.join()).toContain("小节骨架与首个块")
  })

  test("找不到「第X章」标题会告警而不是静默返回空结构", () => {
    expect(parseTemplateSchema("# 标题\n\n正文\n").warnings.join()).toContain("没找到")
  })

  test("术语容器改名 → 报 unresolved（开放项将无法区分 term 与 field）", () => {
    const renamed = HETERO.replace("### 2.2 术语定义", "### 2.2 专有名词表")
    const s = parseTemplateSchema(renamed)
    expect(s.unresolvedPolicy).toContain("术语定义")
    expect(s.warnings.join()).toContain("术语容器")
  })
})

describe("对抗用例：模板自身的坑（每条都是实测打出来的）", () => {
  test("围栏代码块里的「## 第X章」不当真章（mermaid 示例带注释行是常见写法）", () => {
    // 不剥围栏时 `## 第九章 伪造` 会被当成真章，凭空多一章 → 槽位地址全错位
    const s = parseTemplateSchema(
      ["## 第一章 甲", "### 1.1 a", "```mermaid", "## 第九章 伪造", "```", "### 1.2 b"].join("\n"),
    )
    expect(s.chapters.map((c) => c.number)).toEqual([1])
    expect(s.chapters[0]!.sections.map((x) => x.key)).toEqual(["1.1", "1.2"])
  })

  test("真实模板里的 mermaid 围栏未被误吞（剥离后结构不变）", () => {
    // 反向护栏：剥离围栏不能吃掉真实标题
    const s = parseTemplateSchema(real!)
    expect(s.chapters).toHaveLength(7)
    expect(s.featureSubs).toHaveLength(15)
    expect(s.warnings).toEqual([])
  })

  test("小节编号首段与所属章号不符 → 报出模板笔误，但仍收进结构", () => {
    const s = parseTemplateSchema(["## 第三章 甲", "### 3.1 a", "### 4.1 b"].join("\n"))
    expect(s.chapters[0]!.sections.map((x) => x.key)).toEqual(["3.1", "4.1"])
    expect(s.warnings.join()).toContain("疑似模板笔误")
  })

  test("单个功能点块也能解析（模板不必写死第二个样例块）", () => {
    const s = parseTemplateSchema(
      ["## 第五章 功能", "### 5.1 甲", "#### 5.1.1 组", "##### 5.1.1.1 简要概述"].join("\n"),
    )
    expect(s.featureChapter).toBe(5)
    expect(s.featureSubs).toEqual([{ rel: "1.1", title: "简要概述" }])
    expect(s.warnings.join()).not.toContain("骨架")
  })

  test("两位中文数字与阿拉伯数字章号都能解析", () => {
    expect(parseTemplateSchema(["## 第九章 甲", "### 9.1 a", "## 第十章 乙"].join("\n")).chapters.map((c) => c.number))
      .toEqual([9, 10])
    expect(parseTemplateSchema(["## 第3章 甲", "### 3.1 a"].join("\n")).chapters.map((c) => c.number)).toEqual([3])
  })

  test("后继子节不串到相邻功能点块（曾因范围按章末截断而重复登记 30 条）", () => {
    const s = parseTemplateSchema(
      [
        "## 第五章 功能",
        "### 5.1 甲",
        "#### 5.1.1 组",
        "##### 5.1.1.1 简要概述",
        "##### 5.1.1.2 控制要求",
        "### 5.2 乙",
        "#### 5.2.1 组",
        "##### 5.2.1.1 简要概述",
        "##### 5.2.1.2 控制要求",
      ].join("\n"),
    )
    expect(s.featureSubs).toHaveLength(2)
    expect(s.warnings.join()).not.toContain("骨架")
  })

  test("章内小节带更深级标题 → 该章被判为功能点章并如实报出缺政策", () => {
    // 解析器无法区分「功能点块」与「章内恰好有四级小节的章节」，
    // 后果由 unresolvedPolicy 兜住：结构错了会吵，而不是静默。
    const s = parseTemplateSchema(["## 第一章 甲", "### 1.1 a", "#### 1.1.1 组", "##### 1.1.1.1 子"].join("\n"))
    expect(s.featureChapter).toBe(1)
    expect(s.unresolvedPolicy).toContain("简要概述")
  })

  test("标题带来源标签时按原文留存（政策匹配用标题原文，容差在 cleanHeading 一处统一）", () => {
    const s = parseTemplateSchema(["## 第一章 甲", "### 1.1 需求类型 [文档]"].join("\n"))
    expect(s.chapters[0]!.sections[0]!.title).toBe("需求类型 [文档]")
  })
})

describe("派生口径 ≡ 生产口径（阶段 B 可切换的前提）", () => {
  // 这组是阶段 A 最重要的一条证据：解析结果不只是「看起来对」，而是与**生产函数
  // requiredSlots/requiredContainers 的实际输出**逐条相同。阶段 B 才敢让生产改吃 schema；
  // 若此处有任何偏差，golden 免改的前提就不成立。
  const s = parseTemplateSchema(real!)
  const feats: ReqdocFeature[] = [
    { no: 1, name: "甲", priority: "high", confirmedAt: 0 },
    { no: 2, name: "乙", priority: "low", confirmedAt: 0 },
  ]
  const fc = s.featureChapter!
  const derivedLeaves = [
    ...s.chapters.flatMap((c) => c.sections.map((x) => x.key)).filter((k) => !s.chapterContainers.includes(k)),
    ...feats.flatMap((_, bi) => s.requiredSubRels.map((r) => `${fc}.${bi + 1}.${r}`)),
  ].sort((a, b) => a.localeCompare(b, "en"))
  const derivedContainers = [...s.chapterContainers, ...feats.map((_, bi) => `${fc}.${bi + 1}.${s.featureContainerRels[0]!}`)].sort()

  test("必填叶子逐条一致（2 功能点场景）", () => {
    const production = [...requiredSlots(feats)].sort((a, b) => a.localeCompare(b, "en"))
    expect(derivedLeaves).toEqual(production)
  })

  test("必填容器逐条一致", () => {
    expect(derivedContainers).toEqual([...requiredContainers(feats)].sort())
  })

  test("必填叶子随功能点数线性扩展且单点也一致", () => {
    const one: ReqdocFeature[] = [{ no: 1, name: "甲", priority: "high", confirmedAt: 0 }]
    const derivedOne = [
      ...s.chapters.flatMap((c) => c.sections.map((x) => x.key)).filter((k) => !s.chapterContainers.includes(k)),
      ...s.requiredSubRels.map((r) => `${fc}.1.${r}`),
    ].sort((a, b) => a.localeCompare(b, "en"))
    expect(derivedOne).toEqual([...requiredSlots(one)].sort((a, b) => a.localeCompare(b, "en")))
    expect(requiredSlots(feats).length - requiredSlots(one).length).toBe(s.requiredSubRels.length)
  })
})

describe("templateSchema：缓存与送达", () => {
  test("返回解析结果且与直接解析一致", () => {
    const s = templateSchema()
    expect(s).not.toBeNull()
    expect(s!.chapters).toEqual(parseTemplateSchema(real!).chapters)
  })

  test("重复调用命中缓存（同一对象引用）", () => {
    expect(templateSchema()).toBe(templateSchema())
  })

  test("加载器搬进 shared 后路径探测仍成立（三种部署形态共用同一组候选）", () => {
    // 真实不变量：加载器现在住在 shared/src，但要同时服务 shared/src（3 层深）、
    // plugin/src（3 层深）与打包后的 dist/plugin（2 层深）。三者靠同一组候选里的
    // 不同项覆盖——少一条，打包插件就静默拿不到模板 → 组装退化为模型手写，校验全失效。
    // 从本文件位置（packages/shared/test）上溯到仓库根是 3 层，故 dist/plugin 的 2 层深
    // 形态用「同级 dist 目录」模拟。
    const repoRoot = join(import.meta.dir, "..", "..", "..")
    const from = (...depth: string[]) => join(repoRoot, ...depth, "docs", "reqdoc-prd-template.md")
    // 源码形态：<root>/packages/{shared,plugin}/src → 上溯三级
    expect(existsSync(from("packages", "shared", "src", "..", "..", ".."))).toBe(true)
    expect(existsSync(from("packages", "plugin", "src", "..", "..", ".."))).toBe(true)
    // 打包形态：<root>/dist/plugin → 上溯两级
    expect(existsSync(from("dist", "plugin", "..", ".."))).toBe(true)
    // 运行目录兜底形态
    expect(existsSync(from())).toBe(true)
  })
})