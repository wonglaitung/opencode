/**
 * 评测用工具执行器（`EVAL_EXECUTE=1` 时启用）。
 *
 * 存在的理由：PRD 由服务端 `reqdoc_assemble` 从槽位投影生成，**规则明令模型不得手写产物**。
 * 所以渲染质量与五维分只能从**真实产物**评——而评测器原本从不执行工具
 * （`ModelOutput` 只有 `text` + `toolCalls`），只看模型正文。第十轮查明这让四个渲染场景
 * 变成了「奖励违规」：遵守规则的模型必然失败，而把「不要手写产物」这条规则加强，
 * 通过率反而下降。
 *
 * 本执行器让评测走一遍真实链路：真实 `Store`（内存）+ 真实工作区（临时目录）+ 真实工具
 * 实现，然后把工具结果按 OpenAI 兼容协议回灌给模型继续多轮，最后从工作区读回组装产物
 * 供 `render` / `score` 判据评分。
 *
 * **它不是生产环境的忠实复刻**：记忆库走 `SM_MEMORY_HOME`（临时目录，避免污染开发者本机），
 * 也不含 opencode 宿主（无插件 Hook、无上游 SDK）。它只保证「模型的动作真的过了服务端校验」，
 * 这正是渲染质量判据成立的前提。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ModelOutput, ToolCall, WorkflowState } from "sm-shared"
import { Store } from "../../../packages/plugin/src/db"
import { createReqdocKbTools } from "../../../packages/plugin/src/tools/reqdoc-kb-tools"
import { createReqdocFeatureTools } from "../../../packages/plugin/src/tools/reqdoc-features"
import { createWorkflowTools } from "../../../packages/plugin/src/tools/workflow"
import { createReviewTools } from "../../../packages/plugin/src/tools/review"
import { REQDOC_DIRS } from "../../../packages/plugin/src/tools/reqdoc-dirs"

/** 工具结果回灌用的协议消息（assistant 工具调用 / tool 结果）。 */
export interface PriorMessage {
  role: string
  content?: string
  tool_calls?: unknown[]
  tool_call_id?: string
}

export interface ExecResult {
  /** 累积的协议消息，供下一轮请求原样回灌 */
  prior: PriorMessage[]
  /** 模型最后一次输出 */
  last: ModelOutput
  /**
   * **全部轮次**的工具调用（按时序）与正文。
   *
   * 判据必须看这个而不是 `last`：多轮模式下期望的调用常发生在**更早的轮次**
   * （第一轮调了 workflow_baseline，第二轮无调用只做收尾），只看最后一轮会把
   * 「已完成」判成「未调用」——我第一版就这么错了，26 个场景里 12 个假失败。
   */
  allCalls: ToolCall[]
  allTexts: string[]
  /** 组装产物正文（读自工作区）；未产出时为 undefined */
  artifact?: string
  /** 逐次调用的执行结果，供「调用是否被服务端拒绝」类判定与诊断 */
  toolResults: { name: string; ok: boolean; result: string }[]
  /**
   * 模型是否陷入重复调用同一动作的死循环。
   *
   * 实测弱模型会连发同一个 `reqdoc_confirm_features`（qwen3 连发 4 次参数完全相同），
   * 每一轮都「成功」但状态不变，于是轮数耗尽、什么也没推进。这种情况下不能无限跑——
   * 既浪费时间，也会把「死循环」误读成「模型不听话」。故检测到重复即停，并如实标记。
   */
  looped?: { call: string; times: number }
}

const OUT_DIR = "07_需求规格产出"

/** 建临时工作区：按目录契约建 00~07 骨架（材料目录空，记忆与产物落盘于此）。 */
function makeWorktree(): string {
  const root = mkdtempSync(join(tmpdir(), "eval-rules-exec-"))
  for (const dir of REQDOC_DIRS) mkdirSync(join(root, dir), { recursive: true })
  return root
}

/** 把场景夹具状态灌进 store（只取工作流本身，不落盘）。 */
function seed(store: Store, sessionID: string, state: WorkflowState): void {
  store.mutateWorkflow(sessionID, (w) => {
    w.type = state.type
    w.stages = state.stages
    w.commit = state.commit
    w.quality = state.quality
    w.comprehension = state.comprehension
    w.checklist = state.checklist
    w.review = state.review
    w.features = state.features
    w.kb = state.kb
    w.baseline = state.baseline
  })
}

/**
 * 读回组装产物。
 *
 * **必须递归**：组装按功能点分子目录落盘（`07_需求规格产出/1_名单排查/PRD.md`），
 * 只扫顶层会永远读不到产物——而「读不到产物」在 render/score 判据里表现为「模型没渲染」，
 * 是个会把排查引向错误方向的假失败。
 */
function readArtifact(root: string): string | undefined {
  const dir = join(root, OUT_DIR)
  const found: string[] = []
  const walk = (d: string, depth: number): void => {
    if (depth > 4) return
    let names: string[]
    try {
      names = readdirSync(d)
    } catch {
      return
    }
    for (const name of names.sort()) {
      const p = join(d, name)
      if (name.endsWith(".md")) found.push(p)
      else {
        try {
          if (readdirSync(p)) walk(p, depth + 1)
        } catch {
          // 非目录，跳过
        }
      }
    }
  }
  walk(dir, 0)
  return found.length > 0 ? readFileSync(found[0]!, "utf8") : undefined
}

/**
 * 执行一轮对话：模型出工具调用 → 真实工具跑 → 结果回灌 → 模型续跑，直至无工具调用或达到轮数上限。
 *
 * `maxTurns` 兜底：模型可能在工具回灌后反复要更多工具调用，无上限会挂死评测。
 */
export async function executeTurns(
  state: WorkflowState,
  model: (prior: PriorMessage[]) => Promise<ModelOutput>,
  opts: { maxTurns?: number; sessionID?: string } = {},
): Promise<ExecResult> {
  const sessionID = opts.sessionID ?? "eval"
  const maxTurns = opts.maxTurns ?? 4
  const root = makeWorktree()
  const origMemoryHome = process.env.SM_MEMORY_HOME
  process.env.SM_MEMORY_HOME = join(root, ".memory")
  const store = Store.memory(() => state.type)
  try {
    seed(store, sessionID, state)
    const ctx = { worktree: root, sessionID } as never
    const registry: Record<string, { execute: (args: unknown, ctx: unknown) => Promise<unknown> } | undefined> = {
      ...createReqdocKbTools(store),
      ...createReqdocFeatureTools(store),
      ...createWorkflowTools(store),
      ...createReviewTools(store),
    }
    const prior: PriorMessage[] = []
    const allCalls: ToolCall[] = []
    const allTexts: string[] = []
    const toolResults: { name: string; ok: boolean; result: string }[] = []
    const seen = new Map<string, number>()
    let looped: ExecResult["looped"]
    let last = await model([])
    for (let turn = 0; turn < maxTurns; turn++) {
      const calls: ToolCall[] = last.toolCalls
      allCalls.push(...calls)
      if (last.text.trim() !== "") allTexts.push(last.text)
      if (calls.length === 0) break
      // assistant 侧必须原样带上 tool_calls（含 id），否则模型侧无法与 tool 结果配对
      prior.push({
        role: "assistant",
        content: last.text,
        tool_calls: calls.map((c) => ({
          id: c.id ?? c.name,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      })
      for (const c of calls) {
        // 重复调用检测：参数完全相同的调用只会产生同样的结果，重跑无意义
        const sig = `${c.name}:${JSON.stringify(c.args)}`
        const times = (seen.get(sig) ?? 0) + 1
        seen.set(sig, times)
        if (times > 1) {
          looped = { call: c.name, times }
          toolResults.push({
            name: c.name,
            ok: false,
            result: `重复调用：与此前参数完全相同的服务端调用不会产生新变化（第 ${times} 次）`,
          })
          continue
        }
        const tool = registry[c.name]
        if (!tool) {
          // 评测工具集与真实实现不同步时不能静默跳过——那会让判定看到假的「调用成功」
          const result = `评测环境未实现该工具：${c.name}`
          toolResults.push({ name: c.name, ok: false, result })
          prior.push({ role: "tool", tool_call_id: c.id ?? c.name, content: result })
          continue
        }
        try {
          const out = await tool.execute(c.args, ctx)
          const result = Array.isArray(out) ? out.filter((x) => typeof x === "string").join("\n") : String(out ?? "")
          toolResults.push({ name: c.name, ok: true, result })
          prior.push({ role: "tool", tool_call_id: c.id ?? c.name, content: result })
        } catch (err) {
          // 工具抛错**是有效观测**：服务端拒绝（如越序提交）正是要评的事实，不能吞掉
          const result = err instanceof Error ? err.message : String(err)
          toolResults.push({ name: c.name, ok: false, result })
          prior.push({ role: "tool", tool_call_id: c.id ?? c.name, content: result })
        }
      }
      last = await model(prior)
    }
    return { prior, last, allCalls, allTexts, artifact: readArtifact(root), toolResults, looped }
  } finally {
    store.close()
    if (origMemoryHome === undefined) delete process.env.SM_MEMORY_HOME
    else process.env.SM_MEMORY_HOME = origMemoryHome
    rmSync(root, { recursive: true, force: true })
  }
}
