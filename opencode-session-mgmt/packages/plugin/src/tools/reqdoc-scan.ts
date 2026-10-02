/**
 * reqdoc 文档扫描工具（设计文档 workflow-reqdoc.md 3 章、8 章）。
 * reqdoc_scan —— 按目录扫描需求资料并提取文本（单目录参数，AI 分阶段调用）：
 *   goal→01_背景与目标、rules→02_流程与数据、edge→03_制度与合规/04_角色与权限（可选 05_系统现状与能力）、prd→07_需求规格产出。
 * 解析范围：docx（jszip 解 document.xml）、pdf（pdfjs 文本层）、xlsx（exceljs）、
 * txt/md/json/csv 等纯文本。图像/未知格式显式降级——qwen3.6 无多模态，杜绝 AI 空承诺看图。
 */
import { readdir, stat } from "node:fs/promises"
import { basename, extname, join } from "node:path"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import JSZip from "jszip"
import ExcelJS from "exceljs"
import { resolveWithinWorktree, projectRoot } from "../fs-safe"
import { REQDOC_DIRS } from "./reqdoc-dirs"

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
  // pdfjs-dist 的 pdf.mjs 初始化会执行 new DOMMatrix()，而 opencode 插件运行时
  // 可能没有 DOMMatrix（canvas polyfill 依赖 @napi-rs/canvas 原生绑定），
  // 静态 import 会导致整个插件加载失败。故改为动态 import，仅扫 PDF 时才加载。
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
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

/** 单个文件的提取结果：成功文本或降级说明（reqdoc_import 复用）。 */
export async function extractFile(file: string): Promise<string> {
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

/**
 * 记忆匹配的证据文本 = **业务投放的材料原文**（00~05），不是模型转述的槽位正文。
 *
 * 为什么换源（对抗审查 I-1，方案 C）：原实现拿 `kb.slots` 正文喂 `matchMemory`，
 * 而正文是模型写的——模型写一句「本需求与 CCB 系统无关」就能让 CCB 命中 L1，
 * 进而消掉一个本该问业务的问题（否定句也命中；证据源可被书写即自证面平移）。
 * 换成材料原文后，材料里没有的词，模型怎么写都命中不了。
 *
 * **必须排除 06/07**：07 里是组装出来的 PRD，正由槽位正文生成，
 * 拿它当证据等于把自证面挪回原位；06 是 AI 工作区，同理。
 *
 * 代价（已确认）：`[问答]`/`[缺省]` 来源的槽位不再参与记忆匹配——
 * 记忆只服务「材料驱动」场景。状态栏同步走 `kb.evidence` 快照，避免两处口径不一。
 */
const MATERIAL_EVIDENCE_DIRS = REQDOC_DIRS.filter((d) => !d.startsWith("06_") && !d.startsWith("07_"))

/** 证据总量上限（与 scan 的单次预算同量级，防止多目录累加爆上下文/状态体积）。 */
const MAX_EVIDENCE_CHARS = 40_000

/** root → { 指纹, 文本 }。材料在两次调用之间被业务替换时指纹变化即重读。 */
const EVIDENCE_CACHE = new Map<string, { sig: string; text: string }>()

/** 材料目录内全部文件的 `名:mtime:size` 指纹——用它判断缓存是否过期。 */
async function evidenceSignature(root: string): Promise<string> {
  const parts: string[] = []
  for (const dir of MATERIAL_EVIDENCE_DIRS) {
    let names: string[]
    try {
      names = await readdir(join(root, dir))
    } catch {
      continue
    }
    for (const name of names.filter((n) => !n.startsWith(".")).sort()) {
      try {
        const st = await stat(resolveWithinWorktree(root, join(dir, name)))
        parts.push(`${dir}/${name}:${st.mtimeMs}:${st.size}`)
      } catch {
        parts.push(`${dir}/${name}:gone`)
      }
    }
  }
  return parts.join("|")
}

export async function materialEvidence(root: string): Promise<string> {
  const sig = await evidenceSignature(root)
  const cached = EVIDENCE_CACHE.get(root)
  if (cached && cached.sig === sig) return cached.text
  const parts: string[] = []
  let total = 0
  outer: for (const dir of MATERIAL_EVIDENCE_DIRS) {
    let names: string[]
    try {
      names = await readdir(join(root, dir))
    } catch {
      continue
    }
    for (const name of names.filter((n) => !n.startsWith(".")).sort()) {
      const text = await extractFile(resolveWithinWorktree(root, join(dir, name)))
      parts.push(text)
      total += text.length
      if (total >= MAX_EVIDENCE_CHARS) break outer
    }
  }
  const text = parts.join("\n")
  EVIDENCE_CACHE.set(root, { sig, text })
  return text
}

export function createReqdocScanTool(): Record<string, ToolDefinition> {
  const reqdoc_scan = tool({
    description:
      "reqdoc 需求资料扫描：列出指定需求资料目录下的文件，解析并提取文本内容供分析。" +
      "单目录参数，按阶段分步调用：goal→01_背景与目标、rules→02_流程与数据、" +
      "edge→03_制度与合规 与 04_角色与权限（可选 05_系统现状与能力）、prd→07_需求规格产出（检查已有产出）。" +
      "支持 docx/pdf/xlsx/txt/md/json/csv 等文本类；图像与不支持格式会明确提示降级，请让业务补文字说明。",
    args: {
      directory: z
        .string()
        .describe(
          "需求资料目录名（01_背景与目标 / 03_制度与合规 / 02_流程与数据 / 04_角色与权限 / 07_需求规格产出 / 05_系统现状与能力（可选））",
        ),
    },
    async execute(args, context) {
      const dir = resolveWithinWorktree(projectRoot(context), args.directory)
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        throw new Error(`目录 ${args.directory} 不存在或不可读，请先确认业务已创建该目录（可调用 reqdoc_init 搭建 00~07 骨架，见 reqdoc-r8 目录就绪检查）`)
      }
      const files = names.filter((n) => !n.startsWith(".")).sort()
      if (files.length === 0) {
        return `目录 ${args.directory} 为空，未扫描到任何资料。可引导业务补充材料（放入 01~05 对应目录）后重新调用 reqdoc_scan 扫描，或直接通过对话收集。`
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
