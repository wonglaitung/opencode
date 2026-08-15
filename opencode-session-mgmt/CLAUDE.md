# opencode-session-mgmt

OpenCode 会话管理定制：标准化开发流程（五阶段门禁）、理解保障（复述确认）、效能分析（Token ROI / 返工率）。
形态为 **插件 + 独立 CLI + org 收集服务**，对 OpenCode 上游**零修改**，以便持续同步上游更新。

## 铁律（破坏则同步上游必冲突）

- **不修改 `packages/*` 下任何上游文件**，也不改仓库根目录的 `CLAUDE.md` 等上游文件——根 CLAUDE.md 是上游的，本文件才是本项目的。
- 所有定制产出只落在定制目录内：`opencode-session-mgmt/`（本工程）与 `opencode-edge-debug/`（按需 Edge 调试插件，独立工程）。
- 本目录是独立 bun workspace，**不被上游根 workspace 收录**（上游 glob 为 `packages/*` 等，不匹配本路径）；改动后须确认上游根 `package.json` 的 workspace glob 仍不匹配本目录。
- 上游同步策略：**日常 `git pull` 只同步 `origin`（wonglaitung/opencode），不要主动同步 anomalyco/opencode**；仅当明确要求「同步上游」时才按 `docs/upstream-sync.md` 手工执行（remote：`origin`=wonglaitung/opencode，`upstream`=anomalyco/opencode 且 push 已禁用）。

## 已定案，勿重议（详见 docs/session-management.md）

- **身份全手填**：`opencode-sm init` 交互四问（账号 / 组 / 组织 / 收集服务地址），写入全局 `~/.config/opencode/session-mgmt/identity.json`，每机器一次。**不读上游登录账号**，**没有 team.yaml**。
- **插件不读上游数据库**：account 打标取自 identity.json；cost/tokens 经上游 SDK 获取。依赖面仅 Hook + REST API。
- **group 是名称字符串**，无 ID、无嵌套表；子组用命名约定（`前端组/基础架构组`）。CLI 参数 `--group "组名"`。
- **收集服务每 org 部署一个**（内网 HTTP），三端点：`POST /api/report`（插件汇报，不含代码）、`POST /api/ci-quality`（CI 回写）、`GET /api/stats`（CLI 查询）。不可用时插件本地缓冲、恢复补推。
- **身份是汇报快照**：改 init 只影响之后的汇报，历史归属不追溯变更。
- **CLI 命名为 `opencode-sm`**（曾短暂叫 ocsm，已废弃，勿再用）。
- 会话不能改名：上游 `Session.Service` 无 update 方法，会话标题由上游自动生成，勿设计 rename 功能。
- 工作流推进是**完成门禁模型**（AI 主动 `workflow_advance`，AI 引导人决定），不是审批流；提交门禁经 `tool.execute.before` 拦截 `git commit` 实现；迭代上限 3 轮；`comprehension_confirm` 单次只认一段（防批量走过场）。
- **手工修改走 open_ide 锁定（sdlc-r12，软提示 + 硬拦截）**：开发者要手工改代码时 AI 先调 `open_ide`（带 file 自动锁定，防 AI 覆盖手工改动）；锁定期间 AI 可继续其它任务但不得改被锁文件（`tool.execute.before` 服务端硬拦截）；解锁须开发者明确确认后 `unlock_file`，并重新读取最新内容。open-ide 已**物理合并**进本工程（`packages/plugin/src/open-ide/`，原 `opencode-open-ide` 独立工程已移除）：锁持久化进 SQLite `file_lock` 表（daemon 重启自动恢复），**SDLC 完结时完成态注入解锁提示**（仅 sdlc，经 `hasCommitGate` 门控，reqdoc 不提示）。
- 规则**阶段化注入**：`WorkflowDefinition.rules` 为 `RuleItem[]`（含 `stage` 归属），每轮只注入 global + 当前阶段（`rulesForStage`/`currentInProgressStage`）；状态以一行阶段条展示（`buildStateBar`），替代冗长 JSON。无 in_progress 分三态（未启动/空档/完成），**完成态注入专用完成块**（提交查门禁→引导 /new 开新需求保持统计隔离→workflow_revisit 改本需求），不注入常规规则（避免「尚未开始」与「已全部完成」自相矛盾）。`applyTransition` 严格执行状态机：enter 已 approved 须走 revisit、enter 已 in_progress 幂等；**revisit 级联回退该阶段之后所有已 approved 的下游阶段**（同样 revision++，下游结论建立在被回退阶段之上，须重走）。规则遵循度评测基线在 `scripts/eval-rules/`（不随 `bun test` 跑，需真实模型端点，见设计文档第 13 章）。
- **reqdoc 重构（双通道 + 功能点拆解 + PRD 质量打分卡，目标：辅助业务写需求）**：业务「口述 + 丢材料」，AI 代笔。目录契约改 01~06（01_背景与目标 / 02_制度与合规 / 03_流程与数据 / 04_角色与权限为业务投放材料区；05_功能点、06_需求规格产出为 AI 工作区）。**文档扫描经专用工具 `reqdoc_scan(directory)`**（单目录参数、按阶段分步调用，解析 docx/pdf/xlsx/txt/md/json/csv；qwen3.6 纯文本无多模态，图像显式降级提示文字描述）。**prd 前置功能点拆解**：综合材料 + 问答拆功能点清单 → 业务确认后 `reqdoc_confirm_features(features)` 记录并建 `05_功能点/N_名称/` 子目录（来源摘录），同时幂等预建 `06_需求规格产出/N_名称/`。**PRD 质量打分卡（实施方案第三节）**：edge 完成进 prd 前经 `reqdoc_score` 五维打分（满分 100，`total` 服务端计算，`business_confirmed` 强制）→ 按《业务需求说明书》模板渲染，逐字段标来源 `[文档]/[问答]/[缺省]` 绝不杜撰，渲染严格逐字遵循模板（reqdoc-r20 铁律，模板内部瑕疵一律原样输出，扣分项按字段映射落位）；≥85 分且业务确认才可进入 prd 渲染与定稿（workflow_advance enter(prd) + review_submit 两处硬门禁，仅 reqdoc）；未达标按三档分级引导（<60 补主流程与异常、60-84 补脱敏/权限/逆向、≥85 停止追问），追问严禁纯技术词汇（reqdoc-r21/r2，实施方案第四节）。展示得分附质量得分进度条（reqdoc_score 返回文本服务端渲染 10 格）。扣分明细含证据仅本机留痕、汇报不上行。PRD 定稿后经 `reqdoc_export(source=md路径)` 导出 Word 交付件（md→docx，docx 库，与 md 同目录归档）。**三大支柱与加固优先级**：追问（喂入）→ 打分（门禁）→ 模板（交付）三根支柱缺一不可；模板/打分已结构性固化（模板权威源 + 单一事实源 + 服务端算分，漂移风险低），**追问为纯规则文本驱动、是全流程最软一环，后续加固优先做追问的可验证化**（追问轮次计数、关键探针覆盖检查），不是动模板与打分。sdlc 完全不动。

## 结构

```
packages/shared/     # 契约包：WorkflowState 类型、汇报 payload、identity、合并语义（三包共用，先完成）
packages/plugin/     # OpenCode 插件：system prompt 注入、工具注册、提交门禁、汇报
packages/cli/        # opencode-sm 独立 CLI：init/tag/workflow/stats/list
packages/collector/  # org 收集服务：三端点 + 聚合库
deploy/              # 部署示例：收集服务 docker-compose、opencode.json.example
docs/                # 设计文档 session-management.md、同步方案 upstream-sync.md
```

每个源文件 stub 顶部注明对应设计文档章节，实现前先读该章节。

## 技术约定

- bun workspace monorepo；bun 直接跑 TS（CLI 入口 shebang `#!/usr/bin/env bun`）。
- TypeScript strict；新代码零 `any`；`bun build --compile` 出 CLI 单二进制。
- 插件 Hook 基于 `@opencode-ai/plugin` 的 `Hooks` 接口，均为 experimental——**同步上游后优先核对 hook 签名**（尤其 `experimental.chat.system.transform`），变更只需改 `packages/plugin/src/prompt.ts` 适配层。
- **插件入口 `packages/plugin/src/index.ts` 只能 default 导出插件工厂，内部辅助函数一律不加 `export`**。opencode 的 legacy 加载器会把模块「所有函数导出」都当作插件工厂，以 `(input, options)` 逐一调用；曾因 `syncSessionTitle`/`backfillSessionTitles` 加了 `export`，被当作工厂调用时首行 `store.get(sessionID)` 抛 `store.get is not a function`，导致插件加载失败、opencode 启动报 `Unexpected server error`（见 5.2 与 `index.ts` 内注释）。
- 本地存储用 bun:sqlite。
- `bun test` 跑测试；测试文件与源码同目录 `*.test.ts`。

## 经验教训（通用约定）

- **用户手写 JSON 配置含文件路径时，单反斜杠是陷阱**（三工程通用约定）：JSON 里 `\` 是转义符——`\P` 等非法转义导致解析失败（回退默认但用户不明所以）；更隐蔽的是 `\b`/`\n`/`\t` 是**合法**转义，`"C:\bin\..."` 会被静默转成控制字符，路径错但 JSON 解析"成功"。凡工程引入用户可编辑的 JSON 配置且可能含文件路径，文档必须明确要求**用正斜杠 `/`（Windows 原生接受）或双反斜杠 `\\`**；代码侧解析失败时 warning 要直接点出这个诱因。本工程现状：`identity.json`（账号/组/组织/服务地址）不含文件路径，`deploy/opencode.json.example` 的 plugin 路径为相对/正斜杠写法；插件 `config.json`（源出已合并的 open-ide）含用户可编辑的 `tools` binary 路径，须按本约定落实（见 `packages/plugin/src/open-ide/config.ts`）。
- **配置文档示例须显式标注字段语义**（覆盖 / 新增 / 缺省用默认），避免用户误以为所有项都要写全才生效。本工程现状：插件 `config.json` 的 `tools` 示例标注「cursor=新增、idea=覆盖」（源出已合并的 open-ide）。

## 文档与语言

- 设计文档、注释、commit message 用**中文**；conventional commit 格式（本仓库历史可参照）。
- **任何文档与注释都不要用 `§` 符号**引用章节，一律用纯文字（「第 3 章」「3.4 节」或裸编号「见 3.4」）。
- 设计文档任何行为变更须同步更新对应 mermaid 流程图（共 17 个），改链路必改图。
- 发布前 TODO 见 `README.md`（npm scope、插件发布形态、收集服务镜像）。
