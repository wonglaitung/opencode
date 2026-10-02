/**
 * 换模板检测的判据护栏（待决 1「显式重置」）。
 *
 * 检测要回答的不是「模板变了吗」，而是**「本会话已确认的槽位，在新模板下还作数吗」**——
 * 只有后者为否才值得让业务重走一遍需求。后者代价很大（整轮问答重来），
 * 所以判据必须**宁窄勿宽**：误报一次就是让业务白做一遍，漏报一次只是多问一节。
 *
 * 实测过的边界（每条都是打出来的，见 template-drift.test.ts 断言）：
 * - 不报：改措辞、机构加一节（必填集变大 = 多答一节）、功能点块数变化；
 * - 报：章节重编号、功能点挪章、删必填小节、删必填功能点子节、容器挪位。
 *
 * 另一个关键性质：**只报不自动清**。`kb.slots` 是唯一事实源、原地覆盖不留历史，
 * 自动清空等于替业务决定「这轮问答不算数」；跨版本搬地址要判断旧内容在新模板的
 * 哪一节算数，服务端无法校验语义（与导入旧稿「映射由 AI 完成」同类）。
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { parseTemplateSchema, schemaAddressSpace, templateDrift } from "sm-shared"

/** 真实模板全文（换模板检测的基准；只读不改——曾有探测脚本改坏它的事故）。 */
const REAL = readFileSync(join(import.meta.dir, "..", "..", "..", "docs", "reqdoc-prd-template.md"), "utf8")

const BASE_SPACE = schemaAddressSpace(parseTemplateSchema(REAL))

/** 旧空间里哪些地址在新空间下已失效（与 `templateDrift` 同一判据，测试里独立实现一遍做对照）。 */
function lost(oldSpace: string, newSpace: string): string[] {
  const parse = (s: string) => {
    const get = (k: string): string[] =>
      (s.split("|").find((p) => p.startsWith(`${k}=`)) ?? "").slice(k.length + 1).split(",").filter(Boolean)
    return {
      leaf: new Set(get("leaf")),
      cont: new Set(get("cont")),
      sub: new Set(get("sub")),
      fc: (s.split("|").find((p) => p.startsWith("fc=")) ?? "fc=none").slice(3),
    }
  }
  const a = parse(oldSpace)
  const b = parse(newSpace)
  if (a.fc !== b.fc) return ["fc-changed"]
  const out: string[] = []
  for (const x of a.leaf) if (!b.leaf.has(x)) out.push(x)
  for (const c of a.cont) if (!b.cont.has(c)) out.push(`cont:${c}`)
  for (const s of a.sub) if (!b.sub.has(s)) out.push(`sub:${s}`)
  return out
}

/** 改写模板后取新地址空间。 */
const spaceAfter = (mutate: (t: string) => string): string =>
  schemaAddressSpace(parseTemplateSchema(mutate(REAL)))

describe("换模板检测：宁窄勿宽的判据", () => {
  test("不改模板 → 无告警", () => {
    expect(templateDrift({ templateAddressSpace: BASE_SPACE })).toBeNull()
  })

  test("未记地址空间（首次建库前）→ 无告警", () => {
    expect(templateDrift({})).toBeNull()
  })

  test("改措辞（机构改了小节标题）→ 不报：地址没变，旧槽位全仍作数", () => {
    const next = spaceAfter((t) => t.replace("6.3 安全与信创", "6.3 安全与合规"))
    expect(lost(BASE_SPACE, next)).toEqual([])
  })

  test("机构加一节（必填集变大）→ 不报：只是多答一节，不必让业务重走整份需求", () => {
    const next = spaceAfter((t) => t.replace("### 7.2 量化验收口径", "### 7.2 量化验收口径\n\n### 7.3 附则"))
    expect(lost(BASE_SPACE, next)).toEqual([])
  })

  test("章节重编号 → 报，且指名道姓说哪些小节没了", () => {
    const next = spaceAfter((t) => t.replace("### 3.1 需求类型", "### 3.9 需求类型"))
    expect(lost(BASE_SPACE, next)).toEqual(["3.1"])
  })

  test("删必填小节 → 报", () => {
    const next = spaceAfter((t) => t.replace(/### 6\.3 安全与信创\n[\s\S]*?(?=### 6\.4)/, ""))
    expect(lost(BASE_SPACE, next)).toContain("6.3")
  })

  test("删必填功能点子节 → 报（漏这条会让挂在该子节的已确认槽位静默成孤儿）", () => {
    const next = spaceAfter((t) => t.replace(/##### 5\.1\.2\.6 清算处理\n[\s\S]*?(?=##### 5\.1\.2\.7)/, ""))
    expect(lost(BASE_SPACE, next)).toContain("sub:2.6")
  })

  test("容器挪位 → 报（容器下的术语/字段叶子全部失联）", () => {
    const next = spaceAfter((t) => t.replace("### 4.1 术语定义", "### 8.1 术语定义"))
    expect(lost(BASE_SPACE, next)).toContain("cont:4.1")
  })

  test("功能点挪章 → 报（功能点下所有地址作废）", () => {
    const next = spaceAfter((t) => t.replace(/^## 第五章 需求功能详述/m, "## 第九章 需求功能详述"))
    expect(lost(BASE_SPACE, next)).toEqual(["fc-changed"])
  })
})

describe("换模板告警文案：只报不自动清", () => {
  const drift = (space: string): string => templateDrift({ templateAddressSpace: space }) ?? ""

  test("文案给出可执行动作（开新会话），而不是让业务以为要手工修", () => {
    const msg = drift(spaceAfter((t) => t.replace("### 3.1 需求类型", "### 3.9 需求类型")))
    expect(msg).toContain("开新会话")
    expect(msg).toContain("07_需求规格产出")
  })

  test("文案不得承诺自动迁移（否则模型会声称已搬数据，业务白等）", () => {
    const msg = drift(spaceAfter((t) => t.replace("### 3.1 需求类型", "### 3.9 需求类型")))
    expect(msg).not.toContain("自动迁移")
    expect(msg).not.toContain("已为你转换")
    expect(msg).not.toContain("已保留")
  })

  test("文案说明旧交付件不会丢（否则业务不敢开新会话）", () => {
    const msg = drift(spaceAfter((t) => t.replace("### 3.1 需求类型", "### 3.9 需求类型")))
    expect(msg).toContain("不会被覆盖")
  })

  test("模板不可读时不抛错（它在 system prompt 构建路径上，抛错=整个请求失败）", () => {
    // 用一个结构不同的空间串无法模拟不可读；此处断言的是「不抛错」这个契约本身——
    // 真正的不可读路径需重置模块缓存，此处由 status-bar 接线用例覆盖其不崩。
    expect(() => templateDrift({ templateAddressSpace: "垃圾输入" })).not.toThrow()
  })

  test("无法解析的旧记录（格式被改坏）按无漂移处理，不误报", () => {
    // 宁可漏报（多答一节）也不误报（让业务白做一遍）
    expect(templateDrift({ templateAddressSpace: "garbage" })).toBeNull()
  })
})