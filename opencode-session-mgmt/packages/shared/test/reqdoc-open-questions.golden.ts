/**
 * reqdoc 开放项清单 golden 规格（设计文档 4.4 第 1 层 golden 的**数据**部分）。
 *
 * 目的：冻结"应有开放项"的权威预期，作为重构期"少问 vs 漏问"的比对基线。
 * 核心价值：重构的目标是**少问**，但"少问"与"漏问"在指标上同形——唯一区分办法是
 * 拿新旧两份开放项清单做逐地址等价性比对。**多一个 = 少问了（可疑），少一个 = 漏问了（回归）**。
 *
 * 严格约束（设计 4.4 陷阱警告）：本文件是**从设计意图手工推导**的冻结清单，
 * **不是跑一遍现实现录下来的**。否则会把当前 bug 固化成基线，漏问检测形同虚设。
 * 推导依据：模板必填字段（`REQDOC_TEMPLATE_CHAPTERS` 各章 sections）+ 7 条追问探针
 * （`REQDOC_PROBES`）+ 渲染映射字段（`MAPPED_FIELD_KEYS`，每功能点必填来源标注）。
 *
 * 状态：本文件在阶段 0 建立；随阶段 1 的 `deriveOpenQuestions` 落地，由
 * `reqdoc-open-questions.test.ts` 比对"实现输出 ≡ 本清单"。阶段 1 之前不参与运行断言。
 */

/** 槽位地址类型：章节级（3.x/4.x/6.x/7.x）或功能点子小节级（5.k.g.s）。 */
export type SlotAddress = string

/**
 * 场景 A「无记忆基线」：全新需求、业务尚未确认任何槽位时的应有开放项。
 * 推导：每个必填章节/字段各一个开放项；不含已由材料 `[文档]` 自动填的槽位
 * （本基线假设纯口述起步，材料扫描后 draft 槽位仍进开放项等待确认）。
 */
export const BASELINE_OPEN_QUESTIONS: readonly SlotAddress[] = [
  // 第三章 需求概述（模板 sections 全必填）
  "3.1", "3.2", "3.3", "3.4", "3.5", "3.6",
  // 第四章 术语定义 / 业务规则（术语容器本身不进开放项，见 6.2.1.1；此处为其下的典型叶子）
  "4.1", "4.2",
  // 第五章 每功能点必填子小节：简要概述 + 控制要求 + 10 个映射字段 + 流程图
  // （以单功能点 5.1.* 为代表；多功能点按 5.k.* 展开）
  "5.1.1.1", "5.1.1.2",
  "5.1.2.1", "5.1.2.2", "5.1.2.3", "5.1.2.6", "5.1.2.7",
  "5.1.2.8", "5.1.2.9", "5.1.2.11", "5.1.2.12", "5.1.2.13",
  // 第六章 非功能需求（模板 sections 全必填）
  "6.1", "6.2", "6.3", "6.4",
  // 第七章 验收标准（模板 sections 全必填）
  "7.1", "7.2",
]

/**
 * 场景 B「有记忆期望」：给定 L1 术语记忆（CRD=信贷审批部），哪些开放项**应消失**。
 * 推导：L1 命中把 `4.1`（术语定义容器）下的 CRD 叶子置 confirmed、**消缺口**；
 * 其余开放项**必须仍在**（验证"L1 只消自己的缺口，不误伤别人"这条权限线）。
 * 结构：`{ expectedVanished: 应消失的地址, expectedRemain: 必须仍开放的关键地址 }`。
 */
export const MEMORY_L1_EXPECTATION = {
  /** 消缺口的地址（仅 4.1 容器——因 CRD 术语已确认） */
  expectedVanished: ["4.1"] as const,
  /** 必须仍在的开放项（抽样验证 L1 未越权消缺口） */
  expectedRemain: ["3.1", "3.6", "5.1.2.1", "5.1.2.13", "6.1", "7.1"] as const,
}

/**
 * 场景 B'「L2 记忆期望」：给定 L2 组织知识（如已知对外接口 CIPS），哪些开放项**不应消失**。
 * 推导：L2 命中**只作 draft**（6.2/3.6 规则 2），**仍被问一次**但带默认猜测。
 * 结构：`{ mustRemainOpen: 必须仍开放的地址 }`。
 */
export const MEMORY_L2_EXPECTATION = {
  /** L2 不消缺口——这些地址即使有 L2 命中也必须仍在开放项里 */
  mustRemainOpen: ["5.1.2.11"] as const,
}

/**
 * 场景 C「冲突场景期望」：记忆与材料对同一术语给出不同定义时的应有行为（6.4）。
 * 推导：槽位进入 `conflict`，**两侧都不装**、**不算覆盖**、**不出现在 PRD 正文**，
 * 但**仍计入未收口项**（force 才能放行）。
 */
export const CONFLICT_EXPECTATION = {
  /** 冲突时该地址不进 PRD 正文（渲染为空节 + [缺省：冲突未裁决]） */
  emptyRenderAddresses: ["4.1"] as const,
  /** 冲突槽位计入未收口项，未 force 则 review_submit 拦截 */
  countsAsUnclosed: true as const,
}

/**
 * 四必含用例的断言清单（设计 4.4）。`impl` 列为阶段 1 的实现挂点，阶段 0 只冻结语义。
 * 四个用例中只有"CRD"和"漏问检测"依赖 `deriveOpenQuestions`；AML/猜错固化依赖记忆层纯函数。
 */
export const GOLDEN_CASES = [
  {
    id: "crd-l1-vanishes",
    desc: "材料含 CRD + 全局库有 CRD → 4.1 容器 confirmed 且不在开放项",
    asserts: ["4.1 不在开放项", "containerCovered('4.1') 为真"],
    dependsOn: "deriveOpenQuestions + containerCovered",
  },
  {
    id: "aml-industry-term",
    desc: "行业通用缩写（AML/KYC）不产生定义要求（验 kind 分类生效）",
    asserts: ["AML 不进开放项", "不要求用户定义 AML"],
    dependsOn: "记忆层 kind 分类",
  },
  {
    id: "guess-corrected",
    desc: "猜错定义被纠正确认后入 glossary，下次命中用的是纠正值（防污染回归）",
    asserts: ["纠错后 glossary 存纠正值", "下次命中返回纠正值而非错误值"],
    dependsOn: "记忆层读写 + 纠错路径",
  },
  {
    id: "no-under-ask",
    desc: "与冻结基线逐地址相等——多一个=少问了(可疑)，少一个=漏问了(回归)",
    asserts: ["实现输出 === BASELINE_OPEN_QUESTIONS"],
    dependsOn: "deriveOpenQuestions",
  },
] as const
