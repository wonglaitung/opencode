import { describe, expect, test } from "bun:test"
import plugin from "../src/tui"

describe("plugin entry", () => {
  test("只导出 tui 入口", () => {
    expect(plugin.id).toBe("collab-room")
    expect(typeof plugin.tui).toBe("function")
    expect("server" in plugin).toBe(false)
  })
})

test("房间视图提供 Alt+M 与 F3 两种切换方式", async () => {
  const source = await Bun.file(new URL("../src/route.tsx", import.meta.url)).text()
  expect(source).toContain('key.name === "m" && (key.option || key.meta)')
  expect(source).toContain('key.name === "f3"')
  expect(source).toContain("Alt+M / F3 切换")
})
