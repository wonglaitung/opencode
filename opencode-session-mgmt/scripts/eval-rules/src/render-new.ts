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

/**
 * 渲染当前注入文本。
 *
 * `lockedFiles` 必须能传进去：sdlc 完成块的解锁提示有条件（`lockedFiles.length > 0`
 * 才注入），而场景的锁是**执行阶段**才灌进 store 的——注入若不带上锁，解锁提示就不会出现，
 * 判据要求的事根本没进 system prompt（s22 曾因此稳定 0/3，场景不可满足）。
 */
export function renderNew(workflow: WorkflowState, lockedFiles: readonly string[] = []): string {
  return buildSystemFragment(workflow, {}, [...lockedFiles])
}
