/**
 * reqdoc PRD 组装（设计文档 6.2.1.2「assemble 对空内容与空节的渲染规则」第 1 层实现）。
 *
 * 核心原则（设计 2.3/2.4）：**文档是构建产物，槽位是唯一事实源**。
 * 组装是纯函数——同样的槽位必然产出同样的文档；文档被手改后重跑组装会得到
 * 不同的摘要，`review_submit` 据此区分「过期构建产物」与「产物被手改」（设计 9.3 三分支）。
 *
 * 边界：`templateText` 由调用方传入（模板读取在 plugin 层 `template.ts`，
 * 按 `import.meta.dir` 上溯三级找 `docs/`，与 `buildPrdSkeleton` 同边界）。
 */
import { createHash } from "node:crypto"
import { MAPPED_FIELD_KEYS, buildPrdSkeleton } from "./reqdoc-render"
import type { ReqdocFeature } from "./workflow"
import {
  aggregateSourceTag,
  docAddrOf,
  isContainerAddr,
  type ContainerDecl,
  type ReqdocSlot,
} from "./reqdoc-slots"

/** 组装选项。 */
export interface AssembleOptions {
  /** 容器声明（可为空通道）：全空的 `required:false` 容器整节省略 */
  containers?: Readonly<Record<string, ContainerDecl>>
}

/** 组装结果：正文 + 摘要（供幂等校验）+ 结构指纹（golden 比对）。 */
export interface AssembleResult {
  /** PRD Markdown 正文 */
  md: string
  /** 槽位摘要：address|status|source|reason|content 规范化后 SHA-256（前 16 位） */
  digest: string
  /** 结构指纹：章节顺序 + 功能点块数 + 每块子小节地址 + 各节来源标签（不含文字，可稳定比对） */
  fingerprint: {
    chapters: string[]
    featureCount: number
    subSections: string[]
    tags: Record<string, string>
  }
  /** 本次组装省略掉的空容器节（可为空通道） */
  omittedContainers: string[]
}

/** 有效槽位（排除 retired——已作废留痕但不参与渲染）。 */
function active(slots: readonly ReqdocSlot[], addr: string): ReqdocSlot[] {
  return slots.filter((s) => docAddrOf(s.address) === addr && s.status !== "retired")
}

/**
 * 取某地址的正文：优先 confirmed，其次 draft；无内容返回空串。
 *
 * 结构行转义在此统一进行（I-2）——prose 正文同样内插进 markdown，
 * 一个 `## 第九章` 就能造出新章节并绕过全部三重校验（它们只验「槽位 ↔ 产物一致」，
 * 而产物正是由本函数生成的）。
 */
function bodyOf(slots: readonly ReqdocSlot[], addr: string): string {
  const list = active(slots, addr)
  const confirmed = list.find((s) => s.status === "confirmed")
  const chosen = confirmed ?? list[0]
  return chosen ? escapeStructural(chosen.content.trim()) : ""
}

/**
 * 槽位摘要（幂等校验基准，9.3）：按 address 排序后规范化取 SHA-256。
 * 规范化抹去书写差异（空白/换行），只对"实质内容 + 状态 + 来源"敏感。
 */
export function kbDigest(slots: readonly ReqdocSlot[]): string {
  const norm = slots
    .filter((s) => s.status !== "retired")
    .map((s) => `${s.address}|${s.status}|${s.source}|${s.reason ?? ""}|${s.content.replace(/\s+/g, " ").trim()}`)
    .sort()
    .join("\n")
  return createHash("sha256").update(norm, "utf8").digest("hex").slice(0, 16)
}

/**
 * 内容里的 **markdown 结构行**检测（对抗审查 I-2）。
 *
 * 槽位正文是业务语言需求描述，禁掉所有换行不现实；但**标题行与表格行会改变文档结构**——
 * 子键已焊死（`isValidSlotAddr`），值却是敞开的：`content` 里塞一个
 * `## 第九章 伪造章节` 就能把伪造内容送进 Word 交付件，且 kbDigest / LCS / 定稿三重校验全部放行
 * （它们只看「槽位 ↔ 产物是否一致」，而产物正是由这个 content 生成的——自证）。
 *
 * 规则：拒绝以 `#` / `|` 开头的行（标题、表格）。普通段落、列表、换行照常允许。
 */
export function hasStructuralMarkdown(text: string): boolean {
  return text
    .split(/\r?\n/)
    .some((line) => /^\s*(#{1,6}\s|\|)/.test(line))
}

/** 容器节正文：术语容器渲染术语表，字段容器渲染字段清单（均为子项聚合视图）。 */
function containerBody(slots: readonly ReqdocSlot[], container: string): string {
  const children = active(slots, container).sort((a, b) => a.address.localeCompare(b.address))
  if (children.length === 0) return ""
  // 内容里的标题/表格行会被转义——它们只在正文里是字面量，不应改变文档结构（I-2）
  const body = (c: ReqdocSlot) => `- **${slotName(c.address, container)}**：${escapeStructural(c.content.trim())}`
  return children.map(body).join("\n")
}

/**
 * 把内容里的 markdown 结构行降级为字面量：`## 伪造章节` → `\#\# 伪造章节`。
 * 保留语义（读者仍能看出那是标题文本）但不再被解析成新章节。
 */
function escapeStructural(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (/^\s*(#{1,6}\s|\|)/.test(line) ? line.replace(/^(\s*)(#{1,6}\s|\|)/, "$1\\$2") : line))
    .join("\n")
}

/** 取槽位子键（术语名 / 字段名）。 */
function slotName(addr: string, container: string): string {
  return addr.startsWith(`${container}.`) ? addr.slice(container.length + 1) : addr
}

/** 该地址是否必标来源（映射字段）。 */
function requiresTag(addr: string): boolean {
  const m = addr.match(/^5\.\d+\.(\d+)\.(\d+)$/)
  if (!m) return false
  return MAPPED_FIELD_KEYS.includes(`${m[1]}.${m[2]}`)
}

/**
 * 组装整篇 PRD。
 *
 * 空内容渲染规则（6.2.1.2）：
 * - prose 有内容 → 正常写正文
 * - prose 空 → **留空标题、正文为空**，标 `[缺省：<理由>]`
 * - 映射字段空 → 同上，且**仍受"必标来源"约束**（空节也须带标签）
 * - 容器节全空且 `required:false` → **整节省略**，不渲染标题
 */
export function assembleDoc(
  slots: readonly ReqdocSlot[],
  features: readonly ReqdocFeature[],
  templateText: string | null,
  opts: AssembleOptions = {},
): AssembleResult | null {
  const skeleton = buildPrdSkeleton(templateText, features)
  if (skeleton === null) return null

  const containers = opts.containers ?? {}
  const omittedContainers: string[] = []
  const tags: Record<string, string> = {}
  const subSections: string[] = []

  // 逐节填充：按骨架里的标题顺序走，替换正文 + 写来源标签
  const lines = skeleton.split("\n")
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (!heading) {
      out.push(line)
      i++
      continue
    }
    // 标题原文里的编号（3.1 / 5.1.2.3）
    const addr = heading[2]!.match(/^(\d+(?:\.\d+)*)\s/)?.[1]
    const titleText = heading[2]!.trim()
    // 收集本节原有正文（到**下一个任意标题**为止——逐节处理，不跨节合并）
    const body: string[] = []
    i++
    while (i < lines.length) {
      if (/^#{1,6}\s/.test(lines[i]!)) break
      body.push(lines[i]!)
      i++
    }

    if (!addr) {
      // 无编号标题（封面/文档说明/功能点块内非编号行）→ 原样保留
      out.push(line, ...body)
      continue
    }
    // 容器节：全空且声明可为空 → 整节省略（**在 push subSections 之前**，否则指纹会含被略节）
    if (isContainerAddr(addr)) {
      const decl = containers[addr]
      const children = active(slots, addr)
      if (children.length === 0 && decl?.required === false) {
        omittedContainers.push(addr)
        continue
      }
    }
    subSections.push(addr)

    const newBody = isContainerAddr(addr) ? containerBody(slots, addr) : bodyOf(slots, addr)
    const label = labelFor(slots, addr, newBody, requiresTag(addr))
    tags[addr] = label
    out.push(`${heading[1]} ${titleText} ${label}`.trimEnd())
    if (newBody) out.push("", newBody, "")
    else out.push("") // 空正文：留空标题，不写占位文字
  }

  const digest = kbDigest(slots)
  // 摘要内嵌进产物头部，供定稿时区分「过期」与「被手改」（9.3 三分支）
  const body = out.join("\n").replace(/\n{3,}/g, "\n\n").trim()
  const md = `<!-- kb-digest: ${digest} -->\n\n${body}\n`
  return {
    md,
    digest,
    fingerprint: {
      chapters: lines.filter((l) => /^##\s/.test(l)).map((l) => l.trim()),
      featureCount: features.length,
      subSections,
      tags,
    },
    omittedContainers,
  }
}

/**
 * 节标签（6.2.2 聚合最弱档）：容器取子项聚合，映射字段即使为空也须带标签。
 * 非映射字段且有内容时省略标签（保持模板正文干净）。
 */
function labelFor(
  slots: readonly ReqdocSlot[],
  addr: string,
  body: string,
  requires: boolean,
): string {
  if (isContainerAddr(addr)) {
    const children = active(slots, addr)
    if (children.length === 0) return "[缺省：本节无内容]"
    return aggregateSourceTag(children).tag
  }
  const self = active(slots, addr)
  if (self.length > 0) {
    const confirmed = self.find((s) => s.status === "confirmed")
    if (confirmed) {
      const tag = aggregateSourceTag([confirmed]).tag
      // 非映射字段不必逐节标来源（否则正文噪声过大）
      return requires ? tag : ""
    }
  }
  if (requires || !body) return "[缺省：未确认]"
  return ""
}

/** 组装幂等校验（9.3 三分支）：比对摘要区分「过期构建产物」与「产物被手改」。 */
export type AssembleVerdict = "consistent" | "stale" | "tampered"

export function verifyAssemble(
  current: readonly ReqdocSlot[],
  recordedDigest: string,
  previousDigest: string,
): AssembleVerdict {
  const now = kbDigest(current)
  if (now === recordedDigest) return "consistent"
  // 槽位变了而摘要对不上 → 产物过期（槽位为准，产物需重建）
  if (previousDigest && now !== previousDigest) return "stale"
  return "tampered"
}