/**
 * question 工具选择菜单的预估证据（6.3）。
 * 选择结果以 tool result 返回，不触发 chat.message；由 tool.execute.after 提取后
 * 写入与聊天消息相同的 baselineProposedByDev，workflow_baseline 才能放行。
 */
import { describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { createWorkflowTools } from "../src/tools/workflow"
import { applyQuestionBaselineProposal, extractQuestionBaselineHours } from "../src/tools/baseline-proposal"

const ctx = { sessionID: "s1" } as never

function setup() {
  const store = Store.memory(() => "task")
  store.mutateWorkflow("s1", () => {})
  return { store, tools: createWorkflowTools(store) }
}

describe("question 预估证据", () => {
  test("预估问题 + 裸「2 小时」→ 写入证据并放行 workflow_baseline", async () => {
    const { store, tools } = setup()
    try {
      applyQuestionBaselineProposal(
        store,
        "s1",
        { questions: [{ question: "请提供预估工时（小时）" }] },
        { answers: [["2 小时"]] },
        "q1",
      )
      expect(store.get("s1")!.workflow!.baselineProposedByDev?.hours).toBe(2)
      await expect(
        tools.workflow_baseline!.execute({ estimated_hours: 2, developer_confirmed: true } as never, ctx),
      ).resolves.toContain("已记录")
      expect(store.get("s1")!.workflow!.baseline?.estimatedHours).toBe(2)
    } finally {
      store.close()
    }
  })

  test("完整标签/人天也能解析", () => {
    expect(extractQuestionBaselineHours("请提供预估工时", "预估 2 小时")).toBe(2)
    expect(extractQuestionBaselineHours("请提供预估工时", "2 人天")).toBe(16)
    expect(extractQuestionBaselineHours("请提供预估工时（小时）", "2 小时")).toBe(2)
  })

  test("无关问题不写入证据，workflow_baseline 仍拒绝", async () => {
    const { store, tools } = setup()
    try {
      applyQuestionBaselineProposal(
        store,
        "s1",
        { questions: [{ question: "需要几个文件？" }] },
        { answers: [["2 小时"]] },
        "q1",
      )
      expect(store.get("s1")!.workflow!.baselineProposedByDev).toBeUndefined()
      await expect(
        tools.workflow_baseline!.execute({ estimated_hours: 2, developer_confirmed: true } as never, ctx),
      ).rejects.toThrow(/未检测到|数字/)
    } finally {
      store.close()
    }
  })

  test("无单位数字不算预估", () => {
    expect(extractQuestionBaselineHours("请提供预估工时", "2")).toBeNull()
    expect(extractQuestionBaselineHours("请提供预估工时", "未作答")).toBeNull()
    expect(extractQuestionBaselineHours("需要几个文件？", "2 小时")).toBeNull()
  })
})
