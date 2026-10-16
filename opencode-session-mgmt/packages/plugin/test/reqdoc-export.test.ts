/**
 * reqdoc_export Word 导出工具测试（实施方案「标准 PRD (Markdown/Word)」）。
 * 覆盖：md→docx 转换生成合法 OOXML zip（含 document.xml 与标题/表格内容）、
 * 工具写 .docx 与源同目录、非 md 源拒绝、源不存在报错。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import JSZip from "jszip"
import { Store } from "../src/db"
import { createReqdocExportTool, mdToDocx } from "../src/tools/reqdoc-export"

const store = Store.memory(() => "reqdoc" as const)
const dirs: string[] = []

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sm-export-"))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 校验 buf 是合法 docx：PK 头 + word/document.xml 存在且含指定片段。 */
async function assertDocx(buf: Buffer, expectContains: string[]) {
  expect(buf.subarray(0, 2).toString()).toBe("PK")
  const zip = await JSZip.loadAsync(buf)
  const doc = zip.file("word/document.xml")
  expect(doc).not.toBeNull()
  const xml = await doc!.async("text")
  for (const frag of expectContains) expect(xml).toContain(frag)
}

const SAMPLE_MD = `# 业务需求说明书

## 一、项目信息

| 项目信息 | 内容 |
|------|------|
| 标题 | 内部工单系统 |
| 优先级 | ● 高　○ 中　○ 低 |

## 第三章 需求功能详述

- 功能点编号：1
- 功能名称：**名单排查**

> 来源标注：文档提取 [文档]

### 1.1 简要概述

业务人员在排查名单时…`

describe("reqdoc_export", () => {
  test("mdToDocx 生成合法 docx（标题/表格/列表/加粗/引用内容均在 document.xml）", async () => {
    const buf = await mdToDocx(SAMPLE_MD)
    expect(buf.length).toBeGreaterThan(1000)
    await assertDocx(buf, [
      "业务需求说明书", // H1
      "一、项目信息", // H2
      "内部工单系统", // 表格单元格
      "功能点编号：1", // 列表
      "名单排查", // 加粗段
      "来源标注：文档提取", // 引用
      "业务人员在排查名单时", // 段落
    ])
  })

  test("○/● 选项行不加 Word 项目符号（避免多一个 ●）", async () => {
    const md = `# 标题

- 真实列表项
- ○ 涉及　● 不涉及
- ○ 适用　● 不适用`
    const buf = await mdToDocx(md)
    const zip = await JSZip.loadAsync(buf)
    const xml = await zip.file("word/document.xml")!.async("text")
    expect(xml).toContain("○ 涉及　● 不涉及")
    expect(xml).toContain("○ 适用　● 不适用")
    // 仅真实列表项带 numPr，两条选项行不带（否则 Word 会在前方叠加一个 ●）
    expect(xml.match(/<w:numPr>/g)?.length).toBe(1)
  })

  test("工具把 .docx 写到源 md 同目录并返回路径", async () => {
    const worktree = tempDir()
    const rel = "07_需求规格产出/1_名单排查/需求规格书.md"
    mkdirSync(dirname(join(worktree, rel)), { recursive: true })
    writeFileSync(join(worktree, rel), SAMPLE_MD, "utf8")
    const tools = createReqdocExportTool(store)
    const out = String(
      await tools.reqdoc_export!.execute({ source: rel } as never, { worktree } as never),
    )
    expect(out).toContain("已导出 Word 版交付件：需求规格书.docx")
    const outPath = join(worktree, "07_需求规格产出/1_名单排查/需求规格书.docx")
    expect(existsSync(outPath)).toBe(true)
    await assertDocx(Buffer.from(await Bun.file(outPath).arrayBuffer()), ["内部工单系统"])
  })

  test("非 .md 源被拒", async () => {
    const worktree = tempDir()
    const tools = createReqdocExportTool(store)
    await expect(
      tools.reqdoc_export!.execute({ source: "07_需求规格产出/需求规格书.docx" } as never, { worktree } as never),
    ).rejects.toThrow(/必须指向 .md/)
  })

  test("源文件不存在报错（提示先完成 PRD 渲染）", async () => {
    const worktree = tempDir()
    const tools = createReqdocExportTool(store)
    await expect(
      tools.reqdoc_export!.execute({ source: "07_需求规格产出/不存在/需求规格书.md" } as never, { worktree } as never),
    ).rejects.toThrow(/源文件不存在或不可读/)
  })
})

describe("reqdoc_export · Mermaid 渲染（无浏览器链路 + 裸中文 ID 静默丢弃防线，2026-10 方案回归）", () => {
  /** 从 docx zip 里取 word/media/ 下的图片部件（排除目录项）。 */
  async function mediaParts(buf: Buffer): Promise<{ name: string; data: Buffer }[]> {
    const zip = await JSZip.loadAsync(buf)
    return Promise.all(
      Object.keys(zip.files)
        .filter((f) => f.startsWith("word/media/") && !f.endsWith("/"))
        .map(async (name) => ({ name, data: await zip.file(name)!.async("nodebuffer") })),
    )
  }

  /** 渲染 md → docx，返回「是否出图 + 是否带降级提示」。 */
  async function renderBlock(block: string): Promise<{ pngCount: number; degrade: boolean }> {
    const buf = await mdToDocx(`# 图\n\n\`\`\`mermaid\n${block}\n\`\`\``)
    const zip = await JSZip.loadAsync(buf)
    const xml = await zip.file("word/document.xml")!.async("text")
    return { pngCount: (await mediaParts(buf)).length, degrade: xml.includes("流程图暂不支持渲染") }
  }

  test("中文 flowchart 渲染为 PNG 嵌入（media 里有真实 PNG，比例自适应）", async () => {
    const md = [
      "# 图",
      "",
      "```mermaid",
      "flowchart TD",
      "    A[用户提交申请] --> B{金额是否超限}",
      "    B -->|是| C[转人工审批]",
      "    B -->|否| D[系统自动审批]",
      "```",
    ].join("\n")
    const buf = await mdToDocx(md)
    const media = await mediaParts(buf)
    expect(media.length).toBe(1)
    expect(media[0]!.data.subarray(1, 4).toString()).toBe("PNG")
    // IHDR 宽高：宽高比不为写死的 500:300（回归旧 500×300 拉伸）
    const w = media[0]!.data.readUInt32BE(16)
    const h = media[0]!.data.readUInt32BE(20)
    expect(Math.abs(w / h - 500 / 300)).toBeGreaterThan(0.1)
  })

  test("裸中文节点 ID 渲染为 PNG（A′ 改写：曾被解析器静默丢弃→空图降级）", async () => {
    const r = await renderBlock("flowchart TD\n    客户 --> 系统\n    系统 --> 数据库")
    expect(r.pngCount).toBe(1)
    expect(r.degrade).toBe(false)
  })

  test("混合图（ASCII+裸中文 ID）渲染出完整图（曾静默丢边成错图，P2 回归）", async () => {
    const r = await renderBlock("flowchart TD\n    A[开始] --> 结束\n    结束 --> C[完成]")
    expect(r.pngCount).toBe(1)
    expect(r.degrade).toBe(false)
  })

  test("中文子图与 & 并联渲染为 PNG", async () => {
    const sg = await renderBlock("flowchart TD\n    subgraph 审批组\n        A --> B\n    end\n    B --> C")
    expect(sg.pngCount).toBe(1)
    const amp = await renderBlock("flowchart TD\n    开始 & 结束 --> 归档")
    expect(amp.pngCount).toBe(1)
  })

  test("中文 classDef/class/style/::: 简写渲染为 PNG（样式类名一并改写）", async () => {
    const r = await renderBlock(
      "flowchart TD\n    开始[提交]:::高风险 --> 结束\nclassDef 高风险 fill:#f00,stroke:#333\nstyle 结束 fill:#eee",
    )
    expect(r.pngCount).toBe(1)
    expect(r.degrade).toBe(false)
  })

  test("sequenceDiagram（裸中文 actor / alt）渲染为 PNG（解析器 \S 匹配，Unicode 安全）", async () => {
    const bare = await renderBlock("sequenceDiagram\n    甲->>乙: 提交申请\n    乙-->>甲: 返回结果")
    expect(bare.pngCount).toBe(1)
    const alt = await renderBlock(
      [
        "sequenceDiagram",
        "    participant 客户",
        "    participant 系统",
        "    客户->>系统: 提交贷款申请",
        "    alt 金额大于50万",
        "        系统-->>客户: 转人工审批",
        "    else 金额不大于50万",
        "        系统-->>客户: 自动审批通过",
        "    end",
      ].join("\n"),
    )
    expect(alt.pngCount).toBe(1)
  })

  test("嵌入文本箭头（-- 是 -->）降级为源码提示（不静默、不崩）", async () => {
    const r = await renderBlock("flowchart TD\n    A -- 是 --> B")
    expect(r.pngCount).toBe(0)
    expect(r.degrade).toBe(true)
  })

  test("解析器不支持的箭头（--x / ~~~）降级（扫描器与解析器箭头表对齐 + 差分校验兜底）", async () => {
    const x = await renderBlock("flowchart TD\n    A --x B")
    expect(x.pngCount).toBe(0)
    expect(x.degrade).toBe(true)
    // ~~~ 是差分校验的专属防线：扫描器放行时（SAFE 表误含）解析器仍会丢边，靠箭头差分拦下
    const t = await renderBlock("flowchart TD\n    A ~~~ B")
    expect(t.pngCount).toBe(0)
    expect(t.degrade).toBe(true)
  })

  test("classDef 样式值里无法改写的中文（未加引号 font-family）降级", async () => {
    const r = await renderBlock("flowchart TD\n    A --> B\nclassDef hot font-family:微软雅黑")
    expect(r.pngCount).toBe(0)
    expect(r.degrade).toBe(true)
  })

  test("认不出的图型（gantt）降级为源码提示（不崩、不出图）", async () => {
    const md = ["# 图", "", "```mermaid", "gantt", "    title x", "    section s", "    t1:2024-01-01, 1d", "```"].join(
      "\n",
    )
    const buf = await mdToDocx(md)
    await assertDocx(buf, ["流程图暂不支持渲染，以下为源码", "gantt"])
    expect((await mediaParts(buf)).length).toBe(0)
  })

  test("同一图源二次导出命中缓存，产物仍为 PNG", async () => {
    const src = "```mermaid\nflowchart LR\n    开始 --> 结束\n```"
    const first = await mediaParts(await mdToDocx(`# 缓存\n\n${src}`))
    const second = await mediaParts(await mdToDocx(`# 缓存2\n\n${src}`))
    expect(first.length).toBe(1)
    expect(second.length).toBe(1)
    expect(second[0]!.data.equals(first[0]!.data)).toBe(true)
  })
})
