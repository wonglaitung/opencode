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
  // 访客页要能翻页：键位与正常会话页一致，且 textarea 有兜底
  expect(source).toContain("collab.page.up")
  expect(source).toContain("collab.page.down")
  expect(source).toContain("pageup,ctrl+alt+b")
  expect(source).toContain("pagedown,ctrl+alt+f")
  expect(source).toContain('key.name === "pageup" || key.name === "pagedown"')
  expect(source).toContain("PgUp/PgDn 翻页")
  // 走宿主 keymap，输入框失焦或终端不解析 Alt 组合时也能生效
  expect(source).toContain("props.api.keymap.registerLayer")
  expect(source).toContain('{ key: "alt+m"')
  expect(source).toContain('{ key: "f3"')
  expect(source).toContain("onMouseUp={() => toggle()}")
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
  // 输入框只保留左侧竖线与底部圆角，不再画下面那条横线
  expect(source).not.toContain("TAIL_CHARS")
  expect(source).toContain('bottomLeft: "╹"')
  expect(source).not.toContain('border={["bottom"]}')
  // 消息、审批、提问都走与正常页对应的组件，而不是占位文本
  expect(source).toContain("<MessageView")
  expect(source).toContain("<PermissionCard")
  expect(source).toContain("<QuestionCard")
  expect(source).toContain("formatTokens")
})

test("消息渲染覆盖文本/工具/思考/补丁，并与正常页同参数", async () => {
  const message = await Bun.file(new URL("../src/view/message.tsx", import.meta.url)).text()
  expect(message).toContain('part.type === "text"')
  expect(message).toContain('part.type === "tool"')
  expect(message).toContain('part.type === "reasoning"')
  expect(message).toContain('part.type === "patch"')
  expect(message).toContain("backgroundPanel")
  expect(message).toContain("border={[\"left\"]}")

  const text = await Bun.file(new URL("../src/view/text.tsx", import.meta.url)).text()
  expect(text).toContain("<markdown")
  expect(text).toContain('internalBlockMode="top-level"')

  const tool = await Bun.file(new URL("../src/view/tool.tsx", import.meta.url)).text()
  expect(tool).toContain("<diff")
  expect(tool).toContain("点击展开")
  expect(tool).toContain("输出过长，已省略")
})

test("host 转发权限详情、提问与会话错误，并截断超长输出", async () => {
  const host = await Bun.file(new URL("../src/host.tsx", import.meta.url)).text()
  expect(host).toContain('api.event.on("question.asked"')
  expect(host).toContain('api.event.on("question.replied"')
  expect(host).toContain('api.event.on("session.error"')
  expect(host).toContain("toWirePermission")
  expect(host).toContain("MAX_TOOL_OUTPUT")
  expect(host).toContain("toWireInfo")
})
