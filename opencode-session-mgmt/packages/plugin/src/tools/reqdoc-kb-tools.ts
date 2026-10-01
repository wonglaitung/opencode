/**
 * reqdoc 知识库工具组（重构阶段 2a「先立后破」：只加不删）。
 *
 * 三个工具对应模型在槽位模型下的两种职责（设计 2.5）：
 * 1. `reqdoc_ingest` —— 批量提交从材料提取的槽位（模型只填被指定的地址）
 * 2. `reqdoc_answer` —— 逐项填补派生开放项
 * 3. `reqdoc_assemble` —— 由槽位投影生成整篇 PRD（服务器负责结构，模型不碰文档）
 *
 * **门禁接入**：本组是 prd 门禁与定稿门禁的唯一依据（`workflow.ts` 与 `review.ts` 的
 * 在 2b 才改读 `kbGate`）。此阶段旧工具与旧状态字段全部保留、两套并存，
 * 便于对照与回退（见设计文档 12 章阶段 2a/2b/2c）。
 */
import { mkdir, writeFile } from "node:fs/promises"
import { basename, join, relative } from "node:path"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import {
  QUESTIONS_PER_TURN,
  assembleDoc,
  STOP_ASK_AFTER,
  advanceAskCounts,
  deriveQuestions,
  isValidSlotAddr,
  matchMemory,
  writeL1Term,
  writeL2Fact,
  writeL4Pref,
  getDefinition,
  requiredSlots,
  type ContainerDecl,
  type ReqdocFeature,
  type MemoryFact,
  type MemoryTerm,
  type ReqdocKbState,
  type ReqdocSlot,
} from "sm-shared"
import type { Store } from "../db"
import { WorkflowOpError } from "../workflow-ops"
import { loadReqdocTemplate } from "../template"
import { projectRoot, resolveWithinWorktree } from "../fs-safe"
import { materialEvidence } from "./reqdoc-scan"

const z = tool.schema

/** KB 目录名（设计第 5 章：独立顶层目录，不占用 00~07 编号、不混入业务投料区）。 */
const KB_DIR = "需求知识库"
const KB_MD = "知识库.md"
const KB_JSON = ".kb.json"

function requireReqdoc(workflow: { type: string }, toolName: string) {
  const def = getDefinition(workflow.type as never)
  if (def.type !== "reqdoc") {
    throw new WorkflowOpError(`${toolName} 仅用于 reqdoc 工作流（当前为 ${def.type}）`)
  }
}

/** 取当前 KB 状态；未初始化时返回空壳（功能点来自旧 features 字段，保证必填集可派生）。 */
function readKb(workflow: {
  kb?: ReqdocKbState
  features?: { no: number; name: string; priority: "high" | "medium" | "low"; confirmedAt: number }[]
}): ReqdocKbState {
  return (
    workflow.kb ?? {
      slots: [],
      features: workflow.features ?? [],
      containers: {},
      askCounts: {},
      updatedAt: 0,
    }
  )
}

/** 写知识库双文件（`.kb.json` 机器态 + `知识库.md` 人可读账本）。 */
async function writeKbFiles(root: string, kb: ReqdocKbState): Promise<void> {
  const dir = join(root, KB_DIR)
  await mkdir(dir, { recursive: true })
  // evidence（材料原文快照，给同步状态栏用）只活在工作流状态里——
  // 不写进项目侧 kb.json，否则每次换材料都会往交付目录塞几十 KB 原文。
  await Bun.write(join(dir, KB_JSON), JSON.stringify({ ...kb, evidence: undefined }, null, 2))
  // 人可读账本：按地址排序渲染，已作废（retired）以删除线保留（设计 B5）
  const rows = [...kb.slots]
    .sort((a, b) => a.address.localeCompare(b.address))
    .map((s) => {
      const head = `- \`${s.address}\`（${s.kind}/${s.status}）`
      if (s.status === "retired") return `${head} ~~${s.content.slice(0, 40)}~~ 已作废`
      return `${head} ${s.content.replace(/\n/g, " ").slice(0, 80)}`
    })
  await Bun.write(
    join(dir, KB_MD),
    `# 需求知识库\n\n> 由 reqdoc 工具自动维护，请勿手工编辑（改动会在下次工具调用时被覆盖）。\n\n` +
      `功能点数：${kb.features.length}；槽位数：${kb.slots.length}\n\n` +
      `## 槽位\n\n${rows.join("\n") || "（暂无）"}\n`,
  )
}

/**
 * 组装产物目录（2c）：单功能点时进功能点子目录，多功能点时落在 07_ 根。
 * 组装与定稿校验共用，避免两处各算一遍路径而漂移。
 */
export function assembleDir(root: string, features: readonly ReqdocFeature[]): string {
  if (features.length === 1) {
    return join(root, "07_需求规格产出", `${features[0]!.no}_${features[0]!.name}`)
  }
  return join(root, "07_需求规格产出")
}

export function createReqdocKbTools(store: Store): Record<string, ToolDefinition> {
  const reqdoc_ingest = tool({
    description:
      "reqdoc 槽位批量提交：把从材料中提取的内容一次提交为**槽位**（不是直接写文档）。" +
      "服务端按模板派生「哪些槽位还开着」，只让你填这些地址；status 一律记为待确认（draft），" +
      "业务确认请用 reqdoc_answer。分批调用：每次提交后看返回的「本轮该填」清单，" +
      `一次最多 ${QUESTIONS_PER_TURN} 项。仅 reqdoc 工作流有效。`,
    args: {
      slots: z
        .array(
          z.object({
            address: z.string().describe("槽位地址（服务端给出的待填地址，如 3.1 / 5.1.2.3 / 4.1.CRD）"),
            kind: z.enum(["prose", "term", "field"]).describe("prose=小节正文；term=术语条目；field=字段定义"),
            content: z.string().describe("该槽位的内容（业务语言正文；术语填释义；字段填定义说明）"),
            source: z.enum(["文档", "问答", "缺省"]).describe("来源：文档=材料可循 / 问答=业务口述 / 缺省=本次不涉及（须在 reason 给理由）"),
            reason: z.string().optional().describe("source=缺省 时必填：本次不涉及的理由"),
            ref: z.string().optional().describe("材料出处（文件名或段落，便于溯源）"),
          }),
        )
        .describe("本批提交的槽位（地址必须来自上一次的「本轮该填」清单）"),
      features: z
        .array(
          z.object({
            name: z.string().describe("功能点名称（如：名单排查）"),
            priority: z.enum(["high", "medium", "low"]).describe("优先级"),
          }),
        )
        .optional()
        .describe("功能点清单（首次提交时给；已确认过则省略）"),
      candidates: z
        .record(z.string(), z.array(z.string()))
        .optional()
        .describe(
          "容器下的子项候选（如 {\"4.1\": [\"CRD\",\"AML\"], \"5.1.2.1\": [\"客户号\"]}）——" +
            "从材料中抽取到的术语/字段名。**这是记忆生效的必要条件**：命中 L1 术语记忆的候选会直接消缺口（不再问），" +
            "服务端才能据此少问。只填材料里真实出现的，不要臆造。",
        ),
      containers: z
        .record(z.string(), z.object({ required: z.boolean(), reason: z.string().optional() }))
        .optional()
        .describe("容器声明（如 4.1/5.1.2.1 声明 required:false 表示本次无术语/无结构化字段，须给 reason）"),
    },
    async execute(args, context) {
      const root = projectRoot(context)
      const saved = store.mutateWorkflow(context.sessionID, (workflow) => {
        requireReqdoc(workflow, "reqdoc_ingest")
        const kb = readKb(workflow)
        // 功能点：给了就以它为准（首次或修正）
        if (args.features && args.features.length > 0) {
          kb.features = args.features.map((f, i) => ({
            no: i + 1,
            name: f.name,
            priority: f.priority,
            confirmedAt: Date.now(),
          }))
        }
        // 容器声明合并
        kb.containers = { ...(kb.containers ?? {}), ...(args.containers ?? {}) }
        // 候选合并（去重）：记忆消缺口的唯一入口
        if (args.candidates) {
          const next = { ...(kb.candidates ?? {}) }
          for (const [container, list] of Object.entries(args.candidates)) {
            const merged = new Set([...(next[container] ?? []), ...list])
            next[container] = [...merged]
          }
          kb.candidates = next
        }
        // 地址合法性校验（P1-a）：非法地址会让事实「收了但不进交付件」且零告警。
        // 已存在的地址放行（那是改内容，不是建新地址）。
        const invalid = args.slots.filter((x) => !isValidSlotAddr(x.address, kb.features) && !kb.slots.some((y) => y.address === x.address))
        if (invalid.length > 0) {
          throw new WorkflowOpError(
            `槽位地址非法：${invalid.map((x) => x.address).join("、")}。\n` +
              `合法地址只有两类：① 工具返回的「本轮该填」清单里的地址（如 3.1、5.1.2.13）；` +
              `② 容器叶子（4.1.<术语名>、5.1.2.1.<字段名>）。\n` +
              `请先取本轮清单再提交；若确有模板外内容，用 containers 声明或另开附注，不要自造地址。`,
          )
        }
        // 槽位合并：同地址覆盖（status 由服务端强制 draft，模型不能自称已确认）
        const byAddr = new Map(kb.slots.map((s) => [s.address, s]))
        for (const s of args.slots) {
          if (s.source === "缺省" && !s.reason) {
            throw new WorkflowOpError(`槽位 ${s.address} 标为 [缺省] 但未给 reason（缺省必须写明理由）`)
          }
          byAddr.set(s.address, {
            kind: s.kind,
            address: s.address,
            content: s.content,
            source: s.source,
            status: "draft",
            reason: s.reason,
            ref: s.ref,
            askCount: 0,
          })
        }
        kb.slots = [...byAddr.values()]
        kb.updatedAt = Date.now()
        workflow.kb = kb
      })
      const kb = readKb(saved)
      await writeKbFiles(root, kb)
      // 记忆匹配的证据 = **材料原文**（方案 C，对抗审查 I-1）。
      // 此前用槽位正文——正文是模型写的：写一句「本需求与 CCB 系统无关」就能让 CCB 命中 L1，
      // 消掉一个本该问业务的问题（否定句也命中；证据可被书写 = 自证面只是平移）。
      // 换成 00~05 材料原文后，材料里没有的词模型怎么写都命中不了；
      // candidates 仍只决定「问什么」不作证据（N-5 已堵）；07 产物不作证据（自证）。
      const evidence = await materialEvidence(root)
      const hits = matchMemory(evidence)
      // 快照给同步的状态栏（buildStateBar 读不了文件），否则两处开放项口径不一
      store.mutateWorkflow(context.sessionID, (wf) => {
        if (wf.kb) wf.kb.evidence = evidence
      })
      const derived = deriveQuestions(kb.features, {
        slots: kb.slots,
        askCounts: kb.askCounts,
        decls: kb.containers,
        candidates: kb.candidates,
        l1: hits.l1,
        l2: hits.l2,
      })
      // 推进轮次：把本轮展示的地址计数 +1（6.3 按轮次计）
      const counts = advanceAskCounts(kb.askCounts ?? {}, derived.batch.map((q) => q.address))
      store.mutateWorkflow(context.sessionID, (workflow) => {
        if (workflow.kb) workflow.kb.askCounts = counts
      })
      const cov = kbCoverage(kb)
      const lines = derived.batch.map((q) => `  - ${q.address}${q.guess ? `（默认：${q.guess}）` : ""}`)
      return [
        `📥 已提交 ${args.slots.length} 个槽位（均为待确认 draft）；已写入 ${KB_DIR}/。`,
        `覆盖率：${cov}；本轮该填 ${derived.batch.length}/${derived.all.length} 项：`,
        ...(lines.length ? lines : ["  （无——全部槽位已确认）"]),
        derived.stopped.length > 0
          ? `⏸ 因连续 ${STOP_ASK_AFTER} 轮未确认已停问：${derived.stopped.map((q) => q.address).join("、")}（可由业务确认或定稿时 force 收口）`
          : "",
        // 记忆效果必须对模型可见，否则它会重复问已被记忆消缺口的项（「少问」机制形同虚设）
        derived.l1Applied.length > 0
          ? `🧠 L1 记忆免问 ${derived.l1Applied.length} 项（业务曾复述过，采信其定义，**不要问业务**）：${derived.l1Applied.join("、")} —— 它们不在「本轮该填」清单里、仍是 draft，**须由你用材料原文直接 reqdoc_answer 落定**（不落定则必填容器覆盖不过、进 prd 会被拦）`
          : "",
        hits.l2.length > 0
          ? `🧠 L2 组织知识命中 ${hits.l2.length} 项（**不消缺口**，仅作默认值请业务点头）：${hits.l2.map((f) => f.content).join("；")}`
          : "",
        "→ 逐项请业务确认后用 reqdoc_answer 落定；不要直接编辑 PRD 文件。",
      ]
        .filter(Boolean)
        .join("\n")
    },
  })

  const reqdoc_answer = tool({
    description:
      "reqdoc 槽位确认：把某一项请业务确认后的结论落定（状态转 confirmed）。" +
      "**只接受派生清单给出的地址**；业务未答满 2 轮的项会被停问，此时应显式收口" +
      "（source=缺省 + reason 写明未确认原因），而不是反复追问。",
    args: {
      address: z.string().describe("槽位地址（来自本轮该填清单或停问清单）"),
      content: z.string().describe("业务确认后的内容（业务语言，不照搬口语）"),
      source: z.enum(["文档", "问答", "缺省"]).describe("来源：文档 / 问答（业务口述）/ 缺省（本次不涉及）"),
      reason: z.string().optional().describe("source=缺省 时必填（如「本次无清算处理」）"),
      restated_term: z
        .object({
          term: z.string().describe("业务刚刚口头复述释义的缩写/简称（如 CRD）"),
          definition: z.string().describe("业务给出的释义（用业务原话，不要臆测润色）"),
          kind: z.enum(["行业通用", "系统口径", "内部简称"]).describe("分类：内部简称=行内叫法；系统口径=本系统约定；行业通用=通用行话"),
        })
        .optional()
        .describe(
          "【记忆】仅当业务**主动口头解释了某个缩写/简称**时才填（origin=restated）。" +
            "下一个需求材料出现该词将直接采信、不再追问。**业务只是点了「同意默认」时绝对不要填**——" +
            "静默接受不入库，否则错误定义会跨需求传播。",
        ),
    },
    async execute(args, context) {
      const root = projectRoot(context)
      const saved = store.mutateWorkflow(context.sessionID, (workflow) => {
        requireReqdoc(workflow, "reqdoc_answer")
        const kb = readKb(workflow)
        if (args.source === "缺省" && !args.reason) {
          throw new WorkflowOpError(`槽位 ${args.address} 标为 [缺省] 但未给 reason`)
        }
        if (!isValidSlotAddr(args.address, kb.features) && !kb.slots.some((y) => y.address === args.address)) {
          throw new WorkflowOpError(
            `槽位地址非法：${args.address}。合法地址只有两类：① 工具返回的「本轮该填」清单里的地址；` +
              `② 容器叶子（4.1.<术语名>、5.1.2.1.<字段名>）。请先取本轮清单再回答。`,
          )
        }
        const idx = kb.slots.findIndex((s) => s.address === args.address)
        const prev = idx >= 0 ? kb.slots[idx]! : undefined
        if (!prev) {
          // 未先 ingest 的地址：允许直接回答（等于补填并确认）
          kb.slots.push({
            kind: "prose",
            address: args.address,
            content: args.content,
            source: args.source,
            status: "confirmed",
            reason: args.reason,
          })
        } else {
          kb.slots[idx] = {
            ...prev,
            content: args.content,
            source: args.source,
            status: "confirmed",
            reason: args.reason,
          }
        }
        kb.updatedAt = Date.now()
        workflow.kb = kb
      })
      // 记忆写入（3.6.1 ①）：业务复述 → 立即写 L1。origin 固定 restated——
      // 模型无法自行指定 origin，杜绝「点默认也入库」的污染路径。
      const mem = args.restated_term
        ? writeL1Term(args.restated_term.term, args.restated_term.definition, {
            kind: args.restated_term.kind,
            scope: "org",
            origin: "restated",
            fromProject: basename(root),
          })
        : null
      const memNote =
        mem?.ok === true
          ? `🧠 已记入 L1 术语记忆：${args.restated_term!.term} = ${args.restated_term!.definition}（下个需求出现该词将直接采信、不再问）`
          : mem?.ok === false && mem.reason === "conflict"
            ? `⚠ 术语「${args.restated_term!.term}」记忆里已有不同释义（${mem.existing}），未覆盖——请与业务确认该用哪个`
            : ""
      const kb = readKb(saved)
      await writeKbFiles(root, kb)
      // 阶段 3：记忆接线——按**材料原文**匹配（同 ingest，方案 C）。
      // L1 命中免问（不再问）、L2 命中只作默认值（仍问一次）。
      const evidence = await materialEvidence(root)
      const hits = matchMemory(evidence)
      store.mutateWorkflow(context.sessionID, (wf) => {
        if (wf.kb) wf.kb.evidence = evidence
      })
      const derived = deriveQuestions(kb.features, {
        slots: kb.slots,
        askCounts: kb.askCounts,
        decls: kb.containers,
        candidates: kb.candidates,
        l1: hits.l1,
        l2: hits.l2,
      })
      return [
        `✅ 已确认 \`${args.address}\`（来源 ${args.source}${args.reason ? `：${args.reason}` : ""}）。`,
        `覆盖率：${kbCoverage(kb)}；剩余本轮该填 ${derived.batch.length} 项。`,
        derived.unclosed.length > 0 ? `⚠ 仍未收口：${derived.unclosed.join("、")}` : "",
        derived.l1Applied.length > 0
          ? `🧠 L1 记忆免问 ${derived.l1Applied.length} 项（业务曾复述过，采信其定义，**不要问业务**）：${derived.l1Applied.join("、")} —— 它们不在「本轮该填」清单里、仍是 draft，**须由你用材料原文直接 reqdoc_answer 落定**（不落定则必填容器覆盖不过、进 prd 会被拦）`
          : "",
        memNote,
      ]
        .filter(Boolean)
        .join("\n")
    },
  })

  const reqdoc_assemble = tool({
    description:
      "reqdoc PRD 组装：把槽位投影成整篇 PRD（md）并归档到 07_需求规格产出。" +
      "**结构与来源标签由服务端保证**，你不需要也不应手工编辑产物。" +
      "产物内嵌槽位摘要，定稿时据此校验一致性（摘要不符 = 过期产物或被手改）。",
    args: {
      source: z
        .string()
        .optional()
        .describe(
          "输出文件名（**只能是基本文件名**，如 需求规格书.md；默认 PRD.md）。功能点子目录由服务端按功能点建。" +
            "不要传含斜杠的路径——定稿校验按同一个文件名查找，传路径会导致定稿时找不到产物。",
        ),
    },
    async execute(args, context) {
      const root = projectRoot(context)
      const workflow = store.get(context.sessionID)?.workflow
      if (!workflow) throw new WorkflowOpError("未找到工作流状态")
      requireReqdoc(workflow, "reqdoc_assemble")
      const kb = readKb(workflow)
      const result = assembleInto(kb)
      if (!result) {
        return "⚠ 无法组装：模板不可用或功能点为空。请先 reqdoc_ingest 提交功能点清单。"
      }
      const fileName = args.source ?? "PRD.md"
      // 只允许基本文件名：含斜杠/.. 会逃出功能点目录，且与定稿查找路径不一致（P1-d）
      if (fileName !== basename(fileName) || fileName === "." || fileName === "..") {
        throw new WorkflowOpError(`source 只能是文件名（如 需求规格书.md），收到：${fileName}。功能点子目录由服务端自动创建。`)
      }
      const outDir = assembleDir(root, kb.features)
      await mkdir(outDir, { recursive: true })
      // 统一走 resolveWithinWorktree（同仓 review.ts 的做法），杜绝越界写
      const outPath = resolveWithinWorktree(root, join(relative(root, outDir), fileName))
      await Bun.write(outPath, result.md)
      // 记住产物文件名：定稿/变更记录/溯源回填都按它定位（P1-d：否则自定义 source 会与硬编码 PRD.md 脱节）
      store.mutateWorkflow(context.sessionID, (w) => {
        if (w.kb) w.kb.assembledFile = fileName
      })
      return [
        `🧩 已组装 PRD：${outDir}/${args.source ?? "PRD.md"}（${result.md.length} 字符）。`,
        `结构指纹：功能点 ${kb.features.length} 个、小节 ${result.fingerprint.subSections.length} 个、来源标签 ${Object.keys(result.fingerprint.tags).length} 处。`,
        result.omittedContainers.length > 0 ? `省略的空容器节：${result.omittedContainers.join("、")}` : "",
        `槽位摘要：${result.digest}（用于幂等校验）。`,
        "→ 本阶段为预览；结构与标签由服务端保证，请勿手工编辑产物。",
      ]
        .filter(Boolean)
        .join("\n")
    },
  })

  /**
   * 记忆候选回顾（设计 3.6.1 ③，阶段 3）：定稿后由业务**勾选**才写入 L2 组织知识。
   *
   * 刻意做成独立工具而非定稿自动写：自动写等于「AI 决定什么值得记住」，
   * 而记忆会跨需求传播，污染成本高（3.6 规则 3）。业务勾选是唯一的入库授权。
   */
  const reqdoc_memory_recall = tool({
    description:
      "reqdoc 定稿记忆回顾：把本次收集到的组织知识候选（系统名/接口/产品线等）逐条列给业务**勾选**，" +
      "只有业务勾选的才写入 L2 组织记忆（供后续需求复用为默认值）。" +
      "定稿通过后调用一次即可；业务未勾选的**不会**写入。不影响任何门禁与判定。",
    args: {
      facts: z
        .array(z.object({ content: z.string().describe("一条组织知识（如「交易走 CIPS，报文经 ESB」）") }))
        .describe("业务勾选要记住的条目（由你从本次问答中提取候选，逐条给业务确认）"),
      prefs: z
        .array(z.object({ key: z.string().describe("偏好键（如 详略/措辞/分工）"), value: z.string().describe("偏好内容") }))
        .optional()
        .describe("可选的表达偏好（只影响措辞与详略，不影响事实与门禁）"),
      retire_slots: z
        .array(z.string())
        .optional()
        .describe(
          "可选：本次已写入记忆、后续不必再问的**槽位地址**（如 [\"5.1.2.11\"]）。" +
            "被退役的槽位不再进开放项、也不计入覆盖率——只填确实已进记忆的，填错会导致门禁永远不通过。",
        ),
    },
    async execute(args, context) {
      const root = projectRoot(context)
      // 工作流校验（P1-e）：此前无此校验，sdlc 会话也能调，往全局 L2/L4 写记忆
      const workflow = store.get(context.sessionID)?.workflow
      if (!workflow) throw new WorkflowOpError("未找到工作流状态")
      requireReqdoc(workflow, "reqdoc_memory_recall")
      const fromProject = basename(root)
      const written: string[] = []
      const skipped: string[] = []
      for (const f of args.facts) {
        const r = writeL2Fact(f.content, { source: "问答", scope: "org", origin: "restated", fromProject })
        if (r.ok) written.push(f.content)
        else skipped.push(f.content)
      }
      const prefWritten: string[] = []
      for (const p of args.prefs ?? []) {
        const r = writeL4Pref(p.key, p.value, { scope: "reqdoc", origin: "restated", fromProject })
        if (r.ok) prefWritten.push(`${p.key}=${p.value}`)
      }
      // 退役对应槽位（它们已进记忆，不必重复追问）。
      // 此前用 `written.includes(sl.content)` 严格相等匹配——L2 content 是概括性组织知识、
      // slot content 是 PRD 正文，**永不匹配**，是段空操作（P1-e）。改为按 slotAddress 显式指定。
      const retireAddrs = args.retire_slots ?? []
      if (retireAddrs.length > 0) {
        store.mutateWorkflow(context.sessionID, (w) => {
          if (!w.kb) return
          w.kb.slots = w.kb.slots.map((sl) =>
            retireAddrs.includes(sl.address) ? { ...sl, status: "retired" as const } : sl,
          )
        })
      }
      return [
        `🧠 记忆回顾完成：写入 L2 组织知识 ${written.length} 条${written.length ? `——${written.join("；")}` : ""}`,
        prefWritten.length > 0 ? `已记表达偏好 ${prefWritten.length} 条：${prefWritten.join("、")}` : "",
        skipped.length > 0 ? `⚠ 未写入（静默默认来源不入库）：${skipped.join("、")}` : "",
        "→ 可用 `opencode-sm memory list` 查看与遗忘（删文件即遗忘）。",
      ]
        .filter(Boolean)
        .join("\n")
    },
  })

  return { reqdoc_ingest, reqdoc_answer, reqdoc_assemble, reqdoc_memory_recall }
}

/** 覆盖率文本（状态条与工具返回共用口径）。 */
function kbCoverage(kb: ReqdocKbState): string {
  const req = requiredSlots(kb.features)
  const filled = req.filter((a) =>
    kb.slots.some((s) => s.address === a && s.status === "confirmed"),
  ).length
  return `${filled}/${req.length} 必填（${req.length ? Math.round((filled / req.length) * 100) : 0}%）`
}

/**
 * 调用组装：槽位投影为整篇 PRD（`assembleDoc` 在 shared，纯函数）。
 *
 * 导出供 `review.ts` 的定稿校验复用——组装与校验必须用同一函数、同一模板，
 * 否则两处各算一遍会漂移（定稿比对必然失真）。
 */
export function assembleInto(kb: ReqdocKbState) {
  return assembleDoc(kb.slots, kb.features, loadReqdocTemplate(), { containers: kb.containers })
}