# 定点修订（对话引导式 · 保留原稿 / 乙）— 设计与实施

> 状态：实施中。权威实现源并入 `docs/workflow-reqdoc.md` 后本节同步。
> 对抗审核结论与局限见末尾。

## 1. 决策汇总（已锁定）

| # | 项 | 决定 |
|---|---|---|
| 1 | 修订模式 | 对话引导（AI 问、业务答），**彻底去掉文件重传** |
| 2 | 来源标注 | 改/补内容 `source=问答`；原文档已摄入部分仍 `source=文档` 不变 |
| 3 | 章解析目标 | **PRD/模板章**（非用户原稿章）；支持数字/标题/内容词三输入 |
| 4 | 锁定前确认 | 说"改第 N 章"后回显 PRD 章目录+标题+内容预览，确认才置 `editScope`（每次都确认） |
| 5 | 跨章影响 | 只列不阻断 |
| 6 | 硬不变量 | `editScope` 服务端作用域锁 + 越界拒收 + 进入/退出明确 |
| 7 | retirement 守卫 | 章内 >50% 槽位 retired 须显式 `confirmRetire` |
| 8 | 原稿章名解析 | PRD 内搜词→列候选→用户认领→解析到 PRD 章（可集合）；找不到=补进（`问答`），不静默 |
| 9 | 能力披露 | 修订意图出现时 AI 抛"整体 vs 只改某章"分叉；建书完常驻一句；状态条加模型提醒 |
| 10 | 用户选乙 | 内部仍产完整模板 PRD（工作底稿），交付物=改动部分；新增定点导出 |

导出形式：**两者都要、默认 diff**（差异含增/删/改；整章正文备选）。

## 2. 用户视角节

**实际操作顺序**：上传原稿→初评+常驻能力一句→说"改第2章"→AI 回显 7 章目录让你认"第2章『流程与数据』对吗"→引导问事实→只动第2章、改的内容标"来自你的口述"→列跨章影响不阻断→问导出（差异/整章）→给 diff+原稿映射+单向提醒→你说"改完了"清锁。

**不变的部分**：原稿文件只进不出；PRD 仍槽位纯函数投影；定稿完整度门禁不变；首次接入流程不变。

**不会发生 / 你须配合**：不逼答全部必填项；不偷偷改他章；不替你拍板。你用"第N章"或原稿节名指明；被问给事实。**单向提醒**：导出贴回原稿后系统**不回读**你手改的原稿。

**before/after**：只改一章=引导只动该章+导出贴回；越界写被拒；误删>50%须确认；原稿章名可解析；导出可选整章/diff。

## 3. 技术节

**架构基线（全复用）**：`SlotSource`、`reqdoc_answer`、`deriveQuestions`、`chapterContainers`、`docSectionAddrs`、`assembleDoc`、`diffAgainstBaseline`+「文档变更过程」、`reqdoc-export.ts` 已存在。

**实施步骤**
1. `shared/reqdoc-slots.ts`：`resolveChapterLabel(label,schema)`（PRD 章，三输入+候选）、`chapterOf(addr)`、`slotsByChapter`、`crossChapterImpact`、`chapterRetireRatio`、`chapterDiff(before,after,ch)`、`DeriveOptions.chapter`。
2. `shared/workflow.ts`：`ReqdocKbState.editScope={chapter,snapshotBefore,active,sessionId}`（会话绑定，会话结束或新 baseline 强清）；引导修订指引放 `plugin/prompt.ts`（prd 阶段注入），不另立全局规则以免撑大上下文预算（见 reqdoc-context-budget 守卫）。
3. `plugin/tools/reqdoc-kb-tools.ts`：`editScope.active` 时 ingest/answer **拒收章外地址**；`confirmRetire?:boolean`，`chapterRetireRatio` 超阈值未确认则拒收（守卫同时查"内容变空占比"防替换绕过）。
4. `plugin/tools/review.ts`：复用 `diffAgainstBaseline`（基准=`editScope.snapshotBefore`）。
5. `plugin/tools/reqdoc-export.ts`：`mode:"chapter"|"diff"`+`chapter`；diff 用 `chapterDiff`；附**原稿节映射**+**单向提醒（写进聊天）**+**跨章影响一并写进导出**。
6. `plugin/prompt.ts`：引导行为（不代写、默认项标推测、未变`文档`不重标、结束清锁）+ 能力披露（抛分叉）+ 章解析回显确认（含内容预览，要"是/不是"）。

**7 条加固（重构后）**：① editScope 锁+越界拒收 ② 跨章影响列出（废弃文件跨章检测） ③ 对话 retirement 确认守卫（>50%） ④ 列影响不阻断+定稿人工过目 ⑤ snapshotBefore 编辑前快照 ⑥ export 未定稿+retirement 章告警 ⑦ 章解析升级为 PRD 章（数字/标题/内容）+锁定前回显确认（含预览）。

**文件清单**：shared/reqdoc-slots.ts、shared/workflow.ts、plugin/tools/reqdoc-kb-tools.ts、plugin/tools/review.ts、plugin/tools/reqdoc-export.ts、plugin/prompt.ts。

## 4. 对抗审核

**已覆盖硬不变量**：`editScope` 锁+越界拒收、`confirmRetire` 守卫——服务端强制，呼应 agents-notes「软约束不算不变量」。

**须落地的修订（防真实 bug/盲区）**
- **B 会话清锁**：`editScope` 持久化，会话中途退出会残留→下会话误拒他章。改：绑会话/TTL，结束或新 baseline 强清。
- **I 提醒进聊天**：单向提醒若写工具回执，TUI 默认不渲染→用户看不见。改：写聊天消息。
- **G 影响进导出**：聊天气泡里的跨章影响易被跳过。改：写进导出产物随 diff 走。
- **C 补进 vs scope**："找不到=补进"可能跨章突破窄 scope。改：补进限定章内或显式退 scope+指定目标章。
- **D 确认带预览**：模糊命中错章+rubber-stamp。改：回显附内容片段+要"是/不是"。
- **F 替换绕过**：守卫只查 retired，替换成空可绕过清空。改：查"内容变空占比"。
- **J AGENTS.md #7 旧措辞**：删去"source=文档 须从 ref 文件解析"子句（乙已弃文件）。

**须声明的已知局限（不假装解决）**
- **A 双真相源漂移**：乙 固有，M 次手贴后与原稿 PRD 可永久分叉，系统不感知。建议每次即时贴回。
- **E 格式不同**：导出 diff 出自模板 PRD，格式/章名与你原稿不同，贴回需手动适配；unmapped 内容走"补进"另出。
- **H 披露软约束**："抛分叉"靠 prompt/状态条非强制，模型可跳过（仅便利损失）。

**结论**：硬不变量扎实；乙 引入 6 处须落地修订（B/I/G/C/D/F）+ 3 处局限声明（A/E/H）；架构影响不大（无新来源/工具，净改动限于 editScope 锁+导出选项+引导意图）。

## 5. 验收口径

`bun run typecheck` + 三包分目录全量 `bun test` + `bun run eval:dry` 新场景"对话引导只改一章（乙：定点导出）"。单元测试：`resolveChapterLabel`/`slotsByChapter`/`crossChapterImpact`/`chapterRetireRatio`/`chapterDiff`/`deriveQuestions({chapter})`。集成：摄入→采纳基线→"改第2章"→引导→断言仅第2章变且标`问答`、他章`文档`完好、`editScope` 拒收越界（回归）、>50% retired 触发确认、找不到=补进、导出 chapter/diff 含映射+提醒+影响、跨章影响列、全门禁未触发。
