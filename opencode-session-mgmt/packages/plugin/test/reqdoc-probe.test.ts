/**
 * reqdoc_probe 追问探针记录工具测试（质量飞轮 P1）。
 * 覆盖：asked 跨轮追加去重、gaps 替换、round 自动递增与 ≤3 钳制、显式 round 优先、
 * 写 WorkflowState、仅 reqdoc 可用、formatProbeCard 输出。
 */
import { describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { createReqdocProbeTools } from "../src/tools/reqdoc-probe"

const ctx = { sessionID: "s1" } as never

describe("reqdoc_probe", () => {
  test("首轮记录：asked/gaps 落盘，round 缺省取 1", async () => {
    const store = Store.memory(() => "reqdoc")
    const tools = createReqdocProbeTools(store)
    const out = await tools.reqdoc_probe!.execute(
      { asked: ["main_flow", "exception"], gaps: ["authority"], round: 1 } as never,
      ctx,
    )
    expect(String(out)).toContain("第 1 轮")
    expect(String(out)).toContain("已问 2/7 探针")
    expect(String(out)).toContain("authority（权限与机构隔离）→authority 维度")
    const probes = store.get("s1")!.workflow!.probes!
    expect(probes.asked).toEqual(["main_flow", "exception"])
    expect(probes.gaps).toEqual(["authority"])
    expect(probes.round).toBe(1)
    expect(typeof probes.updatedAt).toBe("number")
    store.close()
  })

  test("跨轮追加去重：asked 取并集，历史轮次保留", async () => {
    const store = Store.memory(() => "reqdoc")
    const tools = createReqdocProbeTools(store)
    await tools.reqdoc_probe!.execute({ asked: ["main_flow", "exception"], gaps: ["authority"] } as never, ctx)
    // 第二轮补问 authority，异常已问过则去重；同时 reverse 新问
    await tools.reqdoc_probe!.execute(
      { asked: ["authority", "exception", "reverse"], gaps: ["reverse"] } as never,
      ctx,
    )
    const probes = store.get("s1")!.workflow!.probes!
    expect(probes.asked).toEqual(["main_flow", "exception", "authority", "reverse"])
    store.close()
  })

  test("gaps 每次整体替换（不追加）", async () => {
    const store = Store.memory(() => "reqdoc")
    const tools = createReqdocProbeTools(store)
    await tools.reqdoc_probe!.execute({ asked: ["main_flow"], gaps: ["exception", "authority"] } as never, ctx)
    await tools.reqdoc_probe!.execute({ asked: ["reverse"], gaps: ["reverse"] } as never, ctx)
    const probes = store.get("s1")!.workflow!.probes!
    expect(probes.gaps).toEqual(["reverse"])
    store.close()
  })

  test("round 缺省自动递增（上一轮 +1），超过 3 钳制在 3", async () => {
    const store = Store.memory(() => "reqdoc")
    const tools = createReqdocProbeTools(store)
    // 第 1 轮（显式）
    await tools.reqdoc_probe!.execute({ asked: ["main_flow"], gaps: ["exception"] } as never, ctx)
    // 第 2 轮（缺省 = 1+1）
    await tools.reqdoc_probe!.execute({ asked: ["reverse"], gaps: [] } as never, ctx)
    expect(store.get("s1")!.workflow!.probes!.round).toBe(2)
    // 第 3 轮（缺省 = 2+1）
    await tools.reqdoc_probe!.execute({ asked: ["audit"], gaps: [] } as never, ctx)
    expect(store.get("s1")!.workflow!.probes!.round).toBe(3)
    // 超过 3：缺省 3+1 → 钳制 3
    await tools.reqdoc_probe!.execute({ asked: ["desensitize"], gaps: [] } as never, ctx)
    expect(store.get("s1")!.workflow!.probes!.round).toBe(3)
    store.close()
  })

  test("显式 round 优先于自动递增", async () => {
    const store = Store.memory(() => "reqdoc")
    const tools = createReqdocProbeTools(store)
    await tools.reqdoc_probe!.execute({ asked: ["main_flow"], gaps: [] } as never, ctx)
    await tools.reqdoc_probe!.execute({ asked: ["exception"], gaps: [], round: 1 } as never, ctx)
    expect(store.get("s1")!.workflow!.probes!.round).toBe(1)
    store.close()
  })

  test("无缺口记录：覆盖进度满格", async () => {
    const store = Store.memory(() => "reqdoc")
    const tools = createReqdocProbeTools(store)
    const out = await tools.reqdoc_probe!.execute(
      { asked: ["main_flow", "flow_trigger", "exception", "reverse", "desensitize", "audit", "authority"], gaps: [] } as never,
      ctx,
    )
    expect(String(out)).toContain("已问 7/7 探针")
    expect(String(out)).toContain("无缺口")
    expect(String(out)).toContain("[▓▓▓▓▓▓▓▓▓▓] 100%")
    store.close()
  })

  test("仅 reqdoc 工作流可用（sdlc 拒绝）", async () => {
    const store = Store.memory(() => "sdlc")
    const tools = createReqdocProbeTools(store)
    await expect(
      tools.reqdoc_probe!.execute({ asked: ["main_flow"], gaps: [] } as never, ctx),
    ).rejects.toThrow(/仅用于 reqdoc/)
    expect(store.get("s1")?.workflow?.probes).toBeUndefined()
    store.close()
  })
})
