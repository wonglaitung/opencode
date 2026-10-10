# AGENTS.md 依据与踩坑史

`AGENTS.md` 只写**要求**；本文件存放那些「为什么」与变更史。AGENTS.md 相应位置指向此处。

## 技术约定

**插件入口只能 default 导出。** opencode 的 legacy 加载器会把模块「所有函数导出」都当作
插件工厂，以 `(input, options)` 逐一调用。曾因 `syncSessionTitle`/`backfillSessionTitles`
加了 `export`，被当作工厂调用时首行 `store.get(sessionID)` 抛 `store.get is not a
function`，导致插件加载失败、opencode 启动报 `Unexpected server error`（见设计文档 5.2 与
`index.ts` 内注释）。

## 经验教训

**JSON 里的反斜杠是陷阱。** `\` 是转义符——`\P` 等非法转义导致解析失败（回退默认但用户不
明所以）；更隐蔽的是 `\b`/`\n`/`\t` 是**合法**转义，`"C:\bin\..."` 会被静默转成控制字符，
路径错但 JSON 解析「成功」。

本工程现状：`identity.json`（api_key 明文 / 收集服务地址；发送前转 SHA-256 哈希，网络不传
明文）不含文件路径；`deploy/opencode.json.example` 的 plugin 路径为相对/正斜杠写法；插件
`config.json`（源出已合并的 open-ide）含用户可编辑的 `tools` binary 路径，须落实正斜杠约定
（见 `packages/plugin/src/open-ide/config.ts`）。

**配置文档示例须标注字段语义。** 插件 `config.json` 的 `tools` 示例标注「cursor=新增、
idea=覆盖」（源出已合并的 open-ide）。

**pdfjs 的教训：顶层初始化会拖垮整个插件。** `pdfjs-dist` 的 pdf.mjs 初始化执行 `new
DOMMatrix()`，而 opencode 插件运行时无该全局对象（canvas polyfill 依赖 `@napi-rs/canvas`
原生绑定，打包环境缺失）→ 抛 `ReferenceError` → 插件加载失败、不建表不写库（曾致 1.18.18 下
DB 全无）。修复：静态 import 改为使用点内 `await import()`；pdf.mjs 顶层 `const SCALE_MATRIX
= new DOMMatrix()` 加 `typeof DOMMatrix !== "undefined"` 守卫后，纯文本提取完全不依赖 canvas
（见 `packages/plugin/src/tools/reqdoc-scan.ts`）。守卫补丁在 node_modules 内、不入 git。

**正则 `\b` 对 CJK 恒不成立。** JS 里 `\b` 是单词边界，汉字/中文标点属非单词字符；`8小时`
里单位前的 `\b` 永不匹配 → 整条正则对中文表述**恒返回 null**（功能静默失效、因「不报错」极难发现）。
中文边界改用 `(?![\p{L}\p{N}])` + `u` 旗；顺便更窄（避开 `8http`/`8公顷`）。

**解析失败返回 null 优于误解析（fail-safe）。** 中文数词（半天/十天左右）不解析成数字是刻意取舍：
漏捕 = 开发者真实估值被拒（安全），而非被毒化（危险）。给解析层加能力时，宁可不识别也别猜。

## 对抗性审查

**拖到提交前集中审等于走过场。** 与验证同拍时上下文最热、diff 最小、归因最容易；提交前审的
已是多轮叠加的旧账，反例失败也难定位是哪一步引入的。故提交前只复核结论与护栏已随批提交。

**默认可见性不能凭感觉断言。** 插件工具回执在 TUI 默认不渲染（上游
`routes/session/index.tsx` 的 `generic_tool_output_visibility` 默认 false，且折叠只显示前 3
行）、桌面端 `GenericTool` 根本不渲染 `output`——「挂回执等于没告诉用户」。

**拿规约当判据时要审全表。** 曾援引 `07-业务口语` 打自己、却放过同一函数里更严重的同类违规。

**假护栏的三种形态**（本项目长期只要求「有断言」、从不要求「断言能失败」，代价如下）：

1. **只查字符串存在**：断言只 `toContain` 某段源码，于是把整段 `if` 删掉后字符串仍在
   **注释**里，断言照样通过（实测破坏即假通过）。
2. **不校验控制流**：只 `toContain` 源码路径，不检查它在什么分支里。
3. **边界正则方向写反**：首版按 `defaultLoad:` **之后**找 `out.`，而真正的读取在其**之前**。

写完断言**当场破坏一次**，看它报不报红——与「可见性须实证」同源：**断言本身要被观测**。

**验证器（judge/eval）自身有盲点也要审。** P1 基线修复后 eval 报 s1「通过」，但 `tool` 判据只查
`toolCalls` 意图、从不查 `ok`；被服务端拒收的调用照样算通过。于是正则对中文单位恒返回 null（功能
全失效）的坏修复被「验过」却没发现。同源「假护栏」：**验证结论本身要被观测**——给修复写验证时，
先验「我的验证会不会对失效实现也绿」。把判据改成必须查 `ok` 后，坏修复才现形。

**软约束（靠 prompt 让模型自限）不算不变量。** P1 教训是「服务端必须拒收越界写（尝试了也不得
成功）」。定点修订初稿只靠 prompt 指令让模型「只改一章、不整篇重采纳」，既没保证省时（模型可仍走
全量），又留溯源造假口子（模型可把别的章写成 `source=文档`）。任何「不该做 X」的约束若只在提示词
里、没有服务端拒收，等于没约束——要落成 `kb.editScope` 之类的作用域锁 + 越界写入拒收。

**分数判据的下限必须能分开「好实现」与「坏实现」，否则「通过」毫无信息。** r18（材料齐全→组装
高分）长期 75 分绿：实测 qwen3 先 `reqdoc_assemble` 后 ingest、自造地址 1.1~2.4 被服务端拒收 ×4
（1 非法 + 3 重复），口述材料（脱敏/归档）从未进产物，全靠预置槽位撑 75 过 60 线——而做对了
（材料落地）总分≈100。「做对 100」与「跳步 75」共用一条 60 线，判据对坏实现也绿（第 6 条的分数
版）。修法：补 `dimMin: flowClosure 10、compliance 10`（坏态 5、6 必红；好态 20、16 必绿——
scorePrd 是确定性关键词评分，坏产物缺的两个关键词恰好长在被跳过的收尾与合规章节，下限取坏/好
中点之下即可分界）。对抗验证：坏产物离线判红 + 真实模型复跑当场红（0/1）、合成好产物绿（100）。

**定点修订引导曾有双重信号冲突（r23 追查产物）。** 业务说「改完记得重新组装」，静态引导只说
「用 export 拿差异贴回原稿」——只字未提重组装（槽位变了不重组装，kb-digest 过期、定稿三重校验
会拒）；active 块更写成「先 end_scoped_edit 释放锁、再 export 差异」——与锁语义相反（差异导出
要求锁在，释放后 export 会抛，e2e 实证）。修法：两处统一为「先 assemble 重组装 → 锁定期间
export → 最后 end」，`prompt.test.ts` 加文本契约 + 段内顺序断言钉住（回退坏文案当场 2 断言红）。
r23 本身在 vLLM 两变体皆红：模型习惯先 ingest 游走（baseline 无此引导同样犯），4 轮预算内到不
了 assemble；「ingest 打回已确认槽位」的有害半边已被服务端硬拦，残余是模型效率问题，列 P3 观察。


## 回答规范

**「一个概念一个名字」的反例在代码里：** `reqdoc-slots.ts` 的「容器声明。**别名 decls；
两者等价**」——两套名字并存，读的人得同时记住。已存在的别名要在文档标明等价、代码注释写清
来源；**不要新造别名**。

**不做 ASD-STE100 级中文约束**——做不到也不必做，写一条没人遵守的规则比不写更坏。

**为什么 n=1 在本项目无意义**（真实翻转记录）：

- r23 一天内 3/3 → 0/3 → 3/3（端点与夹具都未变）；
- 同一 r27 曾三次 0/3，而全量单次只 1/5；
- 兜底出口率因样本从 45 问句涨到 127 而从 5% 变 13%；
- 观测指标本身错了三轮（虚高 7 倍 → 低报 → 真值），每轮当时都「有代码、有测试、有自检」。

**表格里放管道的命令会改变命令语义。** 当前 `docs/session-management.md` 与 `AGENTS.md`
表格里没有此类违规，此条是**防未来**。


## 已定案一节的完整原文与变更史

`AGENTS.md` 的「已定案，勿重议」一节原先把**定案结论**与**变更史/踩坑**写在同一条目里
（该节 7791 字符，其中约 5801 是变更史）。现`AGENTS.md` 只留结论，依据与变更史在此。

保留全文以便查证：

## 已定案，勿重议（详见 docs/session-management.md）

- **身份全手填**：`opencode-sm init` 交互两问（api_key / 收集服务地址）+ 可选主要工作流类型，写入全局 `~/.config/opencode/session-mgmt/identity.json`，每机器一次。`api_key` 仅本机明文存储；插件上送前转为 SHA-256 哈希（网络不传明文）。**不读上游登录账号**，**没有 team.yaml**。组/组织归属由后台收集服务据 api_key 哈希解析，客户端不再填写。
- **插件不读上游数据库**：身份以 api_key 标识，上送前转 SHA-256 哈希；cost/tokens 经上游 SDK 获取。依赖面仅 Hook + REST API。
- **组/组织归属由后台收集服务解析**：客户端不再填写组/组织，api_key 哈希即身份标识；组名/部门由收集端据哈希映射。CLI 不再支持组/组织级查询。
- **后台收集服务为外部独立项目** `https://github.com/karsonto/performance_dashboard`：插件仅经 `POST /api/report` 上送会话摘要（不含代码，身份以 api_key 的 SHA-256 哈希标识），组/组织聚合由该服务解析；CLI 不再直查组/组织级统计，只做本机会话/项目级聚合。收集端不可用时插件本地缓冲、恢复补推。
- **身份是汇报快照**：改 init 只影响之后的汇报，历史归属不追溯变更。
- **CLI 命名为 `opencode-sm`**（曾短暂叫 ocsm，已废弃，勿再用）。
- 会话不能改名：上游 `Session.Service` 无 update 方法，会话标题由上游自动生成，勿设计 rename 功能。
- 工作流推进是**完成门禁模型**（AI 主动 `workflow_advance`，AI 引导人决定），不是审批流；提交门禁经 `tool.execute.before` 拦截 `git commit` 实现；含提交门禁的工作流（sdlc）失录**基线预估工时**亦阻断（迫使弱模型在提交前主动询问并调用 `workflow_baseline`）；迭代上限 3 轮；`comprehension_confirm` 单次只认一段（防批量走过场）。
- **手工修改走 open_ide 锁定（sdlc-r12，软提示 + 硬拦截）**：开发者要手工改代码时 AI 先调 `open_ide`（带 file 自动锁定，防 AI 覆盖手工改动）；锁定期间 AI 可继续其它任务但不得改被锁文件（`tool.execute.before` 服务端硬拦截）；解锁须开发者明确确认后 `unlock_file`，并重新读取最新内容。open-ide 已**物理合并**进本工程（`packages/plugin/src/open-ide/`，原 `opencode-open-ide` 独立工程已移除）：锁持久化进 SQLite `file_lock` 表（daemon 重启自动恢复），**SDLC 完结时完成态注入解锁提示**（仅 sdlc，经 `hasCommitGate` 门控，reqdoc 不提示）。
- 规则**阶段化注入**：`WorkflowDefinition.rules` 为 `RuleItem[]`（含 `stage` 归属），每轮只注入 global + 当前阶段（`rulesForStage`/`currentInProgressStage`）；状态以阶段状态块（`buildStateBar`，含阶段表头「当前阶段（第 N/Y 步）+ 目的 + 状态」、来源覆盖、渲染校验、追问覆盖多行）展示，替代冗长 JSON。无 in_progress 分三态（未启动/空档/完成），**完成态注入专用完成块**（提交查门禁→引导 /new 开新需求保持统计隔离→workflow_revisit 改本需求），不注入常规规则（避免「尚未开始」与「已全部完成」自相矛盾）。`applyTransition` 严格执行状态机：enter 已 approved 须走 revisit、enter 已 in_progress 幂等；**revisit 级联回退该阶段之后所有已 approved 的下游阶段**（同样 revision++，下游结论建立在被回退阶段之上，须重走）。规则遵循度评测基线在 `scripts/eval-rules/`（不随 `bun test` 跑，需真实模型端点，见设计文档第 13 章）；**评测与质量飞轮实操手册见 `.opencode/skills/workflow-rules-eval/SKILL.md`**。
- **reqdoc 槽位知识库（Slot-filling KB，目标：辅助业务写需求）**：业务「口述 + 丢材料」，AI 代笔。**槽位是唯一事实源**——服务端派生「该问什么 / 覆盖率 / 门禁 / PRD」，PRD 只是槽位的投影（`reqdoc_assemble`），**不得用 write 手写或手工编辑产物**。**模板结构同样只有一份事实源**：`docs/reqdoc-prd-template.md`，由 `reqdoc-template-schema.ts` 解析出章/小节/功能点子节——**换模板只改该 md，不改代码**；政策层（哪些子节必填、哪些必标来源、哪些是容器）按**标题**声明在同文件，改小节标题会由 `unresolvedPolicy` 报出要求人工确认（按编号声明会在章节重排瞬间失效，故不采用）。**代码与规则文本里不得再出现模板地址字面量**（`5.k.2.13`、`4.1` 之类）——编号会随机构模板漂移，写死即误导；模型侧一切以「本轮该填」清单为准（工具描述里的示例地址亦由 schema 实时派生）。护栏 `template-addr-hardcode.test.ts` 扫**全部插件源文件**（不是白名单——白名单式扫描必然漏：新增工具文件就逃过了），只放行占位形状（`<容器地址>.<名称>`）、`${addrHint()}` 插值与设计文档引用（`（6.3）`、`3.4 逃生口`、`要点 2.3`）。**换模板后旧会话怎么办：显式重置**——`schemaAddressSpace`（模板的必填地址空间：功能点章号 + 必填小节 + 容器 + 必填功能点子节，**不含标题**）记在 `kb.templateAddressSpace`，`templateDrift` 做**集合包含**判定：旧必填地址不在新模板里才算漂移（改措辞、机构加一节都不报）；漂移时状态条与三处回执报「建议开新会话重走」。**判据宁窄勿宽**——误报一次就是让业务白做一遍需求。**只报不自动清**（`kb.slots` 是唯一事实源、原地覆盖，自动清等于替业务决定这轮问答不算数；跨版本搬地址的语义服务端无法校验）。**多模板并存：不做**——当前是「一份模板 + 可换」，多模板需模板注册表 + `kb.templateId` + 跨模板记忆语义，等第二个模板要同时在线时再单独设计。**模板不可读时分软硬两路**（对抗审查 P1）：**提示类**（状态条 / 工具回执 / 覆盖率 / 开放项派生 / 漂移检测）一律用 `templateSchemaOrEmpty()`，**绝不抛**——它们每轮都经 system prompt 构建路径被调用，抛一次就是整个请求失败（与 pdfjs 静态 import 拖垮插件加载同类）；降级方向必须安全：必填集为空 → 覆盖率 0% → 门禁必不通过，呈现为「看起来什么都没填」而非「填完了」。**产物类**（组装 / 渲染结构校验 / 骨架生成）一律用 `requireTemplateSchema()`，**必须抛**让用户报障——宁可请求失败也不能产出结构不明的交付件，那会让手改检测、幂等校验、定稿溯源三条防线同时失效且无人察觉。**「不崩」不等于「能用」**：软降级后必填集为空、ingest 收不了地址、开放项问不出问题，而门禁默认文案会把人引向「用 ingest 补齐」这条死路——故提示类路径必须带 `templateUnavailableNotice()`（真因 + 出路 + 承诺已填内容不丢），接状态条与各工具回执。目录契约 00~07（编号即五步编写流顺序：00_初稿需求书 为初稿导入入口；01_背景与目标 / 02_流程与数据 / 03_制度与合规 / 04_角色与权限 为业务投放材料区；05_系统现状与能力 为可选目录；06_功能点、07_需求规格产出为 AI 工作区）。**文档扫描经 `reqdoc_scan(directory)`**（单目录参数、按阶段分步调用，解析 docx/pdf/xlsx/txt/md/json/csv；qwen3.6 纯文本无多模态，图像显式降级提示文字描述）。**工作流**：① `reqdoc_ingest(slots, features?, candidates?, containers?)` 把从材料提取的内容提交为**槽位**（地址必须来自工具返回的「本轮该填」清单，非法地址会被拒；`candidates` 是术语/字段候选，**记忆消缺口的必要条件**，须填材料中真实出现的）；② `reqdoc_answer(address, content, source, reason?, restated_term?)` 逐项请业务确认后落定（`source=缺省` 必附 reason）；③ `reqdoc_assemble(source?)` 由服务端按《业务需求说明书》模板投影出整篇 md（结构与来源标签由服务端保证，产物内嵌 `<!-- kb-digest -->` 槽位摘要）。**功能点拆解**：`reqdoc_confirm_features(features)` 记录并建 `06_功能点/N_名称/` 子目录。**唯一门禁是 `kbGate`**（`reqdoc-slots.ts`）：必填叶子槽位覆盖率 + 必填容器（术语容器 / 字段容器，地址由模板结构派生）已覆盖或已声明可为空 + 无未收口项（停问项/conflict）；确实无法补齐且业务坚持时 `force_kb=true` + 业务给的 `force_reason` 放行（理由模型不得代填）。**记忆机制**（`reqdoc-memory.ts`，跨需求共享）：匹配证据是 **00~05 材料原文**（`materialEvidence`，非模型转述的槽位正文；`06/07` 不作证据）——因此 `[问答]`/`[缺省]` 来源的槽位不参与记忆匹配，记忆只服务材料驱动场景；L1 术语（业务主动复述，`origin=restated`）命中即**免问**不再问——**免问项不在「本轮该填」清单里且仍是 draft，须由模型随后 `reqdoc_answer` 落定，source 一律标「问答」**（定义出自过往需求中业务的复述，材料只出现该词、并未给出定义；标「文档」等于在交付件上做不实溯源，`r30` 已注明不算来源降级）。不落定则术语容器覆盖不过、进 prd 被拦；****分支二（改已有需求：自己的初稿 / 本流程上一版定稿 / 换会话接手）**：**调用序按 `reqdoc-r36` 不跳步**——import 导入为 `[文档]` → `reqdoc_ingest` 提交槽位（**每项 ref 填稿路径**）→ `reqdoc_adopt_baseline` **先不带 confirm 预演**（按章分组清单给业务过目）→ 带 `confirm=true` + `authorized_by` + `confirm_note` 执行（**两项须来自业务，模型不得代填**，照 `force_kb`/`force_reason` 先例）+ `unmapped`（稿里有、模板装不下的内容）**逐条申报处置**——不申报这类内容会静默消失（PRD 只渲染已登记的需求要点）；只认 `source=文档` 且 `ref` 指向该基线文件的槽位（`[问答]` 冒充基线 = 不实溯源），**承认基线不豁免任何必填项**；确认时冻结 `kb.baselineSnapshot`（`kb.slots` 原地覆盖不留历史，没快照就答不出「这次改了哪些」）。沿用基线后**只问「旧稿未覆盖的必填项 + 新增功能点」**。**别被状态条的「必填容器未覆盖」带偏**：术语容器与字段容器（本轮清单里 `kind=term` / `kind=field` 的那两个）是**聚合判定**——旧稿里有对应内容就提交成容器叶子（地址形如 `<容器地址>.CRD`），容器即算覆盖；确实没有才声明 `required:false` + reason，**不要把旧稿里已写着的术语与字段重问一遍**——「问业务要改什么」是**对话义务而非服务端机制**（曾有 `reqdoc_scope` 范围声明，已砍：靠上面这条 + 纯追加护栏 + `r35②` 即可，不必新增工具与状态字段）。定稿回执输出**本次变更清单**（新增/改写/不再需要/新增功能点，只认 `confirmed`），**只在回执里说，不改交付件格式**。**功能点只能追加末尾**（Step 3 硬拦），**ingest 不得把已确认槽位打回 draft**（整批拒绝并指路 `reqdoc_answer`，不做静默跳过——跳过会让模型以为改成功而实际没改）。**已知限制**：旧稿章节与模板不一致时，映射由 AI 完成、服务端无法校验语义正确性——六道防线全在「槽位→产物」一侧，内容错位只能靠业务核对；**`00_初稿需求书/` 里任何文件都会被当成「分支二（改已有需求）」并承认基线**，故该目录只放本需求自己的初稿或上一版定稿（曾做 `参考_` 证据面隔离，已砍；那次隔离也没覆盖这条更重的路径，非本次退化）。动作指令载于 `reqdoc_ingest` 的工具描述**（model-only、每次请求都在、不分阶段），回执与状态条只报事实且措辞可直接转述（`07-业务口语` 第 3 节：状态条面向模型、允许带地址与门禁原因，讲给业务听时按第 1 节翻译）。**给用户看的故障提示只能挂状态条**——工具回执在 TUI 默认不渲染（上游 `routes/session/index.tsx` 的 `generic_tool_output_visibility` 默认 false，且折叠只显示前 3 行）、桌面端 `GenericTool` 不渲染 `output`；状态条是唯一无条件进 system prompt 的载体。挂回执等于没告诉用户（曾因此把「模板不可用」提示挂在 prd 分支内，而模板坏掉时用户多在 goal/rules 阶段，恰好是最需要提示时看不到）；L2 组织知识命中**不消缺口**，只作默认值仍问一次；**静默点默认不入库**（防污染唯一入口），同名不同义不静默覆盖。记忆**不影响门禁判定**（只影响"问什么"）。`reqdoc_answer(restated_term=…)` 在业务复述时写 L1，**`business_quote`（业务原话）必填、留空拒写**——L1 命中即免问、免问项由模型自己落定、业务不再被问，污染不可逆且旧条目只有模型释义无从追查，与 `force_reason`/`confirm_note` 同一原则；`reqdoc_memory_recall(facts, prefs?, retire_slots?)` 在定稿后由**业务勾选**才写 L2/L4（自动写等于"AI 决定什么值得记住"，污染成本高）。可见性/遗忘走 `opencode-sm memory list|forget`。**定稿三重校验**（`review_submit`）：① `kbGate`；② 摘要一致（`kb-digest`）——抓"槽位变了没重组装"；③ **重组装 LCS 比对**（服务端重投影一次与磁盘产物逐行比对）——抓纯内容手改与**行置换**；溯源章节独立校验（与 `reviewRecord` 逐条对照，防伪造证据）。PRD 定稿后经 `reqdoc_export(source=PRD路径)` 导出 Word 交付件。**sdlc 完全不动**（记忆不得影响 sdlc 门禁与理解确认）。详细机制见 `docs/workflow-reqdoc.md`（现行实现权威源）与 `docs/reqdoc-kb-refactor.md`（设计+实施记录）。
- **编写规约（绑定规约，按工作流类型 + 阶段门控 + 只注入）**：机构规约按工作流类型放 `packages/plugin/conventions/<type>/*.md`（基线，随插件打包）；机构覆盖放 `<项目根>/conventions/<type>/*.md`（插件读取、按 `workflow.type` 隔离、不跨流泄漏）。每个 `.md` 头部 frontmatter 声明 `stage:`（`global`=常驻全程，否则仅在对应当前阶段注入，无 in_progress 只注入 global）——与 `rulesForStage` 的「global + 当前阶段」哲学一致、降低弱模型上下文负担。插件 `loadWorkflowConventions(type, stage, projectRoot)`（`src/conventions.ts`）读目录内 `*.md`（跳点文件）解析 frontmatter 排序过滤拼接，`buildSystemFragment` 按 `def.type`+`stage` 注入（`createSystemTransform` 收 `directory` 传入项目根），只注入、无门禁、不进 `RuleItem`/打分/评测。通用常驻机构规则写机构自己的 `AGENTS.md`（OpenCode 原生合并），不放 conventions 目录；新增工作流规约 = 丢一个带 frontmatter 的 `<type>/` 目录，零代码。sdlc：`01-提交信息规约` global（`[AI]` 标题末标记，提交发生完成态故常驻），编码/安全/日志/并发幂等 implementation；reqdoc：范围边界 goal、术语命名/状态机 rules、异常/NFR edge、可验证性 prd。

