/**
 * reqdoc 目录骨架工具（设计文档 workflow-reqdoc.md 4 章 reqdoc-r8「目录就绪检查」）。
 * reqdoc_init —— 在需求资料根约定下幂等创建 01~07 七个目录骨架（07_系统现状与能力 为可选目录，单位技术侧投放系统架构/现有能力/接口/数据模型，未投放则走对话确认）
 * （01_背景与目标 / 02_制度与合规 / 03_流程与数据 / 04_角色与权限为业务投放材料区；
 * 05_功能点 / 06_需求规格产出为 AI 工作区；07_系统现状与能力 为可选目录，单位技术侧投放系统架构/现有能力/接口/数据模型）。绝不重建或覆盖业务已放材料。
 * 跨平台安全：目录名一律经 sanitizeDirName 过滤，规避 Windows 保留字符
 * （< > : " / \ | ? * 与尾随 . 空格、CON/PRN 等设备名）导致 mkdir 失败。
 */
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { projectRoot } from "../fs-safe"

const z = tool.schema

/** reqdoc 需求资料目录骨架（根下六目录，契约见 reqdoc-r8）。 */
export const REQDOC_DIRS = [
  "01_背景与目标",
  "02_制度与合规",
  "03_流程与数据",
  "04_角色与权限",
  "05_功能点",
  "06_需求规格产出",
  "07_系统现状与能力",
] as const

/** 各目录用途与建议投放的基础材料（业务投放 01~04；05/06 为 AI 工作区，业务一般不需手动放）。 */
const REQDOC_DIR_USAGE: Record<(typeof REQDOC_DIRS)[number], string> = {
  "01_背景与目标": "业务背景、上线目标、要解决的核心痛点、使用角色与业务场景（Word/Markdown/纯文本均可）",
  "02_制度与合规": "相关制度文件、监管/合规要求、行内规定、风控条款（docx/pdf/txt）",
  "03_流程与数据": "现有流程图、字段定义、数据字典、库表说明、上下游系统对接说明（xlsx/docx/md）",
  "04_角色与权限": "岗位角色清单、权限矩阵、审批流与授权说明、总/分/支行隔离要求（xlsx/docx/txt）",
  "05_功能点": "AI 工作区（功能点拆解后自动建子目录，业务一般不需手动投放）",
  "06_需求规格产出": "AI 工作区（PRD 与各模板外成果自动落盘，业务一般不需手动投放）",
  "07_系统现状与能力": "单位技术侧投放系统架构/现有能力/对外接口/数据模型；可选，AI 在 edge 阶段调 reqdoc_scan 拉取作为 PRD 撰写依据，未投放则走对话确认（缺口标 [缺省]）",
}

/** 单个目录的 README 说明（脚手架元数据，幂等写入、已存在则跳过，绝不覆盖业务补充）。 */
function dirReadme(dir: string, usage: string): string {
  let hint: string
  if (dir.startsWith("07_")) {
    hint = "本目录为可选目录：由单位技术侧投放系统架构 / 现有能力 / 对外接口 / 数据模型材料；AI 会在 edge 阶段调 reqdoc_scan 拉取作为 PRD 撰写依据。未投放则走对话确认，缺口在 PRD 标 [缺省]。"
  } else if (Number(dir.slice(0, 2)) <= 4) {
    hint = "请把对应材料（Word/PDF/Excel/Markdown/纯文本均可）放进本目录，投放后告知 AI 调用 reqdoc_scan 扫描提取。"
  } else {
    hint = "本目录为 AI 工作区，由工具自动落盘（功能点拆解 / PRD 渲染），业务一般不需手动投放。"
  }
  return `# ${dir}\n\n${usage}\n\n${hint}\n\n> 本说明由 reqdoc 目录骨架初始化自动生成；你可在此基础上补充更具体的投放指引，不会被覆盖。\n`
}

/** 资料根目录总览 README（独立文件名，避免覆盖业务自有 README.md）。 */
const ROOT_README = `# 需求资料目录说明（reqdoc 骨架）

本目录为 reqdoc 需求资料工作区根。请按以下约定投放材料：

${REQDOC_DIRS.map((d) => `- **${d}**：${REQDOC_DIR_USAGE[d]}`).join("\n")}

  - 01~04 为业务投放材料区；05_功能点、06_需求规格产出 为 AI 工作区；07_系统现状与能力 为可选目录，由单位技术侧投放系统架构/现有能力/接口/数据模型，未投放则走对话确认。
- 投放后告知 AI，AI 调用 reqdoc_scan 逐目录扫描提取（建议顺序 01 → 03 → 02 → 04）；也可全程口述，AI 按阶段追问补全。
- 各目录内已附 README.md 说明，可直接打开查看。
`

/**
 * 跨平台目录名净化：过滤 Windows/文件系统非法字符（< > : " / \ | ? *）、
 * 控制字符与尾随 . 空格，并把 Windows 设备名（CON/PRN/AUX/NUL/COM1/LPT1…）加后缀，
 * 避免 mkdir 在 Windows 抛 ENOENT/EINVAL。空名兜底为下划线。纯函数，便于测试。
 */
export function sanitizeDirName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/, "")
    .trim()
  if (cleaned === "") return "_"
  const device = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(cleaned)
  return device ? `${cleaned}_` : cleaned
}

export function createReqdocInitTool(): Record<string, ToolDefinition> {
  const reqdoc_init = tool({
    description:
      "reqdoc 目录骨架初始化：在需求资料根（项目根）幂等创建 01~07 七个约定目录" +
      "（01_背景与目标 / 02_制度与合规 / 03_流程与数据 / 04_角色与权限为业务投放材料区；" +
      "05_功能点 / 06_需求规格产出为 AI 工作区；07_系统现状与能力 为可选目录，单位技术侧投放系统架构/现有能力/接口/数据模型）。已存在则跳过，绝不重建或覆盖业务已放材料。" +
      "goal 阶段目录就绪检查时，确认业务要搭建骨架后调用本工具；业务说资料已放好可用 reqdoc_scan 扫描。仅 reqdoc 工作流有效。" +
      "调用本工具后，必须把返回的目录绝对路径逐行粘贴到你的回复正文里（不要只写「见工具返回/见上方」——业务可能看不到工具记录），再附「① 投放材料 / ② 直接口述」二选一并停下等待其明确选择，不得直接进入追问或先问其它问题。",
    args: {},
    async execute(_args, context) {
      const created: string[] = []
      const existed: string[] = []
      const root = projectRoot(context)
      for (const dir of REQDOC_DIRS) {
        const full = join(root, dir)
        const dirExisted = existsSync(full)
        // recursive 保证父级存在即可建；已存在不报错、不改动内容
        await mkdir(full, { recursive: true })
        if (dirExisted) existed.push(dir)
        else created.push(dir)
        // 幂等写入目录说明：仅当 README 不存在时写，绝不覆盖业务已补充的内容
        const readmePath = join(full, "README.md")
        if (!existsSync(readmePath)) {
          await writeFile(readmePath, dirReadme(dir, REQDOC_DIR_USAGE[dir]), "utf8")
        }
      }
      // 根目录总览（独立文件名，避免覆盖业务自有 README.md）
      const rootReadmePath = join(root, "需求资料目录说明.md")
      if (!existsSync(rootReadmePath)) {
        await writeFile(rootReadmePath, ROOT_README, "utf8")
      }
      const materialDirs = REQDOC_DIRS.filter((d) => Number(d.slice(0, 2)) <= 4)
      const list = materialDirs
        .map((d) => `  📁 ${join(root, d)}\n      ↳ ${REQDOC_DIR_USAGE[d]}`)
        .join("\n")
      const nextStep =
        `\n\n👉 下一步（投放多少算多少，不强制一次备齐）：\n` +
        `  ① 投放材料：把你能提供的文件放进上方 01~04 对应目录（已附 README 说明），有多少投多少；放好后告诉我，我对这些目录调 reqdoc_scan 逐目录扫描提取（建议顺序 01 → 03 → 02 → 04），没投放的目录我们口述补全。\n` +
        `  ② 先口述：说「直接口述」，我从痛点聊起按阶段追问补全（全程 [问答] 来源，定稿时需你确认「无书面材料」）。`
      return (
        `📂 资料根目录：${root}\n\n` +
        `✅ 已就绪需求资料目录骨架（${created.length} 个，幂等不覆盖），并已为每个目录写入 README.md 使用说明（根目录另附「需求资料目录说明.md」总览）。\n\n` +
        `请把以下基础材料放进对应目录（绝对路径如下，直接打开即可投放；05_功能点 / 06_需求规格产出 为 AI 工作区，业务一般不需手动放）：\n\n` +
        list +
        nextStep +
        `\n\n你手头有哪些材料？放进对应目录后告诉我（我扫描提取），或说「先口述」我们从痛点聊起？` +
        (existed.length ? `\n（其中 ${existed.length} 个目录原本已存在，已保留其内部材料与 README.md，未覆盖。）` : "")
      )
    },
  })

  return { reqdoc_init }
}
