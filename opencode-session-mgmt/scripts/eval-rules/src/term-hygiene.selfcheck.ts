import { formatTermHygiene, parseTermHits } from "./term-hygiene"

/**
 * 术语白话解析器自检（不调模型，随 `--dry` 跑）——与选项质量自检同理：
 * 合成样例上绿 ≠ 真实输出上对，解析器自己先要被观测。
 */
export function termHygieneSelfCheck(): string[] {
  const fails: string[] = []

  const hit = parseTermHits("这个字段的枚举值有哪些？API 返回 token")
  if (hit.hits !== 3 || hit.byTerm["枚举值"] !== 1 || hit.byTerm["API"] !== 1 || hit.byTerm["token"] !== 1) {
    fails.push(`命中词未计出（期望 枚举值/API/token 各 1，实际 ${JSON.stringify(hit.byTerm)}）`)
  }

  // 长词不被子词重复计：「枚举值」只记枚举值，不重复记「枚举」
  const dup = parseTermHits("枚举值")
  if (dup.hits !== 1 || dup.byTerm["枚举值"] !== 1 || dup.byTerm["枚举"] !== undefined) {
    fails.push(`长词被子词重复计数（实际 ${JSON.stringify(dup.byTerm)}）`)
  }

  // 业务已接受的词不入表：接口 / 字段 / 数据库 不算命中
  const clean = parseTermHits("这个接口的字段存到数据库，允许填哪几种值？")
  if (clean.hits !== 0) {
    fails.push(`业务语言被误计（实际 ${JSON.stringify(clean.byTerm)}）`)
  }

  // 拉丁词大小写不敏感
  const ci = parseTermHits("返回 json 内容")
  if (ci.byTerm["JSON"] !== 1) fails.push("拉丁词大小写不敏感失效")

  if (formatTermHygiene("纯业务话术").includes("0 处命中") === false) {
    fails.push("0 命中格式串异常")
  }
  return fails
}
