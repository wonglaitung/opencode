/**
 * 记忆写入侧测试（设计 3.6.1，阶段 3）。
 *
 * 关注两件事：
 * 1. **业务勾选才入库**——`reqdoc_memory_recall` 不勾不写，origin 由服务端固定不可伪造。
 * 2. **防污染**——静默默认（accepted_default）与推测（inferred）永不入库；
 *    同名不同义走冲突提示而非静默覆盖。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Store } from "../src/db"

/** 记忆文件名含内容哈希后缀，按内容查找而非硬编码文件名。 */
function findMemory(layer: string, pred: (e: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  const dir = join(home, "memory", layer)
  if (!existsSync(dir)) return null // 没写过 = 目录不存在
  for (const f of readdirSync(dir)) {
    const e = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>
    if (pred(e)) return e
  }
  return null
}
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
    const saved = findMemory("l1-glossary", (e) => e.term === "CIPS")!
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
    expect(findMemory("l1-glossary", (e) => e.term === "CRD")!.definition).toBe("信贷审批部")
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
  test("勾选的写入 L2；退役槽位按地址显式指定（P1-e：内容匹配曾是空操作）", async () => {
    const store = reqdocStore()
    const tools = createReqdocKbTools(store)
    const out = String(
      await tools.reqdoc_memory_recall!.execute(
        { facts: [{ content: "交易走 CIPS 报文经 ESB" }], retire_slots: ["5.1.2.11"] } as never,
        { sessionID: "r1", worktree: home } as never,
      ),
    )
    expect(out).toContain("写入 L2 组织知识 1 条")
    const saved = findMemory("l2-org", (e) => e.content === "交易走 CIPS 报文经 ESB")!
    expect(saved.origin).toBe("restated")
    // 按地址退役——内容相等的写法永不匹配（L2 content 是概括知识、slot content 是正文）
    const slots = store.get("r1")!.workflow!.kb!.slots
    expect(slots.find((s) => s.address === "5.1.2.11")!.status).toBe("retired")
    expect(slots.find((s) => s.address === "4.2")!.status).toBe("confirmed")
    store.close()
  })

  test("★ sdlc 会话不得写全局记忆（P1-e：此前无工作流校验）", async () => {
    const sdlc = Store.memory(() => "sdlc" as const)
    sdlc.mutateWorkflow("s1", (w) => {
      w.features = [{ no: 1, name: "登录", priority: "high", confirmedAt: 1 }]
    })
    const tools = createReqdocKbTools(sdlc)
    await expect(
      tools.reqdoc_memory_recall!.execute({ facts: [{ content: "不该写进去" }] } as never, {
        sessionID: "s1",
        worktree: home,
      } as never),
    ).rejects.toThrow(/仅用于 reqdoc/)
    expect(findMemory("l2-org", () => true)).toBeNull()
    sdlc.close()
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
    expect(findMemory("l4-prefs", (e) => e.key === "详略")!.value).toBe("偏简洁")
    store.close()
  })
})