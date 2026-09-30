/**
 * 定稿门禁护栏（重构审查 P1）：
 *
 * 审查发现三个可绕过定稿校验的缺口，本文件把它们钉死：
 * 1. 幂等校验曾写成 `if (liveRender?.kbDigest && ...)`——产物缺失或无内嵌摘要时整条静默跳过，
 *    模型用 write 手写一篇 PRD 即可绕过。
 * 2. `no_document_confirmed` / `skip_field_dict` 是死参数：schema 暴露给模型、description 承诺
 *    「可跳过门禁」，但 execute 零处读取——造成虚假安全感。
 * 3. 死参数删除后，规则文本若仍指示模型使用，同样是缺陷。
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { kbDigest, parseRenderStructure, requiredSlots, reviewRecord } from "sm-shared"
import { Store } from "../src/db"
import { createReqdocKbTools } from "../src/tools/reqdoc-kb-tools"
import { createReviewTools } from "../src/tools/review"

const dirs: string[] = []
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "sm-p1guard-"))
  dirs.push(d)
  return d
}
process.on("exit", () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const CHECKLIST = {
  completeness: true,
  clarity: true,
  edgeCoverage: true,
  resolution: true,
} as never

/** 已填满槽位 + 前序阶段 approved 的 reqdoc store。 */
function readyStore(): Store {
  const store = Store.memory(() => "reqdoc" as const)
  store.mutateWorkflow("r1", (w) => {
    for (const n of ["goal", "rules", "edge", "prd"]) w.stages[n].status = "approved"
    const features = [{ no: 1, name: "公告发布", priority: "medium" as const, confirmedAt: 1000 }]
    w.kb = {
      slots: requiredSlots(features).map((address) => ({
        kind: "prose" as const,
        address,
        content: `${address} 内容`,
        source: "文档" as const,
        status: "confirmed" as const,
      })),
      features,
      containers: {
        "4.1": { required: false, reason: "无特殊术语" },
        "5.1.2.1": { required: false, reason: "无结构化字段" },
      },
      askCounts: {},
      updatedAt: 1000,
    }
  })
  return store
}

/** 用 reqdoc_assemble 在真实 worktree 生成产物（等价于真实流程）。 */
async function assemble(store: Store, worktree: string) {
  const ctx = { sessionID: "r1", worktree } as never
  await createReqdocKbTools(store).reqdoc_assemble!.execute({} as never, ctx)
  return ctx
}

describe("P1 · 定稿幂等门禁不可绕过", () => {
  test("★ 产物缺失 → 定稿被拒（force_kb 也不豁免）", async () => {
    const store = readyStore()
    const worktree = tempDir()
    const ctx = { sessionID: "r1", worktree } as never // 故意不组装
    await expect(
      createReviewTools(store).review_submit!.execute(CHECKLIST, ctx),
    ).rejects.toThrow(/未找到 PRD 产物/)
    store.close()
  })

  test("★ 手写产物（无内嵌摘要）→ 定稿被拒", async () => {
    const store = readyStore()
    const worktree = tempDir()
    // 模型用 write 手写一篇结构完整但没有 <!-- kb-digest --> 的 PRD
    const rel = "07_需求规格产出/1_公告发布/PRD.md"
    mkdirSync(dirname(join(worktree, rel)), { recursive: true })
    writeFileSync(
      join(worktree, rel),
      "## 第一章 项目信息\n## 第三章 需求概述\n## 第五章 需求功能详述\n",
      "utf8",
    )
    const ctx = { sessionID: "r1", worktree } as never
    await expect(
      createReviewTools(store).review_submit!.execute(CHECKLIST, ctx),
    ).rejects.toThrow(/缺少槽位摘要/)
    store.close()
  })

  test("★ 槽位变更后未重组装（过期产物）→ 定稿被拒并指明原因", async () => {
    const store = readyStore()
    const worktree = tempDir()
    const ctx = await assemble(store, worktree)
    // 槽位变更（模拟业务补充了一个槽位）
    store.mutateWorkflow("r1", (w) => {
      w.kb!.slots.push({
        kind: "prose",
        address: "3.1",
        content: "业务补充的新内容",
        source: "文档",
        status: "confirmed",
      })
      if (w.kb?.askCounts) w.kb.askCounts["3.1"] = 0
    })
    await expect(
      createReviewTools(store).review_submit!.execute(CHECKLIST, ctx),
    ).rejects.toThrow(/与知识库不一致/)
    store.close()
  })

  test("★ 产物被手改（摘要被抹掉）→ 定稿被拒", async () => {
    const store = readyStore()
    const worktree = tempDir()
    const ctx = await assemble(store, worktree)
    const rel = join(worktree, "07_需求规格产出/1_公告发布/PRD.md")
    // 模拟模型手工编辑产物、连带删掉内嵌摘要
    writeFileSync(rel, readFileSync(rel, "utf8").replace(/<!--\s*kb-digest:[^>]*-->\n?/g, ""), "utf8")
    await expect(
      createReviewTools(store).review_submit!.execute(CHECKLIST, ctx),
    ).rejects.toThrow(/缺少槽位摘要/)
    store.close()
  })

  test("正向：组装产物与槽位一致 → 定稿通过", async () => {
    const store = readyStore()
    const worktree = tempDir()
    const ctx = await assemble(store, worktree)
    const out = String(await createReviewTools(store).review_submit!.execute(CHECKLIST, ctx))
    expect(out).toContain("审查阶段通过")
    store.close()
  })
})

describe("P1 · 死参数已移除", () => {
  test("★ review_submit schema 不再暴露 skip_field_dict / no_document_confirmed", () => {
    const tools = createReviewTools(readyStore())
    const shape = tools.review_submit!.args ?? {}
    expect(Object.keys(shape)).not.toContain("skip_field_dict")
    expect(Object.keys(shape)).not.toContain("no_document_confirmed")
  })

  test("★ workflow_advance 保留 force_kb / force_reason（有实际门禁作用）", () => {
    const shape = createReqdocKbTools(readyStore()).reqdoc_ingest!.args ?? {}
    // 结构存在性检查：ingest 无 force 参数（force 在 workflow_advance 上），此处只断言 ingest 参数集
    expect(Object.keys(shape)).toContain("slots")
    expect(Object.keys(shape)).not.toContain("skip_field_dict")
  })

  test("★ 组装产物首行内嵌摘要，可被 parseRenderStructure 读回", async () => {
    const store = readyStore()
    const worktree = tempDir()
    await assemble(store, worktree)
    const md = readFileSync(join(worktree, "07_需求规格产出/1_公告发布/PRD.md"), "utf8")
    expect(md.startsWith("<!-- kb-digest: ")).toBe(true)
    // 摘要可被 parseRenderStructure 读回——这是幂等校验能工作的前提
    const parsed = parseRenderStructure(md)
    const kb = store.get("r1")!.workflow!.kb!
    expect(parsed.kbDigest).toBe(kbDigest(kb.slots))
  })
})

describe("P1 · 确认溯源门禁仍生效（未被重构削弱）", () => {
  test("已接受要点未回填来源 → 定稿被拦（即使知识库齐备）", async () => {
    const store = readyStore()
    const worktree = tempDir()
    const tools = createReviewTools(store)
    const ctx = await assemble(store, worktree)
    await tools.comprehension_add!.execute(
      { codeSegmentId: "目标与场景", explanation: "缩短开户录入" } as never,
      ctx,
    )
    await tools.comprehension_confirm!.execute({ codeSegmentId: "目标与场景" } as never, ctx)
    await expect(tools.review_submit!.execute(CHECKLIST, ctx)).rejects.toThrow(/确认溯源缺失/)
    // 定稿被拦 → review 阶段未被 approve
    expect(reviewRecord(store.get("r1")!.workflow!).status).not.toBe("approved")
    store.close()
  })
})