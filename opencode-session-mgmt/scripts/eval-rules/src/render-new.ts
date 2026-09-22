/**
 * new 注入渲染:直接复用改造后的插件 buildSystemFragment(阶段化规则 + 一行阶段条)。
 * 改造前跑 --variant new 与 baseline 输出等价(此时 buildSystemFragment 尚为旧实现),
 * 改造后即自动切换到新注入格式。
 *
 * 渲染目标结构:reqdoc 且当前阶段为 prd 时注入结构摘要(P3 上下文瘦身,见 reqdoc-render.ts
 * renderTargetDigest)。模板逐字落实改由服务端 reqdoc_render_skeleton 生成骨架保证,不再注入模板全文;
 * baseline 保持冻结不注入——这正是要对比的差距。
 */
import { buildSystemFragment } from "../../../packages/plugin/src/prompt"
import { type WorkflowState } from "sm-shared"

export function renderNew(workflow: WorkflowState): string {
  return buildSystemFragment(workflow, {}, [])
}
