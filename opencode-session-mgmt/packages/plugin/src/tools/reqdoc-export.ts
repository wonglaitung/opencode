/**
 * reqdoc Word 导出工具（设计文档 workflow-reqdoc.md 8 章，实施方案「标准 PRD (Markdown/Word)」）。
 * reqdoc_export —— 将已渲染的 PRD Markdown（07_需求规格产出 下）转换为 Word（.docx）
 * 交付件，与源 md 同目录归档，供行方交付。仅 reqdoc 工作流使用（规则 reqdoc-r14；
 * 未定稿也能导出，产物里没定的内容标「暂未获得」，供线下讨论）。
 *
 * 转换覆盖模板渲染实际用到的标记：标题（#~#####）、表格（|…|）、无序列表（-）、
 * 引用（>）、代码块（```）与行内加粗（**…**）/反引号（`…`）。Mermaid 流程图
 * （```mermaid）渲染为 PNG 嵌入 Word（beautiful-mermaid 纯 JS 出 SVG + resvg 光栅化，
 * 无浏览器、无联网、无 puppeteer；认不出的图型降级输出源码+提示）。
 */
import { createHash } from "node:crypto"
import { basename, dirname, extname, join } from "node:path"
import { mkdir } from "node:fs/promises"
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

/** Mermaid 渲染缓存：同一段源码跨图/跨导出只渲染一次（键为源码 sha256；PRD 图数量个位数，无界可接受）。 */
const mermaidPngCache = new Map<string, Buffer>()

/** 渲染缩放倍数（与旧 mermaid-cli -s 2 同口径，Word 里 500px 宽下更清晰）。 */
const MERMAID_PNG_SCALE = 2

/**
 * 尝试把 Mermaid 源码渲染为 PNG：beautiful-mermaid（纯 JS 解析 + ELK 布局，无 DOM/浏览器）
 * 出 SVG，resvg 光栅化出 PNG；失败返回 null，由调用方降级输出源码。
 * 2026-10 方案：不走 mermaid-cli/puppeteer/系统浏览器（spike 3/3：中文 flowchart、
 * sequence alt、sequence loop+note）。
 *
 * 其手写解析器用 ^([\w-]+)（仅 ASCII）识别裸节点 ID——裸中文 ID（开始 --> 结束）的行会被
 * 静默丢弃，混合图（A[开始] --> 结束）会渲染成缺边错图（P2 实证）。故 flowchart 先经
 * normalizeFlowchart：把节点位裸 Unicode ID 改写为 ASCII ID+中文标签，并做箭头差分校验与
 * 残留 Unicode 扫描；过不了就返回 null 降级——宁给源码文本，不给错图。
 */
async function renderMermaidToPng(mermaidSrc: string): Promise<Buffer | null> {
  const key = createHash("sha256").update(mermaidSrc).digest("hex")
  const hit = mermaidPngCache.get(key)
  if (hit) return hit
  try {
    const { parseMermaid, renderMermaidSVG } = await import("beautiful-mermaid")
    const { Resvg } = await import("@resvg/resvg-js")
    const normalized = normalizeMermaidSource(mermaidSrc)
    if (!normalized) return null
    let source = normalized.src
    if (normalized.kind === "flow") {
      // 差分校验：扫描器计数的箭头必须都被解析器落成边；改写出的节点 ID 必须都在图里
      let graph
      try {
        graph = parseMermaid(source)
      } catch {
        return null
      }
      if (graph.edges.length < normalized.arrows) return null
      for (const id of normalized.nodeIds) {
        if (!graph.nodes.has(id)) return null
      }
      source = normalized.src
    }
    // beautiful-mermaid 会在 SVG 头部内嵌 Google Fonts @import——剥掉，产物不外联
    const svg = renderMermaidSVG(source).replace(/@import[^;]*;/g, "")
    const png = new Resvg(svg, {
      fitTo: { mode: "zoom", value: MERMAID_PNG_SCALE },
      // loadSystemFonts 覆盖 win/mac 系统字体（中文标签依赖）；linux 需显式字体目录
      font: { fontDirs: ["/usr/share/fonts", "/usr/local/share/fonts"], loadSystemFonts: true },
    })
      .render()
      .asPng()
    mermaidPngCache.set(key, png)
    return png
  } catch {
    return null
  }
}

/** 归一化结果：flow 带差分校验数据；seq 直通（sequence 解析器用 \S 匹配 actor，Unicode 安全，有 e2e 钉住）。 */
type NormalizedMermaid = { kind: "flow"; src: string; arrows: number; nodeIds: string[] } | { kind: "seq"; src: string }

/** 按首行图型分派：仅放行 r34 允许的 flowchart/graph 与 sequenceDiagram，其余（gantt 等）降级。 */
function normalizeMermaidSource(src: string): NormalizedMermaid | null {
  const header = src.split(/\r?\n/).find((l) => l.trim() !== "")
  if (!header) return null
  if (/^\s*sequenceDiagram\b/.test(header)) return { kind: "seq", src }
  if (/^\s*(?:flowchart|graph)\b/.test(header)) {
    const normalized = normalizeFlowchart(src)
    return normalized && { kind: "flow", ...normalized }
  }
  return null
}

/** 单行词法片段；node/cls 为待改写的裸 Unicode 标识，raw/arrow 原样回贴。 */
type FlowPiece = { k: "raw" | "arrow" | "node" | "cls"; v: string }
type FlowLine = { pieces: FlowPiece[]; arrows: number }

/** 安全箭头 op 表——与 beautiful-mermaid 的 ARROW_REGEX 同口径（对齐比较双方，防宽表漏检）。 */
const SAFE_FLOW_ARROW_OPS = ["-.->", "-.-", "-->", "==>", "===", "---"]

/** 从位置 i 匹配安全箭头（含可选 < 反向前缀）；|边标签| 由调用方紧随消费。 */
function matchSafeFlowArrow(line: string, i: number): string | null {
  let j = i
  if (line[j] === "<") j++
  for (const op of SAFE_FLOW_ARROW_OPS) {
    if (line.startsWith(op, j)) return line.slice(i, j + op.length)
  }
  return null
}

/**
 * flowchart 单行扫描：状态机「节点位 ⇄ 箭头位」。节点位接受 ASCII ID 或裸 Unicode 标识
 * （node 片段，待改写为 mN[原文]）；箭头位只接受安全箭头（+紧随 |标签|）。任何未知字符、
 * 嵌入文本箭头（-- 是 -->）、节点位外的 Unicode 等一律返回 null（整图降级，绝不静默丢行）。
 */
function scanFlowLine(line: string): FlowLine | null {
  const pieces: FlowPiece[] = []
  let arrows = 0
  let expectNode = true
  let i = 0
  const n = line.length
  const readBracket = (start: number): number => {
    const open = line[start]!
    const close = open === "[" ? "]" : open === "(" ? ")" : "}"
    let depth = 0
    for (let j = start; j < n; j++) {
      if (line[j] === open) depth++
      else if (line[j] === close && --depth === 0) return j + 1
    }
    return -1
  }
  while (i < n) {
    const c = line[i]!
    if (c === " " || c === "\t") {
      pieces.push({ k: "raw", v: c })
      i++
      continue
    }
    const arrow = matchSafeFlowArrow(line, i)
    if (arrow) {
      // 箭头只在接受态（前置节点已出现）合法；节点位直接来箭头（--> B）视为怪写法
      if (expectNode) return null
      pieces.push({ k: "arrow", v: arrow })
      i += arrow.length
      arrows++
      expectNode = true
      // |边标签| 紧随箭头（与 ARROW_REGEX 的 (?:\|([^|]*)\|)? 同口径）
      if (line[i] === "|") {
        const end = line.indexOf("|", i + 1)
        if (end < 0) return null
        pieces.push({ k: "raw", v: line.slice(i, end + 1) })
        i = end + 1
      }
      continue
    }
    if (c === "&" && !expectNode) {
      pieces.push({ k: "raw", v: "&" })
      i++
      expectNode = true
      continue
    }
    if (line.startsWith(":::", i) && !expectNode) {
      const cls = /^:::[\w\p{L}-]+/u.exec(line.slice(i))
      if (!cls) return null
      pieces.push({ k: "cls", v: cls[0].slice(3) })
      i += cls[0].length
      continue
    }
    if ((c === "[" || c === "(" || c === "{") && !expectNode) {
      const end = readBracket(i)
      if (end < 0) return null
      pieces.push({ k: "raw", v: line.slice(i, end) })
      i = end
      continue
    }
    if (expectNode) {
      const ascii = /^[A-Za-z_][\w-]*/.exec(line.slice(i))
      if (ascii) {
        pieces.push({ k: "raw", v: ascii[0] })
        i += ascii[0].length
        expectNode = false
        continue
      }
      const uni = /^[^\s&|<>=()[\]{}"'`~.,-]+/u.exec(line.slice(i))
      if (uni && /[^\x00-\x7F]/.test(uni[0])) {
        pieces.push({ k: "node", v: uni[0] })
        i += uni[0].length
        expectNode = false
        continue
      }
    }
    return null
  }
  return { pieces, arrows }
}

/**
 * flowchart 归一化：两遍扫描——收集节点/子图/样式类名的 Unicode 标识映射，再改写发射；
 * 随后做「标签区外不得残留 Unicode」保守扫描（classDef 中文类名等改写不了的场景走降级）。
 * 返回 null = 含怪写法或无法安全改写，整图降级。
 */
function normalizeFlowchart(src: string): { src: string; arrows: number; nodeIds: string[] } | null {
  const lines = src.split(/\r?\n/)
  const idMap = new Map<string, string>()
  const nodeIds: string[] = []
  let nextId = 0
  const mapped = (token: string): string => {
    let id = idMap.get(token)
    if (!id) {
      id = `m${nextId++}`
      idMap.set(token, id)
    }
    return id
  }
  const isStructural = (line: string): boolean =>
    /^\s*(%%|flowchart\b|graph\b|direction\b|end\b|classDef\b|class\b|style\b|linkStyle\b|click\b|accTitle\b|accDescr\b)/.test(
      line,
    )

  // 第一遍：节点/子图行建映射；结构行仅登记 class/classDef 行的样式类名（含 :::中文 简写共用一张表）
  const scans: (FlowLine | null)[] = []
  for (const line of lines) {
    if (isStructural(line)) {
      scans.push(null)
      const cm = /^\s*class\s+(.+?)\s+(\S+)\s*$/.exec(line)
      if (cm && /[^\x00-\x7F]/.test(cm[2]!)) mapped(cm[2]!)
      const cd = /^\s*classDef\s+(\S+)/.exec(line)
      if (cd && /[^\x00-\x7F]/.test(cd[1]!)) mapped(cd[1]!)
      continue
    }
    const sg = /^\s*subgraph\s+(.+)$/.exec(line)
    if (sg) {
      const rest = sg[1]!.trim()
      if (!/^[\w-]+(\s*\[.*\])?$/.test(rest)) {
        if (/[[\](){}]/.test(rest)) return null
        mapped(rest)
      }
      scans.push(null)
      continue
    }
    const flow = scanFlowLine(line)
    if (!flow) return null
    scans.push(flow)
    for (const p of flow.pieces) {
      if (p.k === "node") {
        mapped(p.v)
        if (!nodeIds.includes(idMap.get(p.v)!)) nodeIds.push(idMap.get(p.v)!)
      }
      if (p.k === "cls" && /[^\x00-\x7F]/.test(p.v)) mapped(p.v)
    }
  }

  // 第二遍：发射。节点位裸 Unicode 标识 → mN[原文]（紧随方括号组时只换 ID）；class/style 行查表改写。
  const out: string[] = []
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!
    const flow = scans[li]
    if (flow) {
      let text = ""
      for (let pi = 0; pi < flow.pieces.length; pi++) {
        const p = flow.pieces[pi]!
        if (p.k === "node") {
          const id = mapped(p.v)
          let next = flow.pieces[pi + 1]
          let ni = pi + 1
          while (next && next.k === "raw" && next.v.trim() === "") {
            ni++
            next = flow.pieces[ni]
          }
          text += next && next.k === "raw" && /^[[({]/.test(next.v.trimStart()) ? id : `${id}[${p.v}]`
          continue
        }
        if (p.k === "cls") {
          text += `:::${/[^\x00-\x7F]/.test(p.v) ? mapped(p.v) : p.v}`
          continue
        }
        text += p.v
      }
      out.push(text)
      continue
    }
    if (!isStructural(line)) {
      const sg = /^\s*subgraph\s+(.+)$/.exec(line)
      if (sg) {
        const rest = sg[1]!.trim()
        out.push(/^[\w-]+(\s*\[.*\])?$/.test(rest) ? line : `subgraph ${mapped(rest)}[${rest}]`)
        continue
      }
      out.push(line)
      continue
    }
    // accTitle/accDescr 不进 PNG，直接丢弃（其文本常为中文，保留会误触发残留扫描）
    if (/^\s*acc(Title|Descr)\b/i.test(line)) continue
    const clsLine = /^\s*class\s+(.+?)\s+(\S+)\s*$/.exec(line)
    if (clsLine) {
      out.push(
        `${line.slice(0, line.length - clsLine[0].trimStart().length)}${clsLine[1]!
          .split(",")
          .map((t) => {
            const tok = t.trim()
            return idMap.get(tok) ? t.replace(tok, idMap.get(tok)!) : t
          })
          .join(",")} ${/[^\x00-\x7F]/.test(clsLine[2]!) ? mapped(clsLine[2]!) : clsLine[2]!}`,
      )
      continue
    }
    const cdLine = /^\s*classDef\s+(\S+)(\s+.*)?$/.exec(line)
    if (cdLine) {
      const name = /[^\x00-\x7F]/.test(cdLine[1]!) ? mapped(cdLine[1]!) : cdLine[1]!
      out.push(`classDef ${name}${cdLine[2] ?? ""}`)
      continue
    }
    const styleLine = /^\s*style\s+(\S+)(\s+.*)$/.exec(line)
    if (styleLine) {
      out.push(`style ${idMap.get(styleLine[1]!) ?? styleLine[1]!}${styleLine[2]}`)
      continue
    }
    out.push(line)
  }
  const rewritten = out.join("\n")
  // 保守扫描：剥去注释行、引号串、方括号/圆括号/花括号组与 |标签| 后不得残留 Unicode
  const stripped = rewritten
    .split(/\r?\n/)
    .filter((l) => !/^\s*%%/.test(l))
    .map((l) =>
      l
        .replace(/"[^"]*"/g, "")
        .replace(/'[^']*'/g, "")
        .replace(/\[[^\]]*\]/g, "")
        .replace(/\([^)]*\)/g, "")
        .replace(/\{[^}]*\}/g, "")
        .replace(/\|[^|]*\|/g, ""),
    )
    .join("\n")
  if (/[^\x00-\x7F]/.test(stripped)) return null
  return { src: rewritten, arrows: scans.reduce((a, f) => a + (f?.arrows ?? 0), 0), nodeIds }
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
          // PNG IHDR 宽高在 offset 16/20：固定宽 500、高按实际比例（替换旧写死 500×300）
          const width = 500
          const height = Math.max(1, Math.round((width * png.readUInt32BE(20)) / png.readUInt32BE(16)))
          children.push(
            new Paragraph({
              children: [new ImageRun({ data: png, transformation: { width, height }, type: "png" })],
              spacing: { before: 120, after: 120 },
            }),
          )
          continue
        }
        // 降级：未知图型/渲染失败，输出源码 + 提示
        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: "[流程图暂不支持渲染，以下为源码]", italics: true, color: "999999" }),
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
      "在 reqdoc_assemble 生成 PRD（写入 07_需求规格产出）后即可调用，**未定稿也能导出**——产物里没定的内容会标着「暂未获得」，可直接拿去线下讨论。" +
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
            // 对抗 H2：draft（未经业务确认）与 confirmed 同列会让人误贴——逐项标注。
            const pending = s.status === "confirmed" ? "" : "（待业务确认）"
            lines.push(`### ${a}（${d.added.includes(a) ? "新增" : "改写"}）${pending}`, s.content, "")
          }
          if (d.removed.length) {
            lines.push("## 已移除（retired / 消失）")
            for (const a of d.removed) lines.push(`- ${a}`)
            lines.push("")
          }
        } else {
          // 对抗 H1：整章导出曾原样打印 retired 内容——用户会把已删内容贴回原稿。
          const inCh = kb.slots.filter((s) => chapterOf(s.address) === target && s.status !== "retired")
          const removedInCh = kb.slots.filter((s) => chapterOf(s.address) === target && s.status === "retired")
          lines.push(`# 定点修订 · 第${target}章《${title}》整章导出`, "")
          lines.push(
            `> ⚠ 单向提醒：贴回原稿后系统不回读；原稿节映射：本导出对应 PRD 第${target}章《${title}》，` +
              "若你原稿该部分标题不同请按内容自行对应到原稿相应节。",
          )
          lines.push("")
          for (const s of inCh) {
            const pending = s.status === "confirmed" ? "" : "（待业务确认）"
            lines.push(`### ${s.address}${pending}`, s.content, "")
          }
          if (removedInCh.length) {
            lines.push("## 已移除（retired，不贴回）")
            for (const s of removedInCh) lines.push(`- ${s.address}`)
            lines.push("")
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
          `⚠ 请按业务场景转述：有外部原稿、需把内容贴回的——① 贴回后系统不回读（单向）② 跨章影响见导出内「跨章影响」节 ` +
          `③ 原稿节映射见导出顶部；无外部原稿（纯对话产出）的——不必贴回，直接用重组装后的 07 产物/Word 交付，本文件仅作改动清单。`
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
