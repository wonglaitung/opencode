/**
 * reqdoc 初稿导入工具（基于初稿完善入口，质量飞轮补充；设计文档 workflow-reqdoc.md 4 章 reqdoc-r32）。
 * reqdoc_import —— 把业务已有的初稿需求书（文件或目录）解析为 [文档] 来源并落盘到 00_初稿需求书/，
 * 复用 reqdoc_scan 的解析器（docx/pdf/xlsx/txt/md/json/csv；图像显式降级）。导入即产出「按机构规约的初评」
 * （复用 REQDOC_CONVENTION_REVIEW_PROMPT），并停在起点等待业务看初评后再逐阶段走——不自动 approve 任何阶段、不替业务快进。
 */
import { existsSync } from "node:fs"
import { readdir, mkdir, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { projectRoot, resolveWithinWorktree } from "../fs-safe"
import { extractFile } from "./reqdoc-scan"
import { REQDOC_CONVENTION_REVIEW_PROMPT } from "./reqdoc-review-conventions"

const z = tool.schema

/** 初稿落盘目录（材料区最前，排在所有 01~ 业务投放目录之前）。 */
export const REQDOC_DRAFT_DIR = "00_初稿需求书"

export function createReqdocImportTool(): Record<string, ToolDefinition> {
  const reqdoc_import = tool({
    description:
      "reqdoc 初稿导入：把业务已有的初稿需求书（文件或目录路径）解析为 [文档] 来源，落盘到 00_初稿需求书/，" +
      "并产出「按机构规约的初评」（逐份规约列 满足/缺失/矛盾）。导入后停在起点，等待业务看初评后逐阶段走工作流补全（不自动快进）。" +
      "path 可为文件（docx/pdf/xlsx/txt/md/json/csv）或目录（递归扫描其中文件）。仅 reqdoc 工作流有效。",
    args: {
      path: z
        .string()
        .describe("初稿文件或目录路径（相对项目根，或绝对路径；须在需求资料工作区内）"),
    },
    async execute(args, context) {
      const full = resolveWithinWorktree(projectRoot(context), args.path)
      if (!existsSync(full)) {
        throw new Error(`初稿路径 ${args.path} 不存在或不可读，请确认路径（文件或目录）。`)
      }
      const isDir = (await stat(full)).isDirectory()
      let texts: string[] = []
      if (isDir) {
        const names = (await readdir(full)).filter((n) => !n.startsWith(".")).sort()
        if (names.length === 0) {
          return `目录 ${args.path} 为空，未扫描到初稿文件。请放入初稿后重调 reqdoc_import。`
        }
        for (const name of names) {
          texts.push(`\n--- ${name} ---\n${await extractFile(join(full, name))}`)
        }
      } else {
        texts.push(`\n--- ${basename(full)} ---\n${await extractFile(full)}`)
      }
      const draft = texts.join("\n").trim()
      // 落盘到 00_初稿需求书/（导入前确保目录存在，不依赖 reqdoc_init）
      const draftDir = join(projectRoot(context), REQDOC_DRAFT_DIR)
      await mkdir(draftDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)
      const outName = `初稿_${stamp}.md`
      await Bun.write(join(draftDir, outName), `# 导入初稿（${basename(full)}）\n\n> 本文件由 reqdoc_import 解析落盘，作为 PRD 渲染的 [文档] 来源；初评据此产出，不改写初稿本身。\n\n${draft}\n`)
      return (
        `📥 已导入初稿并落盘：${join(draftDir, outName)}（解析 ${draft.length} 字，作为 [文档] 来源）。\n\n` +
        `${REQDOC_CONVENTION_REVIEW_PROMPT}\n\n` +
        `初稿文件：${join(draftDir, outName)}\n请先阅读初稿，按上表输出逐规约结构化初评（满足/缺失/矛盾 + 引用段落 + 补全路径）。` +
        `初评后按三类路径补全，再逐阶段走工作流（不自动快进）。`
      )
    },
  })

  return { reqdoc_import }
}
