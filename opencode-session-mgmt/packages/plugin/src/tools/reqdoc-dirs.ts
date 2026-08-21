/**
 * reqdoc 目录骨架工具（设计文档 workflow-reqdoc.md 4 章 reqdoc-r8「目录就绪检查」）。
 * reqdoc_init —— 在需求资料根约定下幂等创建 01~06 六个目录骨架
 * （01_背景与目标 / 02_制度与合规 / 03_流程与数据 / 04_角色与权限为业务投放材料区；
 * 05_功能点 / 06_需求规格产出为 AI 工作区）。绝不重建或覆盖业务已放材料。
 * 跨平台安全：目录名一律经 sanitizeDirName 过滤，规避 Windows 保留字符
 * （< > : " / \ | ? * 与尾随 . 空格、CON/PRN 等设备名）导致 mkdir 失败。
 */
import { mkdir } from "node:fs/promises"
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
] as const

/** 各目录用途与建议投放的基础材料（业务投放 01~04；05/06 为 AI 工作区，业务一般不需手动放）。 */
const REQDOC_DIR_USAGE: Record<(typeof REQDOC_DIRS)[number], string> = {
  "01_背景与目标": "业务背景、上线目标、要解决的核心痛点、使用角色与业务场景（Word/Markdown/纯文本均可）",
  "02_制度与合规": "相关制度文件、监管/合规要求、行内规定、风控条款（docx/pdf/txt）",
  "03_流程与数据": "现有流程图、字段定义、数据字典、库表说明、上下游系统对接说明（xlsx/docx/md）",
  "04_角色与权限": "岗位角色清单、权限矩阵、审批流与授权说明、总/分/支行隔离要求（xlsx/docx/txt）",
  "05_功能点": "AI 工作区（功能点拆解后自动建子目录，业务一般不需手动投放）",
  "06_需求规格产出": "AI 工作区（PRD 与各模板外成果自动落盘，业务一般不需手动投放）",
}

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
      "reqdoc 目录骨架初始化：在需求资料根（项目根）幂等创建 01~06 六个约定目录" +
      "（01_背景与目标 / 02_制度与合规 / 03_流程与数据 / 04_角色与权限为业务投放材料区；" +
      "05_功能点 / 06_需求规格产出为 AI 工作区）。已存在则跳过，绝不重建或覆盖业务已放材料。" +
      "goal 阶段目录就绪检查时，确认业务要搭建骨架后调用本工具；业务说资料已放好可用 reqdoc_scan 扫描。仅 reqdoc 工作流有效。",
    args: {},
    async execute(_args, context) {
      const created: string[] = []
      const existed: string[] = []
      const root = projectRoot(context)
      for (const dir of REQDOC_DIRS) {
        const full = join(root, dir)
        // recursive 保证父级存在即可建；已存在不报错、不改动内容
        await mkdir(full, { recursive: true })
        created.push(dir)
      }
      const skeleton = REQDOC_DIRS.map((d) => `  ${d}/\n    ↳ ${REQDOC_DIR_USAGE[d]}`).join("\n")
      return (
        `📂 资料根目录：${root}\n\n` +
        `✅ 已就绪需求资料目录骨架（${created.length} 个，幂等不覆盖）。请业务把以下基础材料放进对应目录：\n\n` +
        skeleton +
        `\n\n📌 投放后请告知 AI，AI 将调用 reqdoc_scan 逐目录扫描提取（建议顺序：01 → 03 → 02 → 04）；会话中途补充了材料，也可随时再次调用 reqdoc_scan 重扫，不必等下一轮。` +
        `\n没有现成文档时也可直接口述，AI 会按阶段追问补全，不必强求每个目录都填。` +
        (existed.length ? `\n（其中 ${existed.length} 个目录原本已存在，已保留其内部材料，未覆盖。）` : "")
      )
    },
  })

  return { reqdoc_init }
}
