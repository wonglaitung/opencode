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
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { basename, join, relative } from "node:path"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import {
  QUESTIONS_PER_TURN,
  assembleDoc,
  STOP_ASK_AFTER,
  advanceAskCounts,
  chapterOf,
  chapterClearRatio,
  chapterRetireRatio,
  deriveQuestions,
  featuresAppendViolation,
  hasFeatureScopedSlots,
  isValidSlotAddr,
  matchMemory,
  writeL1Term,
  writeL2Fact,
  writeL4Pref,
  getDefinition,
  requiredSlots,
  requireTemplateSchema,
  schemaAddressSpace,
  templateSchema,
  templateUnavailableNotice,
  templateDrift,
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

/**
 * 从模板实时取几个真实地址，用于工具描述里的**示例**。
 *
 * 此前这些示例写死（`3.1`、`5.1.2.3`、`4.1.CRD`），模板一换就变成误导——
 * 模型会照着示例自造地址，而服务端只认清单里的。改为实时派生后，
 * 换模板时示例自动跟随，且始终是当前模板里真实存在的地址。
 *
 * 取不到模板时退化为不含具体编号的通用文案（宁可少示例，不给错示例）。
 */
function addrHint(): { leaf: string; feature: string; termContainer: string; fieldContainer: string; termLeaf: string; fieldLeaf: string } {
  const s = templateSchema()
  if (!s) return { leaf: "", feature: "", termContainer: "", fieldContainer: "", termLeaf: "", fieldLeaf: "" }
  const leaf = [...s.docSectionAddrs][0] ?? ""
  const ch = s.featureChapter
  const firstRel = s.requiredSubRels[0] ?? s.featureSubs[0]?.rel ?? ""
  const feature = ch === null || firstRel === "" ? "" : `${ch}.1.${firstRel}`
  const termContainer = s.chapterContainers[0] ?? ""
  const fieldContainer = ch === null || !s.featureContainerRels[0] ? "" : `${ch}.1.${s.featureContainerRels[0]}`
  return {
    leaf,
    feature,
    termContainer,
    fieldContainer,
    termLeaf: termContainer ? `${termContainer}.CRD` : "",
    fieldLeaf: fieldContainer ? `${fieldContainer}.客户号` : "",
  }
}

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
/**
 * 取知识库状态——**功能点的唯一事实源在 `kb.features`**。
 * `workflow.features` 只是 `kb` 尚未建立时的初始化输入：kb 一旦存在，`readKb` 只认 `kb.features`
 * （槽位地址、kbGate、组装、review、统计全部从它派生）。任何写功能点的地方都必须走 kb，
 * 写 `workflow.features` 会造成「目录按新列表建、地址体系仍是旧列表」的分叉。
 * 导出供 reqdoc_confirm_features 复用，保证 KB 初始字段只有一处定义。
 */
export function readKb(workflow: {
  kb?: ReqdocKbState
  features?: { no: number; name: string; priority: "high" | "medium" | "low"; confirmedAt: number }[]
}): ReqdocKbState {
  const kb: ReqdocKbState =
    workflow.kb ??
    ({
      slots: [],
      features: workflow.features ?? [],
      containers: {},
      askCounts: {},
      updatedAt: 0,
    } satisfies ReqdocKbState)
  // 首次建库时记下模板的必填地址空间，供 `templateDrift` 检测「换了模板还在填旧地址」。
  // 只记一次：后续模板变更不得改写，否则漂移检测会自我抹平。
  // 此处**不落盘** kb.json（随工作流状态走，与 evidence 同理）。
  if (!kb.templateAddressSpace) {
    const s = templateSchema()
    // 模板不可读时不记地址空间：留待组装等硬路径显式报错。readKb 每轮被调，
    // 绝不能在这里抛（同 templateDrift 的理由）。
    if (s) kb.templateAddressSpace = schemaAddressSpace(s)
  }
  return kb
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
      `一次最多 ${QUESTIONS_PER_TURN} 项。` +
      "**返回里「已采信历史记忆」列出的地址不在清单里、也不要再问业务**——服务端已替你免问，" +
      "由你随后直接 reqdoc_answer 落定，**source 一律用「问答」**（定义出自业务过往口述，材料只出现该词、" +
      "并未给出定义；标「文档」等于在交付件上做不实溯源）。不落定则必填容器覆盖不过。" +
      "**只提交「本轮该填」清单里的地址——绝不整篇重提**：ingest 对每个提交的地址一律记为 draft 并把 askCount 归零，" +
      "把旧稿/上一版 PRD 整篇重新提交会让已确认槽位静默打回草稿、覆盖率崩塌、业务被迫重述整份需求；" +
      "要改已有槽位的内容用 reqdoc_answer（它保持 confirmed）。仅 reqdoc 工作流有效。",
    args: {
      slots: z
        .array(
          z.object({
            address: z.string().describe(
              `槽位地址（**只能取工具返回的「本轮该填」清单里的地址**，勿自造；当前模板的合法形状如 ${addrHint().leaf} / ${addrHint().feature} / ${addrHint().termLeaf}）`,
            ),
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
        .describe(
          "功能点清单（首次提交时给；已确认过则省略）。与 reqdoc_confirm_features 同为「整体替换 + 按序重编号」语义，" +
            "**给已有需求加功能时必须传「原清单 + 末尾追加的新功能」，不得插在中间、不得删除或改名**" +
            "（既有槽位的功能点地址按序号索引，具体地址取工具清单；改动会让地址漂移、业务被要求重述整份需求）。",
        ),
      candidates: z
        .record(z.string(), z.array(z.string()))
        .optional()
        .describe(
          `容器下的子项候选（如 ${addrHint().termContainer ? `{ "${addrHint().termContainer}": ["CRD","AML"]` : "{\"<容器地址>\": [\"CRD\",\"AML\"]"}` +
          `${addrHint().fieldContainer ? `, "${addrHint().fieldContainer}": ["客户号"]` : ""}）——` +
            "从材料中抽取到的术语/字段名。**这是记忆生效的必要条件**：命中 L1 术语记忆的候选会直接消缺口（不再问），" +
            "服务端才能据此少问。只填材料里真实出现的，不要臆造。",
        ),
      containers: z
        .record(z.string(), z.object({ required: z.boolean(), reason: z.string().optional() }))
        .optional()
        .describe(
          `容器声明（对**工具清单里标出的必填容器**声明；如 ${addrHint().termContainer || "<术语容器地址>"} / ${addrHint().fieldContainer || "<字段容器地址>"} 声明 required:false 表示本次无术语/无结构化字段，须给 reason）`,
        ),
    },
    async execute(args, context) {
      const root = projectRoot(context)
      const saved = store.mutateWorkflow(context.sessionID, (workflow) => {
        requireReqdoc(workflow, "reqdoc_ingest")
        const kb = readKb(workflow)
        // 功能点：给了就以它为准（首次或追加）。**纯追加校验**：地址按序号索引，
        // 已有槽位落在功能点地址域后再插入/删除/改名会让地址漂移 → 已确认内容错位、
        // 门禁判成未填 → 业务被迫重述整份需求。措辞与 reqdoc_confirm_features 共用同一份。
        if (args.features && args.features.length > 0) {
          const next = args.features.map((f, i) => ({
            no: i + 1,
            name: f.name,
            priority: f.priority,
            confirmedAt: Date.now(),
          }))
          const violation = featuresAppendViolation(kb.features, next, hasFeatureScopedSlots(kb.slots))
          if (violation) throw new WorkflowOpError(violation)
          kb.features = next
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
              `合法地址只有两类：① 工具返回的「本轮该填」清单里的地址（如 ${addrHint().leaf}、${addrHint().feature}）；` +
              `② 容器叶子（<容器地址>.<术语名>、<容器地址>.<字段名>，如 ${addrHint().termLeaf}）。\n` +
              `请先取本轮清单再提交，不要自造地址。\n` +
              `确实装不进模板的内容只有两条合法出路：① 该维度本次不涉及 → 用 containers 声明对应容器 ` +
              `${addrHint().termContainer || "<术语容器地址>"} / ${addrHint().fieldContainer || "<字段容器地址>"} 声明 {required:false, reason:"<理由>"}；② 它其实属于某个已有章节 → 归到该章节的具体地址。\n` +
              `**不要凭空造一个"附注/附录"章节**——本模板没有这种章节，凭空新增的内容不会出现在 PRD 里，等于悄悄丢失；` +
              `若两类都归不进去，如实告诉业务「这段内容模板装不下」，由业务决定删掉还是另立需求，不要自行处置。`,
          )
        }
        // 已确认槽位不可被 ingest 打回 draft：ingest 对提交的地址一律记 draft 并把 askCount
        // 归零，整篇重提旧稿会把已确认内容静默打回、覆盖率崩塌、业务被迫重述。
        // 这里**整批拒绝**而不是静默跳过——静默跳过会让模型以为改成功、实际没改，
        // 而 PRD 只渲染槽位，漏掉的更新会一路静默到交付件（与「无静默失败」相悖）。
        const alreadyConfirmed = args.slots
          .filter((s) => kb.slots.some((y) => y.address === s.address && y.status === "confirmed"))
          .map((s) => s.address)
        if (alreadyConfirmed.length > 0) {
          throw new WorkflowOpError(
            `本批包含已确认的槽位：${alreadyConfirmed.join("、")}。\n` +
              `reqdoc_ingest 对提交的地址一律记为待确认（并把 askCount 归零），用它改已确认内容会让业务被迫重述。\n` +
              `请把这些地址从本批移除；确需修改已确认内容，改用 reqdoc_answer(address, content, source)（它保持已确认）。`,
          )
        }
        // 定点修订（乙）作用域锁：进入 editScope 后只接受锁定章的地址，越界写入服务端拒收
        // （硬不变量，呼应 AGENTS.md「软约束不算不变量」；防模型走全量或误写他章）。
        if (kb.editScope?.active) {
          const ch = kb.editScope.chapter
          const out = args.slots.filter((s) => chapterOf(s.address) !== ch).map((s) => s.address)
          if (out.length > 0) {
            throw new WorkflowOpError(
              `已进入定点修订，作用域锁定在第 ${ch} 章：本批含越界地址 ${out.join("、")}。\n` +
                `请只提交第 ${ch} 章内的槽位；要改其它章请先结束本次定点修订（或另开会话）。`,
            )
          }
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
        chapter: kb.editScope?.active ? kb.editScope.chapter : undefined,
      })
      // 推进轮次：把本轮展示的地址计数 +1（6.3 按轮次计）
      const counts = advanceAskCounts(kb.askCounts ?? {}, derived.batch.map((q) => q.address))
      store.mutateWorkflow(context.sessionID, (workflow) => {
        if (workflow.kb) workflow.kb.askCounts = counts
      })
      const cov = kbCoverage(kb)
      const lines = derived.batch.map((q) => `  - ${q.address}${q.guess ? `（默认：${q.guess}）` : ""}`)
      return [
        // 模板不可用置顶（比漂移更前置：连地址都无从谈起），其次漂移告警
        templateUnavailableNotice() ?? "",
        templateDrift(saved.kb ?? {}) ?? "",
        `📥 已提交 ${args.slots.length} 个槽位（均为待确认 draft）；已写入 ${KB_DIR}/。`,
        `覆盖率：${cov}；本轮该填 ${derived.batch.length}/${derived.all.length} 项：`,
        ...(lines.length ? lines : ["  （无——全部槽位已确认）"]),
        derived.stopped.length > 0
          ? `⏸ 因连续 ${STOP_ASK_AFTER} 轮未确认已停问：${derived.stopped.map((q) => q.address).join("、")}（可由业务确认或定稿时 force 收口）`
          : "",
        // 记忆效果必须对模型可见，否则它会重复问已被记忆消缺口的项（「少问」机制形同虚设）
        derived.l1Applied.length > 0
          ? `🧠 已采信历史记忆，免问 ${derived.l1Applied.length} 项（定义来自过往需求中业务的复述；不在本轮清单、不必再问，由你直接 reqdoc_answer 落定，source=问答）：${derived.l1Applied.join("、")}`
          : "",
        hits.l2.length > 0
          ? `🧠 共享知识命中 ${hits.l2.length} 项（不消缺口，仅作默认值；仍要确认一次，问时带上默认值）：${hits.l2.map((f) => f.content).join("；")}`
          : "",
        "→ 清单里的项逐条确认后用 reqdoc_answer 落定；不要直接编辑 PRD 文件。",
      ]
        .filter(Boolean)
        .join("\n")
    },
  })

  const reqdoc_answer = tool({
    description:
      "reqdoc 槽位确认：把某一项请业务确认后的结论落定（状态转 confirmed）。" +
      "**接受派生清单（本轮该填/停问）给出的地址，也接受回执「已采信历史记忆」列出的地址**" +
      "（后者已替你免问、由你直接落定，source 用「问答」）；业务未答满 2 轮的项会被停问，此时应显式收口" +
      "（source=缺省 + reason 写明未确认原因），而不是反复追问。",
    args: {
      address: z.string().describe("槽位地址（来自本轮该填清单、停问清单，或回执「已采信历史记忆」列出的地址——后者不问业务、由你直接落定，source 用「问答」）"),
      content: z.string().describe("业务确认后的内容（业务语言，不照搬口语）"),
      source: z.enum(["文档", "问答", "缺省"]).describe("来源：文档 / 问答（业务口述）/ 缺省（本次不涉及）"),
      reason: z.string().optional().describe("source=缺省 时必填（如「本次无清算处理」）"),
      restated_term: z
        .object({
          term: z.string().describe("业务刚刚口头复述释义的缩写/简称（如 CRD）"),
          definition: z.string().describe("业务给出的释义（用业务原话，不要臆测润色）"),
          kind: z.enum(["行业通用", "系统口径", "内部简称"]).describe("分类：内部简称=行内叫法；系统口径=本系统约定；行业通用=通用行话"),
          business_quote: z
            .string()
            .describe(
              "**业务刚才的原话**（照抄听到的那句，不要改写成书面语）——与 force_reason / confirm_note 同一原则：**模型不得代填**。" +
                "L1 命中即免问、免问项由你自己落定、业务不再被问，写错会跨需求永久传播，故必须留可追查的凭据；" +
                "留空按拒写处理，不会静默入库。",
            ),
        })
        .optional()
        .describe(
          "【记忆】仅当业务**主动口头解释了某个缩写/简称**时才填（origin=restated），且 business_quote 必填。" +
            "下一个需求材料出现该词将直接采信、不再追问。**业务只是点了「同意默认」时绝对不要填**——" +
            "静默接受不入库，否则错误定义会跨需求传播。",
        ),
      confirmClear: z
        .boolean()
        .optional()
        .describe(
          "定点修订中，当空内容 answer 使锁定章的清空占比超过 50% 时，必须显式传 true 确认" +
            "（大范围删改须业务拍板；防用空内容绕过退役守卫悄悄清空一章）。",
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
              `② 容器叶子（<容器地址>.<术语名>、<容器地址>.<字段名>，如 ${addrHint().termLeaf}）。请先取本轮清单再回答。`,
          )
        }
        // 定点修订（乙）作用域锁：越界地址服务端拒收（硬不变量）。
        if (kb.editScope?.active && chapterOf(args.address) !== kb.editScope.chapter) {
          throw new WorkflowOpError(
            `已进入定点修订，作用域锁定在第 ${kb.editScope.chapter} 章：地址 ${args.address} 不在该章。` +
              `请只改第 ${kb.editScope.chapter} 章；要改其它章请先结束本次定点修订。`,
          )
        }
        // 对抗 F：confirmRetire 只看退役，空内容 answer 可绕过它清空整章——清空占比 >50% 同权须确认。
        if (kb.editScope?.active && args.content.trim() === "") {
          const ch = kb.editScope.chapter
          const ratio = chapterClearRatio(kb.slots, ch, [args.address])
          if (ratio > 0.5 && !args.confirmClear) {
            throw new WorkflowOpError(
              `定点修订中空内容将清空第 ${ch} 章的 ${Math.round(ratio * 100)}% 槽位（>50%）。` +
                `大范围删改须业务拍板：确属业务要求，传 confirmClear=true 重试；` +
                `若本意是退役槽位，用 reqdoc_memory_recall 的 retire_slots（大范围退役同样要 confirmRetire）——不要用空内容代替退役。`,
            )
          }
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
        // 连续接受默认的轮数（reqdoc-r27 的触发条件）。此前这个数**只存在于对话里**：
        // 服务端不存、状态条不显示，模型得自己跨轮数「同意默认」出现几次——弱模型
        // 不可靠，实测 9/34 场景仍带默认推荐。与 r14 同病：规则要求模型判断一个
        // 服务端未提供的信息。口径：收口为 [缺省] 即业务接受了这个默认 → +1；
        // 任何其它调用（给了具体意见）归零，连续即中断。
        kb.defaultAcceptStreak = args.source === "缺省" ? (kb.defaultAcceptStreak ?? 0) + 1 : 0
        kb.updatedAt = Date.now()
        workflow.kb = kb
      })
      // 记忆写入（3.6.1 ①）：业务复述 → 立即写 L1。origin 固定 restated——
      // 模型无法自行指定 origin，杜绝「点默认也入库」的污染路径。
      // business_quote（业务原话）必填：L1 命中即免问、免问项由模型自己落定、
      // 业务不再被问，污染不可逆且旧格式条目里只有模型的释义、无从追查谁说的。
      const mem = args.restated_term
        ? writeL1Term(args.restated_term.term, args.restated_term.definition, {
            kind: args.restated_term.kind,
            scope: "org",
            origin: "restated",
            fromProject: basename(root),
            businessQuote: args.restated_term.business_quote,
          })
        : null
      const memNote =
        mem?.ok === true
          ? `🧠 已记入 L1 术语记忆：${args.restated_term!.term} = ${args.restated_term!.definition}（下个需求出现该词将直接采信、不再问）`
          : mem?.ok === false && mem.reason === "missing_quote"
            ? `⚠ 术语「${args.restated_term!.term}」**未入库**：L1 记忆必须有业务原话作凭据（business_quote），` +
              `留空即拒写——记忆一入库就跨需求免问、业务不再被问，写错无法追查。` +
              `若业务确实口头解释过，请照抄那句原话重试；只是点了「同意默认」则不要写记忆。`
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
        chapter: kb.editScope?.active ? kb.editScope.chapter : undefined,
      })
      return [
        templateUnavailableNotice() ?? "",
        templateDrift(saved.kb ?? {}) ?? "",
        `✅ 已确认 \`${args.address}\`（来源 ${args.source}${args.reason ? `：${args.reason}` : ""}）。`,
        `覆盖率：${kbCoverage(kb)}；剩余本轮该填 ${derived.batch.length} 项。`,
        derived.unclosed.length > 0 ? `⚠ 仍未收口：${derived.unclosed.join("、")}` : "",
        derived.l1Applied.length > 0
          ? `🧠 已采信历史记忆，免问 ${derived.l1Applied.length} 项（定义来自过往需求中业务的复述；不在本轮清单、不必再问，由你直接 reqdoc_answer 落定，source=问答）：${derived.l1Applied.join("、")}`
          : "",
        memNote,
      ]
        .filter(Boolean)
        .join("\n")
    },
  })

  const reqdoc_start_scoped_edit = tool({
    description:
      "定点修订（乙）入口：锁定某一章后只引导该章。业务说「改第 N 章」且你已回显 PRD 章目录 + 标题 + 内容预览请其认领确认后，调此工具锁定。" +
      "锁定后 ingest/answer 越界被服务端拒收（硬不变量）；改完用 reqdoc_end_scoped_edit 释放，或用 reqdoc_export(mode, chapter) 导出差异。仅 reqdoc 工作流有效。",
    args: {
      chapter: z.number().describe("已与业务确认的要修改的 PRD 章号（如 2）；须先回显章目录请业务认领，不要凭空传。"),
    },
    async execute(args, context) {
      const root = projectRoot(context)
      const saved = store.mutateWorkflow(context.sessionID, (workflow) => {
        requireReqdoc(workflow, "reqdoc_start_scoped_edit")
        const kb = readKb(workflow)
        const schema = templateSchema()
        if (!schema?.chapters.some((c) => c.number === args.chapter)) {
          throw new WorkflowOpError(
            `章号 ${args.chapter} 不是合法 PRD 章号。合法章号见 PRD 模板（第一章到第七章）；请先回显章目录请业务确认后再锁定。`,
          )
        }
        // 冻结编辑前快照作差异基准，并绑定会话（会话结束即失效，杜绝跨会话残留误拒——对抗 B）
        kb.editScope = {
          chapter: args.chapter,
          snapshotBefore: kb.slots.map((s) => ({ ...s })),
          active: true,
          sessionId: context.sessionID,
          at: Date.now(),
        }
        workflow.kb = kb
      })
      const kb = readKb(saved)
      const schema = templateSchema()
      const title = schema?.chapters.find((c) => c.number === args.chapter)?.title ?? ""
      const derived = deriveQuestions(kb.features, { slots: kb.slots, chapter: args.chapter })
      return [
        `🔒 已进入定点修订，锁定第 ${args.chapter} 章《${title}》。编辑前快照已冻结（差异基准）。`,
        `后续只引导该章；ingest/answer 越界会被服务端拒收。改完用 reqdoc_end_scoped_edit 释放锁，或用 reqdoc_export(mode:"diff"|"chapter", chapter:${args.chapter}) 导出差异。`,
        `本轮该填（限第 ${args.chapter} 章）${derived.batch.length}/${derived.all.length} 项：`,
        ...derived.batch.map((q) => `  - ${q.address}${q.guess ? `（默认：${q.guess}）` : ""}`),
      ].join("\n")
    },
  })

  const reqdoc_end_scoped_edit = tool({
    description:
      "定点修订（乙）结束：释放作用域锁。业务确认改完、导出差异后调用；锁释放后 ingest/answer 恢复全章可写。仅 reqdoc 工作流有效。",
    args: {},
    async execute(_args, context) {
      store.mutateWorkflow(context.sessionID, (workflow) => {
        requireReqdoc(workflow, "reqdoc_end_scoped_edit")
        const kb = readKb(workflow)
        if (!kb.editScope) return
        kb.editScope = undefined
        workflow.kb = kb
      })
      return "🔓 已释放定点修订作用域锁，恢复全章可写。"
    },
  })

  const reqdoc_adopt_baseline = tool({
    description:
      "reqdoc 承认基线：把一份**已有需求书**（业务自己写的初稿，或本流程上一版 PRD）派生出的槽位" +
      "**一次性确认为已确认**，这样业务不必把稿里已有的内容再说一遍——之后只问真正的缺口。\n" +
      "**前置**：先用 reqdoc_ingest 把稿里的内容提交为槽位（source=文档、ref=该文件），" +
      "并把「稿里有、但本模板装不下的内容」逐条列进 unmapped（这是必须申报的，不申报本工具拒绝执行）。\n" +
      "**不带 confirm 先调一次做预演**：返回将要确认的清单（按章分组）与覆盖率变化，给业务看过再执行；\n" +
      "确认时必须给 authorized_by（谁确认的）与 confirm_note（业务确认原话），**这两项模型不得代填**。\n" +
      "**不会豁免任何必填项**：基线没覆盖到的必填地址照旧进「本轮该填」照常问。" +
      "仅 reqdoc 工作流有效。",
    args: {
      file: z.string().describe("基线文件路径（相对项目根，须在工作区内；槽位的 ref 须指向它）"),
      addresses: z
        .array(z.string())
        .optional()
        .describe("要确认的地址；省略 = 全部 ref 指向该文件且仍是待确认的槽位"),
      confirm: z.boolean().optional().describe("省略 = 预演（只报清单与覆盖率变化，不改状态）；true = 执行"),
      authorized_by: z.string().optional().describe("confirm=true 时必填：确认人（业务方），模型不得代填"),
      confirm_note: z.string().optional().describe("confirm=true 时必填：业务确认的原话摘要（审计用），模型不得代填"),
      unmapped: z
        .array(
          z.object({
            excerpt: z.string().describe("稿里有、但本模板装不下的内容（原文摘录）"),
            disposition: z.string().describe("处置：本次不纳入（理由）/ 归入某地址 / 待业务决定"),
          }),
        )
        .describe(
          "**必须申报**（可为空数组）：稿里哪些内容放不进本模板，逐条给处置。" +
            "PRD 只渲染已登记的需求要点，装不下的内容若不申报就会静默消失——" +
            "宁可显式告诉业务「这段模板装不下」，也不要自行处置。",
        ),
    },
    async execute(args, context) {
      const root = projectRoot(context)
      const relFile = args.file.replace(/\\/g, "/").replace(/^\.\//, "")
      const abs = resolveWithinWorktree(root, relFile)
      const saved = store.mutateWorkflow(context.sessionID, (workflow) => {
        requireReqdoc(workflow, "reqdoc_adopt_baseline")
        const kb = readKb(workflow)
        if (!existsSync(abs)) {
          throw new WorkflowOpError(`基线文件不存在：${args.file}（工作区根 ${root}）`)
        }
        const target = kb.slots.filter(
          (s) => args.addresses ? args.addresses.includes(s.address) : !!s.ref?.includes(relFile),
        )
        if (target.length === 0) {
          throw new WorkflowOpError(
            `没有可确认的槽位：既没有 ref 指向「${args.file}」的槽位，addresses 也没命中。\n` +
              `先用 reqdoc_ingest 提交该稿的内容（source=文档、ref=该文件路径），再调用本工具。`,
          )
        }
        // 只认文档来源、且源就是这个基线文件的槽位——「记忆免问」落定的那批是 [问答]，
        // 拿它们冒充基线等于把旧需求的说辞写成本次的书面依据（不实溯源）。
        const notFromBaseline = target.filter((s) => s.source !== "文档" || !s.ref?.includes(relFile))
        if (notFromBaseline.length > 0) {
          throw new WorkflowOpError(
            `这些槽位不能作为基线确认：${notFromBaseline.map((s) => `${s.address}(来源${s.source}/ref:${s.ref ?? "无"})`).join("、")}。\n` +
              `基线确认只接受 source=文档 且 ref 指向「${args.file}」的槽位。`,
          )
        }
        const alreadyConfirmed = target.filter((s) => s.status === "confirmed")
        if (args.confirm !== true) {
          return
        }
        if (!args.authorized_by?.trim() || !args.confirm_note?.trim()) {
          throw new WorkflowOpError(
            `执行确认必须给 authorized_by（谁确认的）与 confirm_note（业务确认原话）——**这两项模型不得代填**，` +
              `照 force_kb/force_reason 的先例：理由必须来自业务。先不带 confirm 预演，把清单给业务看过再执行。`,
          )
        }
        for (const s of target) {
          if (s.status === "confirmed") continue
          s.status = "confirmed"
          s.askCount = 0
        }
        if (kb.askCounts) for (const s of target) delete kb.askCounts[s.address]
        // 快照只冻一次（基准是这次承认的基线，不是上一版定稿——后者会掩盖本次的真实改动面）
        if (!kb.baselineSnapshot) {
          kb.baselineSnapshot = {
            file: relFile,
            slots: target.map((s) => ({ ...s })),
            features: kb.features.map((f) => ({ ...f })),
            at: Date.now(),
          }
        }
        kb.updatedAt = Date.now()
        // 新基线强清定点修订锁：承认新基线后旧的 editScope 快照基准已失准，须重新进入（对抗 B）
        kb.editScope = undefined
        workflow.kb = kb
        void alreadyConfirmed
      })
      const kb = readKb(saved)
      await writeKbFiles(root, kb)
      const base = relFile.split("/").pop() ?? relFile
      const target = args.addresses
        ? kb.slots.filter((s) => args.addresses!.includes(s.address))
        : kb.slots.filter((s) => s.ref?.includes(relFile))
      const pending = target.filter((s) => s.status !== "confirmed")
      const already = target.length - pending.length
      // 按章分组：业务看的是「哪一块」，不是 40 行明细
      const byChapter = new Map<string, string[]>()
      for (const s of pending) {
        const ch = s.address.split(".")[0]
        byChapter.set(ch, [...(byChapter.get(ch) ?? []), s.address])
      }
      return [
        // 模板不可用时本工具派生出的 target 恒为空，用户会看到「（无待确认项）」
        // 然后莫名以为基线已沿用——那是空承诺，须说清真因。
        templateUnavailableNotice() ?? "",
        args.confirm === true
          ? `✅ 已按业务授权承认基线「${base}」：${pending.length} 项由待确认转为已确认${already > 0 ? `（另有 ${already} 项本就已确认，未重复处理）` : ""}。`
          : `🔎 预演：若确认，将把「${base}」派生的 ${pending.length} 项由待确认转为已确认${already > 0 ? `（另有 ${already} 项已是已确认，不动）` : ""}。`,
        pending.length > 0
          ? [...byChapter.entries()].map(([ch, addrs]) => `  第 ${ch} 章 ${addrs.length} 项：${addrs.join("、")}`)
          : "  （无待确认项）",
        args.confirm === true ? "" : "以上清单请给业务逐条看过，业务确认后再带 confirm=true、authorized_by、confirm_note 执行。",
        `覆盖率：${kbCoverage(kb)}（承认基线不豁免任何必填项）。`,
        args.unmapped.length > 0
          ? `⚠ 已申报的「稿里有、模板装不下」内容 ${args.unmapped.length} 条：\n` +
            args.unmapped.map((u) => `  - ${u.excerpt} → ${u.disposition}`).join("\n") +
            `\n  这些内容不会进入需求书（PRD 只渲染已登记的需求要点），处置结论请写进变更记录并告知业务。`
          : "已申报：稿中内容都能放进模板（无归宿内容 0 条）。",
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
      // 政策与模板不匹配（如机构改了模板小节标题）：必须让业务看见——
      // 否则被跳过的必填项一路静默到定稿，表现为「明明没问却门禁拦下」。
      // 位置在 `assembleInto` **之后**是刻意的：模板不可读时上面已经抛了硬错误，
      //这里只轮得到「模板可读但政策对不上」这一种。挪到 assemble 之前会变成
      // 提示路径先抛、掩盖了真正该报的组装失败——顺序依赖，显式说明以防后人踩。
      const policyMiss = requireTemplateSchema().unresolvedPolicy
      return [
        templateUnavailableNotice() ?? "",
        templateDrift(kb) ?? "",
        policyMiss.length > 0
          ? `⚠ 政策与模板不匹配：${policyMiss.length} 个小节标题在模板里找不到（${policyMiss.join("、")}）` +
            `——可能机构改了模板标题。已跳过对应必填项，不计入本轮覆盖率；若这些维度本次仍需要，请在模板里恢复该标题或告知业务。`
          : "",
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
          `可选：本次已写入记忆、后续不必再问的**槽位地址**（如 ${addrHint().feature ? `["${addrHint().feature}"]` : "[]"}，地址取工具清单）。` +
            "被退役的槽位不再进开放项、也不计入覆盖率——只填确实已进记忆的，填错会导致门禁永远不通过。",
        ),
      confirmRetire: z
        .boolean()
        .optional()
        .describe(
          "定点修订中，当拟退役的槽位将使锁定章的 retired 占比超过 50% 时，必须显式传 true 确认" +
            "（大范围删改须业务拍板，防模型用「替换成空 / 批量退役」悄悄清空一章）。",
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
        // 定点修订（乙）retirement 守卫：锁定章内拟退役超 50% 须显式确认
        // （防「替换成空 / 批量退役」悄悄清空一章；守卫查占比而非仅 retired 状态）。
        if (workflow.kb?.editScope?.active) {
          const ch = workflow.kb.editScope.chapter
          const inScope = retireAddrs.filter((a) => chapterOf(a) === ch)
          if (inScope.length > 0) {
            const ratio = chapterRetireRatio(workflow.kb.slots, ch, inScope)
            if (ratio > 0.5 && !args.confirmRetire) {
              throw new WorkflowOpError(
                `定点修订中拟退役第 ${ch} 章 ${inScope.length} 个槽位，将使该章 retired 占比达 ${Math.round(ratio * 100)}%（>50%）。` +
                  `这是大范围删改，须显式确认：重调并传入 confirmRetire:true（表明业务确实要放弃该章过半内容）。`,
              )
            }
          }
        }
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

  return {
    reqdoc_ingest,
    reqdoc_answer,
    reqdoc_start_scoped_edit,
    reqdoc_end_scoped_edit,
    reqdoc_adopt_baseline,
    reqdoc_assemble,
    reqdoc_memory_recall,
  }
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