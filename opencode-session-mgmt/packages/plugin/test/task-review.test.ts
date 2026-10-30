/**
 * 独立 code_review 子任务：报告校验与完成门禁（仅 TASK，不关联其他工作流）。
 */
import { describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { applyTransition } from "../src/workflow-ops"
import { createTaskReviewTool } from "../src/tools/task-review"
import { createWorkflowTools } from "../src/tools/workflow"

const ctx = { sessionID: "s1" } as never

const dimensions = {
  correctness: { status: "pass" as const, notes: "覆盖了空值与重复提交" },
  security: { status: "pass" as const, notes: "无新增敏感字段与权限变更" },
  design: { status: "pass" as const, notes: "复用现有 service，无重复逻辑" },
  tests: { status: "pass" as const, notes: "typecheck + unit test 通过" },
  impact: { status: "pass" as const, notes: "只改 auth 内部，不影响导出 API" },
  readability: { status: "pass" as const, notes: "命名与现有风格一致" },
}

const checks = [
  { name: "typecheck", command: "bun typecheck", status: "passed" as const, evidence: "0 errors" },
  { name: "unit-test", command: "bun test auth", status: "passed" as const, evidence: "12 passed" },
]

function setup(category: "code_review" | "coding" = "code_review", started = true) {
  const store = Store.memory(() => "task")
  store.mutateWorkflow("s1", (workflow) => {
    if (started) applyTransition(workflow, "execute", "enter", 1)
    workflow.task = { category, source: "model", setAt: 1 }
    workflow.baseline = { estimatedHours: 2, setAt: 1 }
  })
  return {
    store,
    review: createTaskReviewTool(store).task_review!,
    advance: createWorkflowTools(store).workflow_advance!,
  }
}

describe("task_review（code_review 子任务）", () => {
  test("通过报告后任务才可 approve", async () => {
    const { store, review, advance } = setup()
    try {
      await expect(
        advance.execute({ stage: "execute", action: "approve", developer_confirmed: true } as never, ctx),
      ).rejects.toThrow(/task_review|报告/)
      await expect(
        review.execute({ scope: ["src/auth.ts"], checks, dimensions } as never, ctx),
      ).resolves.toContain("代码审核报告已提交")
      expect(store.get("s1")!.workflow!.taskReview?.verdict).toBe("approved")
      await expect(
        advance.execute({ stage: "execute", action: "approve", developer_confirmed: true } as never, ctx),
      ).resolves.toContain("approve")
    } finally {
      store.close()
    }
  })

  test("发现问题必须提供 findings，报告仍可提交但结论为需修改", async () => {
    const { store, review } = setup()
    try {
      const failed = {
        ...dimensions,
        security: { status: "fail" as const, notes: "日志打印了 token" },
      }
      await expect(
        review.execute({ scope: ["src/auth.ts"], checks, dimensions: failed } as never, ctx),
      ).rejects.toThrow(/findings/)
      await expect(
        review.execute({
          scope: ["src/auth.ts"],
          checks,
          dimensions: failed,
          findings: ["src/auth.ts:42 日志打印 token"],
        } as never, ctx),
      ).resolves.toContain("需修改")
      expect(store.get("s1")!.workflow!.taskReview?.verdict).toBe("changes_requested")
    } finally {
      store.close()
    }
  })

  test("非 code_review 分类拒绝", async () => {
    const { store, review } = setup("coding")
    try {
      await expect(
        review.execute({ scope: ["src/auth.ts"], checks, dimensions } as never, ctx),
      ).rejects.toThrow(/code_review/)
    } finally {
      store.close()
    }
  })

  test("未启动任务拒绝提交报告", async () => {
    const { store, review } = setup("code_review", false)
    try {
      await expect(
        review.execute({ scope: ["src/auth.ts"], checks, dimensions } as never, ctx),
      ).rejects.toThrow(/进行中/)
    } finally {
      store.close()
    }
  })
})
