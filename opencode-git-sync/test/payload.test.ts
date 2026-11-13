import { describe, expect, test } from "bun:test"
import {
  decodePack,
  denormalize,
  encodePack,
  normalize,
  packPath,
  parsePackPath,
  parseSessionPath,
  PROJECT_PLACEHOLDER,
  WORKSPACE_PLACEHOLDER,
} from "../src/payload"

const rules = { worktree: "/home/a/proj", directory: "/home/a/proj/sub" }

describe("payload", () => {
  test("归一化把本机绝对路径换成占位符", () => {
    const input = {
      directory: "/home/a/proj/sub",
      text: "在 /home/a/proj 里改的",
      nested: [{ file: "/home/a/proj/main.ts" }],
      count: 3,
      flag: true,
    }
    const out = normalize(input, rules) as Record<string, unknown>
    expect(out["directory"]).toBe(PROJECT_PLACEHOLDER)
    expect(out["text"]).toBe(`在 ${WORKSPACE_PLACEHOLDER} 里改的`)
    expect((out["nested"] as Array<Record<string, unknown>>)[0]!["file"]).toBe(`${WORKSPACE_PLACEHOLDER}/main.ts`)
    expect(out["count"]).toBe(3)
    expect(out["flag"]).toBe(true)
  })

  test("还原后路径与本机一致", () => {
    const input = { directory: "/home/a/proj/sub", text: "/home/a/proj/x.ts" }
    const round = denormalize(normalize(input, rules), rules)
    expect(round).toEqual(input)
  })

  test("解析仓库内路径", () => {
    expect(parseSessionPath("sessions/ses_1/meta.ocgs")).toEqual({ sessionID: "ses_1" })
    expect(parseSessionPath("sessions/ses_1/msg_2.ocgs")).toEqual({ sessionID: "ses_1", messageID: "msg_2" })
    expect(parseSessionPath("sync-meta.json")).toBeUndefined()
  })

  test("封包路径与解析", () => {
    expect(packPath("ses_1", 1)).toBe("sessions/ses_1/packs/pack-000001.ocgs")
    expect(packPath("ses_1", 42)).toBe("sessions/ses_1/packs/pack-000042.ocgs")
    expect(parsePackPath("sessions/ses_1/packs/pack-000042.ocgs")).toEqual({ sessionID: "ses_1", seq: 42 })
    expect(parsePackPath("sessions/ses_1/meta.ocgs")).toBeUndefined()
    expect(parseSessionPath("sessions/ses_1/packs/pack-000001.ocgs")).toBeUndefined()
  })

  test("封包编解码往返，且压缩后更小", () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      info: { id: `msg_${index}`, sessionID: "ses_1", role: "user", time: { created: index } },
      parts: [{ id: `prt_${index}`, messageID: `msg_${index}`, sessionID: "ses_1", type: "text", text: "重复内容".repeat(50) }],
    }))
    const encoded = encodePack(messages)
    expect(decodePack(encoded)).toEqual(messages)
    expect(encoded.length).toBeLessThan(Buffer.byteLength(JSON.stringify(messages)) / 2)
  })
})
