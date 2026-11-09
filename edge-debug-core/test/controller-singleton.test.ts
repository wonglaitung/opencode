import { describe, expect, test } from "bun:test"
import { getEdgeDebugController } from "../src/controller"

describe("getEdgeDebugController", () => {
  test("同一项目目录共享同一个 controller，不同目录隔离", () => {
    const a = getEdgeDebugController("/tmp/edge-debug-core-a")
    const b = getEdgeDebugController("/tmp/edge-debug-core-a")
    const c = getEdgeDebugController("/tmp/edge-debug-core-b")
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})
