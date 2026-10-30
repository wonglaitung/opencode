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
  tests: { status: "pass" as const, notes: "测试覆盖空值与重复提交，未发现跳过或伪造断言" },
  impact: { status: "pass" as const, notes: "只改 auth 内部，不影响导出 API" },
  readability: { status: "pass" as const, notes: "命名与现有风格一致" },
}

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
      const result = await review.execute({ scope: ["src/auth.ts"], dimensions } as never, ctx)
      expect(result).toContain("代码审核报告已提交")
      expect(result).toContain("结论：approved（通过）")
      expect(result).toContain("范围：src/auth.ts")
      expect(result).toContain("六维报告")
      expect(result).toContain("正确性与边界：通过 — 覆盖了空值与重复提交")
      const text = typeof result === "string" ? result : result.output
      expect(text.indexOf("六维报告")).toBeLessThan(text.indexOf("审核发现与修复建议"))
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
        review.execute({ scope: ["src/auth.ts"], dimensions: failed } as never, ctx),
      ).rejects.toThrow(/findings/)
      const result = await review.execute({
        scope: ["src/auth.ts"],
        dimensions: failed,
        findings: [
          {
            severity: "major",
            file: "src/auth.ts",
            line: 42,
            issue: "日志打印 token",
            suggestion: "移除日志中的 token，或改为脱敏字段",
          },
        ],
      } as never, ctx)
      expect(result).toContain("需修改")
      expect(result).toContain("结论：changes_requested")
      expect(result).toContain("安全与隐私：未通过 — 日志打印了 token")
      expect(store.get("s1")!.workflow!.taskReview?.verdict).toBe("changes_requested")
    } finally {
      store.close()
    }
  })

  test("扫描出的 blocker/critical 必须在 findings 中提及 ruleId，并带扫描摘要", async () => {
    const { store, review } = setup()
    try {
      store.mutateWorkflow("s1", (workflow) => {
        workflow.taskScan = {
          status: "completed",
          scannedFiles: 1,
          findingCount: 1,
          bySeverity: { blocker: 1, critical: 0, major: 0, minor: 0, info: 0 },
          byDimension: {
            correctness: 0,
            security: 1,
            design: 0,
            tests: 0,
            impact: 0,
            readability: 0,
          },
          warnings: [],
          scope: ["diff"],
          findings: [
            {
              ruleId: "SEC-001",
              title: "提交了私钥",
              severity: "blocker",
              dimension: "security",
              file: "src/key.pem",
              line: 1,
              message: "私钥",
            },
          ],
          engine: "regex",
          scannedAt: 1,
        }
      })
      await expect(
        review.execute({ scope: ["src/auth.ts"], dimensions } as never, ctx),
      ).rejects.toThrow(/SEC-001/)
      const result = await review.execute({
        scope: ["src/auth.ts"],
        dimensions,
        findings: [
          {
            severity: "blocker",
            file: "src/key.pem",
            line: 1,
            issue: "SEC-001 私钥文件不应提交",
            suggestion: "移除私钥并轮换密钥",
            ruleId: "SEC-001",
          },
        ],
      } as never, ctx)
      expect(result).toContain("- 文件：1；发现：1 条")
      expect(result).toContain("审核发现与修复建议")
      expect(result).toContain("发现：SEC-001 私钥文件不应提交")
      expect(result).toContain("建议：移除私钥并轮换密钥")
      expect(store.get("s1")!.workflow!.taskReview?.scan?.findingCount).toBe(1)
    } finally {
      store.close()
    }
  })

  test("审核规模超过 50 文件/1500 行时必须说明拆分理由", async () => {
    const { store, review } = setup()
    try {
      store.mutateWorkflow("s1", (workflow) => {
        workflow.taskScan = {
          status: "completed",
          scannedFiles: 60,
          findingCount: 0,
          bySeverity: { blocker: 0, critical: 0, major: 0, minor: 0, info: 0 },
          byDimension: { correctness: 0, security: 0, design: 0, tests: 0, impact: 0, readability: 0 },
          reviewSize: { files: 60, lines: 1800 },
          warnings: [],
          scope: ["diff"],
          findings: [],
          engine: "regex",
          scannedAt: 1,
        }
      })
      await expect(
        review.execute({ scope: ["src/auth.ts"], dimensions } as never, ctx),
      ).rejects.toThrow(/拆分理由/)
      await expect(
        review.execute({
          scope: ["src/auth.ts"],
          dimensions,
          findings: [
            {
              severity: "minor",
              issue: "规模超过 50 文件/1500 行",
              suggestion: "拆分为登录与权限两次审核",
            },
          ],
        } as never, ctx),
      ).resolves.toContain("代码审核报告已提交")
    } finally {
      store.close()
    }
  })

  test("无 finding 时明确说明未发现问题", async () => {
    const { store, review } = setup()
    try {
      const result = await review.execute({ scope: ["src/auth.ts"], dimensions } as never, ctx)
      expect(result).toContain("未发现需要修复的问题")
      expect(result).toContain("可理解性：通过 — 命名与现有风格一致")
      expect(store.get("s1")!.workflow!.taskReview?.findings).toEqual([])
    } finally {
      store.close()
    }
  })

  test("非 code_review 分类拒绝", async () => {
    const { store, review } = setup("coding")
    try {
      await expect(
        review.execute({ scope: ["src/auth.ts"], dimensions } as never, ctx),
      ).rejects.toThrow(/code_review/)
    } finally {
      store.close()
    }
  })

  test("未启动任务拒绝提交报告", async () => {
    const { store, review } = setup("code_review", false)
    try {
      await expect(
        review.execute({ scope: ["src/auth.ts"], dimensions } as never, ctx),
      ).rejects.toThrow(/进行中/)
    } finally {
      store.close()
    }
  })
})
