/**
 * 对抗审查 P0 回归护栏（2026 全阶段对抗审查）。
 *
 * 四组缺陷曾真实存在，此文件把它们钉死——每条都是**可复现的实测失败**：
 * 1. **记忆链路未接通**：`candidates` 生产零传递 → 「少问」整段死代码
 * 2. **重组装 diff 漏行置换**：`3.1↔3.2` 内容对调后定稿放行（内容↔地址错位）
 * 3. **溯源节伪造**：整节豁免于比对 → 可写入伪造证据
 * 4. **路径穿越 / 坏 JSON 崩溃 / 词边界误命中 / 长名静默覆盖**
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { matchMemory, requiredSlots, writeL1Term, writeL2Fact } from "sm-shared"
import { Store } from "../src/db"
import { createReqdocKbTools } from "../src/tools/reqdoc-kb-tools"
import { createReviewTools } from "../src/tools/review"

const CHECKLIST = {
  completeness: true,
  clarity: true,
  edgeCoverage: true,
  resolution: true,
} as never

function tempMemory(): string {
  const home = mkdtempSync(join(tmpdir(), "sm-p0-"))
  process.env.SM_MEMORY_HOME = join(home, "memory")
  return home
}

describe("P0-1 · 记忆链路在生产路径真的接通", () => {
  test("★ reqdoc_ingest 传 candidates → 工具返回 L1 消缺口（不再是死代码）", async () => {
    tempMemory()
    writeL1Term("CRD", "信贷审批部", { kind: "内部简称", scope: "org", origin: "restated", fromProject: "p" })
    const store = Store.memory(() => "reqdoc" as const)
    const worktree = mkdtempSync(join(tmpdir(), "sm-p0w-"))
    const tools = createReqdocKbTools(store)
    const out = String(
      await tools.reqdoc_ingest!.execute(
        {
          features: [{ name: "名单排查", priority: "high" }],
          slots: [{ address: "3.1", kind: "prose", content: "信贷审批部流程优化", source: "文档" }],
          candidates: { "4.1": ["CRD", "AML"] },
        } as never,
        { sessionID: "r1", worktree } as never,
      ),
    )
    expect(out).toContain("L1 记忆消缺口")
    expect(out).toContain("4.1.CRD")
    // candidates 必须落进 kb（否则下一轮派生又拿不到）
    expect(store.get("r1")!.workflow!.kb!.candidates).toEqual({ "4.1": ["CRD", "AML"] })
    store.close()
  })

  test("★ candidates 合并去重（多次 ingest 不产生重复项）", async () => {
    tempMemory()
    const store = Store.memory(() => "reqdoc" as const)
    const worktree = mkdtempSync(join(tmpdir(), "sm-p0w-"))
    const tools = createReqdocKbTools(store)
    const args = (candidates: Record<string, string[]>) =>
      tools.reqdoc_ingest!.execute({ candidates, features: [{ name: "X", priority: "high" }], slots: [] } as never, {
        sessionID: "r1",
        worktree,
      } as never)
    await args({ "4.1": ["CRD"] })
    await args({ "4.1": ["CRD", "AML"] })
    expect(store.get("r1")!.workflow!.kb!.candidates!["4.1"]).toEqual(["CRD", "AML"])
    store.close()
  })

  test("★ 门禁调用点不因记忆放行（3.3.2 红线：记忆不影响判定）", async () => {
    tempMemory()
    writeL1Term("CRD", "信贷审批部", { kind: "内部简称", scope: "org", origin: "restated", fromProject: "p" })
    const store = Store.memory(() => "reqdoc" as const)
    const features = [{ no: 1, name: "名单排查", priority: "high" as const, confirmedAt: 1000 }]
    store.mutateWorkflow("r1", (w) => {
      w.kb = {
        slots: [], // 未填任何必填槽位
        features,
        containers: {},
        candidates: { "4.1": ["CRD"] },
        askCounts: {},
        updatedAt: 1,
      }
    })
    // 即便记忆会消掉 4.1.CRD 的缺口，覆盖率仍只认 confirmed 槽位 → 门禁不放行
    const { kbGate, deriveQuestions } = await import("sm-shared")
    const unclosed = deriveQuestions(features, {
      slots: [],
      decls: {},
      candidates: { "4.1": ["CRD"] },
      l1: matchMemory("材料提到 CRD").l1,
    }).unclosed
    const gate = kbGate([], features, { decls: {}, unclosed })
    expect(gate.pass).toBe(false)
    store.close()
  })
})

describe("P0-2 · 重组装 diff 不可绕过", () => {
  async function assembled() {
    tempMemory()
    const store = Store.memory(() => "reqdoc" as const)
    store.mutateWorkflow("r1", (w) => {
      for (const n of ["goal", "rules", "edge", "prd"]) w.stages[n].status = "approved"
      const features = [{ no: 1, name: "公告发布", priority: "medium" as const, confirmedAt: 1000 }]
      w.kb = {
        slots: requiredSlots(features).map((a) => ({
          kind: "prose" as const,
          address: a,
          content: `${a} 内容`,
          source: "文档" as const,
          status: "confirmed" as const,
        })),
        features,
        containers: { "4.1": { required: false, reason: "x" }, "5.1.2.1": { required: false, reason: "y" } },
        askCounts: {},
        updatedAt: 1,
      }
    })
    const worktree = mkdtempSync(join(tmpdir(), "sm-p0r-"))
    const ctx = { sessionID: "r1", worktree } as never
    await createReqdocKbTools(store).reqdoc_assemble!.execute({} as never, ctx)
    return { store, ctx, path: join(worktree, "07_需求规格产出/1_公告发布/PRD.md") }
  }

  const submit = async (store: Store, ctx: never) => {
    try {
      await createReviewTools(store).review_submit!.execute(CHECKLIST, ctx)
      return ""
    } catch (e) {
      return String(e)
    }
  }

  test("★ 行置换（3.1↔3.2 内容对调）→ 拦截", async () => {
    const { store, ctx, path } = await assembled()
    const md = readFileSync(path, "utf8")
    writeFileSync(
      path,
      md.replace("3.1 内容\n", "@@T@@\n").replace("3.2 内容\n", "3.1 内容\n").replace("@@T@@\n", "3.2 内容\n"),
      "utf8",
    )
    // 多重集比对此情形会放行；保序 LCS 必须抓到
    expect(await submit(store, ctx)).toContain("与知识库不一致")
    store.close()
  })

  test("★ 伪造溯源条目 → 拦截（溯源节豁免于 LCS，故独立校验）", async () => {
    const { store, ctx, path } = await assembled()
    writeFileSync(
      path,
      readFileSync(path, "utf8") + "\n\n## 确认溯源\n\n- 要点「不存在」来源：张三 —— 业务总监2024-03-01口头批准\n",
      "utf8",
    )
    expect(await submit(store, ctx)).toContain("确认溯源")
    store.close()
  })

  test("★ 插入伪造章节 → 拦截", async () => {
    const { store, ctx, path } = await assembled()
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("5.1.2.3 内容", "5.1.2.3 内容\n\n## 第八章 伪造章节\n\n伪造内容"),
      "utf8",
    )
    expect(await submit(store, ctx)).toContain("与知识库不一致")
    store.close()
  })

  test("★ 删除整节 → 拦截（保序比对能发现整段丢失）", async () => {
    const { store, ctx, path } = await assembled()
    writeFileSync(path, readFileSync(path, "utf8").replace("## 第六章 非功能需求\n", ""), "utf8")
    expect(await submit(store, ctx)).toContain("与知识库不一致")
    store.close()
  })

  test("正常溯源回填（服务端写入）→ 放行", async () => {
    const { store, ctx, path } = await assembled()
    const tools = createReviewTools(store)
    await tools.comprehension_add!.execute(
      { codeSegmentId: "目标与场景", explanation: "缩短开户录入" } as never,
      ctx,
    )
    await tools.comprehension_confirm!.execute(
      { codeSegmentId: "目标与场景", sourceLabel: "对话第 1 轮", sourceQuote: "开户要手工录三遍" } as never,
      ctx,
    )
    expect(readFileSync(path, "utf8")).toContain("## 确认溯源")
    expect(await submit(store, ctx)).toBe("")
    store.close()
  })
})

describe("P0-3 · 记忆库健壮性", () => {
  test("★ 路径穿越（term 含 ../）→ 写入被约束在记忆目录内", () => {
    const home = tempMemory()
    const r = writeL1Term("../../pwned", "x", { kind: "内部简称", scope: "org", origin: "restated", fromProject: "p" })
    expect(r.ok).toBe(true)
    expect((r as { path: string }).path.startsWith(join(home, "memory"))).toBe(true)
    // 不得逃到记忆目录之外
    expect((r as { path: string }).path.includes("..")).toBe(false)
  })

  test("★ 坏 JSON（term 为数字）→ 跳过而非崩溃", () => {
    const home = tempMemory()
    mkdirSync(join(home, "memory", "l1-glossary"), { recursive: true })
    writeFileSync(join(home, "memory", "l1-glossary", "bad.json"), JSON.stringify({ term: 2024, definition: "年度" }))
    writeFileSync(join(home, "memory", "l1-glossary", "broken.json"), "{ 不是合法 JSON")
    expect(() => matchMemory("任意材料")).not.toThrow()
    expect(matchMemory("任意材料").l1).toEqual([])
  })

  test("★ 词边界：2 字母缩写不再误命中长词内部", () => {
    tempMemory()
    for (const [t, d] of [["IT", "信息技术"], ["CI", "持续集成"], ["卡", "卡片管理"], ["CRD", "信贷审批部"]] as const) {
      writeL1Term(t, d, { kind: "内部简称", scope: "org", origin: "restated", fromProject: "p" })
    }
    // 这段材料一个术语都没提（曾误命中 4 个）
    expect(
      matchMemory("交易经AUDIT留痕，按SPECIFIC规则走CIPS通道，含DEBIT与CREDIT处理，权限隔离与卡片管理").l1,
    ).toEqual([])
    // 真出现时仍能命中
    expect(matchMemory("本需求涉及 IT 与 CRD 改造").l1.map((t) => t.term).sort()).toEqual(["CRD", "IT"])
  })

  test("★ 长公共前缀不再静默覆盖（文件名带内容哈希）", () => {
    tempMemory()
    const prefix = "x".repeat(70)
    const a = writeL2Fact(prefix + "AAA", { source: "问答", scope: "org", origin: "restated", fromProject: "p" })
    const b = writeL2Fact(prefix + "BBB", { source: "问答", scope: "org", origin: "restated", fromProject: "p" })
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    // 两条不同的记忆落到不同文件
    expect((a as { path: string }).path).not.toBe((b as { path: string }).path)
    const dir = join(process.env.SM_MEMORY_HOME!, "l2-org")
    expect(readdirSync(dir).filter((f) => f.endsWith(".json")).length).toBe(2)
  })

  test("retired 条目不参与匹配（既有用例，防回归）", () => {
    const home = tempMemory()
    mkdirSync(join(home, "memory", "l1-glossary"), { recursive: true })
    writeFileSync(
      join(home, "memory", "l1-glossary", "r.json"),
      JSON.stringify({ term: "ESB", definition: "企业服务总线", kind: "内部简称", scope: "org", origin: "restated", confirmedAt: 1, fromProject: "p", retired: true }),
    )
    expect(matchMemory("材料提到 ESB 系统").l1).toEqual([])
  })
})
/**
 * P1 回归护栏（对抗审查第二批）。
 *
 * 1. 非法地址零校验 → 事实「收了却不进交付件」且零告警
 * 2. `reqdoc_answer` 先写记忆后校验 → 失败调用照样污染全局记忆
 * 3. L2 猜测是空壳 → 业务对空默认值点头（规则又规定「回同意默认即确认」）
 * 4. `reqdoc_assemble` 无路径校验 + 自定义 `source` 与定稿期望路径脱节
 * 5. `reqdoc_memory_recall` 无工作流校验 + 退役是空操作
 */
describe("P1 · 槽位地址校验", () => {
  const setup = () => {
    const store = Store.memory(() => "reqdoc" as const)
    const worktree = mkdtempSync(join(tmpdir(), "sm-p1-"))
    const ctx = { sessionID: "r1", worktree } as never
    return { store, worktree, ctx, tools: createReqdocKbTools(store) }
  }
  const ingest = (tools: ReturnType<typeof createReqdocKbTools>, ctx: never, address: string) =>
    tools.reqdoc_ingest!.execute(
      {
        features: [{ name: "名单排查", priority: "high" }],
        slots: [{ address, kind: "prose", content: "重要业务事实", source: "文档" }],
      } as never,
      ctx,
    )

  test("★ 非法地址被拒（此前收了却不进交付件且零告警）", async () => {
    const { store, ctx, tools } = setup()
    await expect(ingest(tools, ctx, "9.9.999.这不是服务端派生的地址")).rejects.toThrow(/地址非法/)
    store.close()
  })

  test("★ 越界功能点被拒（5.9.x 在只有 1 个功能点时）", async () => {
    const { store, ctx, tools } = setup()
    await expect(ingest(tools, ctx, "5.9.2.1.客户号")).rejects.toThrow(/地址非法/)
    store.close()
  })

  test("合法地址放行（必填叶子 / 容器本身 / 容器叶子）", async () => {
    const { store, ctx, tools } = setup()
    for (const addr of ["3.1", "4.1", "4.1.CRD", "5.1.2.1.客户号"]) {
      expect(await ingest(tools, ctx, addr)).toBeTruthy()
    }
    store.close()
  })

  test("★ 已存在的地址放行（改内容而非建新地址）", async () => {
    const { store, ctx, tools } = setup()
    await ingest(tools, ctx, "3.1")
    await tools.reqdoc_ingest!.execute(
      { features: [{ name: "名单排查", priority: "high" }], slots: [{ address: "3.1", kind: "prose", content: "改过的内容", source: "文档" }] } as never,
      ctx,
    )
    expect(store.get("r1")!.workflow!.kb!.slots.find((s) => s.address === "3.1")!.content).toBe("改过的内容")
    store.close()
  })

  test("reqdoc_answer 同样校验地址", async () => {
    const { store, ctx, tools } = setup()
    await expect(
      tools.reqdoc_answer!.execute({ address: "9.9.非法", content: "x", source: "文档" } as never, ctx),
    ).rejects.toThrow(/地址非法/)
    store.close()
  })
})

describe("P1 · 记忆写入必须在校验之后", () => {
  const memFiles = (): string[] => {
    const dir = join(process.env.SM_MEMORY_HOME!, "l1-glossary")
    return existsSync(dir) ? readdirSync(dir) : []
  }
  const setup = () => {
    const home = mkdtempSync(join(tmpdir(), "sm-p1m-"))
    process.env.SM_MEMORY_HOME = join(home, "memory")
    const store = Store.memory(() => "reqdoc" as const)
    const worktree = mkdtempSync(join(tmpdir(), "sm-p1w-"))
    const ctx = { sessionID: "r1", worktree } as never
    return { store, ctx, worktree, tools: createReqdocKbTools(store) }
  }
  const withTerm = (address: string, source: string, reason?: string) => ({
    address, content: "x", source, reason,
    restated_term: { term: "CRD", definition: "信贷审批部", kind: "内部简称" as const },
  })

  test("★ [缺省] 无 reason 失败后记忆库为空", async () => {
    const { store, ctx, tools } = setup()
    await tools.reqdoc_ingest!.execute({ features: [{ name: "X", priority: "high" }], slots: [] } as never, ctx)
    await expect(tools.reqdoc_answer!.execute(withTerm("3.1", "缺省") as never, ctx)).rejects.toThrow()
    expect(memFiles()).toEqual([])
    store.close()
  })

  test("★ 非法地址失败后记忆库为空", async () => {
    const { store, ctx, tools } = setup()
    await tools.reqdoc_ingest!.execute({ features: [{ name: "X", priority: "high" }], slots: [] } as never, ctx)
    await expect(tools.reqdoc_answer!.execute(withTerm("9.9.非法", "文档") as never, ctx)).rejects.toThrow()
    expect(memFiles()).toEqual([])
    store.close()
  })

  test("★ sdlc 会话失败后记忆库为空", async () => {
    const { worktree } = setup()
    const sdlc = Store.memory(() => "sdlc" as const)
    sdlc.ensure("s1")
    await expect(
      createReqdocKbTools(sdlc).reqdoc_answer!.execute(withTerm("3.1", "文档") as never, { sessionID: "s1", worktree } as never),
    ).rejects.toThrow(/仅用于 reqdoc/)
    expect(memFiles()).toEqual([])
    sdlc.close()
  })

  test("正常调用仍写入记忆（修的不是写入，是时机）", async () => {
    const { store, ctx, tools } = setup()
    await tools.reqdoc_ingest!.execute({ features: [{ name: "X", priority: "high" }], slots: [] } as never, ctx)
    const out = String(await tools.reqdoc_answer!.execute(withTerm("3.1", "文档") as never, ctx))
    expect(out).toContain("已记入 L1")
    expect(memFiles().length).toBe(1)
    store.close()
  })
})

describe("P1 · L2 猜测必须带出记忆内容", () => {
  test("★ L2 命中的猜测里含记忆原文（P1-c：原为空壳）", async () => {
    const { deriveQuestions } = await import("sm-shared")
    const features = [{ no: 1, name: "X", priority: "high" as const, confirmedAt: 1 }]
    const d = deriveQuestions(features, {
      slots: [],
      decls: { "4.1": { required: false, reason: "x" } },
      candidates: { "4.1": ["CIPS"] },
      l2: [{ content: "交易走 CIPS 通道，报文经 ESB 网关", source: "问答", scope: "org", origin: "restated", confirmedAt: 1, fromProject: "p" }],
    })
    const q = d.all.find((x) => x.address === "4.1.CIPS")!
    expect(q.from).toBe("memory-L2")
    expect(q.guess).toContain("CIPS")
    expect(q.guess!.length).toBeGreaterThan(15)
  })
})

describe("P1 · 组装路径与定稿一致", () => {
  const setup = () => {
    const store = Store.memory(() => "reqdoc" as const)
    store.mutateWorkflow("r1", (w) => {
      for (const n of ["goal", "rules", "edge", "prd"]) w.stages[n].status = "approved"
      const features = [{ no: 1, name: "公告发布", priority: "medium" as const, confirmedAt: 1000 }]
      w.kb = {
        slots: requiredSlots(features).map((a) => ({
          kind: "prose" as const, address: a, content: `${a} 内容`,
          source: "文档" as const, status: "confirmed" as const,
        })),
        features,
        containers: { "4.1": { required: false, reason: "x" }, "5.1.2.1": { required: false, reason: "y" } },
        askCounts: {}, updatedAt: 1,
      }
    })
    const worktree = mkdtempSync(join(tmpdir(), "sm-p1r-"))
    const ctx = { sessionID: "r1", worktree } as never
    return { store, worktree, ctx }
  }

  test("★ source 含斜杠被拒（路径穿越）", async () => {
    const { store, ctx } = setup()
    await expect(
      createReqdocKbTools(store).reqdoc_assemble!.execute({ source: "../../../evil.md" } as never, ctx),
    ).rejects.toThrow(/只能是文件名/)
    store.close()
  })

  test("★ 自定义 source 后定稿不再死锁（assembledFile 贯通）", async () => {
    const { store, ctx, worktree } = setup()
    await createReqdocKbTools(store).reqdoc_assemble!.execute({ source: "需求规格书V2.md" } as never, ctx)
    expect(store.get("r1")!.workflow!.kb!.assembledFile).toBe("需求规格书V2.md")
    expect(existsSync(join(worktree, "07_需求规格产出/1_公告发布/需求规格书V2.md"))).toBe(true)
    const out = String(await createReviewTools(store).review_submit!.execute(CHECKLIST, ctx))
    expect(out).toContain("审查阶段通过")
    store.close()
  })
})

describe("P1 · memory_recall 工作流校验与退役", () => {
  test("★ sdlc 会话不得写全局记忆", async () => {
    const home = mkdtempSync(join(tmpdir(), "sm-p1rc-"))
    process.env.SM_MEMORY_HOME = join(home, "memory")
    const sdlc = Store.memory(() => "sdlc" as const)
    sdlc.ensure("s1")
    await expect(
      createReqdocKbTools(sdlc).reqdoc_memory_recall!.execute({ facts: [{ content: "x" }] } as never, {
        sessionID: "s1", worktree: mkdtempSync(join(tmpdir(), "w-")),
      } as never),
    ).rejects.toThrow(/仅用于 reqdoc/)
    expect(existsSync(join(home, "memory", "l2-org"))).toBe(false)
    sdlc.close()
  })

  test("★ 退役按地址生效（P1-e：内容匹配曾是空操作）", async () => {
    const home = mkdtempSync(join(tmpdir(), "sm-p1rs-"))
    process.env.SM_MEMORY_HOME = join(home, "memory")
    const store = Store.memory(() => "reqdoc" as const)
    store.mutateWorkflow("r1", (w) => {
      const features = [{ no: 1, name: "公告发布", priority: "medium" as const, confirmedAt: 1000 }]
      w.kb = {
        slots: [
          { kind: "prose", address: "5.1.2.11", content: "交易走 CIPS 报文经 ESB", source: "问答", status: "confirmed" },
          { kind: "prose", address: "4.2", content: "本行受理跨行转账", source: "文档", status: "confirmed" },
        ],
        features, containers: {}, askCounts: {}, updatedAt: 1,
      }
    })
    await createReqdocKbTools(store).reqdoc_memory_recall!.execute(
      { facts: [{ content: "交易走 CIPS 报文经 ESB" }], retire_slots: ["5.1.2.11"] } as never,
      { sessionID: "r1", worktree: mkdtempSync(join(tmpdir(), "w-")) } as never,
    )
    const slots = store.get("r1")!.workflow!.kb!.slots
    expect(slots.find((s) => s.address === "5.1.2.11")!.status).toBe("retired")
    expect(slots.find((s) => s.address === "4.2")!.status).toBe("confirmed")
    store.close()
  })
})

/**
 * P2 回归护栏（对抗审查第三批）。
 *
 * 1. `scope` 只写不读 → 设计声称的「sdlc 记忆不影响 reqdoc 判定」无代码执行
 * 2. 退役机制复活（规则文本里重新点名已删工具/门禁）
 * 3. CLI 与插件记忆根不同源
 */
describe("P2 · scope 过滤真正生效", () => {
  test("★ scope:sdlc 的 L1 条目不得参与 reqdoc 消缺口", async () => {
    const { deriveQuestions } = await import("sm-shared")
    const features = [{ no: 1, name: "X", priority: "high" as const, confirmedAt: 1 }]
    const base = {
      slots: [],
      decls: { "4.1": { required: false, reason: "x" } },
      candidates: { "4.1": ["CRD"] },
    }
    const sdlcTerm = { term: "CRD", definition: "信贷审批部", kind: "内部简称" as const, scope: "sdlc" as const, origin: "restated" as const, confirmedAt: 1, fromProject: "p" }
    const orgTerm = { ...sdlcTerm, scope: "org" as const }

    // sdlc 作用域的记忆：在 reqdoc 里必须被忽略
    const d = deriveQuestions(features, { ...base, l1: [sdlcTerm] })
    expect(d.all.map((q) => q.address)).toContain("4.1.CRD")
    expect(d.l1Applied).toEqual([])

    // org/reqdoc 作用域：正常生效
    const d2 = deriveQuestions(features, { ...base, l1: [orgTerm] })
    expect(d2.all.map((q) => q.address)).not.toContain("4.1.CRD")
    expect(d2.l1Applied).toContain("4.1.CRD")
  })

  test("★ retired 条目同样被忽略", async () => {
    const { deriveQuestions } = await import("sm-shared")
    const features = [{ no: 1, name: "X", priority: "high" as const, confirmedAt: 1 }]
    const retired = { term: "CRD", definition: "信贷审批部", kind: "内部简称" as const, scope: "org" as const, origin: "restated" as const, confirmedAt: 1, fromProject: "p", retired: true }
    const d = deriveQuestions(features, {
      slots: [], decls: { "4.1": { required: false, reason: "x" } },
      candidates: { "4.1": ["CRD"] }, l1: [retired],
    })
    expect(d.l1Applied).toEqual([])
  })

  test("类型错乱退化为空而非崩溃（P0-3 遗留的防御）", async () => {
    const { deriveQuestions } = await import("sm-shared")
    const features = [{ no: 1, name: "X", priority: "high" as const, confirmedAt: 1 }]
    expect(() =>
      deriveQuestions(features, {
        slots: [], decls: {},
        l1: matchMemory("任意") as never, // 误传整个返回值
      }),
    ).not.toThrow()
  })
})

describe("P2 · CLI 与插件记忆根同源", () => {
  test("★ SM_MEMORY_HOME 覆盖对 CLI 同样生效", async () => {
    const home = mkdtempSync(join(tmpdir(), "sm-p2cli-"))
    process.env.SM_MEMORY_HOME = join(home, "memory")
    const { memoryRoot } = await import("sm-shared")
    // CLI 的 memoryDir() 已改为直接复用 memoryRoot()——这里锁定该约定
    expect(memoryRoot()).toBe(join(home, "memory"))
  })
})
