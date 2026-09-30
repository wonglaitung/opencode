# reqdoc 重构设计：需求知识库（Slot-filling KB）

> **文档性质**：目标架构设计（提案），**尚未实施**。当前实现仍以
> [workflow-reqdoc.md](workflow-reqdoc.md) 为准；本文描述的重构落地后，
> 该文档相关章节与 mermaid 图需按本文重写。
>
> **背景动因**：业务投料含组织内部术语（如 CRD=信贷审批部）时，追问环节反复询问
> "CRD 是什么"；同时现有流程经多轮增量修补，规则与校验函数持续膨胀，需要一次整体重构。
>
> **相关文件**：核心设计 [workflow-reqdoc.md](workflow-reqdoc.md)；mermaid 图数量受
> 仓库 28 图上限约束（当前 session-management 23 + workflow-reqdoc 4 = 27，剩 1 个名额），
> 落地时旧图随行为变更整体替换，不新增图块。

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

---

## 2. 核心洞察：服务器已经能独立产出整篇文档

`buildPrdSkeleton()`（`packages/shared/src/reqdoc-render.ts`）已能用正则重写生成完整骨架
（`5.1→5.k`、功能点名称、优先级块）；`patchSectionBody()` 能按编号定位写入正文与规范来源标签。
模板 schema（`REQDOC_TEMPLATE_CHAPTERS` + `FEATURE_SUB_SECTIONS` + `MAPPED_FIELD_KEYS`）服务器全知道。

即：**服务器能生成整篇文档，模型目前只贡献每个小节的文字。**
现状"骨架服务器生成 + 逐节模型 patch + 结构校验"是绕远路。由此得出重构主轴。

---

## 3. 目标架构

### 3.1 唯一抽象：填槽位（Slot）

模板 schema 本身就定义了"哪些槽位必填"。模型的全部产出就是**把槽位填上并声明来源**：

```ts
// packages/shared/src/reqdoc-slots.ts（新文件）
export type SlotSource = "文档" | "问答" | "缺省"   // 与 Option A 来源标签同源
export type SlotStatus = "draft" | "confirmed"      // draft=AI 起草，confirmed=业务确认

export interface ReqdocSlot {
  address: string          // 模板地址：3.1~3.6、4.1/4.2、5.k.1.1、5.k.1.2、5.k.2.1~2.13、6.1~6.4、7.1/7.2
  content: string          // 槽位正文（模型产出）
  source: SlotSource
  status: SlotStatus
  ref?: string             // 材料出处（仅本机，不上行汇报）
  reason?: string          // source=缺省 时必填（等价现有裸 [缺省] 门禁，结构内置）
}
```

**五份表示在这一层全部坍缩**——它们本就是"哪些槽位被填、来源是什么"的不同残缺视图：

| 现有表示 | 在 slot 模型中 |
|----------|----------------|
| 术语表 / 模板 4.1 | `address="4.1"` 的槽位 |
| 功能点 / `06_功能点` 子目录 | 地址中出现的不同 `k`（`5.k.*`）；功能点数 = distinct k |
| fieldDict / 模板 2.1 | `address` 落在 2.1 / 5.k.2.1 的槽位；`数据字典.md` 是投影 |
| provenance（Option A 记账） | `slot.source` 本身，原生内建，不再单独记账 |
| 覆盖率 / 开放追问项 | 必填槽位中 `status ≠ confirmed` 的集合 |
| 八维打分 | 必填槽位按 `MAPPED_FIELD_KEYS[].dims` 上卷（映射表已存在） |

### 3.2 文档是构建产物，KB 是源

PRD 文档 = `assemble(slots, template)` 的输出。改文档 = 改槽位后重新构建，
不是编辑 md 再校验。"文档与状态不一致"这一整类问题**因结构不可能发生而消除**，
不再依赖校验函数兜底。每个字符可溯源到 `(address, source)`，强于现有的事后篡改检测。

### 3.3 模型的职责收敛为两件事

1. **填槽**：从材料提取 + 回答问题，产出 `(address, content, source)` 列表
2. **确认**：业务点头或修正

服务器负责：去重合并、必填槽位派生、覆盖率、打分、组装全文、来源标签、结构合法性、
模板外成果（数据字典/权限矩阵/验收用例）投影。

---

## 4. 目录与落盘

KB 落需求资料根下的独立目录，**不占用 00~07 编号、不混入业务投料区**：

```
<需求资料根>/需求知识库/
  知识库.md        # 人可读账本（服务端渲染；业务可看可改，改后回灌槽位）
  .kb.json         # 机器态（slots/glossary 引用），服务端与 md 同源
```

理由：`00~07` 编号语义为"五步编写流顺序"，插不进 08；`01~05` 是业务投料区，
AI 往业务区写会让用户困惑"这是谁的笔记"。独立顶层目录 + 不编号，性质诚实。

`WorkflowState` 增 `kb?: { slots: ReqdocSlot[]; features: ReqdocFeature[]; updatedAt: number }`
（可选字段，首次前缺省；sdlc 恒缺省——与现有 `probes`/`fieldDict` 同形状）。

### 4.1 全局术语库（跨项目）

- 位置：`~/.config/opencode/session-mgmt/glossary.json`，与 `identity.json` 同级
- 结构：`{ [term]: { definition, kind, aliases?, learnedFrom } }`
- `kind` 分类直接复用 `conventions/reqdoc/00-术语与命名.md` 第 2 条既有区分：
  **行业通用缩写（AML/KYC/CIPS/SWIFT/银承）属正常行话、允许使用；仅"内部黑话"
  （团队自造/拼音缩写/代称）需要定义。** CRD 属后者，AML 属前者——不新造分类标准
- 填槽时先查全局库：命中的槽位直接以 `confirmed` 入库（`source=问答`，
  `learnedFrom` 记来源项目），**CRD 跨需求只问一次**
- 敏感纪律：组织内部知识，只存本机，**不进汇报 payload**（与打分扣分证据同纪律）

---

## 5. 派生算法（纯函数，shared 内核）

```ts
// reqdoc-slots.ts
export function requiredSlots(features: readonly ReqdocFeature[]): SlotAddress[]
export function slotCoverage(slots, required): { filled, total, pct, byDim: Record<DimKey, number> }
export function kbGate(slots, features, opts): GateResult        // 唯一门禁：覆盖率 + 来源完备
export function deriveOpenQuestions(slots, features, glossary): OpenQuestion[]
export function assembleDoc(slots, features, templateText): string
export function kbDigest(slots): string                            // ~1k 字符摘要，注入规则文本
```

要点：
- `requiredSlots` 复用现有 `REQDOC_TEMPLATE_CHAPTERS` + `FEATURE_SUB_SECTIONS` +
  `MAPPED_FIELD_KEYS`，**不重写模板知识**，这是本设计能低成本落地的关键
- `deriveOpenQuestions` 只认 `status=confirmed` 的槽位；`draft` 槽位**不消缺口**
  （否则模型未确认即当已知，重演"自评满分"老问题）
- 开放槽位尽量带**猜测默认值**（"CRD 我理解是信贷审批部，对吗？"），猜测来自
  `decisions`/glossary 历史或同名术语候选；用户点头即 `confirmed`
- `kbGate` 取代现有 7 个校验函数；阈值沿用 `REQDOC_SCORE_PASS` 语义但改为覆盖率口径，
  **门槛实质变严**（多一个小节未填即掉分），首版需校准阈值水位

---

## 6. 工具契约

### 6.1 保留不动

| 工具 | 说明 |
|------|------|
| `reqdoc_init` | 目录骨架；增 `需求知识库/` |
| `reqdoc_scan` | 材料提取（KB 的输入源） |
| `reqdoc_import` / `reqdoc_review_conventions` | 初稿导入与规约初评，与 KB 正交 |
| `reqdoc_export` | md → docx；输入改为 assemble 产物 |

### 6.2 新增

| 工具 | 职责 | 服务端约束 |
|------|------|----------|
| `reqdoc_ingest(slots[], features[])` | 模型从已扫描材料**批量提取**并提交槽位；服务端去重合并、查全局库、**返回派生开放项 + 猜测默认值 + 覆盖率** | `status` 由服务端强制（模型不能自称 confirmed）；仅 reqdoc |
| `reqdoc_answer(address, content, source)` | 逐项填补派生开放项；服务端置 `confirmed`、写 `知识库.md`、回写全局库（术语类） | 只接受 `deriveOpenQuestions` 给出的地址；每项可单独确认 |
| `reqdoc_assemble(source?)` | 由槽位投影生成整篇 PRD + 模板外成果（数据字典/权限矩阵/验收用例），幂等 | 须覆盖度达标或显式 `force`；输出即构建产物 |

`reqdoc_ingest` 支持**分批**：服务器告知"这些地址还开着"，模型填一批再提交，循环。
模型不决定填什么，只填被指定的——这是对小模型最友好的节奏。

### 6.3 删除

| 工具 | 原因 |
|------|------|
| `reqdoc_probe` | 开放项由服务端派生，无须模型"记录探针"；`probes` 状态随之删除 |
| `reqdoc_score`（写路径） | 打分改服务端派生；模型不再自评，`business_confirmed` 舞步消失（确认由 `reqdoc_answer` 承载） |
| `reqdoc_field_dict` | 并入槽位（2.1 / 5.k.2.1），`数据字典.md` 改投影 |
| `reqdoc_confirm_features` | 功能点由 `reqdoc_ingest` 一并提交，`06_功能点` 子目录服务端建 |
| `reqdoc_render_skeleton` | 并入 `reqdoc_assemble`（骨架本就是服务器生成） |
| `reqdoc_patch` | **连同刚完成的 Option A 记账一并退役**：模型不再向文档写入，来源标签由 `slot.source` 生成 |
| `reqdoc_check` | 结构违规因投影不可能发生；降级为只读覆盖率报告，并入 `assemble` 返回值 |

工具数 12 → 8，其中**模型驱动的写工具 8 → 2**。

---

## 7. 状态与门禁重构

### 7.1 状态字段

| 现有 | 处置 |
|------|------|
| `features` | 保留（`reqdoc_ingest` 写入，服务端建 06/07 子目录） |
| `score` | 删除（派生） |
| `probes` | 删除（派生） |
| `render` / `renderCheckFails` | 删除（派生） |
| `renderProvenance` | 删除（内建于 `slot.source`） |
| `fieldDict` | 删除（内建于 2.1 槽位） |
| `kb` | 新增 |

汇报投影（`summarizeWorkflow`）与 CLI 状态条改为读派生值：覆盖率、八维上卷、开放项数。

### 7.2 违规校验函数

`probeGapViolations` / `renderGapViolations` / `renderStructureViolations` /
`missingDefaultReasonViolations` / `consistencyViolations` / `noDocumentSupportViolation` /
`scoreDimZeroViolations` —— **7 个全部删除**，收敛为 `kbGate()` 一个。

### 7.3 门禁点

| 门禁位置 | 现状 | 重构后 |
|----------|------|--------|
| `workflow_advance(enter prd)` | score ≥ 85 + business_confirmed + probe 已记录 + probeGap 一致 + fieldDict 非空 | `kbGate` 覆盖率达标 + 必填槽位全部 confirmed（或显式 `缺省+理由`） |
| `review_submit` | 上述全部重算 + 结构复核 + 篡改检测 + 来源支撑 | 重新 `assemble` 后比对槽位摘要（幂等校验），防构建产物被手改 |

阶段键 `["goal","rules","edge","prd","review"]` **不变**（既定决策）。
KB 横切，不挂任何 stage：goal/rules/edge 为采集与填槽期，prd 为组装期，review 为确认成文期。

---

## 8. 规则重构

32 条 → 约 15 条。删除一致性规则群：

| 规则 | 处置 |
|------|------|
| reqdoc-r21（打分门禁 + 缺口↔满分矛盾） | 删除（矛盾不可能发生） |
| reqdoc-r23（渲染结构校验） | 删除（结构由投影保证） |
| reqdoc-r24（柔性门禁 + 定稿复核 + 来源支撑） | 删除（来源内建于槽位） |
| reqdoc-r31（字段定义双门禁） | 删除（字段即槽位） |
| reqdoc-r20（渲染铁律 + 字段映射） | 降级为"生成事实"：模板权威、映射由 `MAPPED_FIELD_KEYS` 承载，不再作为模型约束文本 |
| reqdoc-r14（分段渲染流程） | 重写为"填槽 → 组装"两步，篇幅大幅缩短 |
| reqdoc-r11（探针清单） | 改为"开放项由服务器派生，只填开放的"，探针清单内容移入 `deriveOpenQuestions` |
| 新增 reqdoc-r33 | 填槽纪律：扫描后批量 `reqdoc_ingest` 起草、一次性确认；术语优先取全局库，取不到才猜且必须带默认值请业务点头；**禁止就已在库术语提问** |

规约（`conventions/reqdoc/`）与五阶段状态机不动。

---

## 9. 迁移与回滚

**硬切 + 一个 shim**，不留双路径：

- 旧 state 有 `score`/`render`/`fieldDict` 而无 `kb` 时，进 prd 门禁改为要求先 `reqdoc_ingest`
  重新采集；旧分数不继承（避免半旧半新状态）
- 迁移期内的 PRD 文档按新流程重新 `assemble`，旧 md 视为过期构建产物
- 回滚策略：重构以独立提交落地，`kb` 相关代码集中在 `reqdoc-slots.ts` + `reqdoc-kb.ts` 两个新文件，
  可整体 revert

**风险与对策**：

| 风险 | 对策 |
|------|------|
| 小模型可能更受益于"逐节 patch"的节奏，而非一次 dump | `ingest` 可分批；服务器指定开放地址，模型只填被指定的 |
| 覆盖率门槛实质变严，存量需求卡门禁 | 首版阈值校准；保留 `force` 显式覆盖并留痕 |
| 评测基线失效（`scripts/eval-rules` 断言现有 score/render 行为） | 重写为断言"派生槽位覆盖 + 组装一致性"，与实现同批落地 |
| 组装质量依赖提取质量（服务器只保结构不保语义） | 与现状同源（正文一直是模型写），但每字符可溯源，净增强 |

---

## 10. 落地次序

1. **shared 内核**：`reqdoc-slots.ts`（slot schema、`requiredSlots`、`slotCoverage`、
   `kbGate`、`deriveOpenQuestions`、`kbDigest`）+ 纯函数单测。复用现有模板 schema，零 UI/门禁耦合
2. **状态与工具**：切 slot 状态；上 `reqdoc_ingest` / `reqdoc_answer` / `reqdoc_assemble`；
   删 7 个写路径工具与 7 个校验函数
3. **门禁与规则**：enter(prd) / review 改读 `kbGate()`；删一致性规则群，r14/r11 重写，r33 新增
4. **收尾**：状态条/汇报投影改派生值；`docs/workflow-reqdoc.md` 相关章与 mermaid 重写
   （旧图整体替换，守住 28 图上限）；[docs/README.md](README.md) 登记；`AGENTS.md` reqdoc 段改写；
   `scripts/eval-rules` 断言重写
5. 每步 `bun typecheck` + `bun test` + `bun run eval:dry`；提交推送 + `sync-bundle.sh`

---

## 11. 验收标准

**唯一真判据是追问变少且没丢事实**：

1. 投一份含 CRD 类缩写的真实材料，全流程追问清单**不出现"CRD 是什么"**，
   该术语出现在 `知识库.md` 与模板 4.1 术语定义
2. 同一缩写在第二个需求中**完全不被问**（全局库命中）
3. 行业通用缩写（AML/KYC/CIPS）不被误要求定义（`kind` 分类生效）
4. 组装出的 PRD 与槽位逐字一致：手改文档后 `assemble` 幂等校验能发现
5. 覆盖率、八维分数、开放项数在状态条与汇报中可见且与 `kbGate` 同源
6. `bun test` 全绿、覆盖率门槛校准记录在案

---

## 12. 未决问题

1. **覆盖率阈值取值**：`REQDOC_SCORE_PASS=85` 换算成覆盖率后等价水位待实测校准
2. **必填槽位的严格程度**：是否所有 `MAPPED_FIELD_KEYS` 都硬必填，还是按功能点类型差异化
3. **`知识库.md` 是否允许业务直接编辑**：允许则需编辑→槽位回灌解析（增加一处解析复杂度），
   建议 P1 阶段只读展示
4. **全局库的组织共享**：是否需要团队级同步（收集服务是统计用途，术语属敏感内部知识，
   本期仅本机；如需共享另立方案）
