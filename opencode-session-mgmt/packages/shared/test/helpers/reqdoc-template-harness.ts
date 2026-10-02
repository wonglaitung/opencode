/**
 * 换模板测试的公共装置。
 *
 * 生产派生函数（`requiredSlots` / `isContainerAddr` / `buildPrdSkeleton` …）都是
 * 「读已加载模板」的纯函数，要验证它们在**另一份模板**下的行为，就得把那份模板的
 * 结构显式传进去。各函数的可选 `schema` 形参就是为此存在——缺省仍读真实模板，
 * 既有调用点零改动。
 */
import { buildPrdSkeleton as skeleton, parseRenderStructure as parse } from "../../src/reqdoc-render"
import { assembleDoc as assemble } from "../../src/reqdoc-assemble"
import {
  isContainerAddr as containerAddr,
  requiredChapterAddrs as chapterAddrs,
  requiredContainers as containers,
  requiredSlots as slots,
} from "../../src/reqdoc-slots"
import { featureAddr, type TemplateSchema } from "../../src/reqdoc-template-schema"

import { parseTemplateSchema } from "../../src/reqdoc-template-schema"

export { parseTemplateSchema }
export { requiredSlots, requiredChapterAddrs, requiredContainers, isValidSlotAddr } from "../../src/reqdoc-slots"
export type { TemplateSchema }

/** 功能点子节绝对地址（生产函数原样调用）。 */
export const featureAddrOf = (s: TemplateSchema, bi: number, rel: string): string => featureAddr(s, bi, rel)

/** 第 bi 个功能点块（0 起）的字段容器绝对地址。 */
export const featureContainerAbs = (s: TemplateSchema, bi: number): string =>
  featureAddr(s, bi, s.featureContainerRels[0] ?? "1.1")

/** 章内必填小节地址集合（去容器，生产函数原样调用）。 */
export const docSectionAddrsOf = (s: TemplateSchema): ReadonlySet<string> => new Set(chapterAddrs(s))

/** 容器判定（生产函数原样调用）。 */
export const isContainerAddrOf = (s: TemplateSchema, addr: string): boolean => containerAddr(addr, s)

/** 必填叶子（生产函数原样调用）。 */
export const requiredSlotsOf = (s: TemplateSchema, features: readonly { no: number; name: string; priority: "high" | "medium" | "low"; confirmedAt: number }[]): string[] =>
  slots(features, s)

/** 必填容器（生产函数原样调用）。 */
export const requiredContainersOf = (s: TemplateSchema, features: readonly { no: number; name: string; priority: "high" | "medium" | "low"; confirmedAt: number }[]): string[] =>
  containers(features, s)

/** 骨架生成（生产函数原样调用，显式传 schema）。 */
export const skeletonOf = (
  templateText: string,
  features: readonly { no: number; name: string; priority: "high" | "medium" | "low"; confirmedAt: number }[],
  s: TemplateSchema,
): string | null => skeleton(templateText, features, s)

/** 渲染结构解析（生产函数原样调用，显式传 schema）。 */
export const parseOf = (md: string, s: TemplateSchema) => parse(md, s)
/** 槽位组装（生产函数原样调用，显式传 schema）。 */
export const assembleOf = (
  slots: readonly { kind: "prose" | "term" | "field"; address: string; content: string; source: "文档" | "问答" | "缺省"; status: "draft" | "confirmed" | "conflict" | "retired"; reason?: string }[],
  features: readonly { no: number; name: string; priority: "high" | "medium" | "low"; confirmedAt: number }[],
  templateText: string,
  s: TemplateSchema,
  containers?: Record<string, { required: boolean; reason?: string }>,
) => assemble(slots, features, templateText, { schema: s, containers })
