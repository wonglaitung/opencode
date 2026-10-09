/**
 * reqdoc Word 导出工具（设计文档 workflow-reqdoc.md 8 章，实施方案「标准 PRD (Markdown/Word)」）。
 * reqdoc_export —— 将已渲染的 PRD Markdown（07_需求规格产出 下）转换为 Word（.docx）
 * 交付件，与源 md 同目录归档，供行方交付。仅 reqdoc 工作流使用（规则 reqdoc-r14 在
 * PRD 定稿后调用）。
 *
 * 转换覆盖模板渲染实际用到的标记：标题（#~#####）、表格（|…|）、无序列表（-）、
 * 引用（>）、代码块（```）与行内加粗（**…**）/反引号（`…`）。Mermaid 流程图
 * （```mermaid）渲染为 PNG 嵌入 Word（优先 bundle 预装 vendor 的 mermaid-cli + 系统
 * Edge/Chrome，回退 npx；均不可用时降级输出源码+提示）。
 */
import { basename, dirname, extname, join } from "node:path"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import {
  chapterDiff,
  chapterOf,
  crossChapterImpact,
  templateSchema,
  type ReqdocKbState,
} from "sm-shared"
import type { Store } from "../db"
import {
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx"
import { resolveWithinWorktree, projectRoot } from "../fs-safe"

const z = tool.schema

/** 行内标记拆分：**加粗** 与 `代码` 拆成多段 TextRun；style 为整段统一修饰（如表头加粗、引用斜体灰字）。 */
function inlineRuns(text: string, style: { bold?: boolean; italics?: boolean; color?: string } = {}): TextRun[] {
  const runs: TextRun[] = []
  const mk = (t: string, bold: boolean, font?: string): TextRun =>
    new TextRun({ text: t, bold: style.bold || bold, italics: style.italics, color: style.color, font })
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push(mk(text.slice(last, m.index), false))
    const tok = m[0]
    if (tok.startsWith("**")) runs.push(mk(tok.slice(2, -2), true))
    else runs.push(mk(tok.slice(1, -1), false, "Consolas"))
    last = m.index + tok.length
  }
  if (last < text.length) runs.push(mk(text.slice(last), false))
  return runs.length ? runs : [mk(text, false)]
}

/** 标题段落：按 # 层级映射 Word 标题样式。 */
function headingParagraph(text: string, level: number): Paragraph {
  const clean = text.replace(/^#{1,6}\s+/, "")
  const map: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
    4: HeadingLevel.HEADING_4,
    5: HeadingLevel.HEADING_5,
  }
  return new Paragraph({ text: clean, heading: map[level] ?? HeadingLevel.HEADING_5 })
}

/** Markdown 表格行是否分隔行（|------| 或 |:--:|）。 */
function isSeparatorRow(row: string): boolean {
  return (
    row.includes("-") &&
    row
      .split("|")
      .slice(1, -1)
      .every((c) => /^:?-+:?$/.test(c.trim()))
  )
}

/** vendor 内 mermaid-cli 入口（bin: mmdc → src/cli.js；index.js 是纯库入口，直接跑静默退出）相对 bundle 根的路径（离线预装，见 sync-bundle.sh / pack-bundle.sh）。 */
const VENDOR_MMDC_ENTRY = join("vendor", "mermaid-cli", "node_modules", "@mermaid-js", "mermaid-cli", "src", "cli.js")

/** 从 start 向上查找已预装 mermaid-cli 的 bundle 根（插件可能从 packages/ 或 node_modules/ 加载，上溯容错）。 */
function findVendorBundleRoot(start: string): string | null {
  let dir = start
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, VENDOR_MMDC_ENTRY))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** Windows 系统浏览器（Edge 必带，Chrome 次选）；非 win32 返回 null，走 puppeteer 自带缓存。 */
function systemBrowser(): string | null {
  if (process.platform !== "win32") return null
  const pf = process.env["ProgramFiles"] ?? "C:\\Program Files"
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"
  const candidates = [
    join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

/** vendor 调用用的 node：优先 bundle 同级的便携 node.exe，其次 PATH 上的 node。 */
function vendorNode(bundleRoot: string): string {
  if (process.platform === "win32") {
    const sibling = join(bundleRoot, "..", "node.exe")
    if (existsSync(sibling)) return sibling
  }
  return "node"
}

/** 尝试用 mermaid-cli (mmdc) 把 Mermaid 源码渲染为 PNG；失败返回 null。 */
async function renderMermaidToPng(mermaidSrc: string): Promise<Buffer | null> {
  try {
    const dir = await mkdtemp(join(tmpdir(), "mermaid-"))
    const inPath = join(dir, "input.mmd")
    const outPath = join(dir, "output.png")
    // mermaid-cli v12 的 -p 接受 JSON 配置文件路径（非内联 JSON），写入临时文件
    const cfgPath = join(dir, "puppeteer.json")
    await writeFile(inPath, mermaidSrc, "utf8")
    const cfg: Record<string, unknown> = { args: ["--no-sandbox", "--disable-setuid-sandbox"] }
    const browser = systemBrowser()
    if (browser) {
      // 离线机不预装 chrome-headless-shell：指向系统浏览器，并覆盖 mermaid-cli 默认
      // headless:"shell"（shell 模式只认 headless-shell 二进制），改用完整浏览器新无头模式
      cfg.executablePath = browser
      cfg.headless = true
    }
    await writeFile(cfgPath, JSON.stringify(cfg), "utf8")
    const bundleRoot = findVendorBundleRoot(import.meta.dir)
    const args = `-i "${inPath}" -o "${outPath}" -b transparent -s 2 -p "${cfgPath}"`
    const command = bundleRoot
      ? `"${vendorNode(bundleRoot)}" "${join(bundleRoot, VENDOR_MMDC_ENTRY)}" ${args}`
      : `npx --yes @mermaid-js/mermaid-cli ${args}`
    const { execSync } = await import("node:child_process")
    execSync(command, { timeout: 60_000, stdio: "pipe" })
    const buf = await readFile(outPath)
    await rm(dir, { recursive: true, force: true })
    return buf
  } catch {
    return null
  }
}

/** 解析 Markdown 表格（首行表头 + 分隔行 + 数据行）为 docx 表格。 */
function parseTable(lines: string[]): Table {
  const cellsOf = (row: string) => row.split("|").slice(1, -1).map((c) => c.trim())
  const header = cellsOf(lines[0])
  const body = lines.slice(1).filter((l) => !isSeparatorRow(l)).map(cellsOf)
  const colCount = Math.max(header.length, ...body.map((r) => r.length))
  const makeRow = (cells: string[], isHeader: boolean): TableRow =>
    new TableRow({
      children: Array.from({ length: colCount }, (_, i) => {
        const cell = cells[i] ?? ""
        const text = new Paragraph({ children: inlineRuns(cell, { bold: isHeader }) })
        return new TableCell({
          children: [text],
          shading: isHeader ? { fill: "F2F2F2", type: ShadingType.CLEAR, color: "auto" } : undefined,
        })
      }),
    })
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [makeRow(header, true), ...body.map((r) => makeRow(r, false))],
  })
}

/** 把 PRD Markdown 转成 docx Document（模板渲染覆盖的标记子集）。 */
export async function mdToDocx(md: string): Promise<Buffer> {
  const children: (Paragraph | Table)[] = []
  const lines = md.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const trimmed = lines[i].trim()
    // 代码块：检测 mermaid 围栏，渲染为 PNG 嵌入
    if (trimmed.startsWith("```")) {
      const lang = trimmed.slice(3).trim().toLowerCase()
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        code.push(lines[i])
        i++
      }
      i++ // 跳过结束围栏
      if (lang === "mermaid") {
        const png = await renderMermaidToPng(code.join("\n"))
        if (png) {
          children.push(
            new Paragraph({
              children: [new ImageRun({ data: png, transformation: { width: 500, height: 300 }, type: "png" })],
              spacing: { before: 120, after: 120 },
            }),
          )
          continue
        }
        // 降级：mmdc 不可用，输出源码 + 提示
        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: "[流程图源码（需安装 @mermaid-js/mermaid-cli 渲染）]", italics: true, color: "999999" }),
            ],
            spacing: { before: 60, after: 60 },
          }),
        )
        children.push(
          new Paragraph({ children: [new TextRun({ text: code.join("\n"), font: "Consolas", size: 18 })] }),
        )
        continue
      }
      // 普通代码块
      children.push(
        new Paragraph({ children: [new TextRun({ text: code.join("\n"), font: "Consolas", size: 18 })] }),
      )
      continue
    }
    // 表格：连续 | 行归一组
    if (lines[i].trimStart().startsWith("|")) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        tableLines.push(lines[i])
        i++
      }
      children.push(parseTable(tableLines))
      continue
    }
    // 标题
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      children.push(headingParagraph(trimmed, heading[1].length))
      i++
      continue
    }
    // 引用（模板顶部源说明等）
    if (trimmed.startsWith(">")) {
      children.push(
        new Paragraph({
          children: inlineRuns(trimmed.replace(/^>\s?/, ""), { italics: true, color: "666666" }),
          indent: { left: 360 },
        }),
      )
      i++
      continue
    }
    // 无序列表；模板内 ○/● 选项行也以 - 开头，但属勾选占位而非真正的项目符号，
    // 若按项目符号处理 Word 会在前方再加一个 ●，故此类行改为普通段落（仅去掉 - 前缀）。
    if (/^[-*•]\s+/.test(trimmed)) {
      const content = trimmed.replace(/^[-*•]\s+/, "")
      const isOptionRow = /^[○●]/.test(content)
      children.push(
        new Paragraph({
          children: inlineRuns(content),
          ...(isOptionRow ? {} : { bullet: { level: 0 } }),
        }),
      )
      i++
      continue
    }
    if (trimmed === "") {
      i++
      continue
    }
    // 普通段落
    children.push(new Paragraph({ children: inlineRuns(lines[i]) }))
    i++
  }
  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: "宋体", size: 22 } }, // 22 half-point = 11pt，正文可读
      },
    },
    sections: [{ children }],
  })
  return Buffer.from(await Packer.toBuffer(doc))
}

export function createReqdocExportTool(store: Store): Record<string, ToolDefinition> {
  const reqdoc_export = tool({
    description:
      "reqdoc Word 导出：将已渲染的 PRD Markdown 导出为 Word（.docx）交付件，与源 md 同目录归档。" +
      "在 reqdoc_assemble 生成 PRD（写入 07_需求规格产出）并定稿后调用；" +
      "source 填 PRD Markdown 相对项目根路径（如 07_需求规格产出/N_名称/xxx.md）。" +
      "定点修订（乙）可选 mode：chapter=导出锁定章整章、diff=只导出相对编辑前快照的增/改/删（默认 diff）；" +
      "此时无需 source，直接从知识库生成，并附单向提醒、原稿节映射提示与跨章影响。",
    args: {
      source: z.string().describe("PRD Markdown 相对项目根路径（07_需求规格产出/N_名称/xxx.md）；定点修订导出时不需要"),
      mode: z
        .enum(["chapter", "diff"])
        .optional()
        .describe("定点修订（乙）导出形态：chapter=锁定章整章；diff=相对编辑前快照的差异（默认）。不传则按 source 整篇导出。"),
      chapter: z.number().optional().describe("定点导出目标章号；省略时取当前定点修订锁定章（kb.editScope.chapter）"),
    },
    async execute(args, context) {
      const root = projectRoot(context)
      // 定点修订（乙）差异/整章导出：从知识库直接生成
      if (args.mode) {
        const kb = store.get(context.sessionID)?.workflow?.kb as ReqdocKbState | undefined
        if (!kb) throw new Error("未找到需求知识库状态，无法定点导出。请先走 reqdoc 流程。")
        const target = args.chapter ?? kb.editScope?.chapter
        if (target === undefined) throw new Error("定点导出须指定 chapter（或先进入定点修订锁定章）。")
        const schema = templateSchema()
        const title = schema?.chapters.find((c) => c.number === target)?.title ?? `第${target}章`
        const lines: string[] = []
        if (args.mode === "diff") {
          if (!kb.editScope?.active) {
            throw new Error("差异导出须先进入定点修订（editScope 已激活并冻结编辑前快照）。整章导出可用 mode:chapter。")
          }
          const d = chapterDiff(kb.editScope.snapshotBefore, kb.slots, target)
          lines.push(`# 定点修订 · 第${target}章《${title}》差异导出`, "")
          lines.push(
            "> ⚠ 单向提醒：本导出是「系统 → 你的原稿」的产物。你把内容贴回原稿后，系统不会回读你手改的原稿；" +
              "后续若再以原稿发起修订，须重新上传并说明改动，否则系统只认这份 PRD 的状态。",
          )
          lines.push("", "## 改动内容（请把下列内容贴回你原稿对应节）")
          for (const a of [...d.added, ...d.changed]) {
            const s = kb.slots.find((x) => x.address === a)
            if (!s) continue
            lines.push(`### ${a}（${d.added.includes(a) ? "新增" : "改写"}）`, s.content, "")
          }
          if (d.removed.length) {
            lines.push("## 已移除（retired / 消失）")
            for (const a of d.removed) lines.push(`- ${a}`)
            lines.push("")
          }
        } else {
          const inCh = kb.slots.filter((s) => chapterOf(s.address) === target)
          lines.push(`# 定点修订 · 第${target}章《${title}》整章导出`, "")
          lines.push(
            `> ⚠ 单向提醒：贴回原稿后系统不回读；原稿节映射：本导出对应 PRD 第${target}章《${title}》，` +
              "若你原稿该部分标题不同请按内容自行对应到原稿相应节。",
          )
          lines.push("")
          for (const s of inCh) {
            lines.push(`### ${s.address}`, s.content, "")
          }
        }
        const impact = crossChapterImpact(kb.slots, target)
        if (impact.length) {
          lines.push("## 跨章影响（仅供参考，不阻断）")
          for (const x of impact) lines.push(`- ${x}`)
          lines.push("")
        }
        const md = lines.join("\n")
        const buf = await mdToDocx(md)
        const outName = args.mode === "diff" ? `定点修订_第${target}章_差异` : `定点修订_第${target}章_整章`
        const outDir = join(root, "07_需求规格产出")
        await mkdir(outDir, { recursive: true })
        const outMd = join(outDir, `${outName}.md`)
        const outDocx = outMd.replace(/\.md$/, ".docx")
        await Bun.write(outMd, md)
        await Bun.write(outDocx, buf)
        return (
          `已导出定点修订（${args.mode === "diff" ? "差异" : "整章"}）第${target}章《${title}》：\n` +
          `- ${outMd}\n- ${outDocx}\n` +
          `⚠ 请务必转述给用户：① 贴回原稿后系统不回读（单向）；② 跨章影响见导出内「跨章影响」节；③ 原稿节映射提示见导出顶部。`
        )
      }
      if (extname(args.source).toLowerCase() !== ".md") {
        throw new Error("source 必须指向 .md 文件（reqdoc_export 只转换 Markdown 渲染的 PRD）")
      }
      const mdPath = resolveWithinWorktree(root, args.source)
      let md: string
      try {
        md = await Bun.file(mdPath).text()
      } catch {
        throw new Error(`源文件不存在或不可读：${args.source}。请先用 reqdoc_assemble 生成 PRD 再调用导出（不要用 write 手写产物）。`)
      }
      const buf = await mdToDocx(md)
      const outPath = mdPath.replace(/\.md$/i, ".docx")
      await Bun.write(outPath, buf)
      return (
        `已导出 Word 版交付件：${basename(outPath)}（${buf.length} 字节），与源 md 同目录（${dirname(args.source) || "."}）。` +
        `建议打开 Word 核对一次排版；模板内 ○/● 勾选以符号原样保留。`
      )
    },
  })
  return { reqdoc_export }
}
