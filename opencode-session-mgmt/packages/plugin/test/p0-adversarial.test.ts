/**
 * 对抗审查 P0 回归护栏（2026 全阶段对抗审查）。
 *
 * 四组缺陷曾真实存在，此文件把它们钉死——每条都是**可复现的实测失败**：
 * 1. **记忆链路未接通**：`candidates` 生产零传递 → 「少问」整段死代码
 * 2. **重组装 diff 漏行置换**：`3.1↔3.2` 内容对调后定稿放行（内容↔地址错位）
 * 3. **溯源节伪造**：整节豁免于比对 → 可写入伪造证据
 * 4. **路径穿越 / 坏 JSON 崩溃 / 词边界误命中 / 长名静默覆盖**
 */
import { describe, expect, jest, test } from "bun:test"
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

/** 业务投放材料（记忆匹配的证据来源）：往 01_背景与目标 放一个文本文件。 */
function dropMaterial(worktree: string, text: string) {
  mkdirSync(join(worktree, "01_背景与目标"), { recursive: true })
  writeFileSync(join(worktree, "01_背景与目标", "材料.md"), text, "utf8")
}

describe("P0-1 · 记忆链路在生产路径真的接通", () => {
  test("★ reqdoc_ingest 传 candidates → 工具返回 L1 消缺口（不再是死代码）", async () => {
    tempMemory()
    writeL1Term("CRD", "信贷审批部", { kind: "内部简称", scope: "org", origin: "restated", fromProject: "p" })
    const store = Store.memory(() => "reqdoc" as const)
    const worktree = mkdtempSync(join(tmpdir(), "sm-p0w-"))
    // 证据 = 材料原文（方案 C）：术语须出现在业务投放的材料里，而非模型转述的槽位正文
    dropMaterial(worktree, "信贷审批部（CRD）负责名单排查与流程优化。")
    const tools = createReqdocKbTools(store)
    const out = String(
      await tools.reqdoc_ingest!.execute(
        {
          features: [{ name: "名单排查", priority: "high" }],
          // 候选名不算自己的证据（对抗审查 N-5：否则臆造 candidates 即可白拿消缺口）
          slots: [{ address: "3.1", kind: "prose", content: "流程优化", source: "文档" }],
          candidates: { "4.1": ["CRD", "AML"] },
        } as never,
        { sessionID: "r1", worktree } as never,
      ),
    )
    expect(out).toContain("L1 记忆免问")
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

  test("★ 门禁不因记忆放行（打 review_submit 生产路径；复审 T-2：上一版手工调 kbGate，纯自证）", async () => {
    tempMemory()
    writeL1Term("CRD", "信贷审批部", { kind: "内部简称", scope: "org", origin: "restated", fromProject: "p" })
    const store = Store.memory(() => "reqdoc" as const)
    const features = [{ no: 1, name: "名单排查", priority: "high" as const, confirmedAt: 1000 }]
    store.mutateWorkflow("r1", (w) => {
      for (const n of ["goal", "rules", "edge", "prd"]) w.stages[n].status = "approved"
      w.kb = {
        // 只填 3.1：记忆最多消掉 4.1.CRD，覆盖率仍远低于 100% → 门禁必须拦。
        slots: [
          { kind: "prose", address: "3.1", content: "信贷审批部（CRD）流程优化", source: "文档", status: "confirmed" },
        ],
        features,
        containers: {},
        candidates: { "4.1": ["CRD"] },
        askCounts: {},
        updatedAt: 1,
      }
    })
    const worktree = mkdtempSync(join(tmpdir(), "sm-p0gate-"))
    const ctx = { sessionID: "r1", worktree } as never
    // 若 review.ts 的门禁调用点被改成「按记忆消缺口后放行」，本用例即失败
    let msg = ""
    try {
      await createReviewTools(store).review_submit!.execute(CHECKLIST, ctx)
    } catch (e) {
      msg = String(e)
    }
    expect(msg).toMatch(/知识库未就绪|未找到 PRD 产物/)
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
  test("★ CLI 真的读到 SM_MEMORY_HOME（跑 CLI 的 runMemory，不复用 memoryRoot）", async () => {
    // 复审 T-1：上一版只断言 memoryRoot()，把 CLI 改回 homedir() 也照样绿——纯自证。
    // 现在真跑 CLI 的 runMemory：写入一条记忆后用 CLI 列出来。
    const home = mkdtempSync(join(tmpdir(), "sm-p2cli-"))
    process.env.SM_MEMORY_HOME = join(home, "memory")
    const { writeL1Term } = await import("sm-shared")
    writeL1Term("CRD", "信贷审批部", { kind: "内部简称", scope: "org", origin: "restated", fromProject: "CLI同源测试" })

    const { runMemory } = await import("../../cli/src/commands/memory")
    // CLI 用 process.stdout.write（不是 console.log），必须捕获真正的出口
    let out = ""
    const spy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out += String(chunk)
      return true
    })
    try {
      await runMemory({ positionals: ["list"], flags: {} })
    } finally {
      spy.mockRestore()
    }
    // CLI 必须列出我们刚写入的条目——若 CLI 用 homedir()，这里会是空
    expect(out).toContain("CRD")
    expect(out).toContain("信贷审批部")
  })

  test("CLI 层名与 shared 的 MEMORY_LAYERS 一致（消除人工约定的漂移面）", async () => {
    const { MEMORY_LAYERS } = await import("sm-shared")
    const src = readFileSync(join(import.meta.dir, "..", "..", "cli", "src", "commands", "memory.ts"), "utf8")
    // CLI 不得自带一份层名字面量——必须引用 shared 的 MEMORY_LAYERS
    expect(src).toContain("MEMORY_LAYERS")
    for (const layer of MEMORY_LAYERS) expect(src).toContain(layer)
  })
})

/**
 * 第二批复审（修复引入的新缺陷）回归护栏。
 *
 * 这些缺陷是**修复本身引入的**，比原缺陷更隐蔽——工具照样返回绿色的
 * 「🧠 L1 记忆消缺口」，而实际行为是错的：
 * - N-3 `containsTerm` 边界判定反了 → 中文术语 100% 不命中（「少问」对中文完全失效）
 * - N-4 子键可塞换行 → 伪造章节直达 Word 交付件，且绕过全部三道校验
 * - N-5 haystack 含 candidates 自身 → 模型臆造候选即白拿消缺口（自证）
 * - N-2 变更记录表行未豁免 → revisit 二次定稿被永久拦截
 * - F-1 豁免与校验两处正则不一致 → 5 种溯源伪造变体全部放行
 * - F-5 溯源整节删除放行；F-4 assembledFile 漏传致迭代副本丢失
 */
describe("N-3 · 中文术语必须命中", () => {
  const seed = (terms: [string, string, "内部简称" | "行业通用"][]) => {
    const home = tempMemory()
    for (const [t, d, k] of terms) writeL1Term(t, d, { kind: k, scope: "org", origin: "restated", fromProject: "p" })
    return home
  }

  test("★ 多字中文术语在真实中文材料里命中（汉字夹住也算）", () => {
    seed([["反洗钱", "反洗钱识别", "行业通用"], ["核心系统", "行内核心系统", "内部简称"], ["信用卡", "信用卡业务", "行业通用"]])
    const hits = matchMemory("本需求涉及反洗钱名单核查，改造核心系统，信用卡业务需要特殊处理。").l1.map((t) => t.term)
    expect(new Set(hits)).toEqual(new Set(["信用卡", "核心系统", "反洗钱"]))
  })

  test("单字中文不误命中相邻词（卡 不该命中 卡片管理）", () => {
    seed([["卡", "卡片管理", "内部简称"]])
    expect(matchMemory("涉及卡片管理流程").l1.map((t) => t.term)).toEqual([])
  })

  test("ASCII 缩写仍要求词边界（IT 不命中 AUDIT）", () => {
    seed([["IT", "信息技术", "内部简称"]])
    expect(matchMemory("经过 AUDIT 留痕").l1.map((t) => t.term)).toEqual([])
    expect(matchMemory("本需求涉及 IT 改造").l1.map((t) => t.term)).toEqual(["IT"])
  })
})

describe("N-4 · 子键不得注入 markdown 结构", () => {
  test("★ 子键含换行/结构字符一律拒绝", async () => {
    const { isValidSlotAddr } = await import("sm-shared")
    const f = [{ no: 1, name: "X", priority: "high" as const, confirmedAt: 1 }]
    for (const bad of ["4.1.CRD\n## 第九章 伪造", "4.1.a/b", "4.1.x\\y", "4.1.x|y", "4.1.`x`", "4.1.a[b]", "4.1." + "长".repeat(41)]) {
      expect(isValidSlotAddr(bad, f)).toBe(false)
    }
    // 合法子键仍放行
    for (const ok of ["4.1.CRD", "4.1.反洗钱", "5.1.2.1.客户号", "4.1"]) {
      expect(isValidSlotAddr(ok, f)).toBe(true)
    }
  })

  test("★ 伪造章节进不了交付件（打真实 assemble 链路）", async () => {
    tempMemory()
    const store = Store.memory(() => "reqdoc" as const)
    const worktree = mkdtempSync(join(tmpdir(), "sm-n4-"))
    const ctx = { sessionID: "r1", worktree } as never
    const tools = createReqdocKbTools(store)
    await tools.reqdoc_ingest!.execute(
      {
        features: [{ name: "名单排查", priority: "high" }],
        slots: [{ address: "3.1", kind: "prose", content: "信贷审批流程优化", source: "文档" }],
      } as never,
      ctx,
    )
    await expect(
      tools.reqdoc_ingest!.execute(
        {
          features: [{ name: "名单排查", priority: "high" }],
          slots: [{ address: "4.1.CRD\n## 第九章 伪造章节\n- **审批人**：业务总监", kind: "term", content: "信贷审批部", source: "文档" }],
        } as never,
        ctx,
      ),
    ).rejects.toThrow(/地址非法/)
    await tools.reqdoc_assemble!.execute({} as never, ctx)
    const md = readFileSync(join(worktree, "07_需求规格产出/1_名单排查/PRD.md"), "utf8")
    expect(md).not.toContain("第九章 伪造章节")
    store.close()
  })

  test("功能点地址禁前导零（F-2）", async () => {
    const { isValidSlotAddr } = await import("sm-shared")
    const f = [{ no: 1, name: "X", priority: "high" as const, confirmedAt: 1 }]
    expect(isValidSlotAddr("5.01.2.1.客户号", f)).toBe(false)
    expect(isValidSlotAddr("5.1.2.1.客户号", f)).toBe(true)
  })
})

describe("N-5 · 候选不得自证", () => {
  test("★ 槽位正文无该术语时，candidates 填了也不消缺口", async () => {
    tempMemory()
    writeL1Term("CRD", "信贷审批部", { kind: "内部简称", scope: "org", origin: "restated", fromProject: "p" })
    const store = Store.memory(() => "reqdoc" as const)
    const worktree = mkdtempSync(join(tmpdir(), "sm-n5-"))
    const out = String(
      await createReqdocKbTools(store).reqdoc_ingest!.execute(
        {
          features: [{ name: "X", priority: "high" }],
          slots: [{ address: "3.1", kind: "prose", content: "本需求为信贷业务改造。", source: "文档" }],
          candidates: { "4.1": ["CRD"] },
        } as never,
        { sessionID: "r1", worktree } as never,
      ),
    )
    // 模型臆造候选 → 不得白拿消缺口
    expect(out).not.toContain("L1 记忆免问")
    store.close()
  })

  test("正文含该术语时正常消缺口（正向）", async () => {
    tempMemory()
    writeL1Term("CRD", "信贷审批部", { kind: "内部简称", scope: "org", origin: "restated", fromProject: "p" })
    const store = Store.memory(() => "reqdoc" as const)
    const worktree = mkdtempSync(join(tmpdir(), "sm-n5b-"))
    dropMaterial(worktree, "信贷审批部（CRD）负责流程优化。")
    const out = String(
      await createReqdocKbTools(store).reqdoc_ingest!.execute(
        {
          features: [{ name: "X", priority: "high" }],
          slots: [{ address: "3.1", kind: "prose", content: "流程优化", source: "文档" }],
          candidates: { "4.1": ["CRD"] },
        } as never,
        { sessionID: "r1", worktree } as never,
      ),
    )
    expect(out).toContain("L1 记忆免问")
    store.close()
  })
})

describe("N-2 / F-1 / F-5 · 服务端追加区块的豁免与校验", () => {
  const ready = () => {
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
    const worktree = mkdtempSync(join(tmpdir(), "sm-n2-"))
    const ctx = { sessionID: "r1", worktree } as never
    return { store, worktree, ctx, tools: createReqdocKbTools(store) }
  }
  /** 定稿前提：有产物。先组装一次。 */
  async function assembled() {
    const r = ready()
    await r.tools.reqdoc_assemble!.execute({} as never, r.ctx)
    return r
  }
  const submit = async (store: Store, ctx: never) => {
    try { await createReviewTools(store).review_submit!.execute(CHECKLIST, ctx); return "" }
    catch (e) { return String(e) }
  }

  test("★ 二次定稿不被变更记录表行拦住（N-2：revisit 重做路径）", async () => {
    const { store, ctx } = await assembled()
    expect(await submit(store, ctx)).toBe("") // 首次定稿：写入变更记录
    store.mutateWorkflow("r1", (w) => { w.stages.review.status = "in_progress" })
    expect(await submit(store, ctx)).toBe("") // 二次定稿：变更记录表行已被豁免
    store.close()
  })

  test("★ 溯源条目格式变体一律拦截（F-1：此前 5 种变体全部放行）", async () => {
    for (const mutate of [
      (l: string) => l.replace(/^- /, "* "),
      (l: string) => l.replace("：", ": ").replace("——", "-"),
      (l: string) => l.replace("要点「T」", "要点「T」 "),
    ]) {
      const { store, ctx, worktree } = await assembled()
      const tools = createReviewTools(store)
      await tools.comprehension_add!.execute({ codeSegmentId: "T", explanation: "e" } as never, ctx)
      await tools.comprehension_confirm!.execute({ codeSegmentId: "T", sourceLabel: "L1", sourceQuote: "Q1" } as never, ctx)
      const p = join(worktree, "07_需求规格产出/1_公告发布/PRD.md")
      writeFileSync(p, readFileSync(p, "utf8").split("\n").map(mutate).join("\n"), "utf8")
      expect(await submit(store, ctx)).toContain("确认溯源")
      store.close()
    }
  })

  test("★ 溯源整节删除被拦（F-5：交付件静默失去全部溯源）", async () => {
    const { store, ctx, worktree } = await assembled()
    const tools = createReviewTools(store)
    await tools.comprehension_add!.execute({ codeSegmentId: "T", explanation: "e" } as never, ctx)
    await tools.comprehension_confirm!.execute({ codeSegmentId: "T", sourceLabel: "L1", sourceQuote: "Q1" } as never, ctx)
    const p = join(worktree, "07_需求规格产出/1_公告发布/PRD.md")
    writeFileSync(p, readFileSync(p, "utf8").replace(/## 确认溯源[\s\S]*$/, ""), "utf8")
    expect(await submit(store, ctx)).toMatch(/确认溯源|缺少/)
    store.close()
  })

  test("★ 自定义 source 时迭代副本不丢（F-4：漏传 assembledFile）", async () => {
    const { store, ctx, worktree, tools } = ready()
    await tools.reqdoc_assemble!.execute({ source: "需求规格书V2.md" } as never, ctx)
    expect(await submit(store, ctx)).toBe("")
    expect(existsSync(join(worktree, "00_初稿需求书"))).toBe(true)
    store.close()
  })
})

/**
 * 第三轮复审（I-2 / I-1）回归护栏。
 *
 * - **I-2** `content` 曾与子键同级地插值进 markdown：子键焊死了，值却敞开——
 *   `content` 里塞 `## 第九章 伪造章节` 即可造出新章节直达 Word 交付件，
 *   且 kbDigest / LCS / 定稿三重校验全部放行（它们只验「槽位 ↔ 产物一致」，
 *   而产物正是由这个 content 生成的——自证）。
 * - **I-1** 记忆匹配的证据源曾包含 `candidates`（候选自证），
 *   改为「只取槽位正文」后自证面只是平移——正文也是模型写的。
 */
describe("I-2 · 槽位内容不得注入 markdown 结构", () => {
  const build = (content: string) => {
    const store = Store.memory(() => "reqdoc" as const)
    const features = [{ no: 1, name: "名单排查", priority: "high" as const, confirmedAt: 1000 }]
    const slots = requiredSlots(features).map((a) => ({
      kind: "prose" as const, address: a, content: `${a} 内容`,
      source: "文档" as const, status: "confirmed" as const,
    }))
    slots[0] = { ...slots[0]!, content }
    store.mutateWorkflow("r1", (w) => {
      for (const n of ["goal", "rules", "edge", "prd"]) w.stages[n].status = "approved"
      w.kb = {
        slots, features,
        containers: { "4.1": { required: false, reason: "x" }, "5.1.2.1": { required: false, reason: "y" } },
        askCounts: {}, updatedAt: 1,
      }
    })
    const worktree = mkdtempSync(join(tmpdir(), "sm-i2-"))
    const ctx = { sessionID: "r1", worktree } as never
    return { store, worktree, ctx }
  }
  const prdOf = (worktree: string) =>
    readFileSync(join(worktree, "07_需求规格产出/1_名单排查/PRD.md"), "utf8")

  test("★ 标题行不被解析为新章节（转义但保留原文）", async () => {
    const { store, worktree, ctx } = build("信贷审批流程\n\n## 第九章 伪造章节\n\n- 审批人：业务总监")
    await createReqdocKbTools(store).reqdoc_assemble!.execute({} as never, ctx)
    const md = prdOf(worktree)
    // 不得成为真正的标题行
    expect(/^\s*#{1,6}\s+第九章/m.test(md)).toBe(false)
    // 但内容仍可读（转义为字面量，不丢信息）
    expect(md).toContain("\\## 第九章 伪造章节")
    expect(md).toContain("信贷审批流程")
    store.close()
  })

  test("★ 表格行不被解析为表格", async () => {
    const { store, worktree, ctx } = build("正文\n\n| 版本 | 说明 |\n| --- | --- |\n| 9.9 | 伪造 |")
    await createReqdocKbTools(store).reqdoc_assemble!.execute({} as never, ctx)
    const md = prdOf(worktree)
    expect(/^\s*\|\s*9\.9/m.test(md)).toBe(false)
    store.close()
  })

  test("容器子项内容同样受约束（子键与值两条路）", async () => {
    const store = Store.memory(() => "reqdoc" as const)
    const features = [{ no: 1, name: "名单排查", priority: "high" as const, confirmedAt: 1000 }]
    const slots = requiredSlots(features).map((a) => ({
      kind: "prose" as const, address: a, content: `${a} 内容`,
      source: "文档" as const, status: "confirmed" as const,
    }))
    slots.push({
      kind: "term" as never, address: "4.1.CRD",
      content: "信贷审批部\n\n## 伪造章节\n\n伪造内容",
      source: "文档" as const, status: "confirmed" as const,
    })
    store.mutateWorkflow("r1", (w) => {
      for (const n of ["goal", "rules", "edge", "prd"]) w.stages[n].status = "approved"
      w.kb = { slots, features, containers: { "5.1.2.1": { required: false, reason: "y" } }, askCounts: {}, updatedAt: 1 }
    })
    const worktree = mkdtempSync(join(tmpdir(), "sm-i2b-"))
    const ctx = { sessionID: "r1", worktree } as never
    await createReqdocKbTools(store).reqdoc_assemble!.execute({} as never, ctx)
    const md = prdOf(worktree)
    expect(/^\s*#{1,6}\s+伪造章节/m.test(md)).toBe(false)
    store.close()
  })

  test("正常需求描述（段落/列表/换行）不受影响", async () => {
    const normal = "流程分三步：\n1. 柜员发起\n2. 系统校验\n3. 通知客户\n\n补充说明：可批量提交。"
    const { store, worktree, ctx } = build(normal)
    await createReqdocKbTools(store).reqdoc_assemble!.execute({} as never, ctx)
    const md = prdOf(worktree)
    expect(md).toContain("流程分三步")
    expect(md).toContain("1. 柜员发起")
    expect(md).not.toContain("\\1.")
    store.close()
  })
})

describe("I-1 · 记忆证据源不可由模型书写", () => {
  test("★ 模型不得自行声称某条术语成立（restated_term 需业务复述语义）", () => {
    // 这条不是门禁而是契约断言：记忆消缺口的正当性来自「业务复述」，
    // 而 restated_term 的 description 已明示「业务只是点了同意默认时绝对不要填」。
    // 工具输出措辞必须体现「仍需确认」而非「已消缺口」——避免模型把它当既成事实。
    const src = readFileSync(join(import.meta.dir, "..", "src", "tools", "reqdoc-kb-tools.ts"), "utf8")
    // 消缺口的提示必须同时给出「无需再问」与「来源是业务复述过的记忆」两个要素
    // 两处回执都必须给出「业务曾复述过」这个来源要素——否则模型会把记忆当成本项目的既成事实
    const notes = src.match(/🧠 L1 记忆[^`]*/g) ?? []
    expect(notes.length).toBeGreaterThanOrEqual(2)
    for (const n of notes) expect(n).toContain("业务曾复述过")
  })

  // 方案 C 落地后：证据是材料原文，模型写的槽位正文不再能制造命中。
  test("★ 模型写了否定句也拿不到记忆免问（材料不含该词）", async () => {
    tempMemory()
    writeL1Term("CCB", "某系统", { kind: "内部简称", scope: "org", origin: "restated", fromProject: "p" })
    const store = Store.memory(() => "reqdoc" as const)
    const worktree = mkdtempSync(join(tmpdir(), "sm-i1-"))
    // 材料里没有 CCB，模型却在槽位正文写「与 CCB 无关」——不得触发
    dropMaterial(worktree, "本需求仅涉及名单排查，不含其他系统。")
    const out = String(
      await createReqdocKbTools(store).reqdoc_ingest!.execute(
        {
          features: [{ name: "X", priority: "high" }],
          slots: [{ address: "3.1", kind: "prose", content: "本需求与 CCB 系统无关。", source: "文档" }],
          candidates: { "4.1": ["CCB"] },
        } as never,
        { sessionID: "r1", worktree } as never,
      ),
    )
    expect(out).not.toContain("L1 记忆免问")
    // 状态栏快照也无命中（两处口径一致）
    expect(store.get("r1")!.workflow!.kb!.evidence ?? "").not.toContain("CCB")
    store.close()
  })

  test("★ 材料确实含该词时照常免问（正向对照：换源没把记忆打没）", async () => {
    tempMemory()
    writeL1Term("CCB", "某系统", { kind: "内部简称", scope: "org", origin: "restated", fromProject: "p" })
    const store = Store.memory(() => "reqdoc" as const)
    const worktree = mkdtempSync(join(tmpdir(), "sm-i1b-"))
    dropMaterial(worktree, "本需求需对接 CCB 系统获取客户号。")
    const out = String(
      await createReqdocKbTools(store).reqdoc_ingest!.execute(
        {
          features: [{ name: "X", priority: "high" }],
          slots: [{ address: "3.1", kind: "prose", content: "取客户号", source: "文档" }],
          candidates: { "4.1": ["CCB"] },
        } as never,
        { sessionID: "r1", worktree } as never,
      ),
    )
    expect(out).toContain("L1 记忆免问")
    expect(store.get("r1")!.workflow!.kb!.evidence).toContain("CCB")
    store.close()
  })
})

/**
 * 第三轮复审（I-3 / I-4 / S-3）回归护栏。
 *
 * - **I-3** `CHANGE_ROW_RE` 曾匹配任意 5 列表格行 → 版本审计轨迹可伪造
 * - **I-4** `verifyTraceback` 只有「每行 → record」单向映射 → 逐条删除溯源记录放行
 * - **S-3** 我曾把 LCS 断言放宽成 `/确认溯源|内容与知识库不一致/`，导致 LCS 路径失去护栏
 */
describe("I-3 / I-4 · 服务端追加区块的完整性", () => {
  const assembled = async () => {
    tempMemory()
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
    const worktree = mkdtempSync(join(tmpdir(), "sm-i34-"))
    const ctx = { sessionID: "r1", worktree } as never
    await createReqdocKbTools(store).reqdoc_assemble!.execute({} as never, ctx)
    return { store, ctx, p: join(worktree, "07_需求规格产出/1_公告发布/PRD.md") }
  }
  const submit = async (store: Store, ctx: never) => {
    try { await createReviewTools(store).review_submit!.execute(CHECKLIST, ctx); return "" }
    catch (e) { return String(e) }
  }

  test("★ 伪造版本审计行被拦（I-3：任意 5 列表格行不再豁免）", async () => {
    const { store, ctx, p } = await assembled()
    writeFileSync(
      p,
      readFileSync(p, "utf8").replace(
        "## 第二章 文档变更过程",
        "## 第二章 文档变更过程\n\n| 9.9 | 【伪造】监管已出具无异议函 | 2020-01-01 | 张三 | 已通过 |",
      ),
      "utf8",
    )
    expect(await submit(store, ctx)).toMatch(/与知识库不一致|内容与知识库不一致/)
    store.close()
  })

  test("服务端自己写的变更记录行仍被豁免（正向：二次定稿不拦）", async () => {
    const { store, ctx } = await assembled()
    expect(await submit(store, ctx)).toBe("") // 首次定稿写入变更记录
    store.mutateWorkflow("r1", (w) => { w.stages.review.status = "in_progress" })
    expect(await submit(store, ctx)).toBe("") // 二次定稿：变更行豁免
    store.close()
  })

  test("★ 溯源逐条删除被拦（I-4：反向完整性）", async () => {
    const { store, ctx, p } = await assembled()
    const tools = createReviewTools(store)
    for (const [id, label, quote] of [["A", "L1", "Q1"], ["B", "L2", "Q2"]] as const) {
      await tools.comprehension_add!.execute({ codeSegmentId: id, explanation: "e" } as never, ctx)
      await tools.comprehension_confirm!.execute({ codeSegmentId: id, sourceLabel: label, sourceQuote: quote } as never, ctx)
    }
    writeFileSync(p, readFileSync(p, "utf8").replace(/^- 要点「B」.*$/m, ""), "utf8")
    expect(await submit(store, ctx)).toMatch(/确认溯源/)
    store.close()
  })
})

describe("C · 证据换源的两个失效路径", () => {
  const ingest = async (store: ReturnType<typeof Store.memory>, worktree: string) =>
    String(
      await createReqdocKbTools(store).reqdoc_ingest!.execute(
        {
          features: [{ name: "X", priority: "high" }],
          slots: [{ address: "3.1", kind: "prose", content: "取客户号", source: "文档" }],
          candidates: { "4.1": ["CCB"] },
        } as never,
        { sessionID: "r1", worktree } as never,
      ),
    )
  const withCCB = async () => {
    tempMemory()
    writeL1Term("CCB", "某系统", { kind: "内部简称", scope: "org", origin: "restated", fromProject: "p" })
    const store = Store.memory(() => "reqdoc" as const)
    const worktree = mkdtempSync(join(tmpdir(), "sm-c-"))
    return { store, worktree }
  }

  test("★ 材料被替换后旧证据不得残留（缓存按指纹失效）", async () => {
    const { store, worktree } = await withCCB()
    dropMaterial(worktree, "本需求需对接 CCB 系统。")
    expect(await ingest(store, worktree)).toContain("L1 记忆免问")
    // 业务换掉材料，CCB 不再出现 → 不得继续凭旧快照免问
    dropMaterial(worktree, "本需求仅涉及名单排查，与外部系统无关。")
    expect(await ingest(store, worktree)).not.toContain("L1 记忆免问")
    store.close()
  })

  test("★ 07 产物不作证据（否则自证面挪回原位）", async () => {
    tempMemory()
    writeL1Term("CCB", "某系统", { kind: "内部简称", scope: "org", origin: "restated", fromProject: "p" })
    const store = Store.memory(() => "reqdoc" as const)
    const worktree = mkdtempSync(join(tmpdir(), "sm-c2-"))
    // 只有组装产物含 CCB（正是由槽位正文生成的），材料目录全空
    mkdirSync(join(worktree, "07_需求规格产出/1_X"), { recursive: true })
    writeFileSync(join(worktree, "07_需求规格产出/1_X/PRD.md"), "对接 CCB 系统获取客户号。", "utf8")
    expect(await ingest(store, worktree)).not.toContain("L1 记忆免问")
    store.close()
  })
})
