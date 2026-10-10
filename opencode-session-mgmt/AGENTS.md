# opencode-session-mgmt

OpenCode 会话管理定制：标准化开发流程（五阶段门禁）、理解保障（复述确认）、效能分析（Token ROI / 返工率）。
形态为 **插件 + 独立 CLI + 外部收集服务**（后台收集器为独立外部项目，不随本仓库分发），对 OpenCode 上游**零修改**，以便持续同步上游更新。

## 铁律（破坏则同步上游必冲突）

- **不修改 `packages/*` 下任何上游文件**，也不改仓库根目录的 `CLAUDE.md` 等上游文件——根 CLAUDE.md 是上游的，本文件才是本项目的。
- 所有定制产出只落在定制目录内：`opencode-session-mgmt/`（本工程）与 `opencode-edge-debug/`（按需 Edge 调试插件，独立工程）。
- 本目录是独立 bun workspace，**不被上游根 workspace 收录**（上游 glob 为 `packages/*` 等，不匹配本路径）；改动后须确认上游根 `package.json` 的 workspace glob 仍不匹配本目录。
- 上游同步策略：**日常 `git pull` 只同步 `origin`（wonglaitung/opencode），不要主动同步 anomalyco/opencode**；仅当明确要求「同步上游」时才按 `docs/upstream-sync.md` 手工执行（remote：`origin`=wonglaitung/opencode，`upstream`=anomalyco/opencode 且 push 已禁用）。

## 已定案，勿重议（依据与变更史见 docs/agents-notes.md）

- **身份全手填**：`opencode-sm init` 交互两问（api_key / 收集服务地址）+ 可选主要工作流类型，写入全局 `~/.config/opencode/session-mgmt/identity.json`，每机器一次。`api_key` 仅本机明文存储；**不读上游登录账号**，**没有 team.yaml**。
- **插件不读上游数据库**：身份以 api_key 标识，上送前转 SHA-256 哈希；cost/tokens 经上游 SDK 获取。依赖面仅 Hook + REST API。
- **组/组织归属由后台收集服务解析**：客户端不再填写组/组织，api_key 哈希即身份标识。CLI 不再支持组/组织级查询。
- **后台收集服务为外部独立项目** `https://github.com/karsonto/performance_dashboard`：插件仅经 `POST /api/report` 上送会话摘要（不含代码）。收集端不可用时插件本地缓冲、恢复补推。
- **身份是汇报快照**：改 init 只影响之后的汇报，历史归属不追溯变更。
- **CLI 命名为 `opencode-sm`**（曾短暂叫 ocsm，已废弃，勿再用）。
- **会话不能改名**：上游 `Session.Service` 无 update 方法，勿设计 rename 功能。
- **工作流推进是完成门禁模型**（AI 主动 `workflow_advance`，AI 引导人决定），不是审批流；提交门禁经 `tool.execute.before` 拦截 `git commit` 实现；含提交门禁的工作流（sdlc）失录**基线预估工时**亦阻断；迭代上限 3 轮；`comprehension_confirm` 单次只认一段（防批量走过场）。
- **手工修改走 open_ide 锁定（sdlc-r12，软提示 + 硬拦截）**：开发者要手工改代码时 AI 先调 `open_ide`（**必须带 `file`**，防AI 覆盖）；锁定期间 AI 可继续其它任务但不得改被锁文件（`tool.execute.before` 服务端硬拦截）；须开发者明确确认后 `unlock_file`，并重新读取最新内容。**SDLC 完结时完成态注入解锁提示**（经 `hasCommitGate` 门控，reqdoc 不提示）。open-ide **物理合并**进本工程（`packages/plugin/src/open-ide/`，原 `opencode-open-ide` 已移除）：锁持久化进 SQLite `file_lock` 表（daemon 重启自动恢复）。
- **规则阶段化注入**：`WorkflowDefinition.rules` 为 `RuleItem[]`（含 `stage`），每轮只注入 global + 当前阶段；状态以阶段状态块（`buildStateBar`）展示，替代冗长 JSON。无 in_progress 分三态，**完成态注入专用完成块**（不注入常规规则）。`applyTransition` 严格执行状态机：enter 已 approved 须走 revisit、enter 已 in_progress 幂等；**revisit 级联回退该阶段之后所有已 approved 的下游阶段**（下游结论建立在被回退阶段之上，须重走）。规则遵循度评测基线在 `scripts/eval-rules/`；**评测与质量飞轮实操手册见 `.opencode/skills/workflow-rules-eval/SKILL.md`**。
- **reqdoc 槽位知识库（Slot-filling KB）**：业务「口述 + 丢材料」，AI 代笔。**槽位是唯一事实源**——服务端派生「该问什么 / 覆盖率 / 门禁 / PRD」，PRD 只是槽位的投影（`reqdoc_assemble`），**不得用 write 手写或手工编辑产物**。**模板结构同样只有一份事实源**：`docs/reqdoc-prd-template.md`，由 `reqdoc-template-schema.ts` 解析；**换模板只改该 md，不改代码**；政策按**标题**声明（改标题会由 `unresolvedPolicy` 报出要求人工确认），按编号声明会随章节重排失效故不采用。**代码与规则文本里不得再出现模板地址字面量**；模型侧一切以「本轮该填」清单为准。护栏 `template-addr-hardcode.test.ts` 扫**全部插件源文件**（不是白名单——白名单式扫描必然漏），只放行占位形状与插值。**换模板后旧会话显式重置**：`schemaAddressSpace` 记必填地址空间（**不含标题**），`templateDrift` 做**集合包含**判定（旧必填地址不在新模板里才算漂移）；漂移时状态条与回执报「建议开新会话重走」。**判据宁窄勿宽**（误报一次就是让业务白做一遍）。**只报不自动清**。**多模板并存：不做**（等第二个模板要同时在线时再单独设计）。**模板不可读时分软硬两路**：提示类一律 `templateSchemaOrEmpty()`、**绝不抛**（抛一次就是整个请求失败）；产物类一律 `requireTemplateSchema()`、**必须抛**让用户报障（宁可请求失败也不能产出结构不明的交付件）。**「不崩」不等于「能用」**——软降级后必填集为空、ingest 收不了地址，而门禁默认文案会把人引向「用 ingest 补齐」的死路，故提示类路径必须带 `templateUnavailableNotice()`（真因 + 出路 + 承诺已填内容不丢）。目录契约 00~07。**文档扫描经 `reqdoc_scan(directory)`**（单目录参数、按阶段分步调用；qwen3.6 纯文本无多模态，图像显式降级提示文字描述）。**工作流**：① `reqdoc_ingest(slots, features?, candidates?, containers?)` 提交为**槽位**（地址必须来自「本轮该填」清单，非法地址会被拒；`candidates` 是记忆消缺口的必要条件，须填材料中真实出现的）；② `reqdoc_answer(address, content, source, reason?, restated_term?)` 逐项请业务确认后落定（`source=缺省` 必附 reason）；③ `reqdoc_assemble(source?)` 由服务端投影出整篇 md。**功能点拆解**：`reqdoc_confirm_features(features)`。**唯一门禁是 `kbGate`**：必填叶子覆盖率 + 必填容器已覆盖或已声明可为空 + 无未收口项；确实无法补齐且业务坚持时 `force_kb=true` + **业务给的** `force_reason` 放行（理由模型不得代填）。**记忆机制**（跨需求共享）：匹配证据是 **00~05 材料原文**（非模型转述的槽位正文；`06/07` 不作证据），故 `[问答]`/`[缺省]` 来源的槽位不参与匹配；L1 术语（业务主动复述）命中即**免问**，**免问项不在「本轮该填」清单里且仍是 draft，须由模型随后 `reqdoc_answer` 落定，source 一律标「问答」**（定义出自业务过往口述，标「文档」等于在交付件上做不实溯源）。不落定则术语容器覆盖不过、进prd 被拦。**分支二（改已有需求）**：**调用序按 `reqdoc-r36` 不跳步**——import 导入为 `[文档]` → `ingest`（**每项 ref 填稿路径**）→ `adopt_baseline` **先不带 confirm 预演** → 带 `confirm=true` + **`authorized_by`/`confirm_note`（两项须来自业务，模型不得代填）** + `unmapped`（稿里有、模板装不下的内容）**逐条申报处置**；只认 `source=文档` 且 `ref` 指向该基线文件的槽位（`[问答]` 冒充基线 = 不实溯源），**承认基线不豁免任何必填项**；确认时冻结 `kb.baselineSnapshot`。沿用基线后**只问「旧稿未覆盖的必填项 + 新增功能点」**。**别被状态条的「必填容器未覆盖」带偏**——容器是**聚合判定**，旧稿里有对应内容就提交成容器叶子（容器即算覆盖）；确实没有才声明 `required:false` + reason，**不要把旧稿里已写着的术语与字段重问一遍**（这是**对话义务而非服务端机制**）。定稿回执输出**本次变更清单**（只认 `confirmed`），**只在回执里说，不改交付件格式**。**功能点只能追加末尾**（Step 3 硬拦）。**ingest 不得把已确认槽位打回 draft**（整批拒绝并指路 `reqdoc_answer`，不做静默跳过）。**已知限制**：旧稿章节与模板不一致时映射由 AI 完成、服务端无法校验语义正确性；**`00_初稿需求书/` 里任何文件都会被当成「分支二」并承认基线**。动作指令载于 `reqdoc_ingest` 的工具描述（model-only、每次请求都在、不分阶段），回执与状态条只报事实且措辞可直接转述。**给用户看的故障提示只能挂状态条**——工具回执在 TUI 默认不渲染、桌面端 `GenericTool` 不渲染 `output`；状态条是唯一无条件进 system prompt 的载体。L2 组织知识命中**不消缺口**，只作默认值仍问一次；**静默点默认不入库**，同名不同义不静默覆盖。记忆**不影响门禁判定**（只影响「问什么」）。`restated_term` 写 L1 时**`business_quote`（业务原话）必填、留空拒写**（污染不可逆且旧条目无从追查）；`reqdoc_memory_recall(...)` 在定稿后由**业务勾选**才写 L2/L4（自动写等于「AI 决定什么值得记住」）。**定稿三重校验**（`review_submit`）：① `kbGate`；② 摘要一致（`kb-digest`，抓「槽位变了没重组装」）；③ **重组装 LCS 比对**（抓纯内容手改与行置换）；溯源章节独立校验（防伪造证据）。PRD 定稿后经 `reqdoc_export` 导出 Word。**定点修订（保留原稿改单章）**：`reqdoc_start_scoped_edit(chapter)` 锁章并冻结快照，`ingest`/`answer` 越界服务端拒收；改完先 `reqdoc_assemble` 重组装、**锁定期间** `reqdoc_export(mode="diff"|"chapter")` 导出单章差异、最后 `reqdoc_end_scoped_edit()` 释放锁（释放后 diff 导出报错）；锁绑会话 + 新 baseline 强清；大范围删改须业务拍板（退役→`confirmRetire`、空内容清空→`confirmClear`，两路同权）。机制详见 workflow-reqdoc.md 7/8 章，设计与对抗审核见 `docs/reqdoc-scoped-edit.md`。**sdlc 完全不动**（记忆不得影响 sdlc 门禁与理解确认）。详细机制见 `docs/workflow-reqdoc.md`（现行实现权威源）与 `docs/reqdoc-kb-refactor.md`（设计+实施记录）。
- **编写规约（绑定规约，按工作流类型 + 阶段门控 + 只注入）**：机构规约按工作流类型放 `packages/plugin/conventions/<type>/`（基线，随插件打包）；机构覆盖放 `<项目根>/conventions/<type>/`（按 `workflow.type` 隔离、不跨流泄漏）。每个 `.md` 头部 frontmatter 声明 `stage:`——**无 frontmatter 或 `stage: global` 视为常驻**，否则仅在对应当前阶段注入；`stage` 为 null（未开始/完成态）时只注入 global 规约。`loadWorkflowConventions(type, stage, projectRoot)` 读目录内 `*.md` 解析 frontmatter 排序过滤拼接，`buildSystemFragment` 注入，**只注入、无门禁、不进 `RuleItem`/打分/评测**。通用常驻机构规则写机构自己的 `AGENTS.md`（OpenCode 原生合并），**不放 conventions 目录**；新增工作流规约 = 丢一个带 frontmatter 的 `<type>/` 目录，零代码。sdlc：`01-提交信息规约` global（`[AI]` 标题末标记）、编码/安全/日志/并发幂等 implementation；reqdoc：范围边界 goal、术语命名/状态机 rules、异常/NFR edge、可验证性 prd。

## 结构

```
packages/shared/     # 契约包：WorkflowState 类型、汇报 payload、identity、合并语义（三包共用，先完成）
packages/plugin/     # OpenCode 插件：system prompt 注入、工具注册、提交门禁、汇报
packages/cli/        # opencode-sm 独立 CLI：init/list/stats（本机会话/项目级聚合）
（后台收集服务为外部项目 performance_dashboard：https://github.com/karsonto/performance_dashboard）
deploy/              # 部署示例：opencode.json.example
docs/                # 设计文档族：session-management.md（通用机制/架构/CLI/统计/部署/评测）+ workflow-sdlc.md（工作流一 sdlc）+ workflow-reqdoc.md（工作流二 reqdoc）；同步方案 upstream-sync.md
```

每个源文件 stub 顶部注明对应设计文档章节，实现前先读该章节。

## 技术约定

- bun workspace monorepo；bun 直接跑 TS（CLI 入口 shebang `#!/usr/bin/env bun`）。
- TypeScript strict；新代码零 `any`；`bun build --compile` 出 CLI 单二进制。
- 插件 Hook 基于 `@opencode-ai/plugin` 的 `Hooks` 接口，均为 experimental：**同步上游后优先核对 hook 签名**（尤其 `experimental.chat.system.transform`），变更只改 `packages/plugin/src/prompt.ts` 适配层。
- **插件入口 `packages/plugin/src/index.ts` 只能 default 导出插件工厂，内部辅助函数一律不加 `export`**（依据见 `docs/agents-notes.md`）。
- 本地存储用 bun:sqlite。
- `bun test` 跑测试；测试文件与源码同目录 `*.test.ts`。

## 修改后必做：对抗性审查

**任何代码、文案、规则的每次修改完成时，立即做一轮对抗性审查**——与验证同拍，不攒到提交前。不是自证「测试通过」，而是主动找反例打自己。五条必查（依据与踩坑史见 `docs/agents-notes.md`）：

1. **受众核查**：每处新增/改写的文本先问「谁会看到」——system prompt / 工具描述 / 工具回执 / 时间线消息 / 交付件，受众不同则措辞不同；给模型的指令不要写进会被转述给业务的载体，反之亦然。**默认可见性须去上游源码实证**，不许凭感觉断言。
2. **比较区间与方向**：修法必须对齐被比较双方的口径、区间与方向，而不是只对齐字面。
3. **同类残留**：修一处同类问题（措辞、指称、格式）后立即 grep 同模式的其余位置；只修被点名的那一处等于修一半。
4. **规约互查**：改动不得违反 `conventions/`、本文档与 docs 权威源；**拿规约当判据时要审它覆盖的全表，不能只审自己那一行**。
5. **实测优先 + 护栏随修**：贴真实输出（工具回执、状态条、组装产物）而非只贴源码断言；缺陷分级 P1/P2/P3——P1/P2 回报用户拍板后再改，P3 记录不动；每条被证实的缺陷都要有断言钉住（文本契约断言 + 端到端各一），并把审查结论写进 docs 变更日志。
   **规则要可判定：把被修的东西改回坏的样子，断言必须 FAIL，否则它不算护栏。**
   写完断言**当场破坏一次**，看它报不报红——断言本身要被观测。

6. **验证器自身也要审**：judge/eval 只查意图不查 `ok` 时，被服务端拒收的调用照样「通过」——失效修复会被「验过」却没发现（本项目 P1 基线正则对中文单位恒返回 null 即此例）。给修复写验证先自问「我的验证会不会对坏实现也绿」；判据该查 `ok` 就必须查 `ok`。

7. **软约束不算不变量**：只靠 prompt 让模型「自觉不做 X」等于没约束——模型可随时走全量或越界写。任何「不该做 X」须有**服务端拒收**（如 `kb.editScope` 作用域锁 + 越界写入拒收），把不变量落到代码而非提示词。依据与踩坑史见 `docs/agents-notes.md`。

交付验证口径：`bun run typecheck` + 三包分目录全量 `bun test`（勿在仓库根跑）+ `bun run acceptance:derive` + `bun run eval:dry`。模型驱动评测（判模型遵循度，如定点修订 r40）须 `EVAL_EXECUTE=1`；本地 qwen3 须再加 `EVAL_DISABLE_THINKING=1`——否则长 system prompt 下模型先「思考」耗尽 token、零工具调用直至超时，评测测不出规则遵循（实测 53s / 零调用 vs 关思考后秒级出工具调用）；**端点一律用 vLLM**——SGLang 同变体跨轮 ±20% 方差且上下文上限仅 21879（vLLM 为 102400），长场景在 SGLang 上必挂（r13 曾因此必红），SGLang 跑出的数字作废。

## 方案呈现：技术细节不能替代用户视角

用户能拍板的前提是「我能想象改完之后自己会面对什么」——**架构写得再细也替代不了这个**。因此每份方案/设计/评审结论都必须同时给两节，缺一不算完成：

1. **技术节**（照常给，不许省）：架构、文件与接口、改动量、数据结构、门禁。
2. **用户视角节**（不可省，必须写全这五点）：
   - 按**用户的实际操作顺序**讲：他做什么 → 系统回什么 → 他最终拿到什么（配一段真实感的对话或界面示例，不用内部术语）；
   - **明确说出「不变的部分」**——否则无法估影响面（例：某分支零改动，就直说零改动）；
   - **明确说出「不会发生的事」**（边界）与「需要用户额外配合的动作」（他要花的力气）；
   - 一张 **before/after 对照表**：今天是什么样 vs 改完是什么样，按使用场景逐行列；
   - 结尾用**大白话**列待决事项，并**给出我的推荐默认值**——不要用内部术语提问，也不要因为存在待决项就不开工（默认走推荐值，在结论里标明「默认，待你确认」）。

判断标准：用户看完能不能不追问就说出「行就这么办」或「这条不行，换个做法」。看完还要回来问「所以到底变了什么」，就是没写到位。

## 经验教训（通用约定）

依据与踩坑史见 `docs/agents-notes.md`；本节只留要求。

- **用户可编辑的 JSON 配置若含文件路径**，文档必须要求**正斜杠 `/`（Windows 原生接受）或双反斜杠 `\`**；解析失败时 warning 须直接点出「反斜杠是转义符」这一诱因。
- **配置文档示例须显式标注字段语义**（覆盖 / 新增 / 缺省用默认）。
- **依赖第三方库若顶层初始化触碰浏览器 API，一律改为使用点内 `await import()`**，并在库自身顶层加 `typeof X !== "undefined"` 守卫；凡引入新依赖先确认其顶层初始化。
- **node_modules 内的守卫补丁不入 git**，重装依赖会丢失，须在文档中标注须手动重打。

## 回答规范（每次作答适用）

- **一个概念一个名字**：同一件事不得两个称呼。已存在的别名要在**文档里标明等价**并在代码注释
  写清来源。短句、主动语态；**不做 ASD-STE100 级别的中文约束**——写一条没人遵守的规则比不写更坏。
- **结论须附检验，否则标注「仅判断」**：说「因为 X 所以 Y」时附**复跑（`--repeat N`）+ 只改一个变量的对照实验**；给不出就明写「**仅判断，未验证**」。**检验必须报 n**（`3/3` 不是 `1/1`）——**n=1 的结论按「仅判断」对待**。
- **数值与判定写进文件，不留在对话里**：报出的每个数（通过率、覆盖率、占比）都要落到
  docs 或提交信息里。对话里的数是**一次性**的，下一个会话就没了。
- **含 `|` 的 shell 命令放代码块，不进表格**：表格内转义会改变命令语义。
- **对话输出禁用 ```mermaid 代码块**——CLI 不渲染 mermaid，只显示源码等于没图；改用代码块
  内 ASCII 框线图。**文档（`docs/*.md`）不受此限**，继续用 mermaid。
- **讲架构 / 数据流 / 状态流转 / 判读顺序时先给图再给文字**；诊断与结论类作答不硬推图。

## 文档与语言

- 设计文档、注释、commit message 用**中文**；conventional commit 格式（本仓库历史可参照）。
- **任何文档与注释都不要用 `§` 符号**引用章节，一律用纯文字（「第 3 章」「3.4 节」或裸编号「见 3.4」）。
- 设计文档任何行为变更须同步更新对应 mermaid 流程图（三个设计文档合计 **28** 个：session-management.md **23** 个、workflow-reqdoc.md **5** 个、workflow-sdlc.md **0** 个；**上限 28**，新增图块须整体搬入对应文档族文件，超出上限需评审；8.7 混合开发/open_ide 文件锁的 5 个图已并入 session-management.md），改链路必改图。
- 发布前 TODO 见 `README.md`（npm scope、插件发布形态、外部收集服务 performance_dashboard）。
