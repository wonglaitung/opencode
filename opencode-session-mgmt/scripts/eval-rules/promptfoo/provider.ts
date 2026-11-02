/**
 * Promptfoo PoC provider：复用现有 eval-rules 的场景、注入和判据。
 *
 * 这不是完整迁移：先证明 Promptfoo 可以承载现有场景夹具、模型调用和 JS 断言。
 * 当前只跑单轮场景；需要真实工具执行的 rejected/render/score 场景仍由原 runner 负责。
 */
import { SCENARIOS } from "../src/scenarios"
import { renderNew } from "../src/render-new"
import { judgeScenario } from "../src/judge"
import { chatComplete } from "../src/client"
import { toolsForWorkflow } from "../src/tool-defs"

interface ProviderOptions {
  id?: string
  config?: Record<string, unknown>
}

export default class WorkflowEvalProvider {
  private providerId: string

  constructor(options: ProviderOptions = {}) {
    this.providerId = options.id ?? "workflow-eval"
  }

  id(): string {
    return this.providerId
  }

  async callApi(_prompt: string, context?: { vars?: Record<string, unknown> }): Promise<{
    output: string
    metadata: Record<string, unknown>
  }> {
    const name = context?.vars?.scenario
    if (typeof name !== "string") throw new Error("缺少 vars.scenario")
    const scenario = SCENARIOS.find((item) => item.name === name)
    if (!scenario) throw new Error(`未知场景：${name}`)

    const state = structuredClone(scenario.state)
    const system = renderNew(state, scenario.lockedFiles)
    const out = await chatComplete(system, scenario.userTurn, toolsForWorkflow(scenario.workflowType))
    const judged = judgeScenario(scenario.judge, out)

    return {
      output: JSON.stringify({
        scenario: scenario.name,
        text: out.text,
        toolCalls: out.toolCalls,
        judge: judged,
      }),
      metadata: {
        scenario: scenario.name,
        workflowType: scenario.workflowType,
        judge: judged,
      },
    }
  }
}
