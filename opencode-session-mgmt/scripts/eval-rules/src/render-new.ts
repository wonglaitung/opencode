/**
 * new 注入渲染:直接复用改造后的插件 buildSystemFragment(阶段化规则 + 一行阶段条)。
 * 改造前跑 --variant new 与 baseline 输出等价(此时 buildSystemFragment 尚为旧实现),
 * 改造后即自动切换到新注入格式。
 */
import { buildSystemFragment } from "../../../packages/plugin/src/prompt"
import type { WorkflowState } from "sm-shared"

export function renderNew(workflow: WorkflowState): string {
  return buildSystemFragment(workflow)
}
