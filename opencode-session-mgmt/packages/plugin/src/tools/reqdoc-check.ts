/**
 * reqdoc 渲染工具（质量飞轮 P2「渲染可测化」+ P1/P2 服务端骨架与增量填充，设计文档 workflow-reqdoc.md 7 章、10 章）。
 * reqdoc_render_skeleton —— 服务端按模板逐字生成 PRD 骨架（消除模型巨型 write）。
 * reqdoc_patch          —— 按小节编号填充正文（服务端定位标题、保证编号，模型只产出内容）。
 * reqdoc_check          —— PRD 写入后对照模板结构 schema（REQDOC_TEMPLATE_CHAPTERS / REQDOC_TEMPLATE_FIELDS）
 *                          做渲染 diff 校验：章节齐全/顺序、功能点块数、映射字段来源标注。
 * 校验结果写入 workflow.render；review_submit 定稿时重读源 md 复核（柔性：不调用则放行）。仅 reqdoc 工作流有效。
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import {
  REQDOC_TEMPLATE_CHAPTERS,
  REQDOC_TEMPLATE_FIELDS,
  FEATURE_SUB_SECTIONS,
  buildPrdSkeleton,
  getDefinition,
  parseRenderStructure,
  patchSectionBody,
  renderStructureViolations,
  type ReqdocFeature,
  type ReqdocRender,
} from "sm-shared"
import type { Store } from "../db"
import { WorkflowOpError } from "../workflow-ops"
import { resolveWithinWorktree, projectRoot } from "../fs-safe"
import { loadReqdocTemplate } from "../template"

const z = tool.schema

export function createReqdocCheckTools(store: Store): Record<string, ToolDefinition> {
  const reqdoc_check = tool({
    description:
      "reqdoc 渲染校验：PRD 渲染完成并写入 07_需求规格产出 后，对照模板结构 schema 校验渲染 diff（章节齐全/顺序、功能点块数、必填字段来源标注；结构口径同 reqdoc-r23）。" +
      "source 填 PRD Markdown 相对项目根路径（如 07_需求规格产出/N_名称/xxx.md）。" +
      "校验有违规须修正后重调复查；结构合规后再 review_submit 定稿。仅 reqdoc 工作流有效。",
    args: {
      source: z.string().describe("PRD Markdown 相对项目根路径（07_需求规格产出/N_名称/xxx.md）"),
      feature: z
        .string()
        .optional()
        .describe("增量诊断（P3.7）：仅聚焦某个功能点（填功能点序号如 '1' 或 '功能点 1'），输出该块的期望 vs 实际逐项差异；缺省校验整篇"),
    },
    async execute(args, context) {
      // 仅 reqdoc + 已确认功能点数（异步文件读取在 mutateWorkflow 回调外，回调同步约束）
      let expectedFeatures = 0
      store.mutateWorkflow(context.sessionID, (workflow) => {
        const def = getDefinition(workflow.type)
        if (def.type !== "reqdoc") {
          throw new WorkflowOpError(`reqdoc_check 仅用于 reqdoc 工作流（当前为 ${def.type}）`)
        }
        expectedFeatures = workflow.features?.length ?? 0
      })
      const mdPath = resolveWithinWorktree(projectRoot(context), args.source)
      let md: string
      try {
        md = await Bun.file(mdPath).text()
      } catch {
        throw new WorkflowOpError(`源文件不存在或不可读：${args.source}。请先完成 PRD 渲染（write 到 07_需求规格产出）再调用校验。`)
      }
      const structure = parseRenderStructure(md)
      const render: ReqdocRender = {
        ...structure,
        source: args.source,
        checkedAt: Date.now(),
        expectedFeatures,
      }
      const violations = renderStructureViolations(render)
      // 连续失败计数（P3.9）：有违规累加，合规清零；≥3 时卡片提示人工介入 + 格式诊断
      let fails = 0
      store.mutateWorkflow(context.sessionID, (workflow) => {
        workflow.render = render
        const prev = workflow.renderCheckFails ?? 0
        fails = violations.length > 0 ? prev + 1 : 0
        workflow.renderCheckFails = fails
      })
      const focused = args.feature ? focusFeatureDiff(render, args.feature) : undefined
      return formatRenderCard(render, violations, fails, focused)
    },
  })

  const reqdoc_render_skeleton = tool({
    description:
      "reqdoc PRD 骨架生成：服务端按《业务需求说明书》模板逐字生成骨架（章节 1~7 + 第五章按已确认功能点的空块）并写入指定路径，" +
      "免去模型手写整篇骨架（避免单次输出过长被截断）。须先经 reqdoc_confirm_features 确认功能点。" +
      "生成后用 reqdoc_patch 逐小节填充内容。仅 reqdoc 工作流有效。",
    args: {
      source: z.string().describe("PRD Markdown 相对项目根路径（07_需求规格产出/N_名称/xxx.md）"),
    },
    async execute(args, context) {
      let features: ReqdocFeature[] = []
      store.mutateWorkflow(context.sessionID, (workflow) => {
        const def = getDefinition(workflow.type)
        if (def.type !== "reqdoc") {
          throw new WorkflowOpError(`reqdoc_render_skeleton 仅用于 reqdoc 工作流（当前为 ${def.type}）`)
        }
        features = workflow.features ?? []
      })
      if (features.length === 0) {
        throw new WorkflowOpError("尚无已确认功能点：请先拆解功能点清单并经业务确认后调用 reqdoc_confirm_features")
      }
      const skeleton = buildPrdSkeleton(loadReqdocTemplate(), features)
      if (skeleton === null) {
        throw new WorkflowOpError("模板不可用或功能点为空，无法生成骨架：请改用 write 按 reqdoc-r14 内联骨架写入")
      }
      const mdPath = resolveWithinWorktree(projectRoot(context), args.source)
      await Bun.write(mdPath, skeleton)
      const structure = parseRenderStructure(skeleton)
      const render: ReqdocRender = {
        ...structure,
        source: args.source,
        checkedAt: Date.now(),
        expectedFeatures: features.length,
      }
      store.mutateWorkflow(context.sessionID, (workflow) => {
        workflow.render = render
      })
      const structOk = structure.ok && structure.featureCount === features.length
      return (
        `🏗 已生成 PRD 骨架（${args.source}，${features.length} 个功能点）。\n` +
        (structOk
          ? "✓ 章节与功能点骨架齐全。"
          : `⚠ 骨架结构异常（请检查模板）：缺章节 ${structure.missing.join("、") || "无"}；缺小节 ${structure.missingSections.join("、") || "无"}；功能点块 ${structure.featureCount}/${features.length}。）`) +
        `\n下一步：用 reqdoc_patch(source="${args.source}", target=<小节编号>, content=<内容>) 逐小节填充。`
      )
    },
  })

  const reqdoc_patch = tool({
    description:
      "reqdoc PRD 小节填充：按编号把小节正文写入骨架（服务端定位标题、保留标题行，仅替换正文），模型只产出内容，编号与结构由服务端保证。" +
      "target 支持章内小节（3.1~3.6、4.1/4.2、6.1~6.4、7.1/7.2）与功能点子小节（5.k.1.1 简要概述、5.k.1.2 控制要求、5.k.2.1~5.k.2.13，k=功能点序号）。" +
      "content 为小节正文（不含标题行），逐字段标来源 [文档]/[问答]/[缺省：理由]。每次只填 1~3 个小节。仅 reqdoc 工作流有效。",
    args: {
      source: z.string().describe("PRD Markdown 相对项目根路径"),
      target: z.string().describe("小节编号（如 3.6、4.1、5.1.2.3、6.1、7.1）"),
      content: z.string().describe("小节正文（不含标题行）"),
    },
    async execute(args, context) {
      store.mutateWorkflow(context.sessionID, (workflow) => {
        const def = getDefinition(workflow.type)
        if (def.type !== "reqdoc") {
          throw new WorkflowOpError(`reqdoc_patch 仅用于 reqdoc 工作流（当前为 ${def.type}）`)
        }
      })
      const mdPath = resolveWithinWorktree(projectRoot(context), args.source)
      let md: string
      try {
        md = await Bun.file(mdPath).text()
      } catch {
        throw new WorkflowOpError(`源文件不存在或不可读：${args.source}。请先用 reqdoc_render_skeleton 生成骨架。`)
      }
      const result = patchSectionBody(md, args.target, args.content)
      if (!result.ok) throw new WorkflowOpError(result.error!)
      await Bun.write(mdPath, result.md)
      const structure = parseRenderStructure(result.md)
      const render: ReqdocRender = {
        ...structure,
        source: args.source,
        checkedAt: Date.now(),
        expectedFeatures: 0,
      }
      store.mutateWorkflow(context.sessionID, (workflow) => {
        render.expectedFeatures = workflow.features?.length ?? 0
        workflow.render = render
      })
      return `✏ 已填充小节 ${args.target}（${args.source}）。`
    },
  })

  return { reqdoc_check, reqdoc_render_skeleton, reqdoc_patch }
}

/** 增量诊断（P3.7）：把某功能点的期望子小节与实际情况逐项对比，输出缺失清单。 */
function focusFeatureDiff(render: ReqdocRender, featureArg: string): { label: string; present: string[]; missing: string[] } | string {
  const m = featureArg.match(/(\d+)/)
  if (!m) return `未解析到功能点序号：${featureArg}（请填 '1' 或 '功能点 1'）`
  const idx = parseInt(m[1], 10)
  const label = `功能点 ${idx}`
  const missing = render.missingFeatureSections
    .filter((s) => s.startsWith(`${label} 缺`))
    .map((s) => s.replace(`${label} 缺 `, ""))
  const present = FEATURE_SUB_SECTIONS.map((s) => `${s.group}.${s.sub} ${s.title}`).filter((t) => !missing.includes(t))
  return { label, present, missing }
}

/** 期望功能点块骨架（同源 renderCheckRubric，避免漂移），供 check 卡片展示"期望 vs 实际"。 */
function expectedSkeleton(): string {
  const subs = FEATURE_SUB_SECTIONS.map((s) => `${s.group}.${s.sub} ${s.title}`).join("、")
  const fields = REQDOC_TEMPLATE_FIELDS.map((f) => `${f.key} ${f.title}`).join("、")
  return (
    `期望每功能点块：${subs}；主分组标题「(2k-1). 功能点输入要素」「(2k). 功能点处理要求」（k=功能点序号，编号全局连续）为可选分组标签（可纯文本/省略），` +
    `小节层级 3~5 均可，标题须含编号+名称；映射字段须逐功能点标来源 [文档]/[问答]/[缺省]（可包全角括号，如「2.1 输入要素的检查（[问答]）」）：${fields}。`
  )
}

/** 把文档校验记录格式化为工具返回文本：章节/功能点骨架、必填字段来源覆盖、10 格进度条。 */
function formatRenderCard(
  render: ReqdocRender,
  violations: string[],
  fails: number,
  focused?: { label: string; present: string[]; missing: string[] } | string,
): string {
  const chapterOk = render.missing.length === 0 && render.outOfOrder.length === 0
  const featureOk = render.featureCount === render.expectedFeatures && render.featureOk
  const totalFields = REQDOC_TEMPLATE_FIELDS.length * render.featureCount
  const coveredCount = REQDOC_TEMPLATE_FIELDS.reduce((sum, f) => sum + (render.covered[f.key] ?? 0), 0)
  const barLen = 10
  const filled = totalFields > 0 ? Math.round((coveredCount / totalFields) * barLen) : barLen
  const bar = "▓".repeat(filled) + "░".repeat(barLen - filled)
  const chapterLine = chapterOk
    ? `章节结构 ✓ 齐全且顺序正确（${render.chaptersPresent.length}/${REQDOC_TEMPLATE_CHAPTERS.length} 章）`
    : `章节结构 ✗ ${[render.missing.map((t) => `缺 ${t}`), render.outOfOrder.map((t) => `乱序 ${t}`)].flat().join("、")}`
  const focusedBlock =
    focused === undefined
      ? ""
      : typeof focused === "string"
        ? `\n🔍 增量诊断：${focused}`
        : `\n🔍 增量诊断（${focused.label} 期望 vs 实际）：\n  期望子小节：${FEATURE_SUB_SECTIONS.map((s) => `${s.group}.${s.sub} ${s.title}`).join("、")}\n  ✓ 已具备：${focused.present.join("、") || "（无）"}\n  ✗ 缺失：${focused.missing.join("、") || "（无）"}`
  const iterateNote =
    fails >= 3
      ? `\n⚠ 已连续 ${fails} 次校验不通过：建议人工介入核对文档格式/结构，或请业务补充材料后重新生成，避免反复修改。`
      : ""
  return (
    `📐 已校验文档结构（${render.source}）：\n` +
    `${chapterLine}\n` +
    `功能点：${render.featureCount}/${render.expectedFeatures}（已确认功能点数）${featureOk ? " ✓" : " ✗ 结构不完整"}\n` +
    `必填字段来源覆盖：${coveredCount}/${totalFields} 处\n` +
    `期望结构：${expectedSkeleton()}\n` +
    `覆盖进度：[${bar}] ${totalFields > 0 ? Math.round((coveredCount / totalFields) * 100) : 100}%\n` +
    focusedBlock +
    (violations.length > 0
      ? `\n⚠ 文档结构有 ${violations.length} 项问题：\n  - ${violations.join("\n  - ")}\n→ 请修正后重新校验；[缺省] 字段需在质量评分中如实扣分。`
      : `\n✓ 结构合规，可提交最终确认。`) +
    iterateNote
  )
}
