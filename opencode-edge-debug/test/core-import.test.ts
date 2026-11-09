/**
 * 消费方集成护栏：确保 edge-debug-core 能被插件工程解析，
 * 且核心 API 在打包/安装后仍可用。
 */
import { describe, expect, test } from "bun:test"
import { MAX_LOGS, createEdgeDebugController, shouldKeepResponse } from "edge-debug-core"

describe("edge-debug-core 消费方", () => {
  test("核心入口可解析", () => {
    expect(typeof createEdgeDebugController).toBe("function")
    expect(MAX_LOGS).toBe(50)
    expect(shouldKeepResponse({ status: 200, url: "https://x/api/u/1", mimeType: "application/json" })).toBe(true)
    expect(shouldKeepResponse({ status: 200, url: "https://x/logo.png", mimeType: "image/png" })).toBe(false)
  })
})
