import { expect, test } from "bun:test"
import { panelText } from "../src/host"
import { awaitApproval, createRoom, request } from "../src/room"

test("面板文本包含人数、队列、审批与邀请码", () => {
  const room = createRoom()
  request(room, { id: "q1", by: "Bob", text: "补单测", queuedAt: 0 })
  const text = panelText(room, ["Bob"], "ws://1.2.3.4:1?token=t")
  expect(text).toContain("1 人")
  expect(text).toContain("Bob：补单测")
  expect(text).toContain("邀请码：ws://1.2.3.4:1?token=t")

  awaitApproval(room, { id: "a1", tool: "bash", requestedAt: 0 })
  expect(panelText(room, ["Bob"], "x")).toContain("待审批：bash")
})
