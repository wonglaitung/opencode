/**
 * reqdoc 规约初评工具（基于初稿完善入口，质量飞轮补充；设计文档 workflow-reqdoc.md 4 章 reqdoc-r32）。
 * reqdoc_review_conventions —— 对 00_初稿需求书/ 下导入的初稿，按 7 份机构规约逐条点评（满足/缺失/矛盾），
 * 并标注每条缺失项的三类补全路径（AI 修 / 人工补材料 / 对话补），引导人机协同补全。结构化初评，不替业务快进。
 * reqdoc_import 在导入初稿后复用本文件的 REQDOC_CONVENTION_REVIEW_PROMPT 直接产出初评，故两工具同源。
 */
import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { projectRoot, resolveWithinWorktree } from "../fs-safe"

const z = tool.schema

/** 规约初评指南（模型据此对初稿产出结构化初评；与 reqdoc_import 共用，避免两份漂移）。 */
export const REQDOC_CONVENTION_REVIEW_PROMPT = `请按以下 7 份机构规约，对刚导入的初稿逐条点评，每条给出「满足 / 缺失 / 矛盾」结论并引用初稿具体段落：
1. 范围与边界：需求范围与边界是否清晰，是否点明「不在范围内」的内容。
2. 术语与命名：关键术语是否定义、是否引用制度/行内原文（而非自造表述）。
3. 状态与生命周期：关键业务对象的状态与生命周期是否定义（如待处理/已处理/已撤销）。
4. 异常分类：业务异常 / 系统异常 / 边界异常三类是否覆盖（网络超时、操作失败、并发重复提交、逆向撤销驳回等）。
5. 非功能量化：性能与容量、可用性与可靠性、安全与信创、数据主权与合规是否给出量化指标。
6. 系统现状与能力：外部系统对接方式、数据来源系统/字段是否逐功能点说明（对应模板 2.11 接口与数据源）。
7. 可验证性与验收：验收标准是否可测、可量化（功能点验收指标 + 量化验收口径）。

对每条「缺失 / 矛盾」，须标注补全路径（三选一）：
- AI 修：结构/术语类（术语未引原文、章节错序、命名不规范）→ 由 AI 直接改，不需业务额外提供。
- 人工补材料：依赖外部依据（制度原文、系统接口、敏感字段清单、现有系统能力）→ 请业务投放 03_制度与合规 / 04_角色与权限 / 05_系统现状与能力 对应目录后调 reqdoc_scan 提取。
- 对话补：仅业务知晓（真实异常实例、量化指标、权限边界）→ 走 edge 阶段探针追问（A/B/C +【默认推荐项】，≤3 轮）。

输出格式（建议 Markdown 表格）：| 规约 | 结论 | 引用段落 | 建议补全路径 |。初评是诊断，不改写初稿本身；待业务确认后逐阶段走工作流补全。`

export function createReqdocConventionReviewTool(): Record<string, ToolDefinition> {
  const reqdoc_review_conventions = tool({
    description:
      "reqdoc 规约初评：对 00_初稿需求书/ 下已导入的初稿，按 7 份机构规约逐条点评（满足/缺失/矛盾）并标注每条缺失项的三类补全路径（AI 修/人工补材料/对话补）。" +
      "须在 reqdoc_import 导入初稿后调用；产出的是结构化诊断，引导人机协同补全，不替业务快进。仅 reqdoc 工作流有效。",
    args: {},
    async execute(_args, context) {
      const dir = resolveWithinWorktree(projectRoot(context), "00_初稿需求书")
      if (!existsSync(dir)) {
        return "尚未导入初稿：请把初稿放进 00_初稿需求书/ 目录后调用 reqdoc_import(path) 导入，再调用本工具做规约初评。"
      }
      const files = (await readdir(dir)).filter((n) => !n.startsWith(".")).sort()
      if (files.length === 0) {
        return "00_初稿需求书/ 目录为空，未找到可初评的初稿。请先 reqdoc_import(path) 导入初稿文件。"
      }
      const paths = files.map((f) => join(dir, f)).join("、")
      return (
        `${REQDOC_CONVENTION_REVIEW_PROMPT}\n\n` +
        `初稿文件（请先阅读，再按上表输出逐规约结构化初评）：${paths}`
      )
    },
  })

  return { reqdoc_review_conventions }
}
