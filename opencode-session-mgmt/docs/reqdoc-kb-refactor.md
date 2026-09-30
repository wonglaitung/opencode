# reqdoc 重构设计 · 核心架构

> **性质**：目标架构设计（提案），**尚未实施**。当前实现仍以 [workflow-reqdoc.md](workflow-reqdoc.md) 为准。
>
> **背景动因**：业务投料含组织内部术语（如 CRD=信贷审批部）时，追问环节反复询问"CRD 是什么"；
> 现有流程经多轮增量修补，规则与校验函数持续膨胀，需要一次整体重构。

## 阅读顺序

本设计因内容增长已拆为四份（原始单文件曾达 1161 行，约为 `workflow-reqdoc.md` 的 2.4 倍，
继续单文件迭代会持续漏检交叉矛盾）：

| # | 文件 | 内容 | 什么时候读 |
|---|------|------|-----------|
| ① | **本文** `reqdoc-kb-refactor.md` | 问题诊断、目标架构（槽位模型、文档即构建产物） | **先读这份**，其余三份都依赖它 |
| ② | [reqdoc-memory-design.md](reqdoc-memory-design.md) | 记忆分层（存/写/用/防污染）、跨工作流共享、回归证据与 golden 集、上下文预算 | 关心"追问为什么变少""怎么证明没变差" |
| ③ | [reqdoc-context-budget.md](reqdoc-context-budget.md) | 三条上下文通道、五条封顶机制、实测数字 | 关心"会不会撑爆小模型上下文" |
| ④ | [reqdoc-kb-migration.md](reqdoc-kb-migration.md) | 目录落盘、派生算法、工具契约、状态与门禁、规则重构、迁移回滚、落地次序、验收标准、未决项 | 动手实现前必读 |

交叉引用约定：`《核心》2.2` 指本文、`《记忆》3.6` 指 ②、`《预算》7.4` 指 ③、`《迁移》6.3` 指 ④。

## 已定决策（讨论中确认，不再重议）

1. 门禁改读**服务端派生值**，不再读模型自评分
2. 五阶段键 `["goal","rules","edge","prd","review"]` **不变**
3. 知识库落**需求资料目录内**
4. 允许重构与删除，不设"只加不改"约束
5. 记忆按**污染风险分层**；仅 L1 身份性事实可消缺口
6. 上下文封顶在**工具层强制**，不靠规则文本叮嘱
7. 记忆机制**按跨工作流共享设计**（`scope` 字段），硬约束（技术选型）不入记忆，归规约

---

## 1. 问题诊断

### 1.1 同一现实存在五份平行表示

reqdoc 流程里"我们知道什么、还缺什么"被同时记录在五处，每处各有自己的完整性口径：

| # | 表示 | 位置 | 记录内容 | 写入工具 |
|---|------|------|----------|----------|
| 1 | 材料 | 磁盘 `01_背景与目标`~`05_系统现状与能力` + 扫描文本 | 业务投的原始材料 | 业务放文件 → `reqdoc_scan` |
| 2 | probes | `WorkflowState.probes` | 7 探针：问过什么、还缺什么 | `reqdoc_probe` |
| 3 | score | `WorkflowState.score` | 八维得分 + 扣分明细 + 业务确认 | `reqdoc_score` |
| 4 | fieldDict | `WorkflowState.fieldDict` + `数据字典.md` | 字段名/类型/必填/取值/来源系统 | `reqdoc_field_dict` |
| 5 | render + provenance | `WorkflowState.render` / `.renderProvenance` + PRD 正文 | 逐字段填没填、来源标了什么 | `reqdoc_render_skeleton` + `reqdoc_patch` + `reqdoc_check` |

### 1.2 规则库大半在做对账

五份表示必须互相对齐，于是产生一整族一致性规则与校验函数：

- probes ↔ score：报缺口却打满分 → `probeGapViolations`（reqdoc-r21 铁律）
- score ↔ render：标 `[缺省]` 的字段对应维度却满分 → `renderGapViolations`
- fieldDict ↔ score：material 维扣分联动 → reqdoc-r31 双门禁
- render ↔ 模板：章节/块数/来源标注 → `renderStructureViolations`（reqdoc-r23）
- render ↔ 文档支撑：全 `[问答]` 无 `[文档]` → `noDocumentSupportViolation`（reqdoc-r24）
- 字段完整性：裸 `[缺省]` → `missingDefaultReasonViolations`；模板一致性 → `consistencyViolations`；可实施性 → `scoreDimZeroViolations`

**这才是"补丁感"的来源**：不是规则写多了，而是维持多份平行账本的一致性，
规则数量必然随维度数相乘增长。当前 reqdoc 规则 32 条、专属工具 12 个、违规校验函数 7 个。

### 1.3 门禁设计诱导过度追问

`score.total ≥ 85` 才能进 prd + 缺口必须问 + 某维 0 分硬拦。对小模型而言：
猜错 = 扣分 = 被门禁拦；追问 = 无成本。**连环追问是激励结构的必然产物，不是模型行为缺陷。**
CRD 被反复问，本质是"知识没有沉淀物"，每次都要从对话历史重新推导。

### 1.4 重构排序的教训

本设计初版按依赖排期（内核 → 工具 → 门禁 → 规则 → 文档），把回归证据当风险项放在末尾。
这是**排序错误**：重构的首要目标是"少问"，而"少问"与"漏问"在指标上完全同形，
没有冻结的"应有开放项清单"就无法自证没有漏问。回归证据是**排期依据**，不是收尾工作。
因此《记忆》第 4 章为顶层章，《迁移》第 12 章按可证性而非依赖重排。

---

## 2. 目标架构

### 2.1 核心洞察：服务器已经能独立产出整篇文档的结构

`buildPrdSkeleton()`（`packages/shared/src/reqdoc-render.ts`）已能用正则重写生成完整骨架
（`5.1→5.k`、功能点名称、优先级块）；`patchSectionBody()` 能按编号定位写入正文与规范来源标签。
模板 schema（`REQDOC_TEMPLATE_CHAPTERS` + `FEATURE_SUB_SECTIONS` + `MAPPED_FIELD_KEYS`）服务器全知道。

即：**服务器有能力和知识产出整篇文档的结构，模型只贡献各小节的文字。**
现状"骨架服务器生成 + 逐节模型 patch + 结构校验"是绕远路。

### 2.2 唯一抽象：填槽位（Slot）

模板 schema 本身就定义了"哪些槽位必填"。模型的全部产出就是**把槽位填上并声明来源**：

```ts
// packages/shared/src/reqdoc-slots.ts（新文件）
export type SlotSource = "文档" | "问答" | "缺省"   // 与 Option A 来源标签同源
export type SlotStatus = "draft" | "confirmed" | "conflict" | "retired"
// draft=AI/记忆起草待确认；confirmed=业务确认；conflict=记忆与材料冲突待裁决；retired=已作废留痕
// 不计入 slotCoverage、不进 PRD 正文（retired 保留痕迹供审计）

export type SlotKind = "prose" | "term" | "field"

export interface ReqdocSlot {
  kind: SlotKind
  /** prose=模板地址（3.1~3.6、4.1/4.2、5.k.1.1、5.k.2.1~2.13、6.1~6.4、7.1/7.2）
   *  term=4.1 + 术语名作子键 | field=5.k.2.1 + 字段名作子键 */
  address: string
  content: string          // prose=正文文本；term/field=结构化定义（见下）
  source: SlotSource
  status: SlotStatus
  ref?: string             // 材料出处（仅本机，不上行汇报）
  reason?: string          // source=缺省 时必填（等价现有裸 [缺省] 门禁，结构内置）
  askCount?: number        // 该槽位被问过几轮（追问终止规则用，见 《迁移》6.3）
}
```

**五份表示在这一层全部坍缩**——它们本就是"哪些槽位被填、来源是什么"的不同残缺视图：

| 现有表示 | 在 slot 模型中 |
|----------|----------------|
| 术语表 / 模板 4.1 | 一组 `kind="term"` 槽位（`4.1.<术语名>`）；**4.1 的散文正文是它们的聚合视图** |
| 功能点 / `06_功能点` 子目录 | 地址中出现的不同 `k`（`5.k.*`）；功能点数 = distinct k |
| fieldDict / 模板 2.1 / `数据字典.md` | 一组 `kind="field"` 槽位（`5.k.2.1.<字段名>`）；**2.1 散文与 `数据字典.md` 都是它们的两个视图** |
| provenance（Option A 记账） | `slot.source` 本身，原生内建，不再单独记账 |
| 覆盖率 / 开放追问项 | 必填槽位中 `status ≠ confirmed` 的集合 |
| 八维打分 | 必填槽位按 `MAPPED_FIELD_KEYS[].dims` 上卷（映射表已存在） |

**术语与字段是一等槽位，不是散文的解析结果。** 早期草案曾把 4.1 与 2.1 当作
"一个散文槽位 + 事后解析出术语表/数据字典"，这是错的方向：2.1 是散文描述，
从散文反解字段名/类型/必填/取值域必然出错。改为 term/field 槽位后：
字段定义只写一次，2.1 的散文与 `数据字典.md` 都是它的**两个视图**，全链路无解析。

**覆盖判定口径**：`slotCoverage` 的 "filled" **只认 `status="confirmed"`**，
与 `deriveOpenQuestions` 同口径。这条必须写死——否则模型提交一堆 `draft` 就能刷高覆盖率，
`kbGate` 形同虚设。`reason` 缺失的 `缺省` 槽位视为未填。

**4.1（术语）的 confirmed 条件特殊**：它是 `term` 槽位的**容器章节**，
自身不单独存散文；只要**至少 1 条 term 槽位 confirmed** 即视为 4.1 已覆盖。
但**不因此消灭其他术语的提问**——每个未确认术语仍是独立的开放项，
术语维度与槽位覆盖分开计数（否则一条 CRD 会掩盖其余未知术语）。

### 2.3 文档是构建产物，KB 是源

PRD 文档 = `assemble(slots, template)` 的输出。改文档 = 改槽位后重新构建，
不是编辑 md 再校验。"文档与状态不一致"这一整类问题**因结构不可能发生而消除**，
不再依赖校验函数兜底。每个字符可溯源到 `(address, source)`，强于现有的事后篡改检测。

### 2.4 能力边界：「服务器组装」不等于「服务器写内容」

**这条必须写死，否则会被误读成能力倒退**：模型仍然写**全部正文散文**，
只是写进**槽位**而不是写进**文档**。服务器只做三件事——按地址摆位、打来源标签、保证结构。
它生成不了业务语言，也不假装能。

> 这不是能力增强的宣称，而是**能力归位**：结构由服务器负责（它本来就有能力），
> 内容仍由模型负责（它本来就是内容来源）。变化在于两者不再通过"模型手改文档"耦合。

### 2.5 模型的职责收敛为两件事

1. **填槽**：从材料提取 + 回答问题，产出 `(address, content, source)` 列表
2. **确认**：业务点头或纠正

服务器负责：去重合并、必填槽位派生、覆盖率、打分、组装全文、来源标签、结构合法性、
模板外成果（数据字典/权限矩阵/验收用例）投影。

---
