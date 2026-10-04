/**
 * 执行链路自检（`EVAL_EXECUTE=1` 时随评测跑；不调模型，纯脚本对话）。
 *
 * 为什么需要：第十一轮把渲染质量/五维分判据接到**真实产物**上（`reqdoc_assemble` 的落盘
 * 结果）。这条链路一旦坏掉，症状是「所有渲染场景一律判『未产出组装件』」——看起来像模型
 * 不听话，实际是执行器没跑通。**必须能在不调模型、不花一分钱的前提下证明链路是通的**，
 * 否则每次排查都要先怀疑模型。
 *
 * 覆盖三件事：
 * 1. 脚本化的 ingest + assemble 能产出真实产物，且产物含内嵌摘要（定稿校验的依据）；
 * 2. `render` / `score` 判据真的读这份产物并给出分数（不是回落模型正文）；
 * 3. 重复调用能被识别为死循环并停止（否则评测会白烧轮数把「循环」误读成「不听话」）。
 */
import { parseRenderStructure } from "sm-shared"
import { requiredSlots } from "../../../packages/shared/src/reqdoc-slots.ts"
import { judgeScenario } from "./judge.ts"
import { executeTurns, buildRegistry } from "./executor.ts"
import { Store } from "../../../packages/plugin/src/db"
import { EVAL_TOOLS } from "./tool-defs.ts"
import type { ModelOutput, WorkflowState } from "./types.ts"

const NOOP: ModelOutput = { text: "", toolCalls: [] }

/** 造一个 prd 阶段、槽位全空的工作流状态（与 r18 夹具同构）。 */
function emptyKbState(): WorkflowState {
  const features = [{ no: 1, name: "自检功能点", priority: "high" as const, confirmedAt: 1 }]
  return {
    type: "reqdoc",
    id: "exec-selfcheck",
    stages: {
      goal: { status: "approved", revision: 1 },
      rules: { status: "approved", revision: 1 },
      edge: { status: "approved", revision: 1 },
      prd: { status: "in_progress", revision: 1 },
      review: { status: "not_started", revision: 0 },
    },
    commit: { status: "blocked", blocked_by: ["prd", "review"] },
    quality: { firstPassRate: null, iterationCount: 0, iterationByFile: {} },
    comprehension: [],
    checklist: {},
    review: {},
    kb: {
      slots: [],
      features,
      containers: { "4.1": { required: false, reason: "自检无术语" } },
      candidates: {},
      askCounts: {},
      updatedAt: 1,
    },
  } as unknown as WorkflowState
}

/** 返回失灵项描述；空数组表示执行链路与判据接线全部正常。 */
export async function execSelfCheck(): Promise<string[]> {
  const fails: string[] = []
  const state = emptyKbState()
  const features = state.kb!.features
  const slots = requiredSlots(features).map((address) => ({
    kind: "prose" as const,
    address,
    content: `${address} 的自检内容`,
    source: "文档" as const,
  }))

  // 1) 脚本化一轮：ingest 提交全部必填 + assemble，产出真实组装件
  const ok = await executeTurns(state, async (prior) =>
    prior.length === 0
      ? {
          text: "",
          toolCalls: [
            { id: "s1", name: "reqdoc_ingest", args: { slots, features } },
            { id: "s2", name: "reqdoc_assemble", args: {} },
          ],
        }
      : NOOP,
  )
  if (!ok.toolResults.some((t) => t.name === "reqdoc_ingest" && t.ok))
    fails.push(`执行链路：reqdoc_ingest 未成功（${ok.toolResults.find((t) => t.name === "reqdoc_ingest")?.result.slice(0, 80) ?? "未调用"}）`)
  if (!ok.artifact) fails.push("执行链路：未产出组装件（读不到 07_需求规格产出 下的 md）")
  else {
    if (!/kb-digest/.test(ok.artifact)) fails.push("执行链路：产物缺内嵌摘要（定稿一致性校验会拒）")
    const struct = parseRenderStructure(ok.artifact)
    if (struct.chaptersPresent.length === 0) fails.push("执行链路：产物解析不出章节（模板投影异常）")
    // 2) 判据必须读产物：给它一个不读产物就必挂的判据，仍通过即证明接线正确
    const judged = judgeScenario(
      { kind: "render", requiredChapters: struct.chaptersPresent.slice(0, 2), ordered: false },
      { text: "", toolCalls: [], artifact: ok.artifact },
    )
    if (!judged.pass) fails.push(`判据接线：真实产物未被判为达标（${judged.detail.slice(0, 100)}）`)
    const scored = judgeScenario(
      { kind: "score", renderMarkers: ["业务需求说明书"], minTotal: 0 },
      { text: "", toolCalls: [], artifact: ok.artifact },
    )
    if (scored.score === undefined) fails.push("判据接线：score 判据未给出分数（产物未进入评分）")
  }

  // 3) 工具覆盖率：`EVAL_TOOLS` 里每个工具都必须有真实实现，否则评测结果失真且看不出失真
  const probeStore = Store.memory(() => "reqdoc")
  const registry = buildRegistry(probeStore)
  const all = (EVAL_TOOLS as { function: { name: string } }[]).map((t) => t.function.name)
  const missing = all.filter((n) => !registry[n])
  probeStore.close()
  // 不再有「已知缺口」豁免：open_ide 系列已用内存锁注册表补齐（见 executor 的 memLocks）。
  // 曾留过豁免，结果 s22「完结后提示解锁」稳定 0/3 却看不出是环境缺口——豁免本身成了盲区。
  if (missing.length > 0)
    fails.push(
      `工具覆盖：${missing.length} 个评测工具没有真实实现（${missing.join("、")}）——模型调到会拿到「未实现」并停下，` +
        `表现为「规则没效果」的假失败。补 packages/plugin/src 的对应 create* 工厂。`,
    )

  // 4) 死循环检测
  // 每一轮都发同一个调用（参数完全相同）——这才是弱模型的真实死循环形态（实测 qwen3 连发 4 次）
  const looped = await executeTurns(state, async () => ({
    text: "",
    toolCalls: [{ id: "l1", name: "reqdoc_confirm_features", args: { features } }],
  }))
  if (!looped.looped) fails.push("死循环检测：重复调用未被识别（评测会白烧轮数）")
  return fails
}
