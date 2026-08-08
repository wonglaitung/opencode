import { describe, expect, test } from "bun:test"
import { reviewRecord } from "sm-shared"
import { Store } from "../src/db"
import { createReviewTools } from "../src/tools/review"

function reviewOf(store: Store, id = "s1") {
  return reviewRecord(store.get(id)!.workflow!)
}

const ctx = { sessionID: "s1" } as never

function setup() {
  const store = Store.memory()
  const tools = createReviewTools(store)
  return { store, tools }
}

describe("comprehension 工具", () => {
  test("add 后 confirm 置真且定论为 accepted", async () => {
    const { store, tools } = setup()
    await tools.comprehension_add!.execute(
      { codeSegmentId: "a.ts:1-2", file: "a.ts", lineStart: 1, lineEnd: 2, explanation: "解释" } as never,
      ctx,
    )
    expect(reviewOf(store).comprehension[0]!.decision).toBe("pending")
    await tools.comprehension_confirm!.execute({ codeSegmentId: "a.ts:1-2" } as never, ctx)
    const rec = reviewOf(store).comprehension[0]!
    expect(rec.developerConfirmed).toBe(true)
    expect(rec.decision).toBe("accepted")
    store.close()
  })

  test("confirm 不存在的片段报错", async () => {
    const { store, tools } = setup()
    await expect(
      tools.comprehension_confirm!.execute({ codeSegmentId: "nope" } as never, ctx),
    ).rejects.toThrow(/不存在/)
    store.close()
  })

  test("ask 将问答追加到 explanation", async () => {
    const { store, tools } = setup()
    await tools.comprehension_add!.execute(
      { codeSegmentId: "a.ts:1-2", file: "a.ts", lineStart: 1, lineEnd: 2, explanation: "原解释" } as never,
      ctx,
    )
    await tools.comprehension_ask!.execute(
      { codeSegmentId: "a.ts:1-2", question: "为何?", answer: "因为X" } as never,
      ctx,
    )
    const explanation = reviewOf(store).comprehension[0]!.explanation
    expect(explanation).toContain("为何?")
    expect(explanation).toContain("因为X")
    store.close()
  })
})

describe("评审状态机（reject/rewrite/manual）", () => {
  test("reject：pending → rejected，feedback 留痕", async () => {
    const { store, tools } = setup()
    await tools.comprehension_add!.execute(
      { codeSegmentId: "a", file: "a.ts", lineStart: 1, lineEnd: 2, explanation: "e" } as never,
      ctx,
    )
    await tools.comprehension_reject!.execute({ codeSegmentId: "a", feedback: "应处理空值" } as never, ctx)
    const rec = reviewOf(store).comprehension[0]!
    expect(rec.decision).toBe("rejected")
    expect(rec.feedback).toBe("应处理空值")
    expect(rec.rejectedAt).not.toBeNull()
    store.close()
  })

  test("reject 非 pending 片段报错", async () => {
    const { store, tools } = setup()
    await tools.comprehension_add!.execute(
      { codeSegmentId: "a", file: "a.ts", lineStart: 1, lineEnd: 2, explanation: "e" } as never,
      ctx,
    )
    await tools.comprehension_confirm!.execute({ codeSegmentId: "a" } as never, ctx)
    await expect(
      tools.comprehension_reject!.execute({ codeSegmentId: "a", feedback: "x" } as never, ctx),
    ).rejects.toThrow(/仅 pending 可拒绝/)
    store.close()
  })

  test("rewrite：rejected → pending，rewrites++", async () => {
    const { store, tools } = setup()
    await tools.comprehension_add!.execute(
      { codeSegmentId: "a", file: "a.ts", lineStart: 1, lineEnd: 2, explanation: "e" } as never,
      ctx,
    )
    await tools.comprehension_reject!.execute({ codeSegmentId: "a", feedback: "f" } as never, ctx)
    await tools.comprehension_rewrite!.execute({ codeSegmentId: "a" } as never, ctx)
    const rec = reviewOf(store).comprehension[0]!
    expect(rec.decision).toBe("pending")
    expect(rec.rewrites).toBe(1)
    expect(rec.developerConfirmed).toBe(false)
    store.close()
  })

  test("rewrite 非 rejected 片段报错", async () => {
    const { store, tools } = setup()
    await tools.comprehension_add!.execute(
      { codeSegmentId: "a", file: "a.ts", lineStart: 1, lineEnd: 2, explanation: "e" } as never,
      ctx,
    )
    await expect(tools.comprehension_rewrite!.execute({ codeSegmentId: "a" } as never, ctx)).rejects.toThrow(
      /仅 rejected 可重写/,
    )
    store.close()
  })

  test("manual：rejected → manual，resolution 留痕", async () => {
    const { store, tools } = setup()
    await tools.comprehension_add!.execute(
      { codeSegmentId: "a", file: "a.ts", lineStart: 1, lineEnd: 2, explanation: "e" } as never,
      ctx,
    )
    await tools.comprehension_reject!.execute({ codeSegmentId: "a", feedback: "f" } as never, ctx)
    await tools.comprehension_manual!.execute({ codeSegmentId: "a", resolution: "已人工重写" } as never, ctx)
    const rec = reviewOf(store).comprehension[0]!
    expect(rec.decision).toBe("manual")
    expect(rec.resolution).toBe("已人工重写")
    store.close()
  })

  test("manual 非 rejected 片段报错", async () => {
    const { store, tools } = setup()
    await tools.comprehension_add!.execute(
      { codeSegmentId: "a", file: "a.ts", lineStart: 1, lineEnd: 2, explanation: "e" } as never,
      ctx,
    )
    await expect(
      tools.comprehension_manual!.execute({ codeSegmentId: "a", resolution: "r" } as never, ctx),
    ).rejects.toThrow(/仅 rejected 可由开发者 manual 处理/)
    store.close()
  })

  test("rejected 片段可复议 confirm 为 accepted", async () => {
    const { store, tools } = setup()
    await tools.comprehension_add!.execute(
      { codeSegmentId: "a", file: "a.ts", lineStart: 1, lineEnd: 2, explanation: "e" } as never,
      ctx,
    )
    await tools.comprehension_reject!.execute({ codeSegmentId: "a", feedback: "f" } as never, ctx)
    await tools.comprehension_confirm!.execute({ codeSegmentId: "a" } as never, ctx)
    expect(reviewOf(store).comprehension[0]!.decision).toBe("accepted")
    store.close()
  })

  test("manual 终态不可再 confirm", async () => {
    const { store, tools } = setup()
    await tools.comprehension_add!.execute(
      { codeSegmentId: "a", file: "a.ts", lineStart: 1, lineEnd: 2, explanation: "e" } as never,
      ctx,
    )
    await tools.comprehension_reject!.execute({ codeSegmentId: "a", feedback: "f" } as never, ctx)
    await tools.comprehension_manual!.execute({ codeSegmentId: "a", resolution: "r" } as never, ctx)
    await expect(tools.comprehension_confirm!.execute({ codeSegmentId: "a" } as never, ctx)).rejects.toThrow(
      /已 manual 终态/,
    )
    store.close()
  })
})

describe("review_submit 门禁", () => {
  test("纯讨论会话（无代码编辑）无片段也可通过", async () => {
    const { store, tools } = setup()
    await tools.review_submit!.execute(
      { businessIntent: true, logicExplainable: true, behaviorVerifiable: true } as never,
      ctx,
    )
    expect(reviewOf(store).status).toBe("approved")
    store.close()
  })

  test("有代码编辑但无片段时拒绝", async () => {
    const { store, tools } = setup()
    store.mutateWorkflow("s1", (wf) => {
      wf.quality.iterationCount = 2 // 模拟本会话已有 AI 代码编辑
    })
    await expect(
      tools.review_submit!.execute(
        { businessIntent: true, logicExplainable: true, behaviorVerifiable: true } as never,
        ctx,
      ),
    ).rejects.toThrow(/片段/)
    store.close()
  })

  test("重复 review_submit 幂等（已 approved 不再报错）", async () => {
    const { store, tools } = setup()
    const args = { businessIntent: true, logicExplainable: true, behaviorVerifiable: true } as never
    await tools.review_submit!.execute(args, ctx)
    await expect(tools.review_submit!.execute(args, ctx)).resolves.toBeDefined()
    expect(reviewOf(store).status).toBe("approved")
    store.close()
  })

  test("存在 pending 片段时拒绝（未定论悬空）", async () => {
    const { store, tools } = setup()
    await tools.comprehension_add!.execute(
      { codeSegmentId: "a", file: "a.ts", lineStart: 1, lineEnd: 2, explanation: "e" } as never,
      ctx,
    )
    await expect(
      tools.review_submit!.execute(
        { businessIntent: true, logicExplainable: true, behaviorVerifiable: true } as never,
        ctx,
      ),
    ).rejects.toThrow(/未定论/)
    store.close()
  })

  test("存在 rejected 片段时拒绝（须 rewrite/manual 定论）", async () => {
    const { store, tools } = setup()
    await tools.comprehension_add!.execute(
      { codeSegmentId: "a", file: "a.ts", lineStart: 1, lineEnd: 2, explanation: "e" } as never,
      ctx,
    )
    await tools.comprehension_reject!.execute({ codeSegmentId: "a", feedback: "f" } as never, ctx)
    await expect(
      tools.review_submit!.execute(
        { businessIntent: true, logicExplainable: true, behaviorVerifiable: true } as never,
        ctx,
      ),
    ).rejects.toThrow(/未定论/)
    store.close()
  })

  test("清单缺项时拒绝", async () => {
    const { store, tools } = setup()
    await tools.comprehension_add!.execute(
      { codeSegmentId: "a", file: "a.ts", lineStart: 1, lineEnd: 2, explanation: "e" } as never,
      ctx,
    )
    await tools.comprehension_confirm!.execute({ codeSegmentId: "a" } as never, ctx)
    await expect(
      tools.review_submit!.execute(
        { businessIntent: false, logicExplainable: true, behaviorVerifiable: true } as never,
        ctx,
      ),
    ).rejects.toThrow(/清单/)
    store.close()
  })

  test("全部满足时审查通过且门禁重算", async () => {
    const { store, tools } = setup()
    await tools.comprehension_add!.execute(
      { codeSegmentId: "a", file: "a.ts", lineStart: 1, lineEnd: 2, explanation: "e" } as never,
      ctx,
    )
    await tools.comprehension_confirm!.execute({ codeSegmentId: "a" } as never, ctx)
    await tools.review_submit!.execute(
      { businessIntent: true, logicExplainable: true, behaviorVerifiable: true } as never,
      ctx,
    )
    const wf = store.get("s1")!.workflow!
    expect(reviewOf(store).status).toBe("approved")
    expect(reviewOf(store).checklist.designRationale).toBe(true)
    expect(wf.commit.blocked_by).not.toContain("review")
    store.close()
  })
})

describe("reqdoc 工作流（业务确认 PRD 要点）", () => {
  test("要点可无 file/lines 登记，review_submit 通过且计算一次通过率", async () => {
    const store = Store.memory(() => "reqdoc" as const)
    const tools = createReviewTools(store)
    const ctx = { sessionID: "r1" } as never
    const wf = store.ensure("r1").workflow!
    expect(wf.type).toBe("reqdoc")
    // reqdoc 要点：不填 file/lineStart/lineEnd
    await tools.comprehension_add!.execute(
      { codeSegmentId: "目标与场景", explanation: "面向一线柜员，缩短开户录入时间" } as never,
      ctx,
    )
    await tools.comprehension_confirm!.execute({ codeSegmentId: "目标与场景" } as never, ctx)
    // reqdoc 清单四项具名参数
    await tools.review_submit!.execute(
      {
        completeness: true,
        clarity: true,
        edgeCoverage: true,
        resolution: true,
      } as never,
      ctx,
    )
    const review = reviewRecord(store.get("r1")!.workflow!)
    expect(review.status).toBe("approved")
    expect(review.checklist).toEqual({
      completeness: true,
      clarity: true,
      edgeCoverage: true,
      resolution: true,
    })
    // 1 段一次通过 → 100%
    expect(store.get("r1")!.workflow!.quality.firstPassRate).toBe(100)
    // reqdoc 无提交门禁：commit 状态仍为 blocked（四阶段未 approve），但门禁不拦截
    store.close()
  })

  test("reqdoc 要点无代码位置信息（id 即要点，file/lines undefined）", async () => {
    const store = Store.memory(() => "reqdoc" as const)
    const tools = createReviewTools(store)
    await tools.comprehension_add!.execute(
      { codeSegmentId: "异常探头", explanation: "接口超时人工补单" } as never,
      { sessionID: "r1" } as never,
    )
    const rec = reviewRecord(store.get("r1")!.workflow!).comprehension[0]!
    expect(rec.id).toBe("异常探头")
    expect(rec.file).toBeUndefined()
    expect(rec.lines).toBeUndefined()
    store.close()
  })
})

describe("firstPassRate 自动计算", () => {
  test("一次通过片段计入分子；重写后 accepted 不计入", async () => {
    const { store, tools } = setup()
    // a：直接 confirm → 一次通过
    await tools.comprehension_add!.execute(
      { codeSegmentId: "a", file: "a.ts", lineStart: 1, lineEnd: 2, explanation: "e" } as never,
      ctx,
    )
    await tools.comprehension_confirm!.execute({ codeSegmentId: "a" } as never, ctx)
    // b：reject → rewrite → confirm → 非一次通过
    await tools.comprehension_add!.execute(
      { codeSegmentId: "b", file: "b.ts", lineStart: 1, lineEnd: 2, explanation: "e" } as never,
      ctx,
    )
    await tools.comprehension_reject!.execute({ codeSegmentId: "b", feedback: "f" } as never, ctx)
    await tools.comprehension_rewrite!.execute({ codeSegmentId: "b" } as never, ctx)
    await tools.comprehension_confirm!.execute({ codeSegmentId: "b" } as never, ctx)
    await tools.review_submit!.execute(
      { businessIntent: true, logicExplainable: true, behaviorVerifiable: true } as never,
      ctx,
    )
    // 2 段定论，仅 a 一次通过 → 50%
    expect(store.get("s1")!.workflow!.quality.firstPassRate).toBe(50)
    store.close()
  })

  test("manual 片段计入分母但不计入分子", async () => {
    const { store, tools } = setup()
    await tools.comprehension_add!.execute(
      { codeSegmentId: "a", file: "a.ts", lineStart: 1, lineEnd: 2, explanation: "e" } as never,
      ctx,
    )
    await tools.comprehension_confirm!.execute({ codeSegmentId: "a" } as never, ctx)
    await tools.comprehension_add!.execute(
      { codeSegmentId: "b", file: "b.ts", lineStart: 1, lineEnd: 2, explanation: "e" } as never,
      ctx,
    )
    await tools.comprehension_reject!.execute({ codeSegmentId: "b", feedback: "f" } as never, ctx)
    await tools.comprehension_manual!.execute({ codeSegmentId: "b", resolution: "已废弃" } as never, ctx)
    await tools.review_submit!.execute(
      { businessIntent: true, logicExplainable: true, behaviorVerifiable: true } as never,
      ctx,
    )
    // a accepted(rewrites=0) + b manual → 1/2 = 50%
    expect(store.get("s1")!.workflow!.quality.firstPassRate).toBe(50)
    store.close()
  })

  test("纯讨论会话无片段时 firstPassRate 保持 null", async () => {
    const { store, tools } = setup()
    await tools.review_submit!.execute(
      { businessIntent: true, logicExplainable: true, behaviorVerifiable: true } as never,
      ctx,
    )
    expect(store.get("s1")!.workflow!.quality.firstPassRate).toBeNull()
    store.close()
  })

  test("全部一次通过时为 100", async () => {
    const { store, tools } = setup()
    await tools.comprehension_add!.execute(
      { codeSegmentId: "a", file: "a.ts", lineStart: 1, lineEnd: 2, explanation: "e" } as never,
      ctx,
    )
    await tools.comprehension_confirm!.execute({ codeSegmentId: "a" } as never, ctx)
    await tools.review_submit!.execute(
      { businessIntent: true, logicExplainable: true, behaviorVerifiable: true } as never,
      ctx,
    )
    expect(store.get("s1")!.workflow!.quality.firstPassRate).toBe(100)
    store.close()
  })
})
