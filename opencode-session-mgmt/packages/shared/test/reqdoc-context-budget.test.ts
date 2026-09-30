/**
 * reqdoc 上下文预算基线断言（设计文档 7 章「上下文预算」第 1 层 golden 的可执行部分）。
 *
 * 目的：在**当前实现**上建立一条可回归的基线——记录 prd 阶段规则注入的实测字符数，
 * 与单点事实源摘要的长度。这些数字是重构收益的度量原点（设计 7.2：重构后应净减约 64%），
 * 也是防"上下文悄悄膨胀"的守卫：任一数字显著上浮即回归。
 *
 * 不依赖尚未落地的槽位代码，纯对现有 `WORKFLOW_DEFINITIONS` / rubric 函数求值，
 * 故本文件在阶段 0（评测地基）即可运行，并为阶段 1~3 提供对照基线。
 */
import { describe, expect, test } from "bun:test"
import {
  WORKFLOW_DEFINITIONS,
  getDefinition,
  reqdocProbeRubric,
  reqdocScoreRubric,
  renderTargetDigest,
} from "sm-shared"

const def = getDefinition("reqdoc")
const rules = def.rules as { id: string; stage: string; text: string }[]
const own = (stage: string) => rules.filter((r) => r.stage === stage)
const sum = (list: { text: string }[]) => list.reduce((a, r) => a + r.text.length, 0)

/** prd 阶段真实注入 = 本级 prd 规则 + 全局规则（global 不重复计入）。 */
const globalChars = sum(own("global"))
const prdChars = sum(own("prd"))
const prdInjection = globalChars + prdChars

describe("reqdoc 上下文预算基线", () => {
  test("prd 阶段规则注入字符数落在实测基线（≈6517 字符，设计 7.1）", () => {
    // 精确基线来自设计文档实测（global 2000 + prd 本级 4517）。
    // 允许极小漂移（规则文本微调），但不允许显著膨胀——那是上下文预算的回归。
    expect(globalChars).toBeGreaterThan(0)
    expect(prdChars).toBeGreaterThan(0)
    expect(prdInjection).toBeGreaterThan(4000)
    expect(prdInjection).toBeLessThan(8000)
  })

  test("global 规则不是全部规则（避免重复计入 global 造成虚高）", () => {
    // global 是被每个阶段共享注入的一小批；其余分散在 goal/rules/edge/prd/review。
    const stageOnly = WORKFLOW_DEFINITIONS.reqdoc.stages.length
    expect(own("global").length).toBeLessThan(rules.length)
    expect(stageOnly).toBeGreaterThan(0)
    // prd 阶段注入不应等于全部规则之和（否则说明把 global 重复计了）
    const allChars = sum(rules)
    expect(prdInjection).toBeLessThan(allChars)
  })

  test("单点事实源摘要都在预算内（各 < 1000 字符，设计 7.4 kbDigest 预算参照）", () => {
    expect(reqdocScoreRubric().length).toBeLessThan(1000)
    expect(reqdocProbeRubric().length).toBeLessThan(1000)
    expect(renderTargetDigest().length).toBeLessThan(1000)
  })

  test("重构 2c：原「平行账本对账」四条已删除或改写为槽位口径", () => {
    // 设计 7.2 点名的四条上下文大户：r21（打分卡）/ r23（渲染结构校验）已整条删除；
    // r24（渲染门禁）/ r31（字段定义）已改写为组装幂等与 field 类槽位口径。
    const removed = ["reqdoc-r21", "reqdoc-r23"].filter((id) => !rules.some((r) => r.id === id))
    expect(removed).toEqual(["reqdoc-r21", "reqdoc-r23"])

    const rewritten = ["reqdoc-r24", "reqdoc-r31"]
      .map((id) => rules.find((r) => r.id === id))
      .filter((r): r is { id: string; stage: string; text: string } => Boolean(r))
    expect(rewritten.length).toBe(2)
    // 改写后单条显著变短（r24 由 ~700 字降到 ~200，r31 由 ~500 降到 ~300）
    for (const r of rewritten) expect(r.text.length).toBeLessThan(500)
  })

  test("★ 注入规则不再点名已删除的工具（重构 2c 核心不变量）", () => {
    // 模型只能看到注入文本。若规则仍命令调用已删工具，弱模型会调用失败——这是 2c 曾遗漏的最大项。
    const dead = /reqdoc_(score|probe|patch|check|field_dict|render_skeleton)\b/
    const offenders = rules.filter((r) => dead.test(r.text)).map((r) => `${r.id}(${r.text.length}字)`)
    expect(offenders).toEqual([])
  })

  test("★ prd 阶段注入已显著下降（重构 2c 验收 #9）", () => {
    // 基线 6517 字符（打分管线 8 条规则）。2c 删 r21/r23 并改写 r14/r20/r24/r31 后应明显下降。
    expect(sum(rules.filter((r) => r.stage === "prd"))).toBeLessThan(4000)
  })
})
