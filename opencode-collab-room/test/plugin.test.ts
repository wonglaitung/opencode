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
  expect(source).toContain("Alt+M / F3 排队")
})

test("房间视图与正常会话页保持同一版式", async () => {
  const source = await Bun.file(new URL("../src/route.tsx", import.meta.url)).text()
  // 不再使用固定宽度的右侧状态栏
  expect(source).not.toContain('width={42}')
  // 与 session 路由相同的左右内边距与物理滚动
  expect(source).toContain("paddingBottom={1} paddingLeft={2} paddingRight={2}")
  expect(source).toContain("stickyScroll={true}")
  expect(source).toContain("verticalScrollbarOptions")
  // 输入框复用 Prompt 的左侧色条 + 底部收口外观
  expect(source).toContain("PROMPT_CHARS")
  expect(source).toContain("TAIL_CHARS")
  expect(source).toContain('bottomLeft: "╹"')
})
