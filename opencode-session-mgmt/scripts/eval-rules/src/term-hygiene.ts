/**
 * 术语白话观测（阶段 1：**只测量、不判定**）。
 *
 * 背景：业务反馈「枚举值」这类科技用语听不懂（非技术背景用户的术语障碍）。
 * 已有两道防线——`reqdoc-r2` 规则禁令 + `07-业务口语` 对照表——但都是软约束，
 * 问句又在模型正文里（不在工具入参），服务端拦不到、判据也不该拦（n=1 方差会
 * 重演「判据与规则反向」）。故照选项质量的路子：先拿命中基线，再决定要不要加码。
 *
 * 口径：只扫**业务可见的回复正文**（与选项质量同一文本源）；工具名/回执是面向
 * 模型的，不计。拉丁词大小写不敏感。词表取「数据字典 + 开发高频词」宁多不漏——
 * 观察项判宽了只是读数偏高，漏了才是瞎子；**「接口」「字段」「数据库」等业务
 * 已接受的词不入表**（07-业务口语 对照表认定 API→「接口」是业务语言）。
 */
export const TECH_TERMS = [
  "枚举值",
  "枚举",
  "布尔",
  "主键",
  "外键",
  "字段类型",
  "数据类型",
  "幂等",
  "高并发",
  "异步",
  "回调",
  "微服务",
  "集群",
  "索引",
  "状态机",
  "请求参数",
  "响应码",
  "JSON",
  "API",
  "token",
] as const

export interface TermHygieneReport {
  /** 命中总处数（词次相加） */
  hits: number
  /** 逐词次数，只含命中过的词 */
  byTerm: Record<string, number>
}

/** 逐词计数。长词先于其子词（「枚举值」先于「枚举」——扫到「枚举值」记「枚举值」，不再重复记「枚举」）。 */
export function parseTermHits(text: string): TermHygieneReport {
  const byTerm: Record<string, number> = {}
  const ordered = [...TECH_TERMS].sort((a, b) => b.length - a.length)
  // 子串先从文中「摘除」再计后续词，保证长词命中不被短词重复计
  let rest = text
  for (const term of ordered) {
    const isLatin = /^[a-z]+$/i.test(term)
    const flags = isLatin ? "gi" : "g"
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags)
    const matches = rest.match(re)
    if (matches?.length) {
      byTerm[term] = matches.length
      rest = rest.replace(re, " ")
    }
  }
  const hits = Object.values(byTerm).reduce((a, b) => a + b, 0)
  return { hits, byTerm }
}

export function formatTermHygiene(text: string): string {
  const r = parseTermHits(text)
  if (r.hits === 0) return "术语白话（观察项，不计通过率）：0 处命中"
  const detail = Object.entries(r.byTerm)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t}×${n}`)
    .join("、")
  return `术语白话（观察项，不计通过率）：命中 ${r.hits} 处（${detail}）`
}
