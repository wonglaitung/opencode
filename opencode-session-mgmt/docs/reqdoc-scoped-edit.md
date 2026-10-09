# 定点修订（只改某章，不复述全篇）

> 状态：待实施。权威实现源并入 `docs/workflow-reqdoc.md` 后本节同步。
> 对抗审核结论见末尾「7 条加固已并回」。

## 背景与动机

业务已导入/确认过需求书后，只想改某一章。当前「改已有需求」走 `reqdoc-r36` 分支二：先
`reqdoc_adopt_baseline` **整篇预演 + 逐章看过 + 确认**，再「只问旧稿未覆盖的必填项 + 新增功能点」。
哪怕只动一章，也把整份基线重新过一遍——这是用户感知到的「浪费」。访谈本身已是渐进批（本轮该填 +
`STOP_ASK_AFTER` 停问），重的是整篇基线重采纳。

用户已确认：提取成模板格式可接受；只反对「只改一章却要答完全部问题」。本方案加一个**定点修订**
意图，与分支二全量重采纳分开，复用现有派生/校验机制，不放松任何门禁。

## 已锁定决策（用户拍板）

1. **跨章一致性**：只**列出**影响，不阻断 → 选 (a)。
2. **改动供给方式**：业务**只重传改动章的文件** → 选 (b)。
3. **强制力度**：采纳对抗审核头条——定点约束必须**服务端强制**（`kb.editScope` 作用域锁），
   不止 prompt 自限。

---

## 用户视角节（必填）

### 实际操作顺序

1. 业务对 AI 说「只改第二章的审批流」，并把改好的「第二章.docx」放进工作区（或给路径）。
2. AI 解析该章文件、定位到第二章，**只更新第二章相关的需求要点**，原稿与改动章文件都原样保留。
3. AI 回：「第二章已更新（X 条要点变更）；检测到第三章仍在用旧术语『审批人』，请知悉（不影响本次保存）。变更已记入文档变更过程。」
4. 业务拿到更新后的需求书；其余章节一字未动。

### 不变的部分

- 原稿文件（`00_初稿需求书/`）与本次重传的章文件都原样保留，AI 不改写。
- 槽位仍是唯一事实源、PRD 仍是槽位纯函数投影（`reqdoc_assemble`）——本方案不改这条铁律。
- 最终「定稿/推进整个工作流」时的**完整度门禁完全不变**；定点修订只是暂存式更新。

### 不会发生的事 / 用户额外配合

- **不会发生**：为改一章而被迫从头回答全部 31 个必填项；整篇基线重采纳预演。
- **不会发生**：别的章节被悄悄改动（作用域锁拒收越界写）。
- **用户须配合**：改动须以**重传的章文件为唯一真相源**（不能只在对话里口述「改成 1000 并发」让 AI 代填 `source=文档`）；若重传文件实际横跨多章或基本为空，AI 会停下来问，不会静默处理。

### before / after 对照表

| 场景 | 今天（分支二全量） | 改完（定点修订） |
|---|---|---|
| 只改一章 | 整篇基线重采纳 + 逐章预演 + 问未覆盖项 | 仅解析该章文件、更新该章槽位、列出跨章影响 |
| 文件横跨 2–3 章 | 按章号过滤，多出的章静默丢 | 检测跨章，停下让业务重传或逐条申报 |
| 重传空白/极短章 | 整章槽位被 retired，章被清空 | 触发确认，不静默清空 |
| 改了术语定义，他章仍用旧词 | 门禁不查语义，溜进定稿 | 列出影响供定稿人工过目（门禁仍不查语义，但变更记录带具体指向） |
| 导出 | 完整即导出 | 存在未定稿+retirement 的章时对该章告警/阻断 |

### 待决事项（默认走推荐值，待确认）

- 章号解析「按名匹配」（如「审批流那章」）不在首版，首版只支持「第 N 章」数字；按名匹配默认**不做**，越界/无法解析时停下来问。
- 编辑前快照的存储位置默认复用 `kb.baselineSnapshot` 机制（见加固 #5），不新增独立表。

---

## 技术节

### 现有可复用基础

- 槽位地址按章编码（`ch.1.<rel>`、`<术语容器>.<术语名>`，`packages/shared/src/reqdoc-slots.ts`：
  `chapterContainers` :95、`docSectionAddrs` :154）。
- `deriveQuestions(features, opts)`（reqdoc-slots.ts:590）已支持分批/停问；加 `chapter` 选项即可
  产出**章内作用域**的「本轮该填」。
- PRD 是纯函数投影（`reqdoc_assemble`），改一章槽位 → 重组装只变该章。
- 增量记录 `diffAgainstBaseline`（review.ts:457）+「文档变更过程/变更记录」（:41、:497）已实现。
- 分支二已有「只认 `source=文档` 且 `ref` 指向基线文件」的校验（reqdoc-kb-tools.ts:532-536）。

### 实施步骤（按文件）

**1. `packages/shared/src/reqdoc-slots.ts` — 纯函数 + 派生选项**
- 加 `resolveChapterLabel(label, schema)`：`"第二章"` → `2`，用 `schema.docSectionAddrs`（:154）匹配章号。
- 加 `slotsByChapter(slots, ch)`：地址以 `${ch}.` 开头或归属 `chapterContainers`（:95）。
- 加 `crossChapterImpact(kb, ch)`：取 ch 章术语容器叶子里的术语名 → 扫描其他章槽位正文，返回引用了这些术语的地址（非阻断，仅供列出）。
- `DeriveOptions` 增 `chapter?: number`，在 `deriveAll`（:475）/ `deriveQuestions`（:590）内按章前缀过滤。

**2. `packages/shared/src/workflow.ts` — 新增「定点修订」规则（如 `reqdoc-r37`）**
- 触发：基线已采纳/确认（baseline 存在）**且**用户说「只改第 N 章/修订某节」**且**提供改动章文件。
- 行为：① **不调** `reqdoc_adopt_baseline` 整篇预演；② `resolveChapterLabel` 定位章；③ 定点
  `reqdoc_import` 解析该章文件 → `reqdoc_ingest` 仅用 `deriveQuestions(features,{chapter:ch})` 的
  章内地址，每条 `source=文档, ref=<该章稿路径>`；④ 章内被删内容对应槽位标 `retired`（:50 过滤）；
  ⑤ 仅列 `crossChapterImpact` 不阻断；⑥ 完整度门禁推迟到显式定稿。
- 写入 `kb.editScope = { chapter: ch, ref: <章文件>, snapshotBefore: <编辑前快照> }`（**服务端状态**，见加固 #1/#5）。

**3. `packages/plugin/src/tools/reqdoc-kb-tools.ts` — 越界拒收（强制核心）**
- `reqdoc_ingest`/`reqdoc_answer`（地址校验 :248-252、:387）在 `kb.editScope` 存在时，**拒绝任何
  地址不落在该章作用域的写入**；`source=文档` 的槽位须能从 `editScope.ref` 文件解析出（章作用域 +
  文件存在双重门禁）。这是把「只改一章」从软建议变硬不变量的关键。
- 新增/覆盖区分：新槽位走 `reqdoc_ingest`，覆盖已确认槽位走 `reqdoc_answer`（保 confirmed，:271）。

**4. `packages/plugin/src/tools/review.ts` — 复用增量记录**
- 定点更新后调用已有 `diffAgainstBaseline`（:457）写「文档变更过程」，diff 基准 = `editScope.snapshotBefore`（见加固 #5）。

**5. `packages/plugin/src/prompt.ts`（或 reqdoc 约定文件）— 行为指令**
- 教模型识别「只改一章」意图并进入定点模式：不整篇重采纳、要求重传该章文件、用章内作用域
  ingest/answer、更新后列跨章影响、定稿前不触发全部门禁。

**6. 测试（`packages/plugin/test/`、`packages/shared` 测试）**
- 单元：`resolveChapterLabel`、`slotsByChapter`、`crossChapterImpact`、`deriveQuestions({chapter})`。
- 集成：导入草稿 → 采纳基线 → 只重传第 2 章文件 → 定点 ingest → 断言：仅第 2 章变、其他章未动、
  PRD 重组装、变更入「文档变更过程」、跨章影响被列出、全门禁未触发；并断言 `kb.editScope` 存在时
  越界写入被拒（服务端强制的回归断言）。

### 文件改动清单

| 文件 | 改动 |
|---|---|
| `packages/shared/src/reqdoc-slots.ts` | `resolveChapterLabel` / `slotsByChapter` / `crossChannelImpact` + `DeriveOptions.chapter` |
| `packages/shared/src/workflow.ts` | 新增 `reqdoc-r37` 定点修订分支 + `kb.editScope` 语义 |
| `packages/plugin/src/tools/reqdoc-kb-tools.ts` | ingest/answer 越界拒收 + `source=文档` 文件可解析校验 |
| `packages/plugin/src/tools/review.ts` | 复用 `diffAgainstBaseline`（基准取 `editScope.snapshotBefore`） |
| `packages/plugin/src/prompt.ts` | 定点模式行为指令 |
| `packages/plugin/test/*` / `packages/shared` 测试 | 单元 + 集成 + 越界拒收回归 |

---

## 7 条加固已并回（作为硬约束，非建议）

对抗审核原 7 条全部落地为**服务端强制或显式守卫**，不再是 prompt 自限：

1. **【头号】服务端 `editScope` 锁 + 越界拒收 + `source=文档` 文件可解析**（覆盖对抗 #头号、#6）。
   定点开始时写 `kb.editScope`；ingest/answer 拒收章外地址；`source=文档` 须能从 `ref` 文件解析。
   把「只改一章」变成硬不变量，堵住溯源造假与模型走全量两条路。
2. **文件跨章检测 + unmapped 申报**（对抗 #1）：解析后若文件内容跨章 ≠ 声明单章，停下让业务重传
   或逐条申报多出的章，绝不静默丢。
3. **空文件/极短重传守卫**（对抗 #2）：新文件有效内容量显著小于该章现有槽位总量时触发确认，
   不静默 retired 整章。
4. **列影响不阻断 + 定稿须人工过目变更记录**（对抗 #3）：跨章语义漂移现有门禁抓不到；变更记录须
   带「ch5 仍引用旧定义」式具体指向，定稿前人工过目。
5. **编辑前快照语义**（对抗 #5）：`kb.editScope.snapshotBefore` 存编辑前状态，每次 delta 对编辑前；
   定稿时再并入 `kb.baselineSnapshot`。
6. **export 对未定稿 + retirement 章告警/阻断**（对抗 #4）：检测到存在未定稿定点编辑且涉及
   retirement 时，该章不得静默导出。
7. **章号解析越界/按名匹配**（对抗 #7）：`resolveChapterLabel` 处理「第 N 章」；越界（如模板只有 2 章却说第 3 章）
   或按名（「审批流那章」）时停下来问，不就近取值、不做首版按名匹配。

### 仍诚实声明的局限

- 跨章**语义**一致性（改了术语定义、他章仍用旧词）现有门禁不查；本方案只「列出」不「阻断」，
  正确性依赖定稿人工过目变更记录。
- 首版定点修订**不优化初次全量导入**（用户已接受提取成模板的整体成本），只优化「已确认后改一章」。

---

## 验收口径

`bun run typecheck` + 三包分目录全量 `bun test`（`packages/plugin` `packages/shared`）+ 定点修订
集成测试（含越界拒收回归）+ `bun run eval:dry`（新增「只改一章」场景，须验证：其他章零改动、
跨章影响被列出、越界写被服务端拒收）。
