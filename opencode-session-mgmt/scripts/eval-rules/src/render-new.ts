/**
 * new 注入渲染:直接复用改造后的插件 buildSystemFragment(阶段化规则 + 一行阶段条)。
 * 改造前跑 --variant new 与 baseline 输出等价(此时 buildSystemFragment 尚为旧实现),
 * 改造后即自动切换到新注入格式。
 *
 * 模板送达:reqdoc 且当前阶段为 prd 时注入模板全文(与插件 createSystemTransform 行为一致,
 * 见 template.ts)。评分场景(r18/r19)靠它渲染出结构完整的 PRD,否则模型只能依赖
 * reqdoc-r14 的内联骨架,无法验证「模板送达」这个环节。baseline 保持冻结不注入——
 * 这正是要对比的差距:没有模板送达的注入,渲染产出质量应更低。
 */
import { buildSystemFragment } from "../../../packages/plugin/src/prompt"
import { loadReqdocTemplate } from "../../../packages/plugin/src/template"
import { currentInProgressStage, getDefinition, type WorkflowState } from "sm-shared"

export function renderNew(workflow: WorkflowState): string {
  const def = getDefinition(workflow.type)
  const stage = currentInProgressStage(workflow)
  const template = def.type === "reqdoc" && stage === "prd" ? loadReqdocTemplate() : null
  return buildSystemFragment(workflow, {}, [], template)
}
