/**
 * reqdoc Word 导出工具（设计文档 7.5，实施方案「标准 PRD (Markdown/Word)」）。
 * reqdoc_export —— 将已渲染的 PRD Markdown（06_需求规格产出 下）转换为 Word（.docx）
 * 交付件，与源 md 同目录归档，供行方交付。仅 reqdoc 工作流使用（规则 reqdoc-r14 在
 * PRD 定稿后调用）。
 *
 * 转换覆盖模板渲染实际用到的标记：标题（#~#####）、表格（|…|）、无序列表（-）、
 * 引用（>）、代码块（```）与行内加粗（**…**）/反引号（`…`）。PRD 为文字件，
 * 图片/图表不走模板正文（模板外成果按 reqdoc-r20 单独落盘），故不解析二进制。
 */
import { basename, dirname, extname, join } from "node:path"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx"

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
    // 代码块（模板源标注用 ```…``` 包额外说明）
    if (trimmed.startsWith("```")) {
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        code.push(lines[i])
        i++
      }
      i++ // 跳过结束围栏
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
    // 无序列表（○/● 选项行也是 - 开头）
    if (/^[-*•]\s+/.test(trimmed)) {
      children.push(new Paragraph({ children: inlineRuns(trimmed.replace(/^[-*•]\s+/, "")), bullet: { level: 0 } }))
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

export function createReqdocExportTool(): Record<string, ToolDefinition> {
  const reqdoc_export = tool({
    description:
      "reqdoc Word 导出：将已渲染的 PRD Markdown 导出为 Word（.docx）交付件，与源 md 同目录归档。" +
      "在 reqdoc-r14 完成 PRD 渲染（write 到 06_需求规格产出）并定稿后调用；" +
      "source 填 PRD Markdown 相对项目根路径（如 06_需求规格产出/N_名称/xxx.md）。",
    args: {
      source: z.string().describe("PRD Markdown 相对项目根路径（06_需求规格产出/N_名称/xxx.md）"),
    },
    async execute(args, context) {
      if (extname(args.source).toLowerCase() !== ".md") {
        throw new Error("source 必须指向 .md 文件（reqdoc_export 只转换 Markdown 渲染的 PRD）")
      }
      const mdPath = join(context.worktree, args.source)
      let md: string
      try {
        md = await Bun.file(mdPath).text()
      } catch {
        throw new Error(`源文件不存在或不可读：${args.source}。请先完成 PRD 渲染（write 到 06_需求规格产出）再调用导出。`)
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
