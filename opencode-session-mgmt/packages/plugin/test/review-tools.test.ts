import { describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { createReviewTools } from "../src/tools/review"

const ctx = { sessionID: "s1" } as never

function setup() {
  const store = Store.memory()
  const tools = createReviewTools(store)
  return { store, tools }
}

describe("comprehension 工具", () => {
  test("add 后 confirm 置真", async () => {
    const { store, tools } = setup()
    await tools.comprehension_add!.execute(
      { codeSegmentId: "a.ts:1-2", file: "a.ts", lineStart: 1, lineEnd: 2, explanation: "解释" } as never,
      ctx,
    )
    await tools.comprehension_confirm!.execute({ codeSegmentId: "a.ts:1-2" } as never, ctx)
    const review = store.get("s1")!.workflow!.stages.review
    expect(review.comprehension[0]!.developerConfirmed).toBe(true)
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
    const explanation = store.get("s1")!.workflow!.stages.review.comprehension[0]!.explanation
    expect(explanation).toContain("为何?")
    expect(explanation).toContain("因为X")
    store.close()
  })
})

describe("review_submit 门禁", () => {
  test("无片段时拒绝", async () => {
    const { store, tools } = setup()
    await expect(
      tools.review_submit!.execute(
        { businessIntent: true, logicExplainable: true, behaviorVerifiable: true } as never,
        ctx,
      ),
    ).rejects.toThrow(/片段/)
    store.close()
  })

  test("片段未全部确认时拒绝", async () => {
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
    ).rejects.toThrow(/未确认/)
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
    expect(wf.stages.review.status).toBe("approved")
    expect(wf.stages.review.checklist.designRationale).toBe(true)
    expect(wf.commit.blocked_by).not.toContain("review")
    store.close()
  })
})
