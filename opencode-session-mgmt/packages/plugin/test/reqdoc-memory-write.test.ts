/**
 * 记忆写入侧测试（设计 3.6.1，阶段 3）。
 *
 * 关注两件事：
 * 1. **业务勾选才入库**——`reqdoc_memory_recall` 不勾不写，origin 由服务端固定不可伪造。
 * 2. **防污染**——静默默认（accepted_default）与推测（inferred）永不入库；
 *    同名不同义走冲突提示而非静默覆盖。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Store } from "../src/db"
import { createReqdocKbTools } from "../src/tools/reqdoc-kb-tools"

let home: string
const orig = process.env.SM_MEMORY_HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sm-memw-"))
  process.env.SM_MEMORY_HOME = join(home, "memory")
})

afterEach(() => {
  process.env.SM_MEMORY_HOME = orig
  rmSync(home, { recursive: true, force: true })
})

function reqdocStore(): Store {
  const store = Store.memory(() => "reqdoc" as const)
  store.mutateWorkflow("r1", (w) => {
    w.kb = {
      slots: [
        { kind: "prose", address: "5.1.2.11", content: "交易走 CIPS 报文经 ESB", source: "问答", status: "confirmed" },
        { kind: "prose", address: "4.2", content: "本行受理跨行转账", source: "文档", status: "confirmed" },
      ],
      features: [{ no: 1, name: "转账", priority: "high", confirmedAt: 1 }],
      containers: {},
      askCounts: {},
      updatedAt: 1,
    }
  })
  return store
}

describe("3.6.1 ① · reqdoc_answer 复述术语即写 L1", () => {
  test("业务复述 → 写入 L1 并告知已记入", async () => {
    const store = reqdocStore()
    const tools = createReqdocKbTools(store)
    const ctx = { sessionID: "r1", worktree: home } as never
    const out = String(
      await tools.reqdoc_answer!.execute(
        {
          address: "4.2",
          content: "本行受理跨行转账",
          source: "问答",
          restated_term: { term: "CIPS", definition: "中国现代化支付系统", kind: "行业通用" },
        } as never,
        ctx,
      ),
    )
    expect(out).toContain("已记入 L1")
    const saved = JSON.parse(
      readFileSync(join(home, "memory", "l1-glossary", "CIPS.json"), "utf8"),
    ) as Record<string, unknown>
    // origin 由服务端固定为 restated——模型无法自行指定，杜绝「点默认也入库」
    expect(saved.origin).toBe("restated")
    expect(saved.definition).toBe("中国现代化支付系统")
    store.close()
  })

  test("★ 同名不同义 → 不静默覆盖，提示与业务确认", async () => {
    const store = reqdocStore()
    const tools = createReqdocKbTools(store)
    const ctx = { sessionID: "r1", worktree: home } as never
    const args = {
      address: "4.2",
      content: "x",
      source: "问答",
      restated_term: { term: "CRD", definition: "信贷审批部", kind: "内部简称" },
    } as never
    expect(String(await tools.reqdoc_answer!.execute(args, ctx))).toContain("已记入 L1")
    const out2 = String(
      await tools.reqdoc_answer!.execute(
        { ...(args as object), restated_term: { term: "CRD", definition: "容器运行时声明", kind: "行业通用" } } as never,
        ctx,
      ),
    )
    expect(out2).toContain("已有不同释义")
    // 原释义未被覆盖
    expect(JSON.parse(readFileSync(join(home, "memory", "l1-glossary", "CRD.json"), "utf8")).definition).toBe(
      "信贷审批部",
    )
    store.close()
  })

  test("未给 restated_term → 不写记忆（普通确认不产生记忆）", async () => {
    const store = reqdocStore()
    const tools = createReqdocKbTools(store)
    const out = String(
      await tools.reqdoc_answer!.execute({ address: "4.2", content: "y", source: "问答" } as never, {
        sessionID: "r1",
        worktree: home,
      } as never),
    )
    expect(out).not.toContain("已记入 L1")
    store.close()
  })
})

describe("3.6.1 ③ · reqdoc_memory_recall 业务勾选才入库", () => {
  test("勾选的写入 L2，且对应槽位退役（不再重复追问）", async () => {
    const store = reqdocStore()
    const tools = createReqdocKbTools(store)
    const out = String(
      await tools.reqdoc_memory_recall!.execute(
        { facts: [{ content: "交易走 CIPS 报文经 ESB" }] } as never,
        { sessionID: "r1", worktree: home } as never,
      ),
    )
    expect(out).toContain("写入 L2 组织知识 1 条")
    const saved = JSON.parse(
      readFileSync(join(home, "memory", "l2-org", "交易走_CIPS_报文经_ESB.json"), "utf8"),
    ) as Record<string, unknown>
    expect(saved.origin).toBe("restated")
    // 已进记忆的槽位退役——避免下轮再问同一件事
    const slots = store.get("r1")!.workflow!.kb!.slots
    expect(slots.find((s) => s.content === "交易走 CIPS 报文经 ESB")!.status).toBe("retired")
    store.close()
  })

  test("★ 只写入勾选项：未勾选的槽位保持 confirmed 不退役", async () => {
    const store = reqdocStore()
    const tools = createReqdocKbTools(store)
    await tools.reqdoc_memory_recall!.execute({ facts: [{ content: "别的知识" }] } as never, {
      sessionID: "r1",
      worktree: home,
    } as never)
    const slots = store.get("r1")!.workflow!.kb!.slots
    expect(slots.every((s) => s.status === "confirmed")).toBe(true)
    store.close()
  })

  test("★ [文档] 来源不因回顾而退役（书面材料仍是本需求证据）", async () => {
    const store = reqdocStore()
    const tools = createReqdocKbTools(store)
    await tools.reqdoc_memory_recall!.execute({ facts: [{ content: "本行受理跨行转账" }] } as never, {
      sessionID: "r1",
      worktree: home,
    } as never)
    const slots = store.get("r1")!.workflow!.kb!.slots
    expect(slots.find((s) => s.source === "文档")!.status).toBe("confirmed")
    store.close()
  })

  test("偏好写入 L4（只影响表达，不影响事实）", async () => {
    const store = reqdocStore()
    const tools = createReqdocKbTools(store)
    const out = String(
      await tools.reqdoc_memory_recall!.execute(
        { facts: [], prefs: [{ key: "详略", value: "偏简洁" }] } as never,
        { sessionID: "r1", worktree: home } as never,
      ),
    )
    expect(out).toContain("已记表达偏好 1 条")
    expect(JSON.parse(readFileSync(join(home, "memory", "l4-prefs", "详略.json"), "utf8")).value).toBe("偏简洁")
    store.close()
  })
})