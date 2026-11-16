import { describe, expect, test } from "bun:test"
import plugin from "../src/tui"

describe("plugin entry", () => {
  test("只导出 tui 入口", () => {
    expect(plugin.id).toBe("collab-room")
    expect(typeof plugin.tui).toBe("function")
    expect("server" in plugin).toBe(false)
  })
})
