/**
 * reqdoc_score 打分卡工具测试（实施方案第三节）。
 * 覆盖：服务端算总分、越界/缺维度拒绝、business_confirmed=false 拒绝、
 * 写 WorkflowState、重打覆盖、仅 reqdoc 可用、返回达标/未达标提示。
 */
import { describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { createReqdocScoreTools } from "../src/tools/reqdoc-score"

const ctx = { sessionID: "s1" } as never

/** 五维达标参数（总分 90）。 */
function passingDims() {
  return [
    { key: "businessValue", score: 15 },
    { key: "flowClosure", score: 25 },
    { key: "edgeControl", score: 30 },
    { key: "compliance", score: 10 },
    { key: "authority", score: 10 },
  ]
}

describe("reqdoc_score", () => {
  test("服务端计算总分并写入 workflow.score（含扣分明细/确认/时间戳）", async () => {
    const store = Store.memory(() => "reqdoc")
    const tools = createReqdocScoreTools(store)
    const dims = passingDims()
    // 其中 edgeControl 扣 5 分带证据
    const out = await tools.reqdoc_score!.execute(
      {
        dims,
        business_confirmed: true,
      } as never,
      ctx,
    )
    expect(String(out)).toContain("90/100")
    expect(String(out)).toContain("达标")
    const score = store.get("s1")!.workflow!.score!
    expect(score.total).toBe(90)
    expect(score.confirmed).toBe(true)
    expect(typeof score.confirmedAt).toBe("number")
    expect(typeof score.updatedAt).toBe("number")
    expect(score.dims.businessValue).toEqual({ score: 15, max: 15 })
    expect(score.dims.edgeControl).toEqual({ score: 30, max: 30 })
    store.close()
  })

  test("工具描述携带完整评分标准（单一事实源 reqdocScoreRubric，含逐维扣分标准）", () => {
    const store = Store.memory(() => "reqdoc")
    const tools = createReqdocScoreTools(store)
    const description = tools.reqdoc_score!.description
    expect(description).toContain("评分标准（满分 100）")
    expect(description).toContain("扣25分：未提及任何异常")
    expect(description).toContain("网络超时")
    expect(description).toContain("扣10分：缺失使用角色")
    store.close()
  })

  test("扣分明细随调用写入（reason/points/evidence 原样记录）", async () => {
    const store = Store.memory(() => "reqdoc")
    const tools = createReqdocScoreTools(store)
    await tools.reqdoc_score!.execute(
      {
        dims: [
          ...passingDims().slice(0, 3),
          { key: "compliance", score: 10, deductions: [{ reason: "缺审计留痕", points: 5, evidence: "03_流程与数据/清分.md:12" }] },
          { key: "authority", score: 10 },
        ],
        business_confirmed: true,
      } as never,
      ctx,
    )
    const deductions = store.get("s1")!.workflow!.score!.deductions
    expect(deductions).toHaveLength(1)
    expect(deductions[0]).toMatchObject({
      key: "compliance",
      points: 5,
      reason: "缺审计留痕",
      evidence: "03_流程与数据/清分.md:12",
    })
    store.close()
  })

  test("维度越界（score > 该维度满分）被拒", async () => {
    const store = Store.memory(() => "reqdoc")
    const tools = createReqdocScoreTools(store)
    const dims = passingDims()
    dims[4] = { key: "authority", score: 11 }
    await expect(
      tools.reqdoc_score!.execute({ dims, business_confirmed: true } as never, ctx),
    ).rejects.toThrow(/超出满分/)
    store.close()
  })

  test("缺维度被拒", async () => {
    const store = Store.memory(() => "reqdoc")
    const tools = createReqdocScoreTools(store)
    await expect(
      tools.reqdoc_score!.execute({ dims: passingDims().slice(0, 4), business_confirmed: true } as never, ctx),
    ).rejects.toThrow(/缺少维度/)
    store.close()
  })

  test("business_confirmed=false 被拒（防 AI 自评自批）", async () => {
    const store = Store.memory(() => "reqdoc")
    const tools = createReqdocScoreTools(store)
    await expect(
      tools.reqdoc_score!.execute({ dims: passingDims(), business_confirmed: false } as never, ctx),
    ).rejects.toThrow(/business_confirmed/)
    expect(store.get("s1")?.workflow?.score).toBeUndefined()
    store.close()
  })

  test("仅 reqdoc 工作流可用（sdlc 拒绝）", async () => {
    const store = Store.memory(() => "sdlc")
    const tools = createReqdocScoreTools(store)
    await expect(
      tools.reqdoc_score!.execute({ dims: passingDims(), business_confirmed: true } as never, ctx),
    ).rejects.toThrow(/仅用于 reqdoc/)
    store.close()
  })

  test("低于 85 分返回未达标提示（记录低分事实）", async () => {
    const store = Store.memory(() => "reqdoc")
    const tools = createReqdocScoreTools(store)
    const out = await tools.reqdoc_score!.execute(
      {
        dims: [
          { key: "businessValue", score: 15 },
          { key: "flowClosure", score: 20 },
          { key: "edgeControl", score: 25 },
          { key: "compliance", score: 5 },
          { key: "authority", score: 10 },
        ],
        business_confirmed: true,
      } as never,
      ctx,
    )
    expect(String(out)).toContain("75/100")
    expect(String(out)).toContain("未达标")
    expect(store.get("s1")!.workflow!.score!.total).toBe(75)
    store.close()
  })

  test("重打覆盖旧打分（扣分明细整体替换，记录新 updatedAt）", async () => {
    const store = Store.memory(() => "reqdoc")
    const tools = createReqdocScoreTools(store)
    await tools.reqdoc_score!.execute(
      {
        dims: [
          { key: "businessValue", score: 15 },
          { key: "flowClosure", score: 20 },
          { key: "edgeControl", score: 25 },
          { key: "compliance", score: 5 },
          { key: "authority", score: 10 },
        ],
        business_confirmed: true,
      } as never,
      ctx,
    )
    const first = store.get("s1")!.workflow!.score!
    // 补缺后重打（edge 追问后达标）
    await tools.reqdoc_score!.execute({ dims: passingDims(), business_confirmed: true } as never, ctx)
    const second = store.get("s1")!.workflow!.score!
    expect(second.total).toBe(90)
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt)
    store.close()
  })
})
