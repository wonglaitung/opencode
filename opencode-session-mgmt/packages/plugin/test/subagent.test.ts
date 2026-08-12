/**
 * 子代理会话识别与跳过测试（2.4 统计纯净度）。
 * 验证：子代理会话（parentID 非空）不建记录、不注入规则、不计数，
 * 主会话行为不受影响。
 */
import { beforeEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { Store } from "../src/db"
import { createSystemTransform } from "../src/prompt"
import { makeSubagentChecker, resetSubagentCache } from "../src/subagent"
import { createIterationCounter } from "../src/tools/quality"

/** 伪造上游 client：session.get 按 id 返回带/不带 parentID；返回 null 表示上游不可达。 */
function fakeClient(
  handler: (id: string) => { parentID?: string } | null,
): PluginInput["client"] {
  return {
    session: {
      get: async ({ path }: { path: { id: string } }) => {
        const data = handler(path.id)
        if (data === null) throw new Error("上游不可达")
        return { data }
      },
    },
  } as unknown as PluginInput["client"]
}

beforeEach(() => {
  resetSubagentCache()
})

describe("makeSubagentChecker：parentID 判定 + 缓存", () => {
  test("带 parentID → 子代理；不带 → 主会话", async () => {
    const isSubagent = makeSubagentChecker(
      fakeClient((id) => (id === "sub" ? { parentID: "main" } : { id })),
    )
    expect(await isSubagent("sub")).toBe(true)
    expect(await isSubagent("main")).toBe(false)
  })

  test("结果按会话缓存：重复判定不重复调 session.get", async () => {
    let calls = 0
    const isSubagent = makeSubagentChecker(
      fakeClient((id) => {
        calls++
        return { parentID: "main" }
      }),
    )
    await isSubagent("s")
    await isSubagent("s")
    await isSubagent("s")
    expect(calls).toBe(1)
  })

  test("上游不可达时保守按主会话处理（不误跳过）", async () => {
    const isSubagent = makeSubagentChecker(fakeClient(() => null))
    expect(await isSubagent("s")).toBe(false)
  })
})

describe("system.transform：子代理不注入、不建记录", () => {
  test("子代理会话 → system 不变、库中无记录", async () => {
    const store = Store.memory()
    const transform = createSystemTransform(store, async () => true)
    const output = { system: ["base"] as string[] }
    await transform({ sessionID: "sub" }, output)
    expect(output.system).toEqual(["base"])
    expect(store.get("sub")).toBeNull()
  })

  test("主会话 → 注入片段并建记录", async () => {
    const store = Store.memory()
    const transform = createSystemTransform(store, async () => false)
    const output = { system: ["base"] as string[] }
    await transform({ sessionID: "main" }, output)
    expect(output.system.length).toBe(2)
    expect(store.get("main")?.workflow).toBeDefined()
  })

  test("缺省识别器（不传）→ 按主会话处理，行为不变", async () => {
    const store = Store.memory()
    const transform = createSystemTransform(store)
    const output = { system: ["base"] as string[] }
    await transform({ sessionID: "s" }, output)
    expect(output.system.length).toBe(2)
    expect(store.get("s")?.workflow).toBeDefined()
  })
})

describe("iteration counter：子代理不计数、不建记录", () => {
  test("子代理会话编辑文件 → 无记录、不抛错", async () => {
    const store = Store.memory()
    const counter = createIterationCounter(store, async () => true)
    await counter({ tool: "write", sessionID: "sub", args: { filePath: "a.ts" } })
    expect(store.get("sub")).toBeNull()
  })

  test("主会话编辑文件 → 正常计数", async () => {
    const store = Store.memory()
    const counter = createIterationCounter(store, async () => false)
    await counter({ tool: "write", sessionID: "main", args: { filePath: "a.ts" } })
    expect(store.get("main")?.workflow!.quality.iterationCount).toBe(1)
  })
})
