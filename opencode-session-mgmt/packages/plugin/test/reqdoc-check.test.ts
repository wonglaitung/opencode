/**
 * reqdoc_check 渲染结构校验工具测试（质量飞轮 P2）。
 * 覆盖：结构合规写入 render（含 source/expectedFeatures/covered）、违规卡输出、
 * 仅 reqdoc 可用（sdlc 拒绝）、源文件缺失报错。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { REQDOC_TEMPLATE_CHAPTERS } from "sm-shared"
import { Store } from "../src/db"
import { createReqdocCheckTools } from "../src/tools/reqdoc-check"

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sm-reqcheck-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 一份结构齐全的单功能点 PRD md（映射字段全标来源）。 */
function goodMd(): string {
  return (
    `## 一、项目信息\n` +
    `## 二、文档变更过程\n` +
    `## 第一章 需求概述\n### 1.1 需求类型\n### 1.2 属于流程优化项目\n### 1.3 涉及跨部门项目\n### 1.4 涉及总行开发\n### 1.5 希望完成时间\n### 1.6 需求提出原因及功能概述\n` +
    `## 第二章 术语定义与业务规则\n### 2.1 术语定义\n### 2.2 业务规则\n` +
    `## 第三章 需求功能详述\n` +
    `### 功能点 1\n` +
    `#### 1. 功能点输入要素\n##### 1.1 简要概述 [文档]\n##### 1.2 控制要求 [文档]\n` +
    `#### 2. 功能点处理要求\n` +
    `##### 2.1 输入要素的检查 [文档]\n##### 2.2 系统处理过程 [文档]\n##### 2.3 异常处理要求 [文档]\n` +
    `##### 2.4 提示信息 [文档]\n##### 2.5 其他要求 [文档]\n##### 2.6 清算处理 [文档]\n` +
    `##### 2.7 差错处理 [文档]\n##### 2.8 交易安全性 [文档]\n##### 2.9 数据存贮和清理 [文档]\n##### 2.10 附件 [文档]\n` +
    `## 第四章 非功能需求\n### 4.1 性能与容量\n### 4.2 可用性与可靠性\n### 4.3 安全与信创\n### 4.4 数据主权与合规\n` +
    `## 第五章 验收标准\n### 5.1 功能点验收指标\n### 5.2 量化验收口径\n`
  )
}

function setupReqdoc(features: number): { store: Store; worktree: string } {
  const store = Store.memory(() => "reqdoc")
  store.mutateWorkflow("r1", (w) => {
    w.features = Array.from({ length: features }, (_, i) => ({
      no: i + 1,
      name: `功能点 ${i + 1}`,
      priority: "medium" as const,
      confirmedAt: 1000,
    }))
  })
  const worktree = tempDir()
  return { store, worktree }
}

const writeMd = (worktree: string, rel: string, md: string) => {
  mkdirSync(dirname(join(worktree, rel)), { recursive: true })
  writeFileSync(join(worktree, rel), md, "utf8")
}

describe("reqdoc_check", () => {
  test("结构合规：写入 render（source/expectedFeatures/covered 齐全）且卡片无违规", async () => {
    const { store, worktree } = setupReqdoc(1)
    const rel = "06_需求规格产出/1_测试/需求规格书.md"
    writeMd(worktree, rel, goodMd())
    const tools = createReqdocCheckTools(store)
    const out = String(
      await tools.reqdoc_check!.execute({ source: rel } as never, { sessionID: "r1", worktree } as never),
    )
    expect(out).toContain("已校验 PRD 渲染结构")
    expect(out).toContain("章节骨架 ✓")
    expect(out).toContain("功能点块：1/1")
    expect(out).toContain("覆盖进度")
    expect(out).toContain("✓ 结构合规，可 review_submit 定稿")
    expect(out).toContain("期望骨架")
    const render = store.get("r1")!.workflow!.render!
    expect(render.source).toBe(rel)
    expect(render.expectedFeatures).toBe(1)
    expect(render.featureCount).toBe(1)
    expect(render.missing).toEqual([])
    expect(render.ok).toBe(true)
    for (const ch of REQDOC_TEMPLATE_CHAPTERS) expect(render.chaptersPresent).toContain(ch.title)
    store.close()
  })

  test("结构违规：缺章节 + 功能点块数与已确认数不符 → 卡片列违规", async () => {
    const { store, worktree } = setupReqdoc(2) // 已确认 2 个功能点
    const rel = "06_需求规格产出/1_测试/需求规格书.md"
    writeMd(worktree, rel, goodMd()) // 但渲染只有 1 个功能点块
    const tools = createReqdocCheckTools(store)
    const out = String(
      await tools.reqdoc_check!.execute({ source: rel } as never, { sessionID: "r1", worktree } as never),
    )
    expect(out).toContain("⚠ 渲染违规")
    expect(out).toContain("功能点块数 1 ≠ 已确认功能点 2")
    const render = store.get("r1")!.workflow!.render!
    expect(render.featureCount).toBe(1)
    expect(render.expectedFeatures).toBe(2)
    store.close()
  })

  test("仅 reqdoc 工作流可用（sdlc 拒绝且不写 render）", async () => {
    const store = Store.memory(() => "sdlc")
    const worktree = tempDir()
    const rel = "06_需求规格产出/1_测试/需求规格书.md"
    writeMd(worktree, rel, goodMd())
    const tools = createReqdocCheckTools(store)
    await expect(
      tools.reqdoc_check!.execute({ source: rel } as never, { sessionID: "s1", worktree } as never),
    ).rejects.toThrow(/仅用于 reqdoc/)
    expect(store.get("s1")?.workflow?.render).toBeUndefined()
    store.close()
  })

  test("源文件不存在或不可读 → 报错提示先完成渲染", async () => {
    const { store, worktree } = setupReqdoc(1)
    const tools = createReqdocCheckTools(store)
    await expect(
      tools.reqdoc_check!.execute(
        { source: "06_需求规格产出/不存在/需求规格书.md" } as never,
        { sessionID: "r1", worktree } as never,
      ),
    ).rejects.toThrow(/源文件不存在或不可读/)
    expect(store.get("r1")?.workflow?.render).toBeUndefined()
    store.close()
  })

  test("P3.7 增量诊断：feature=1 齐全 → 期望 vs 实际无缺失", async () => {
    const { store, worktree } = setupReqdoc(1)
    const rel = "06_需求规格产出/1_测试/需求规格书.md"
    writeMd(worktree, rel, goodMd())
    const tools = createReqdocCheckTools(store)
    const out = String(
      await tools.reqdoc_check!.execute({ source: rel, feature: "1" } as never, { sessionID: "r1", worktree } as never),
    )
    expect(out).toContain("🔍 增量诊断（功能点 1 期望 vs 实际）")
    expect(out).toContain("✗ 缺失：（无）")
    store.close()
  })

  test("P3.7 增量诊断：feature=1 缺 2.3 → 列出缺失子小节", async () => {
    const { store, worktree } = setupReqdoc(1)
    const rel = "06_需求规格产出/1_测试/需求规格书.md"
    writeMd(worktree, rel, goodMd().replace("##### 2.3 异常处理要求 [文档]\n", ""))
    const tools = createReqdocCheckTools(store)
    const out = String(
      await tools.reqdoc_check!.execute({ source: rel, feature: "功能点 1" } as never, { sessionID: "r1", worktree } as never),
    )
    expect(out).toContain("✗ 缺失：2.3 异常处理要求")
    store.close()
  })

  test("P3.9 连续失败计数：两次违规累加，合规后清零", async () => {
    const { store, worktree } = setupReqdoc(1)
    const rel = "06_需求规格产出/1_测试/需求规格书.md"
    const bad = goodMd().replace(/## 第四章[\s\S]*$/, "")
    const tools = createReqdocCheckTools(store)
    const ctx = { sessionID: "r1", worktree } as never
    writeMd(worktree, rel, goodMd()) // 首次合规 → 0
    await tools.reqdoc_check!.execute({ source: rel } as never, ctx)
    expect(store.get("r1")!.workflow!.renderCheckFails).toBe(0)
    writeMd(worktree, rel, bad) // 缺 第四章/第五章
    await tools.reqdoc_check!.execute({ source: rel } as never, ctx)
    await tools.reqdoc_check!.execute({ source: rel } as never, ctx)
    expect(store.get("r1")!.workflow!.renderCheckFails).toBe(2)
    writeMd(worktree, rel, goodMd())
    await tools.reqdoc_check!.execute({ source: rel } as never, ctx)
    expect(store.get("r1")!.workflow!.renderCheckFails).toBe(0)
    store.close()
  })

  test("P3.9 连续失败≥3 → 卡片提示人工介入与格式诊断", async () => {
    const { store, worktree } = setupReqdoc(1)
    const rel = "06_需求规格产出/1_测试/需求规格书.md"
    const bad = goodMd().replace(/## 第四章[\s\S]*$/, "")
    const tools = createReqdocCheckTools(store)
    const ctx = { sessionID: "r1", worktree } as never
    let out = ""
    for (let i = 0; i < 3; i++) {
      writeMd(worktree, rel, bad)
      out = String(await tools.reqdoc_check!.execute({ source: rel } as never, ctx))
    }
    expect(out).toContain("已连续 3 次校验不通过")
    expect(out).toContain("人工介入")
    store.close()
  })
})
