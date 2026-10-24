import { describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { aggregateProject, sessionStats } from "../src/stats"

const usage = { cost: null, tokensInput: null, tokensOutput: null }

describe("task 分类统计", () => {
  test("会话级暴露分类与来源", () => {
    const store = Store.memory(() => "task")
    try {
      store.mutateWorkflow("t1", (workflow) => {
        workflow.task = { category: "debugging", source: "model", setAt: 1 }
      })
      const stats = sessionStats(store.get("t1")!, usage)!
      expect(stats.taskCategory).toBe("debugging")
      expect(stats.taskCategorySource).toBe("model")
    } finally {
      store.close()
    }
  })

  test("项目级按分类计数，未分类单列", () => {
    const store = Store.memory(() => "task")
    try {
      store.mutateWorkflow("t1", (workflow) => {
        workflow.task = { category: "documentation", source: "model", setAt: 1 }
      })
      store.mutateWorkflow("t2", (workflow) => {
        workflow.task = { category: "documentation", source: "model", setAt: 1 }
      })
      store.mutateWorkflow("t3", (workflow) => {
        workflow.task = { category: "testing", source: "model", setAt: 1 }
      })
      store.ensure("t4")
      const project = aggregateProject(store.listAll(), () => usage)
      expect(project.taskCategoryCounts).toEqual({ documentation: 2, testing: 1 })
      expect(project.taskUnclassifiedCount).toBe(1)
    } finally {
      store.close()
    }
  })
})
