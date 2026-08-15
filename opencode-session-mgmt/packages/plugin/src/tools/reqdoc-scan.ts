/**
 * reqdoc 文档扫描工具（设计文档 workflow-reqdoc.md 3 章、8 章）。
 * reqdoc_scan —— 按目录扫描需求资料并提取文本（单目录参数，AI 分阶段调用）：
 *   goal→01_背景与目标、rules→03_流程与数据、edge→02_制度与合规/04_角色与权限、prd→06_需求规格产出。
 * 解析范围：docx（jszip 解 document.xml）、pdf（pdfjs 文本层）、xlsx（exceljs）、
 * txt/md/json/csv 等纯文本。图像/未知格式显式降级——qwen3.6 无多模态，杜绝 AI 空承诺看图。
 */
import { readdir } from "node:fs/promises"
import { basename, extname, join } from "node:path"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import JSZip from "jszip"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import ExcelJS from "exceljs"

const z = tool.schema

/** 纯文本扩展名：直接读内容。 */
const TEXT_EXTS = new Set([".txt", ".md", ".json", ".csv", ".log", ".yaml", ".yml"])

/** 每个文件提取的字符上限（防超大文档爆上下文）。 */
const MAX_CHARS_PER_FILE = 8_000

/** 每次扫描返回的汇总字符上限（防多文件超注入预算）。 */
const MAX_TOTAL_CHARS = 24_000

async function readTextFile(file: string): Promise<string> {
  return (await Bun.file(file).text()).slice(0, MAX_CHARS_PER_FILE)
}

async function readDocx(file: string): Promise<string> {
  const buf = await Bun.file(file).arrayBuffer()
  const zip = await JSZip.loadAsync(buf)
  const doc = zip.file("word/document.xml")
  if (!doc) return ""
  const xml = await doc.async("text")
  return xml
    .replace(/<w:p[^>]*>/g, "\n")
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, MAX_CHARS_PER_FILE)
}

async function readPdf(file: string): Promise<string> {
  const data = new Uint8Array(await Bun.file(file).arrayBuffer())
  const pdf = await pdfjs.getDocument({ data }).promise
  let text = ""
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    text += content.items.map((it) => ("str" in it ? it.str : "")).join(" ")
    text += "\n"
    if (text.length >= MAX_CHARS_PER_FILE) break
  }
  return text.trim().slice(0, MAX_CHARS_PER_FILE)
}

async function readXlsx(file: string): Promise<string> {
  const wb = new ExcelJS.Workbook()
  const buf = new Uint8Array(await Bun.file(file).arrayBuffer())
  await wb.xlsx.load(buf as never)
  const rows: string[] = []
  for (const ws of wb.worksheets) {
    rows.push(`[工作表 ${ws.name}]`)
    ws.eachRow({ includeEmpty: false }, (row) => {
      rows.push((row.values as unknown[]).slice(1).join(" | "))
    })
    if (rows.join("\n").length >= MAX_CHARS_PER_FILE) break
  }
  return rows.join("\n").slice(0, MAX_CHARS_PER_FILE)
}

/** 单个文件的提取结果：成功文本或降级说明。 */
async function extractFile(file: string): Promise<string> {
  const ext = extname(file).toLowerCase()
  if (TEXT_EXTS.has(ext)) return readTextFile(file)
  if (ext === ".docx") return readDocx(file)
  if (ext === ".pdf") return readPdf(file)
  if (ext === ".xlsx") return readXlsx(file)
  // 图像（jpg/png/扫描件）与不支持格式：qwen3.6 无多模态，显式降级而非假装读图。
  if (ext === ".jpg" || ext === ".jpeg" || ext === ".png" || ext === ".bmp" || ext === ".gif" || ext === ".tif" || ext === ".tiff") {
    return `[图像 ${basename(file)} 无法解析：当前模型不支持读图。请业务用文字描述其内容，或提供含文字的文本版/Word 版。]`
  }
  return `[文件 ${basename(file)} 格式 ${ext || "未知"} 暂不支持解析，请业务提供文本版或说明内容。]`
}

export function createReqdocScanTool(): Record<string, ToolDefinition> {
  const reqdoc_scan = tool({
    description:
      "reqdoc 需求资料扫描：列出指定需求资料目录下的文件，解析并提取文本内容供分析。" +
      "单目录参数，按阶段分步调用：goal→01_背景与目标、rules→03_流程与数据、" +
      "edge→02_制度与合规 与 04_角色与权限、prd→06_需求规格产出（检查已有产出）。" +
      "支持 docx/pdf/xlsx/txt/md/json/csv 等文本类；图像与不支持格式会明确提示降级，请让业务补文字说明。",
    args: {
      directory: z
        .string()
        .describe(
          "需求资料目录名（01_背景与目标 / 02_制度与合规 / 03_流程与数据 / 04_角色与权限 / 06_需求规格产出）",
        ),
    },
    async execute(args, context) {
      const dir = join(context.worktree, args.directory)
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        throw new Error(`目录 ${args.directory} 不存在或不可读，请先确认业务已创建该目录（reqdoc-r8 目录就绪检查）`)
      }
      const files = names.filter((n) => !n.startsWith(".")).sort()
      if (files.length === 0) {
        return `目录 ${args.directory} 为空，未扫描到任何资料。可引导业务补充材料，或直接通过对话收集。`
      }
      const parts: string[] = [`📂 ${args.directory}（${files.length} 个文件）`]
      let total = 0
      for (const name of files) {
        const text = await extractFile(join(dir, name))
        total += text.length
        parts.push(`\n--- ${name} ---\n${text}`)
        if (total >= MAX_TOTAL_CHARS) {
          parts.push(`\n…已达扫描总量上限，其余文件未读取。`)
          break
        }
      }
      return parts.join("\n")
    },
  })

  return { reqdoc_scan }
}
