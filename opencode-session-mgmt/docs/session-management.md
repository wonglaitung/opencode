# Session Management: 标准化开发流程、理解保障与效能分析

> **文档族说明**：本文档是设计文档族的主文档（通用机制与架构）。文档族共三份：`session-management.md`（本文档，通用机制 / CLI / 统计 / 部署 / 评测）、`workflow-sdlc.md`（工作流一：sdlc 软件开发定义与规则）、`workflow-reqdoc.md`（工作流二：reqdoc 需求书定义与规则）。引用约定：跨文件引用带文件名前缀（如「见 workflow-reqdoc.md 5 章」）；不带前缀的章号（如「见 3.2」）指本文档。通用机制只在本文件定义一次；两个工作流的**专属内容**（工作流定义 / 规则全文 / 清单 / 场景 / 目录契约）已拆到各自文件，本文件只留摘要指针与指引。文档族导览见 1.5。

## 1. 概述

### 1.1 核心问题

开发人员在使用 OpenCode 进行 AI 辅助开发时，面临三个层次的问题：

| 层次 | 问题 | 本质 |
|------|------|------|
| 过程管理 | 多个需求并行，如何在会话间切换并走完完整流程 | 效率问题 |
| **理解保障** | **AI 生成了代码，人是否真正看懂了？三个月后谁能维护？** | **控制权问题** |
| 效能度量 | AI 到底提效了多少？Token 消耗是否合理 | 可证明性问题 |

这三个层次对应《领导汇报_退出风险与ROI评估》中的两个核心疑问：

- **疑问一（退出风险）**：AI 写的代码，人能不能接、能不能改、AI 停了怎么办
- **疑问二（ROI 验证）**：Token 投入与产出之间的关系，同等产出下资源配置的优化空间

### 1.2 核心场景

**基本前提**：开发人员始终在 TUI 内，以自然语言对话的形式进行开发。工作流的推进（进入阶段、确认完成、回退）、代码审查、理解确认，全部通过对话完成，不需要退出 TUI 执行 CLI 命令。

CLI 只做两件事：
- **会话管理**：在 TUI 之外创建、列表、删除、标记会话
- **外部查看**：在不进入 TUI 的情况下查看工作流状态和统计数据

开发人员使用 OpenCode 进行 AI 辅助开发时，经常在同一时间收到多个需求。每个需求需要走完完整流程：需求分析 → 设计 → 编码 → 测试 → 审查 → 提交。每个需求对应一个会话，在不同需求之间来回切换，但每个需求都能走完完整流程。

### 1.3 能力清单

系统提供四项能力：

1. **会话管理** — 纯 CLI 子命令，不依赖 TUI 也能管理会话
2. **工作流追踪** — 确保每个会话走完完整流程，允许反复迭代但不可跳过
3. **理解保障** — 确保开发者真正理解 AI 生成的代码，而非仅仅"审查通过"
4. **使用分析** — 支撑投入产出评估、算力预算规划与质量监控，为资源配置决策提供数据依据

### 1.4 现状架构

OpenCode 采用 C/S 架构：

```mermaid
graph LR
    subgraph Client["客户端"]
        CLI["CLI 命令行"]
        TUI["TUI 终端UI"]
    end

    subgraph Daemon["本地 Daemon（自动启动）"]
        API["REST API Server<br/>127.0.0.1"]
        Engine["Agent Engine"]
    end

    subgraph Storage["本地存储"]
        DB["SQLite"]
    end

    subgraph External["外部"]
        LLM["LLM Provider"]
    end

    CLI -->|"HTTP"| API
    TUI -->|"HTTP"| API
    API --> DB
    Engine --> LLM
    API --> Engine
```

**TUI 已有完善的会话管理**（不需要改动）：创建、列表、删除、重命名、快速切换（`<leader>1-9`）、分叉、后台运行、压缩、中断、恢复。

**REST API 已完备**（全部复用，不修改）：`session.list`、`session.create`、`session.get`、`session.prompt`、`session.compact`、`session.interrupt`、`session.active`、`session.context`、`session.history`。上游 CLI 也已有 `opencode session list|delete`、`opencode stats`（token/费用统计）。

**Project（项目）是自动关联的**：OpenCode 根据工作目录自动创建 Project（`ProjectTable`，含 `worktree` 路径、`name`、`icon` 等）。开发者在某个目录下启动 OpenCode 时，自动关联该目录对应的 Project。Session 创建时自动继承当前 Project 的 `project_id`。**开发者不需要手动设定或管理 Project**。

> **例**：Alice 在 `~/work/user-service` 下执行 `opencode`，OpenCode 自动创建 Project（`worktree=/home/alice/work/user-service`，`name=user-service`，`id=proj_a1b2c3`）；她在 TUI 里创建的会话自动继承 `project_id=proj_a1b2c3`。第二天她在 `~/work/frontend` 启动 OpenCode，会话自动归属另一个 Project。全程无任何配置操作。因此统计时 `opencode-sm stats --period 7d` 省略 `--project` 即按 CWD 自动聚合本项目数据；组/组织层级聚合由外部收集服务 `performance_dashboard` 的看板提供，CLI 仅做本机会话/项目级聚合（见 3.1、5.2）。

**上游未覆盖的能力**由定制三件套补齐——**插件 + 独立 CLI `opencode-sm` + org 收集服务**（见 2.4，全部不修改上游代码）：

1. 工作流追踪机制（阶段推进、审查门禁、提交门禁）
2. 理解保障机制（代码片段级的理解确认记录）
3. 会话标签与扩展属性（tags、status）
4. 组/组织级的使用统计与质量分析

### 1.5 文档族导览（三个文件怎么分工）

本设计文档族按「**通用机制 / 两个工作流**」三层拆分为三个文件，避免原先一个文档里通用实现与两套工作流纠缠难读：

| 文件 | 内容 | 读者 |
|------|------|------|
| **`session-management.md`（本文档）** | 通用机制与架构：数据模型（3 章）、接口设计（4 章）、CLI（5 章）、统计（6 章）、Agent 工作流约束的机制面（7.1/7.3）、文件清单（8 章）、部署（9 章）、升级（10 章）、安全（11 章）、验证（12 章）、评测方法论（13 章） | 全角色通读 |
| **`workflow-sdlc.md`** | 工作流一：sdlc 软件开发定义（2 章）、12 条规则全文（3 章）、场景一~四（4 章）、审查清单（5 章）、提交门禁（6 章）、统计口径（7 章）、评测场景（8 章） | 开发者 |
| **`workflow-reqdoc.md`** | 工作流二：reqdoc 需求书定义（2 章）、需求资料目录契约（3 章）、24 条规则全文（4 章）、打分卡（5 章）、追问探针（6 章）、渲染结构校验（7 章）、专属工具（8 章）、场景五（9 章）、评测（10 章） | 需求分析师 |

**阅读建议**：先读本文档 1~3 章理解通用机制，再按角色读对应工作流文件；两个工作流文件里出现的「见 session-management.md X.Y」即回指本文档的通用机制。跨文件引用带文件名前缀、不带前缀的章号指当前文件。

---

### 1.6 AI 编码质量管控框架（方法论基础）

本工程不只是一套 OpenCode 插件，更是一套可复用的 **AI 编码质量管控方法论**的落地：用确定性的机制，把"AI 写代码质量不可控"拆成可治理的维度。业界对 AI 辅助研发的质量管控，普遍落在三类根本杠杆——**约束（让它别乱来）、上下文（让它懂业务/架构）、过程（让它按人类节奏走）**；本工程在三者之外，把"度量反馈"显式立为第四根支柱，构成完整闭环。

#### 1.6.1 为什么需要框架

AI 编码产出的质量风险可分为四类，缺一便会在某个环节失控：

| 风险 | 表现 | 失控后果 |
|------|------|----------|
| 约束缺失 | 无统一规约，模型各写各的 | 风格/安全/异常处理不一致，不可维护 |
| 上下文缺失 | 模型不掌握架构与功能语义 | 改对一处、破坏一片，幻觉式实现 |
| 过程缺失 | 无标准化流程与人在回路 | 跳步、漏审、需求与代码脱节 |
| 度量缺失 | 改了规则/提示词但无基线对照 | 凭直觉调优，弱模型遵循度悄然退化 |

#### 1.6.2 四支柱框架

每一根支柱都对应业界成熟概念，并已在本工程找到具体落点：

| 支柱 | 业界概念 | 本工程落地 | 载体 |
|------|----------|------------|------|
| ① 制定规约 | Guardrails / Policy-as-Code（Linter、Style Guide、`.cursorrules`/`AGENTS.md`、ADR） | 机构规约按工作流类型放入 `conventions/<type>/*.md`，frontmatter 声明 `stage`，每轮只注入 global + 当前阶段；基线随插件打包，项目根 `conventions/<type>/*.md` 覆盖不跨流泄漏 | `packages/plugin/conventions/` + `src/conventions.ts` |
| ② 增强知识 | Context Engineering / Repo-level RAG（代码库语义检索、架构文档注入） | 现状仅 `comprehension_ask` 把审查问答沉淀为"可检索知识库"；**架构级/功能级知识层尚未建立**（演进方向见 1.6.4） | `comprehension_*` 工具（部分）；知识层待建 |
| ③ 智能协同 | Agentic Workflow + Human-in-the-loop（强制门禁、确认闭环、工具编排） | sdlc / reqdoc 五阶段完成门禁，AI 主动 `workflow_advance`、引导人决策；`comprehension_confirm` / `reqdoc_*` 确认闭环；本插件即此支柱的工程化身 | `packages/plugin` 工作流 + 工具 |
| ④ 度量反馈 | LLM evals / 回归测试（提示词/规则迭代必带基线） | `scripts/eval-rules` 打分卡八维回归 + `--fail-on-regression`，改规则前跑基线、改后对比，通过率/八维分不降才保留；详见第 13 章评测方法论 | `scripts/eval-rules/` |

> **关于"规约沉淀"**：第①柱不是一次性写死的手册，而是随评审与规则迭代持续累积的组织资产——每轮评测发现的弱模型遵循短板，反向沉淀进 `conventions/` 与规则文本，形成"实践 → 规约 → 再实践"的资产化闭环。

```mermaid
graph TB
    F["AI 编码质量管控框架"]
    F --> R1["① 制定规约 / Guardrails / Policy-as-Code<br/>conventions/ 阶段化注入"]
    F --> R2["② 增强知识 / Context Engineering / RAG<br/>现状仅 comprehension_ask 知识库（架构层待建）"]
    F --> R3["③ 智能协同 / Agentic Workflow + 人在回路<br/>sdlc / reqdoc 五阶段门禁"]
    F --> R4["④ 度量反馈 / LLM evals / 回归<br/>eval-rules 八维 + --fail-on-regression"]
```

#### 1.6.3 支柱关系：约束 → 信息 → 过程 → 度量

四支柱不是并列清单，而是闭环：

- **约束**（①）给模型划定边界；
- **信息**（②）给模型补足架构/功能语义，让它在该边界内做对的事；
- **过程**（③）把单次交互编排为标准流程，并在关键节点让人确认；
- **度量**（④）用评测基线量化前三者的实效，发现退化即回流修正规约与提示词。

闭环方向：① 规约 → ② 知识 → ③ 协同 → ④ 度量 →（回流）① 规约。缺少④，前三者的优化便失去客观判据；缺少②，①与③只能治标（约束得住行为，治不了理解）。

```mermaid
graph LR
    A["① 制定规约<br/>划定边界"] --> B["② 增强知识<br/>补足语义"]
    B --> C["③ 智能协同<br/>编排流程 · 人在回路"]
    C --> D["④ 度量反馈<br/>评测基线 · 量化实效"]
    D -.->|退化回流修正规约与提示词| A
```

#### 1.6.4 与文档族及演进方向的映射

- **文档族分工**：本文档（通用机制 + ③的过程面 + ④的评测方法）；`workflow-sdlc.md` / `workflow-reqdoc.md` 是③的规则实例；`conventions/` 目录是①的载体；`scripts/eval-rules/` 是④的工具。
- **演进方向（待办，非本次实现）**：第②柱的"架构级/功能级知识层"目前是最大缺口。后续可在 `knowledge/<type>/`（或接 RAG 检索底座）落地"按需取架构/功能知识注入系统提示"的机制，与现有 `conventions/` 的阶段化注入同源，补齐闭环中最弱的一环。

## 2. 技术决策记录

### 2.1 工作流模型选择

#### 候选方案对比

| | 方案 A：严格流水线 | 方案 B：完成门控 |
|---|---|---|
| **模型** | 单向推进，不允许回头 | 自由跳转，提交时统一检查 |
| **约束点** | 每个阶段转换 | 仅最终提交 |
| **灵活性** | 差 | 好 |
| **适合场景** | 瀑布式开发 | 迭代式开发 |

#### 方案 A：严格流水线（被拒绝）

```mermaid
graph LR
    A["需求分析"] -->|门禁| B["设计"] -->|门禁| C["编码"] -->|门禁| D["测试"] -->|门禁| E["提交"]
```

**拒绝原因**：开发人员指出，实际开发中编码时经常发现需求不清楚，需要回到需求分析阶段；测试失败也需要回去改代码。严格流水线无法支持这种反复迭代。

#### 方案 B：完成门控（采用）

```mermaid
graph TB
    subgraph IterationZone["自由迭代区（可任意跳转反复）"]
        direction LR
        R["需求分析"] <-->|"反复"| D["设计"]
        D <-->|"反复"| C["编码"]
        C <-->|"反复"| T["测试"]
        C <-->|"反复"| RV["审查"]
        T <-->|"反复"| RV
        R -.->|"可回退"| C
        R -.->|"可回退"| T
        D -.->|"可回退"| T
    end

    subgraph Gate["提交门禁（硬约束）"]
        G{"全部阶段<br/>approved?"}
    end

    IterationZone --> G
    G -->|"✓ 全部完成"| COMMIT["提交"]
    G -->|"✗ 有未完成"| BLOCK["阻止提交<br/>列出未完成项"]
```

**采用原因**：真实开发本质上是迭代的。约束点应该是"所有必需产物是否都已完成"，而不是"当前处于哪个阶段"。

**审查阶段的特殊地位（sdlc）**：审查（review）是 sdlc 五阶段中唯一**不可被 AI 自行推进**的阶段。审查不仅检查代码正确性，更检查**人是否真正理解了代码**。审查清单包含四个硬性检查项（详见 3.2），不满足则审查阶段不可 approve。审查阶段与编码、测试阶段形成迭代循环——编码完成后进入审查，审查不通过则回到编码或测试。审查阶段由 `WorkflowDefinition.reviewStage` 声明；sdlc 与 reqdoc 均声明 `review` 审查阶段（reqdoc 语义为业务确认 PRD 要点）。

### 2.2 阶段检测方式选择

#### 候选方案对比

| | AI 自动推断 | 工具使用模式 | 产物文件判断 | AI 提议+开发者确认 |
|---|---|---|---|---|
| **准确度** | 低（语义歧义） | 低（行为歧义） | 低（存在≠确认） | 高（人为决策） |
| **可靠性** | 概率性 | 启发式 | 机械式 | 确定性 |
| **实现复杂度** | 高 | 中 | 低 | 低 |

**被拒绝的方案**：

- **AI 从对话推断**：讨论"用户权限"是在做需求分析还是设计？AI 会猜错
- **从工具使用判断**：写代码时也可能在重新思考需求
- **从产物文件判断**：文档存在不代表需求已被确认

**核心结论**：唯一真正知道"当前在哪个阶段、是否完成"的人，是**开发者本人**。

#### 采用的方案：AI 提议 + 开发者确认

```mermaid
sequenceDiagram
    participant Dev as 开发者
    participant AI as AI Agent
    participant Store as 插件库（WorkflowState）

    Note over Dev,Store: 阶段进行中
    Dev->>AI: 讨论需求细节...
    AI->>AI: 观察对话上下文
    AI->>Dev: 📋 需求摘要如下：<br/>是否确认，进入设计阶段？

    alt 开发者确认
        Dev->>AI: 确认
        AI->>Store: approve(requirements)
        Store-->>AI: status = approved
        AI->>Dev: ✅ 需求已确认，开始设计...
    else 开发者补充
        Dev->>AI: 等等，还有一点没讨论
        AI->>Dev: 好的，请继续补充
    else 开发者回退
        Dev->>AI: 回到需求分析，scope 要补充
        AI->>Store: revisit(requirements)
        Store-->>AI: requirements: in_progress, revision++<br/>design: 级联回退 in_progress（若已 approved）
        AI->>Dev: 好的，已回到需求阶段
    end
```

**规则**：
1. 阶段转换的唯一来源是开发者的明确操作
2. AI 只能提议，绝不自行推进
3. 开发者说"回到XX"时立即回退
4. 提交是唯一的硬门禁

### 2.3 统计分析粒度选择

讨论中确认需要三个层级：

```mermaid
graph TB
    subgraph Session["会话级"]
        S1["单会话详情"]
        S1a["阶段耗时"]
        S1b["迭代次数"]
        S1c["AI 费用/Token"]
    end

    subgraph Project["项目级"]
        P1["按项目+时段聚合"]
        P1a["平均阶段耗时"]
        P1b["需求迭代次数（需求质量）"]
        P1c["编码-测试循环（代码质量）"]
        P1d["费用效率 $/行"]
    end

    subgraph Group["组级"]
        G1["按组聚合"]
        G1a["组成员排行"]
        G1b["组间完成率对比"]
        G1c["组间一次通过率对比"]
        G1d["组级质量趋势"]
    end

    subgraph Org["组织级（org）"]
        T1["按组织聚合"]
        T1a["组间排行"]
        T1b["完成率趋势"]
        T1c["人力结构弹性分析"]
    end

    Session -->|"聚合"| Project
    Project -->|"聚合"| Group
    Group -->|"聚合"| Org
```

**统计层级说明**：

| 层级 | 聚合维度 | 对应 CLI 参数 | 用途 |
|------|----------|---------------|------|
| 会话级 | 单会话 | `opencode-sm stats <id>` | 开发者自检 |
| 项目级 | 按项目+时段 | `opencode-sm stats --project "用户系统"`（或省略，自动检测 CWD） | 项目经理跟踪 |
| 组级 | 按组聚合 | 外部收集服务 `performance_dashboard` 看板（CLI 仅本机统计，组/组织聚合由收集服务据 api_key 哈希解析） | 组长管理、月度汇报 |
| 组织级（org） | 按组织聚合 | 外部收集服务 `performance_dashboard` 看板 | 领导汇报、预算决策 |

组级统计是核心汇报层级——回应"各组 AI 使用程度和依赖程度"的需求。组级视图展示：成员排行、一次通过率分布、返工率对比、高迭代会话数、AI 净增行数（业务/测试/配置）。

**数据来源决策**：零额外采集。工作流状态变更的时间戳即为分析数据源。

**身份关联决策**：身份以 `api_key` 标识，本地明文存储、上送前转 SHA-256 哈希（网络不传明文）；组/部门/组织等归属由后台收集服务（`performance_dashboard`）据 `api_key` 哈希解析，客户端不再填写 account/group/org。另加 **workflowType（工作流类型）** 维度，由开发者 `opencode-sm init` 填写（api_key / 收集服务地址 / 可选工作流类型），存全局 `identity.json`。workflowType 决定本用户新会话走哪套工作流（开发者 `sdlc` 开发 / 需求分析师 `reqdoc` 需求书），不同角色 = 不同用户（见 3.1、3.2）。跨机聚合在收集服务侧完成（见 2.4、3.1）。

### 2.4 部署架构选择：插件 + 独立 CLI（上游零修改）

#### 决策原则

团队后续需要持续同步 OpenCode 上游更新。**核心文件（session.ts、prompt.ts、sql.ts、protocol）是上游改动最频繁的文件**，任何直接修改都会导致每次同步产生合并冲突，核心 schema 迁移（给 SessionTable 加列）的风险尤其高。因此本方案的硬约束是：**所有定制不修改上游代码，收敛到我们自己的三个包里**（插件、`opencode-sm` CLI、org 收集服务）。

#### 关键发现：上游插件体系已覆盖所需能力

OpenCode 插件运行在 daemon 进程内，生命周期与 daemon 一致，通过 `config.plugin` 按 npm 名或本地路径加载。插件 `Hooks` 接口（`packages/plugin/src/index.ts`）提供的能力与接线位置如下（均已核实上游源码，无需任何上游改动即可使用）：

| 所需能力 | 插件 Hook | 上游已接线位置 |
|----------|-----------|----------------|
| 每轮注入 WorkflowState 到 system prompt | `experimental.chat.system.transform`（修改 `output.system: string[]`） | `agent/agent.ts`、`session/llm/request.ts` |
| 注册工作流工具（LLM 在对话中调用） | `tool`（ToolDefinition 字典） | `tool/registry.ts` |
| 硬门禁：阻断未过审查的提交 | `tool.execute.before`（抛错即令工具失败） | `session/tools.ts` |
| 统计工具执行（迭代计数、AI 代码行数） | `tool.execute.after` | `session/tools.ts` |
| 时间戳采集（阶段耗时数据源） | `chat.message` / `event` | `session/prompt.ts`、事件总线 |
| 读取会话数据（cost/tokens） | `PluginInput.client`（SDK） | 插件入参 |

#### 架构总览

**opencode-sm**（OpenCode Session Management CLI）：我们独立开发、单独安装的命令行工具，与上游代码零耦合，只读插件库与调用上游 REST API。每位开发者在自己机器上独立使用 OpenCode，因此部署形态是"每机器一套插件 + 全局身份配置，每组织一个收集服务"：

```mermaid
flowchart LR
    subgraph Upstream["OpenCode 上游（零修改）"]
        Daemon["Daemon + 插件 Hook 体系"]
        UpCLI["上游 CLI<br/>session list/delete、stats"]
    end

    subgraph Local["每位开发者机器（定制，我们拥有）"]
        Plugin["session-mgmt 插件<br/>config.plugin 加载"]
        PluginDB["插件 SQLite<br/>workflow_session"]
        ID["全局 identity.json<br/>api_key（明文本机）/ collector 地址 /<br/>workflowType（可选）"]
        SM["opencode-sm<br/>独立 CLI"]
    end

    subgraph OrgSvc["外部收集服务（performance_dashboard）"]
        Collector["收集服务<br/>内网 HTTP<br/>汇报端点 + 组/组织聚合"]
        AggDB["聚合库"]
    end

    TUI["TUI 对话"] -->|"调用插件工具"| Plugin
    Plugin -->|"system.transform<br/>注入状态与规则"| Daemon
    Plugin -->|"读身份 / 写会话数据"| ID
    Plugin --> PluginDB
    Plugin -->|"定期汇报会话摘要<br/>（不含代码）"| Collector
    Collector --> AggDB
     SM -->|"本地统计：只读"| PluginDB
     SM -->|"会话数据：REST API"| Daemon
     %% CLI 不再直查收集服务；组/组织聚合由收集服务对外提供（外部看板使用）
     CI["CI 流水线"] -->|"按 sessionID 回写<br/>reworkRate/testCoverage"| Collector
```

#### 设计点映射

| 需求 | 零侵入实现方式 |
|------|----------------|
| WorkflowState 每轮注入 system prompt | 插件 `experimental.chat.system.transform`，从插件 DB 读最新状态追加 |
| 会话 tags、status、workflow 扩展属性 | 存插件自有 SQLite，以核心 sessionID 为主键关联，不动 SessionTable |
| api_key 身份 + workflowType | 开发者 `opencode-sm init` 填写（api_key / 收集服务地址 / 可选工作流类型），存全局 `identity.json`，api_key 本机明文、上送前转 SHA-256 哈希；组/部门/组织由收集服务据哈希解析；workflowType 决定新会话走哪套工作流（见 3.1） |
| 阶段推进 / 审查 / 理解确认 | 插件注册工具（`workflow_advance`、`comprehension_confirm`、`review_submit`），Agent 在 TUI 对话中调用，校验逻辑在工具 handler 内——天然服务端强制 |
| 重复编辑模式检测与提交门禁 | `tool.execute.after` 计数每文件代码编辑（统计用）+ 内存短记忆检测连续重复/高频编辑模式；`tool.execute.before` 对未过审查的 `git commit` 抛错阻断；system prompt 注入 stuck 警告 |
| QualityMetrics 采集 | 会话内指标（firstPassRate/iterationCount/linesByFile）由插件记录于本机插件库；合并后指标（reworkRate/testCoverage）由 CI 按 sessionID 回写 org 收集服务 |
| 外部管理（list/stats） | 独立 CLI `opencode-sm`：本地统计读插件库 + 上游 REST API；组/组织统计由外部收集服务 `performance_dashboard` 看板提供，CLI 不再直查 |

#### 风险与取舍

- **experimental hook 稳定性**：`experimental.chat.system.transform` 带 experimental 前缀，上游可能调整签名。缓解：插件是唯一受影响面，上游升级后只需改插件代码并回归测试，成本远低于核心合并冲突。插件内以适配层封装 hook，集中变更点。
- **rename（重命名会话）**：上游无会话标题更新 API（标题自动生成）。本方案不提供 rename；如将来必须支持，它是全部定制中唯一值得引入的小核心补丁，单独评估。
- **身份变更是快照语义**：汇报携带当时的 `apiKey` 哈希。开发者更换 `api_key` 后重跑 `opencode-sm init`，只影响此后的汇报，历史统计归属不追溯变更。
- **收集服务不可用**：插件在本地缓冲未送达的汇报（同一会话仅保留最新一条快照，避免堆积），服务恢复后补推；期间单机会话/项目级统计的工作流/质量数据不受影响（直读本地插件库），但 cost/tokens 经上游 daemon 取得，daemon 不可达时统计示 `N/A`（而非误导的 $0）。
- **插件 DB 孤儿记录**：会话被上游删除后，插件 DB 中对应的扩展数据成为孤儿记录。`opencode-sm` 与插件定期以 `session.list` 比对清理（惰性清理即可，不影响功能）。
- **子代理会话不计入统计**：上游子代理会话带 `parentID`（指向主会话）。插件据 `session.get` 的 `parentID` 识别子代理会话，对其**不建记录、不打标、不汇报、不注入规则**；启动清理时一并移除存量子代理记录（仅保留主会话），避免子代理会话污染本地统计与收集服务聚合。

---

## 3. 数据模型设计

### 3.1 数据模型（插件库 + 全局身份 + 组织聚合库，上游零修改）

**三个存储位置**（每位开发者在自己机器上独立使用 OpenCode，故身份按机器配置、会话数据按项目存放、跨机统计在组织侧汇聚）：

| 存储 | 位置 | 内容 |
|------|------|------|
| 全局身份配置 | `~/.config/opencode/session-mgmt/identity.json` | `opencode-sm init` 写入：`{apiKey, collector_url, workflowType}`（apiKey 明文本机存储、上送前转 SHA-256 哈希；workflowType 可选，缺省 sdlc），每机器一份 |
| 插件库 | `<project>/.opencode/session-mgmt.db`（插件自动建表，迁移自管） | 每会话的工作流数据 `workflow_session` |
| 组织聚合库 | org 收集服务侧（每 org 一个） | 各机器汇报的会话摘要，组/组织结构由此自然形成 |

所有定制数据均**不修改上游 SessionTable / AccountTable**，通过核心 `sessionID` 与上游会话逻辑关联；费用、Token 等核心指标经 SDK（`session.list`/`session.get`）获取——**插件不直接读上游数据库**。

```mermaid
erDiagram
    SessionTable {
        text id PK "上游已有 - 不修改"
        text project_id FK "上游已有"
        text title "上游已有"
        real cost "上游已有（经 SDK 读取）"
        int tokens_input "上游已有（经 SDK 读取）"
        int tokens_output "上游已有（经 SDK 读取）"
    }

    WorkflowSessionTable {
        text session_id PK "插件库 - 关联上游会话"
        text title "会话标题（上游自动生成，插件经 SDK 同步）"
        text tags "JSON string[]"
        text status "状态标签"
        text workflow "JSON WorkflowState"
        text account_id "遗留列（已不再写入，仅兼容）"
    }

    IdentityConfig {
        string apiKey "init 两问 - api_key（明文本机，发送前 SHA-256）"
        string collector_url "init 两问 - 收集服务地址"
        string workflowType "init 可选 - 工作流类型（缺省 sdlc）"
    }

    ReportsTable {
        text session_id PK "聚合库 - 收集服务侧"
        text api_key_hash "汇报身份（api_key 的 SHA-256）"
        text workflow_type "工作流类型（分区管道，6.4）"
        text summary "阶段时间戳+质量指标"
        real cost "经 SDK 取得后随汇报上报"
    }

    SessionTable ||--o| WorkflowSessionTable : "session_id（逻辑关联）"
    IdentityConfig ||--o{ WorkflowSessionTable : "身份来源（已不写 account_id）"
    WorkflowSessionTable ||--o| ReportsTable : "插件定期汇报"
```

```typescript
// opencode-session-mgmt/packages/plugin/src/db/schema.ts — 插件库（bun:sqlite / drizzle），每项目一个
export const WorkflowSessionTable = sqliteTable("workflow_session", {
  session_id: text("session_id").primaryKey(),  // 上游 SessionTable.id
  title: text(),  // 会话标题（上游自动生成，插件经 SDK 同步写库，5.2 离线可读）
  tags: text({ mode: "json" }).$type<string[]>().$default(() => []),
  status: text(),   // "todo"|"analysis"|"design"|"coding"|"testing"|"review"|"done"|"archived"|null
  workflow: text({ mode: "json" }).$type<WorkflowState>(),
  account_id: text(),  // 遗留列，已不再写入（身份改以 apiKey 哈希标识）
})

// ~/.config/opencode/session-mgmt/identity.json — 全局身份，opencode-sm init 写入
// { "apiKey": "<明文本机存储>", "collector_url": "http://10.0.1.20:8787", "workflowType": "sdlc" }
// 注意：apiKey 仅本机明文；插件上送前转 SHA-256(hex) 哈希，网络不传明文。

// 收集服务侧聚合库（外部项目 performance_dashboard）：reports 表按 session_id 主键
// 接收汇报（apiKey 哈希 + 阶段时间戳 + cost/tokens + 质量指标），不含代码内容
```

**组/部门/组织归属由收集服务解析**：客户端不再填写组名/组织名，身份仅以 `apiKey` 哈希标识；"前端组有几个人"由收集服务据 `apiKey` 哈希映射后在聚合库中自然得出，子组/组织层级是收集端内部实现（本规格书不规定）。

**api_key 身份的关联时机**：

| 关联 | 写入方 | 时机 | 方式 |
|------|--------|------|------|
| identity.json（apiKey/collector_url/workflowType） | 开发者本人 | 每台机器一次，人员或角色变动时重跑 | `opencode-sm init` 交互式填写（见 5.1） |
| `workflow_session.account_id` | 插件 | （已废弃）会话首次活动不再打标；身份改以 apiKey 哈希标识 | 本机 `account_id` 列保留但不再写入，统计显示 N/A |
| 聚合库 api_key_hash + 归属 | 插件 + 收集服务 | 定期汇报 + 阶段事件触发 | 汇报携带 `apiKey` 哈希；组/部门/组织由收集服务据哈希解析落库 |

**快照语义**：`apiKey` 哈希随汇报固化在聚合库记录里。开发者更换 `api_key` 后重跑 `opencode-sm init`，只影响此后的汇报，**历史统计归属不追溯变更**。

**workflowType 继承（用户级流程选择）**：工作流类型由**用户角色**决定，而非目录。插件每次创建新会话 `WorkflowState` 时经 `resolveType` 读取 `identity.json.workflowType`（缺省 `sdlc`）写入 `workflow.type`（快照语义，与 apiKey 一致——已存在会话不重读）。不同角色 = 不同用户（开发者走 sdlc 开发流程、需求分析师走 reqdoc 需求书流程），故**无目录配置、无会话内切换工具**；改类型只影响之后的新会话，历史归属不追溯。流程定义与通用机制解耦见 3.2。

**孤儿记录清理**：上游删除会话后，`workflow_session` 中对应记录成为孤儿。插件**启动后延后**（约 2 秒，错开 TUI 首屏与 daemon 启动竞态，减少启动耗时，见部署文档 FAQ）以 `session.list` 比对惰性清理（保守策略：上游不可达或返回空列表时不清理，防瞬时不可达误删），不影响功能。清理白名单**仅含主会话**（`parentID` 为空）：子代理会话（`parentID` 非空）与孤儿一并移除，配合 2.4 的「子代理不建记录」，保证统计纯净。

### 3.2 WorkflowState Schema

**文件**: `opencode-session-mgmt/packages/shared/src/workflow.ts`（契约包，插件/CLI/收集服务共用）

```mermaid
classDiagram
    class WorkflowState {
        +WorkflowType type
        +Record~string, StageRecord~ stages
        +CommitGate commit
        +QualityMetrics quality
        +BaselineEstimate? baseline
        +ReqdocFeature[]? features
        +ReqdocScore? score
    }

    class StageRecord {
        +StageStatus status
        +number revision
        +Transition[] transitions
    }

    class ReviewStageRecord {
        +StageStatus status
        +number revision
        +Transition[] transitions
        +Record~string, boolean~ checklist
        +ComprehensionRecord[] comprehension
    }

    class ComprehensionRecord {
        +string id
        +string? file
        +number[]? lines
        +string explanation
        +ComprehensionDecision decision
        +boolean developerConfirmed
        +number confirmedAt
        +string feedback
        +number rejectedAt
        +number rewrites
        +string resolution
    }

    class StageStatus {
        <<enumeration>>
        not_started
        in_progress
        approved
    }

    class Transition {
        +TransitionAction action
        +number at
        +string? note
    }

    class TransitionAction {
        <<enumeration>>
        enter
        revisit
        approve
    }

    class CommitGate {
        +blocked|allowed status
        +string[] blocked_by
        +CommitForce force
    }

    class CommitForce {
        +string reason
        +number at
        +boolean used
    }

    class QualityMetrics {
        +number firstPassRate
        +number reworkRate
        +number iterationCount
        +number testCoverage
        +Record iterationByFile
        +Record linesByFile
    }

    class BaselineEstimate {
        +number estimatedHours
        +number setAt
    }

    class WorkflowDefinition {
        +WorkflowType type
        +string[] stages
        +Record labels
        +string? reviewStage
        +ChecklistItem[] checklist
        +boolean hasCommitGate
        +string rules
    }

    class WorkflowType {
        <<enumeration>>
        sdlc
        reqdoc
    }

    class ChecklistItem {
        +string key
        +string label
        +boolean auto?
    }

    WorkflowState *-- WorkflowType
    WorkflowState *-- StageRecord : stages (Record)
    WorkflowState *-- CommitGate
    CommitGate *-- "0..1" CommitForce
    WorkflowState *-- QualityMetrics
    WorkflowState *-- "0..1" BaselineEstimate
    ReviewStageRecord *-- ComprehensionRecord
    StageRecord *-- StageStatus
    StageRecord *-- Transition
    ReviewStageRecord *-- Transition
    Transition *-- TransitionAction
    WorkflowDefinition *-- WorkflowType
    WorkflowDefinition *-- ChecklistItem
```

**WorkflowDefinition 注册表（多流程就绪）**：

插件把「工作流的定义」与「通用机制」解耦。定义（阶段键、阶段中文名、审查清单、提交门禁有无、注入的规则项）收敛为 `WorkflowDefinition`，按 `WorkflowType` 注册：

```typescript
export type WorkflowType = "sdlc" | "reqdoc"          // 当前注册 sdlc 与 reqdoc

export interface ChecklistItem { key: string; label: string; auto?: boolean }

export interface RuleItem {
  id: string                               // 稳定标识（如 sdlc-r1），测试/评测/文档交叉引用
  stage: string | "global"                 // 生效阶段键；"global" 所有阶段通用
  text: string                             // 只承载模型可行动作（工具/时机/确认语义）
}

export interface WorkflowDefinition {
  type: WorkflowType
  stages: string[]                        // 阶段键，顺序即推进顺序
  labels: Record<string, string>          // 阶段中文名（渲染/注入用）
  reviewStage: string | null              // 哪个阶段是审查阶段（可无）
  checklist: ChecklistItem[]              // 审查清单项（仅 reviewStage 存在时用）
  hasCommitGate: boolean                  // sdlc=true；reqdoc 定稿无 git 门禁 → false
  rules: RuleItem[]                       // 注入的规则项（见 7.4），阶段化注入：每轮只取 global + 当前阶段
}

export const WORKFLOW_DEFINITIONS: Record<WorkflowType, WorkflowDefinition>
export const SDLC: WorkflowDefinition     // sdlc 定义（五阶段 + 四清单 + 门禁 + 规则）
export const REQDOC: WorkflowDefinition   // reqdoc 定义（见 workflow-reqdoc.md 2 章、4 章）
export function getDefinition(type: WorkflowType): WorkflowDefinition
export function rulesForStage(def: WorkflowDefinition, stage: string | null): RuleItem[]
  // 阶段化注入取规则：stage 为 null 时只给 global；否则给 global + 该阶段（7.4）
export function currentInProgressStage(s: WorkflowState): string | null
  // 当前进行中阶段：按 stages 顺序取第一个 in_progress，无则 null
export function resolveWorkflowType(v: unknown): WorkflowType   // 未知值回退 "sdlc" 并打 warning
```

`WorkflowState` 含 `type` 字段标明本会话属于哪种工作流；`stages` 为泛化的 `Record<string, StageRecord>`，审查阶段经 `reviewRecord()` 定位（`getDefinition(s.type).reviewStage`）。系统不设 `STAGE_ORDER`/`STAGE_LABELS`/`StageName` 常量——消费方一律通过 `getDefinition(workflow.type)` 取阶段键/中文名/清单。`ComprehensionRecord` 是通用机制（sdlc 编码段与 reqdoc PRD 要点共用，reqdoc 语义见 workflow-reqdoc.md 2 章）。`metricKind`、`workflow_set_type` 工具未实现（reqdoc 指标模型/切换场景未定，避免死代码）。

**sdlc 定义**（五阶段 `["requirements","design","implementation","testing","review"]`、审查阶段 `review`、四清单项 businessIntent/logicExplainable/behaviorVerifiable/designRationale、`hasCommitGate=true`）已移至 **workflow-sdlc.md 2 章**，规则全文见 **workflow-sdlc.md 3 章**。

**reqdoc 定义**（阶段键 `["goal","rules","edge","prd","review"]`、审查阶段 `review` 语义为业务确认 PRD 要点、四清单项 completeness/clarity/edgeCoverage/resolution、`hasCommitGate=false`）与**五阶段推进流程 mermaid** 已移至 **workflow-reqdoc.md 2 章**。reqdoc 专属内容索引：需求资料目录契约（双通道）见 **workflow-reqdoc.md 3 章**；24 条规则全文见 **workflow-reqdoc.md 4 章**；PRD 质量打分卡 `ReqdocScore` 见 **workflow-reqdoc.md 5 章**；追问探针清单 `REQDOC_PROBES` 见 **workflow-reqdoc.md 6 章**；渲染结构 schema 见 **workflow-reqdoc.md 7 章**；专属工具（含 `reqdoc_export`）见 **workflow-reqdoc.md 8 章**；场景五见 **workflow-reqdoc.md 9 章**；`reqdoc_export` 导出 Word 交付件亦见本文档 8 章文件清单。

> **ComprehensionRecord 泛化**：`ComprehensionRecord` 是通用机制（sdlc 编码段与 reqdoc PRD 要点共用）——唯一标识字段为 `id`，`file`/`lines` 可选（sdlc 填、reqdoc 不填）。工具参数名一律保留 `codeSegmentId`（sdlc LLM 契约不变），内部映射到 `id`；`comprehension_add` 的 `file`/`lineStart`/`lineEnd` 可选，sdlc 填、reqdoc 省略。

**BaselineEstimate — 基线预估人工工时（6.3）**：

`baseline` 记录项目经理在需求创建时给出的**预估人工工时**（`estimatedHours`，小时、可小数），`setAt` 为录入时间戳。它给出实际周期的参照系：会话结束后，系统按 `（预估工时 − 实际周期）÷ 预估工时` 计算 **AI 提效百分比**。字段可选（无基线的会话提效率为 N/A），可随时重设（幂等覆盖、记最新值，录入规则见 workflow-sdlc.md 3 章 sdlc-r6 / workflow-reqdoc.md 4 章 reqdoc-r7）；录入由开发者在 TUI 对话中转述项目经理的预估（见 4.1 `workflow_baseline`）。

**reqdoc 专属数据（已移至 workflow-reqdoc.md，本文件不重复定义）**：PRD 质量打分卡 `ReqdocScore`（`score` 字段语义、服务端算分、两处硬门禁、≥85 达标）与评分标准 `REQDOC_SCORE_DIMS`（8 维判定规则 + 扣分标准表）见 **workflow-reqdoc.md 5 章**；追问探针清单 `REQDOC_PROBES`（7 条，与打分卡维度一一映射）与柔性一致校验见 **workflow-reqdoc.md 6 章**；渲染结构 schema `REQDOC_TEMPLATE_CHAPTERS`/`REQDOC_TEMPLATE_FIELDS` 与 `parseRenderStructure` 见 **workflow-reqdoc.md 7 章**。

**ReviewChecklist — 可接手标准检查项（sdlc 专属）**：审查清单由 `WorkflowDefinition.checklist` 定义，sdlc 注册四项（businessIntent/logicExplainable/behaviorVerifiable/designRationale），全部通过后审查阶段才可 approve。清单项要求与验证方式见 **workflow-sdlc.md 5 章**。

`workflow.stages[review].checklist` 存储为 `Record<清单项 key, boolean>`。`review_submit` 从 `def.checklist` 生成具名输入参数（非 auto 项 → 布尔，auto 项由插件置真），未知键由 schema 层拒绝。sdlc 清单项见 **workflow-sdlc.md 5 章**；reqdoc 清单项另见 **workflow-reqdoc.md 2 章**（completeness/clarity/edgeCoverage/resolution）。

此外，审查阶段自动记录 **`firstPassRate`（AI 代码一次通过率）**：

> **一次通过率 = 未重写即被接受的片段数 ÷ 全部定论片段数 × 100**

它反映 **AI 一次把代码写对的能力**，而非"开发者接受建议的比例"。每个片段的最终去留只有两种：**一次通过**（`confirm` 直接接受）或**未一次通过**（经历过 `reject` 后由 AI `rewrite` 重写、或由开发者 `manual` 自己处理）。重写或自己处理都计入"未一次通过"，因此公式分母用**片段数**、分子用**未重写即接受**的片段数。

该指标由 `review_submit` 审查通过时**插件自动计算**，不依赖 Agent 上报。它不设硬性预警阈值（重写频率因团队/任务而异），仅作**返工信号**展示：一次通过率过低提示 AI 返工偏多，应回溯 prompt 或该文件的重写轮次（`rewrites`）。纯讨论会话（无片段）不写，保持 `null`（显示 N/A）。

> 一次通过率由 `review_submit` 自动计算，sdlc 与 reqdoc 均适用：sdlc 分母为「代码片段」、reqdoc 分母为「PRD 要点」，口径一致（未重写即 accepted 占比）。行数三分类/rework/coverage 为 sdlc 专属，reqdoc 为 null（见 6.4）。

> 说明：业界 Copilot 的 25–35% 健康接受率针对**行级补全建议**（开发者多数跳过），而本插件是**整段 AI 代码、开发者审查后决定去留**，一次通过率天然偏高，二者口径不同，故不套用该区间。

**ComprehensionRecord — 理解确认记录**：

`ComprehensionRecord` 是理解保障的核心数据。它不是简单的"审查通过"标记，而是**开发者逐段确认理解的凭证**。每次 AI 生成代码变更后，在审查阶段，每个片段经历一个**去留闭环**：

```mermaid
stateDiagram-v2
    direction LR
    [*] --> pending: add
    pending --> accepted: confirm
    pending --> rejected: reject(+feedback)
    rejected --> pending: rewrite (rewrites++)
    rejected --> accepted: confirm(复议)
    rejected --> manual: manual(+resolution)
    accepted --> [*]
    manual --> [*]
    note right of rejected : 开发者补充意见,大部分要求 AI 重写;<br/>小部分由开发者自己处理;<br/>讨论后认可原实现可直接 confirm 复议
```

1. AI 将每个代码变更拆分为可理解的片段（按方法/类/模块），每个片段一个 `ComprehensionRecord`
2. AI 为每个片段输出 `explanation`（自然语言解释：这段代码做了什么、为什么这样写、有哪些替代方案被放弃）
3. 开发者逐段阅读 `explanation` 决定去留：
   - **接受**（`comprehension_confirm`）：确认理解，片段一次通过
   - **拒绝**（`comprehension_reject`）：附补充意见，进入 `rejected`
4. 被拒绝的片段：
   - **大部分**由 AI 按意见**重写**（`comprehension_rewrite`）→ 回到 `pending`，`rewrites++`，重新审查
   - **小部分**由开发者**自己处理**（`comprehension_manual`，如自己写/删除，须声明 `resolution`）→ 终态
   - 讨论后认可原实现的，可直接 `comprehension_confirm` 复议为 `accepted`（不计重写，`rewrites` 不变）
5. 开发者可以对任意片段追问"为什么这样写"，追问和回答追加到 `explanation` 中
6. 审查通过（`review_submit`）要求：**所有片段必须处于 `accepted` 或 `manual` 终态，不允许 `pending`/`rejected` 悬空**；此时 `designRationale` 才可标记为 `true`

```typescript
interface ComprehensionRecord {
  id: string                            // 唯一标识：sdlc 为代码段 id，reqdoc 为 PRD 要点 id
  file?: string                         // sdlc 专属文件路径；reqdoc 不填
  lines?: [number, number]              // sdlc 专属代码行范围；reqdoc 不填
  explanation: string                   // AI 输出的自然语言解释（含设计推导、替代方案、风险）
  developerConfirmed: boolean           // 兼容旧语义：accepted 时为 true
  confirmedAt: number | null            // 接受时间戳
  decision: "pending" | "accepted" | "rejected" | "manual"  // 片段/要点去留定论
  feedback: string | null               // reject 时开发者补充意见
  rejectedAt: number | null             // 拒绝时间戳
  rewrites: number                      // AI 重写轮次（默认 0；返工信号）
  resolution: string | null             // manual 时人工处理声明（自己写/删除）
}
```

**为什么这能解决"三个月后没人看得懂"的问题**：`ComprehensionRecord[]` 本身就是一个可检索的知识库。三个月后接手这段代码的人，不需要从零阅读代码——先读 `explanation`，理解设计意图；再读代码，验证实现是否匹配意图；如果有疑问，`explanation` 中的"替代方案和风险"能帮助判断改动的安全边界。

**无代码变更的会话**：若本会话没有 AI 代码编辑（`iterationCount=0`，如纯讨论/咨询），审查阶段无代码可理解，无需理解确认片段即可通过；一旦有 AI 代码编辑，`review_submit` 强制要求先 `comprehension_add` 登记片段、并让每个片段**处于终态**（`accepted` 或 `manual`），不允许 `pending`/`rejected` 悬空（以 `iterationCount` 作为"是否有代码编辑"的门控信号，兼顾防绕过）。`review_submit` 幂等：审查已通过后重复调用不再报错。

**审查是最后一关**：`review_submit` 还要求**前序阶段全部 `approved`**（sdlc：需求分析/设计/编码/测试；reqdoc：目标与场景/流程与规则/边界与异常/需求规格书），否则拒绝——防弱模型跳过中间阶段直接假通过审查。仅此一处硬性顺序校验：各阶段**进入/回退仍可任意跳转**（`workflow_revisit` 不受影响），前序校验只在审查批准时生效。

**QualityMetrics — 质量维度数据**：

`QualityMetrics` 记录本会话的质量相关数据，用于统计分析中的质量维度：

| 指标 | 定义 | 来源 |
|------|------|------|
| `firstPassRate` | AI 代码一次通过率（未重写即接受的片段 ÷ 全部定论片段） | 插件自动计算（review 通过时） |
| `reworkRate` | 合并后的代码在后续触发修改/Bug 修复的比例 | 外部 CI 管道回写 |
| `iterationCount` | 同一段代码的 AI 生成-修改循环次数 | Agent 会话内追踪 |
| `testCoverage` | AI 参与模块的增量测试覆盖率 | 外部 CI 管道回写 |
| `linesByFile` | AI 净增代码行数按文件分桶（本机明细），汇总时分为业务/测试/配置三类 | 插件自动累计（tool.execute.after） |

**QualityMetrics 的写入机制**：

`QualityMetrics` 字段按写入来源分为两类：

| 字段 | 写入方 | 写入时机 | 写入方式 |
|------|--------|----------|----------|
| `firstPassRate` | 插件 | 审查通过时 | 插件 `review_submit` 按「未重写即接受片段 ÷ 全部定论片段」自动计算写入插件 DB（不依赖 Agent 上报） |
| `iterationCount` | 插件 | 每次代码生成-修改循环，实时更新 | 插件 `tool.execute.after` hook 按文件（write/edit/apply_patch）累计，取各文件最大值写入插件 DB；本机另存 `iterationByFile` 明细 |
| `linesByFile` | 插件 | 每次 AI 代码编辑，实时更新 | 插件 `tool.execute.after` hook 按净增量口径累计（见下「AI 代码行数统计」） |
| `reworkRate` | 外部 CI 管道 | 合并后，当检测到同一会话产出的代码被再次修改 | CI 按 sessionID 回写 org 收集服务（见 4.3） |
| `testCoverage` | 外部 CI 管道 | 合并后，SonarQube/覆盖率工具生成报告时 | CI 按 sessionID 回写 org 收集服务（见 4.3） |

插件负责会话内指标（`firstPassRate`、`iterationCount`、`linesByFile`，写本机插件库并随汇报上行），外部 CI 负责合并后指标（`reworkRate`、`testCoverage`，回写 org 收集服务）。两条通道在聚合库按 sessionID 合并，互不覆盖，统计时统一聚合（见 4.3）。

`reworkRate` 和 `testCoverage` 依赖外部 CI 集成；未接入 CI 时这两个字段默认为 `null`，统计输出中显示为 `N/A`，不影响其他功能。

**重复编辑模式检测**：插件通过内存短记忆（每 session 最近 20 次代码编辑调用）检测 AI 是否陷入无效循环，而非对编辑次数设硬上限。两个检测信号：

| 信号 | 检测条件 | 含义 |
|------|----------|------|
| 连续相同操作（streak） | 同一文件连续 3 次以上使用相同参数的 AI 编辑 | AI 在重试同一个失败操作 |
| 高频编辑（frequency） | 同一文件在近期 20 次调用中出现 6 次以上 | 振荡循环（A→B→A→B）或渐进退化 |

检测到 stuck 文件时，system prompt 注入警告（"建议审查是否陷入无效循环"），但**不拒绝生成**。`iterationByFile` 和 `iterationCount` 仍按文件累计编辑次数（统计用，写入 WorkflowState），但不再触发硬限制。短记忆不持久化（内存级），daemon 重启自动清零。

参数指纹通过 hash（全参数）提取，区分"重试同一操作"vs"不同目的的编辑"——例如对同一文件做 3 次不同目的的 edit 不会触发 stuck，但用相同 oldString/newString 重试 3 次会触发。

`iterationByFile` 仅存本机插件库用于统计，汇报投影已剥离（不外传文件路径，见第 11 章）。

**AI 代码行数统计（业务 / 单元测试 / 配置 三分类）**：

`linesByFile` 按**净增量口径**记录每个文件在本会话内被 AI 净增的代码行数（`Record<文件路径, 行数>`，可为负），与 `iterationByFile` 共用同一观测点——`tool.execute.after` hook 中 write / edit / apply_patch 三个代码编辑工具的入参（插件不读磁盘文件、不依赖上游内部模块，只从入参推算）：

| 工具 | 行数算法 | 说明 |
|------|----------|------|
| write | `linesByFile[路径] = 行数(content)` | 整文件覆盖写：直接替换该文件的计数（AI 重写不重复累加） |
| edit | `delta = 行数(newString) − 行数(oldString)`，累加 | `oldString=""` 为新建文件语义（上游约束仅新文件可用），此时按 `行数(newString)` 整体计入；`replaceAll=true` 出现次数未知，按单次计（已知轻微低估边界） |
| apply_patch | 解析 `patchText` 段落，逐文件 `+行数 − −行数` 累加 | `*** Add File:` 段数 `+` 行；`*** Update File:` 的 `@@` hunk 内 `+` 行加、`-` 行减；`*** Delete File:` 段数 `-` 行；`*** Move to:`（改名）不计行数。解析器为插件内约 30 行的轻量扫描器（铁律：不 import 上游解析模块） |

同一文件多次编辑在同一会话内**去重累计**（如 write 100 行后 edit 净增 20 行，最终计 120 行）。行数取物理行（末尾换行不多计一行）。

**三分类规则**（`classifyFile`，优先级 测试 → 配置 → 业务）：

| 分类 | 判定 |
|------|------|
| 单元测试 | basename 匹配 `*.test.*` / `*.spec.*` / `*_test.*` / `*_spec.*` / `test_*.*`，或路径段为 `test` / `tests` / `__tests__`（大小写不敏感） |
| 配置文件 | 扩展名 ∈ `.json/.jsonc/.yaml/.yml/.toml/.ini/.conf/.cfg/.properties/.env`，或 basename ∈ `.npmrc/.editorconfig/.gitignore/.prettierrc/.eslintrc/.prettierignore/.eslintignore/Dockerfile/Makefile` |
| 业务代码 | 其余全部 |

**汇总口径**：`sumLinesByCategory` 将 `linesByFile` 分类累加为 `{business, test, config}` 三个数字；**逐文件 clamp ≥ 0**——AI 净删除代码的文件不产生负贡献，避免「删代码」让会话行数出现反直觉的负值。项目/组/组织级对会话行数**求和**（累加型指标，不做平均）。

**隐私**：`linesByFile` 的文件路径仅存本机插件库；汇报投影（`summarizeWorkflow`）剥离路径，只上行三类聚合数字（与 `iterationByFile` 的处理一致，见第 11 章）。行数指标**仅展示、不设告警阈值**。


### 3.3 状态转换规则

```mermaid
stateDiagram-v2
    [*] --> not_started

    not_started --> in_progress : enter
    in_progress --> approved : approve
    approved --> in_progress : revisit<br/>(revision++)

    note right of not_started : 初始状态
    note right of in_progress : 阶段进行中<br/>可反复进出
    note right of approved : 阶段已完成<br/>可 revisit 回退
```

**revisit 级联回退**：`workflow_revisit(阶段S)` 除把 S 回退到 `in_progress`（revision++）外，还会把 **S 之后所有已 `approved` 的下游阶段**一并级联回退到 `in_progress`（同样 revision++、追加 revisit transition）。原因：下游阶段（设计/编码/测试/审查）的结论建立在 S 之上，S 返工后其 approved 状态不再成立，须重新走一遍（含审查的 review_submit 硬校验）。`currentInProgressStage` 按 `def.stages` 顺序取第一个 `in_progress`，级联后规则注入仍以最靠前的回退阶段为准。

每次转换自动追加到 `transitions[]`：

```json
{
  "action": "enter",
  "at": 1722412800000,
  "note": "开始需求分析"
}
```

这些时间戳就是统计分析的数据来源。sdlc 与 reqdoc 的各阶段适用同一套转换规则与时间戳口径。

**会话周期（durationMs）口径**：已完成会话（全部阶段 approved）取「全部转换时间戳的最早到最晚」跨度；进行中会话取「自工作流启动（最早转换）至今」，保证展示不为 0m。**AI 提效率仅对已完成会话计算**——进行中会话的周期是实时值，与整任务预估无参照意义，避免误报高提效。

### 3.4 提交门禁逻辑

提交门禁由 `WorkflowDefinition.hasCommitGate` 驱动：仅 `hasCommitGate=true` 的工作流（sdlc）启用，reqdoc 定稿无 git 提交门禁、`commit_gate_*` 工具不启用。下图以 sdlc 五阶段为例：

```mermaid
flowchart TD
    DEV["开发者请求提交"] --> CHECK{"检查 workflow"}
    CHECK --> REQ{"requirements<br/>approved?"}
    CHECK --> DES{"design<br/>approved?"}
    CHECK --> IMP{"implementation<br/>approved?"}
    CHECK --> TST{"testing<br/>approved?"}
    CHECK --> RV{"review<br/>approved?"}

    REQ -->|✓| ALL
    REQ -->|✗| BLOCK
    DES -->|✓| ALL
    DES -->|✗| BLOCK
    IMP -->|✓| ALL
    IMP -->|✗| BLOCK
    TST -->|✓| ALL
    TST -->|✗| BLOCK
    RV -->|✓| ALL
    RV -->|✗| BLOCK

    ALL{"全部通过?"}
    ALL -->|是| ALLOW["✓ 允许提交"]
    ALL -->|否| BLOCK["✗ 阻止提交"]
    BLOCK --> LIST["列出未完成的阶段"]
    LIST --> ASK{"强制提交?"}
    ASK -->|是| FORCE["⚠ 强制提交<br/>（需填写原因）"]
    ASK -->|否| WAIT["继续工作"]
```

**执行点**：门禁落在插件侧——Agent 调用 `commit_gate_check` 工具获取检查结果；即使 LLM 不遵守规则，`tool.execute.before` hook 也会拦截未过审查的 `git commit`（见 7.3），硬约束不依赖 LLM 自觉。

**强制提交（逃生口）**：对应上图「强制提交（需填写原因）」分支，经 `commit_force_unlock` 工具授权：必须 `developer_confirmed=true` 且填写原因，写入 `commit.force = {reason, at, used:false}`。门禁遇到未使用的授权放行**一次** `git commit`，随即置 `used=true`（不删除，留痕于 WorkflowState 并随汇报上行，使"绕过审查"在组/组织统计中可见）。授权为一次性，此后恢复阻断；再次强制需重新授权。

---

## 4. 接口设计（插件工具 + 复用上游 API + org 收集服务端点，上游零修改）

### 4.1 插件工具（Agent 在 TUI 对话中调用）

工作流的所有状态变更不经过 REST API，而是通过插件注册的**工具（tool）**完成。Agent 在对话中调用这些工具，校验逻辑写在工具的 handler 内——运行在 daemon 进程里，天然具备服务端强制性。

| 工具 | 用途 | 服务端校验 |
|------|------|-----------|
| `workflow_advance` | 提议进入下一阶段 / 标记当前阶段 approved | 必须携带开发者确认语义；`stage` 运行时校验须在 `getDefinition(workflow.type).stages` 内（AI 不可在无确认时调用成功） |
| `workflow_revisit` | 回退到指定阶段（revision++） | 目标阶段必须存在于 `def.stages`；**级联回退**该阶段之后所有已 `approved` 的下游阶段（同样 revision++，见 3.3） |
| `workflow_baseline` | 录入/重设基线预估人工工时（项目经理给出，如 8h，6.3） | `developer_confirmed` 必须为 true（防 AI 杜撰）；`estimated_hours > 0`；幂等覆盖记最新值 |
| `comprehension_add` | 登记一个片段/要点及自然语言解释（sdlc 为代码片段，reqdoc 为 PRD 要点） | 不可重复登记；sdlc 填 `file/lineStart/lineEnd`，reqdoc 省略；登记后 `decision=pending`，待逐段定夺 |
| `comprehension_confirm` | 接受单个片段/要点（一次通过） | **单次调用只接受一个 `codeSegmentId`**，防止批量确认（见 7.3）；须处于 pending/rejected 才可接受 |
| `comprehension_ask` | 对片段/要点追问，问答追加到 explanation | 片段/要点必须存在 |
| `comprehension_reject` | 拒绝单个片段/要点并附补充意见 | 必须存在；`feedback` 必填（意见将用于 AI 重写） |
| `comprehension_rewrite` | AI 按意见重写后回到待审查 | 须处于 `rejected`；`rewrites++`，feedback 并入 explanation |
| `comprehension_manual` | 开发者自己处理该片段/要点（自己写/删除） | 须处于 `rejected`；`resolution` 必填；进入终态 `manual` |
| `review_submit` | 提交审查清单结果（从 `def.checklist` 生成具名参数） | 由 `def.checklist` 生成具名输入参数（非 auto 项布尔，auto 项插件置真）；**前序阶段须全部 `approved`（审查是最后一关）**；有片段/要点时须已 `comprehension_add` 登记、且**全部处于终态 accepted/manual，不允许 pending/rejected 悬空**；通过时自动计算 `firstPassRate`（sdlc 与 reqdoc 均适用） |
| `commit_gate_check` | 提交前门禁检查（`def.hasCommitGate=true` 时启用） | 返回未完成阶段列表；未通过时 `tool.execute.before` 阻断 `git commit` |
| `commit_force_unlock` | 强制提交授权（`def.hasCommitGate=true` 时，3.4 逃生口） | `developer_confirmed` 必须为 true、原因必填；写入一次性授权，门禁放行一次后置 `used` 留痕 |
| `reqdoc_scan` / `reqdoc_confirm_features` / `reqdoc_score` / `reqdoc_check` / `reqdoc_export` | reqdoc 专属工具（需求资料扫描 / 功能点拆解确认 / 八维打分卡 / 渲染结构校验 / Word 导出），仅 `def.type === "reqdoc"` 时生效 | 各工具的用途与服务端校验见 **workflow-reqdoc.md 8 章** 完整表格 |

工具定义遵循上游插件 `ToolDefinition` 接口（`packages/plugin/src/tool.ts`），由 `tool` hook 注册后自动进入 LLM 可用工具集（上游 `tool/registry.ts` 已接线）。

以上工具的行为由当前会话的 `workflow.type` 对应定义驱动：阶段键/中文名/清单项/是否有提交门禁均取自 `getDefinition(workflow.type)`。sdlc 的 `hasCommitGate=true`，行为与改动前一致；reqdoc 的 `hasCommitGate=false`，`commit_gate_*` 工具按 `def.hasCommitGate` 分支直接放行/不注册。

### 4.2 复用的上游 API（不修改）

`opencode-sm` 与插件通过上游 SDK 调用以下已有端点，不新增、不修改任何上游端点：

```
GET  /api/session                     session.list
POST /api/session                     session.create
GET  /api/session/:id                 session.get      （含 cost / tokens）
GET  /api/session/active              session.active
POST /api/session/:id/prompt          session.prompt   （resume 一次性模式）
POST /api/session/:id/compact         session.compact
POST /api/session/:id/interrupt       session.interrupt
GET  /api/session/:id/context         session.context
GET  /api/session/:id/history         session.history
```

### 4.3 质量指标写入与统计查询

**增量合并语义**：插件工具对本机 `workflow_session.workflow` 的写入采用深度合并（等价于 PATCH DeepPartial），只更新传入的字段，Agent 维护的字段互不覆盖。

**两条质量指标写入通道**：

| 指标 | 通道 |
|------|------|
| firstPassRate / iterationCount / linesByFile | 插件工具写入本机插件库 `workflow.quality`，随会话摘要汇报到收集服务（行数仅上行三分类聚合，文件路径不上行） |
| reworkRate / testCoverage | CI 管道按 sessionID **回写 org 收集服务**（`POST {collector_url}/api/ci-quality`），收集服务在聚合库按 session 合并 |

```json
// CI → 收集服务：只回写 reworkRate，与 Agent 汇报的指标在聚合库合并
{ "sessionID": "sess_abc123", "quality": { "reworkRate": 0.08 } }
```

**统计查询（不新增任何核心 API）**：

| 统计范围 | 数据来源 |
|----------|----------|
| 会话级 / 项目级 | `opencode-sm` 本机组合：插件库（工作流/会话内质量）+ 上游 `session.list`/`session.get`（cost/tokens/project），按 sessionID 关联 |
| 组级 / 组织级 | 由外部收集服务 `performance_dashboard` 据 api_key 哈希聚合并提供看板（`GET {collector_url}/api/stats?scope=group&group=前端组`），CLI 仅做本机会话/项目级聚合，不再直查组/组织级 |

`--project` 参数不传时，自动从当前工作目录（CWD）聚合本项目数据。**因本地插件库按项目目录存放（`<project>/.opencode/session-mgmt.db`），`--project` 接受项目目录路径**以查看他处项目（如 `opencode-sm stats --project ~/work/user-service`），明确的目录以**只读**方式打开（库不存在则提示、不创建，避免在任意目录留下 `.opencode/`）；传入名称而非已存在目录时，无法据此定位库，退化为按 CWD 聚合并仅用作展示标签。组/组织级聚合由外部收集服务看板提供，CLI 不接收 `--group`/`--org`（已移除）。

---

## 5. CLI 命令设计

### 5.1 命令清单

命令分两部分：**上游已有命令直接复用**（不新增），**`opencode-sm` 独立 CLI**（我们自己的包，承载定制数据的查看）。

**复用上游 OpenCode 命令（零开发）**：

```
opencode session list                     # 会话列表（上游已有）
opencode session delete <sessionID>       # 删除会话（上游已有）
opencode -c                               # 回到当前目录最近一次会话（--continue，上游已有）
opencode -s <sessionID>                   # 恢复指定会话（--session，上游已有）
opencode stats [--days <n>]               # token/费用统计（上游已有）
opencode                                  # 进入 TUI，交互式恢复任意会话（上游已有）
```

> **恢复中断会话**：`-c`/`--continue` 按**当前工作目录**匹配该目录下最近一次会话，因此须回到当初的项目目录执行；若中断后在该目录又开过新会话，`-c` 接的是最新那个而非中断的那个，此时用 `opencode session list` 查出 ID 再 `opencode -s <sessionID>` 精确恢复。`-s`/`--session` 只认 session ID，不接受会话名。
>
> `opencode session list` 默认以表格输出三列——**Session ID / Title / Updated**：Title 为上游自动生成的会话标题、Updated 为更新时间，凭标题与时间即可辨认目标会话，再取其 ID 传给 `-s`；`--format json` 另含 created、projectId 等字段，`--max-count <n>` 限制条数。

**`opencode-sm` 独立命令（定制，读插件库 + 调上游 API；组/组织聚合由收集服务对外提供）**：

```
opencode-sm init          # 每台机器一次：交互式两问（api_key / 收集服务地址）+ 可选工作流类型，写入全局 identity.json
opencode-sm list         [--status <s>] [--tag <t>] [--json]     # 在上游 session.list 结果上叠加插件库的 status/tag 过滤
opencode-sm stats        [<sessionID>] [--project <dir>] [--workflow <type>] [--period <nd>] [--json]   # 本机会话/项目级聚合（含 cost/tokens）
```

> `workflow` / `tag` / `workflow-type` 子命令已退役：工作流推进在 TUI 对话中完成（`workflow_advance` 等工具），状态查看由 `opencode-sm stats <sessionID>` 承担；组/组织级聚合由外部收集服务 `performance_dashboard` 提供，CLI 不再直查。

**init 交互示例**（两问 + 可选工作流类型，全部手动填写）：

```
$ opencode-sm init
? api_key（明文仅存本机 identity.json；发送前转为 SHA-256 哈希，网络不传明文）: <输入>
? 收集服务地址: http://10.0.1.20:8787
? 主要工作流类型（sdlc 开发 / reqdoc 需求书）[缺省 sdlc]: sdlc
✓ 已写入 ~/.config/opencode/session-mgmt/identity.json，本机即时生效
```

`api_key` 仅本机明文存储，插件上送前转 SHA-256(hex) 哈希；收集服务地址由 org 管理员告知（即 `performance_dashboard` 的内网地址）。**角色变化（换工作流类型）**时重跑 `init` 即可——只影响此后的统计归属（快照语义，见 3.1）。

**说明**：

| 事项 | 处理方式 |
|------|----------|
| resume（继续开发） | 主路径是 TUI 内切换会话（上游已有，`<leader>1-9` 快速切换）；一次性发消息用上游 `session.prompt` API 或 `opencode run` |
| create / get / active / compact / interrupt | 上游 REST API 已完备，TUI 与 `opencode-sm` 直接调用，不包装重复命令 |
| rename | 不提供。上游无标题更新 API，标题自动生成（见 2.4 取舍） |
| review | 并入 `opencode-sm stats <id>`（本机会话级质量指标） |

**workflow 命令说明**：

工作流的推进（进入阶段、确认、回退）通过 **TUI 内自然语言对话**完成（Agent 调用插件工具，见 4.1），不走 CLI。开发者只需在对话中说"需求确认了"、"回到设计阶段"等；外部查看状态用 `opencode-sm stats <sessionID>`。

| 子命令 | 行为 |
|--------|------|
| *(默认)* | 查看当前工作流状态（阶段进度、当前阶段，按 `def.labels` 渲染） |
| `checklist` | 查看审查清单项状态（按 `def.checklist` 逐项） |
| `comprehension` | 列出理解确认记录，支持 `--unconfirmed` 过滤未确认片段（sdlc） |
| `stats` | 查看当前会话质量指标（sdlc：一次通过率、迭代轮次、AI 代码行数业务/测试/配置、覆盖率；reqdoc：通用字段，专属字段为 N/A） |

### 5.2 opencode-sm 实现模式

`opencode-sm` 是独立安装的二进制（我们自己的包），按统计范围选择不同的数据源：

```mermaid
sequenceDiagram
    participant CLI as opencode-sm
    participant PDB as 本机插件库<br/>session-mgmt.db
    participant Daemon as Daemon REST API<br/>（上游，不修改）

    CLI->>PDB: 读 workflow/tags/会话内质量（只读）
    PDB-->>CLI: 定制数据
    CLI->>Daemon: SDK 调 session.list/get（cost/tokens）
    Daemon-->>CLI: 核心数据
    CLI->>CLI: 按 sessionID 关联聚合、格式化
    CLI-->>User: 表格/文本/JSON
    Note over CLI: 组/组织级聚合由外部收集服务<br/>performance_dashboard 看板提供（CLI 不直查）
```

> 会话/项目级明细的**标题**也已由插件在会话活动时经 SDK 同步进插件库（启动后一次性回填 + 每条消息按需补），因此 CLI **离线（daemon 不可达）也能显示标题**；费用/Token 仍须 daemon 实时取。`list` 在上游不可达时同样用插件库标题兜底。
>
> **占位标题处理**：opencode 新建会话时先以 `New session - <ISO>` / `Child session - <ISO>` 占位，积累消息后才生成真实标题。插件同步时把占位符视为「未同步」——回填与按需补都会刷新占位符、只保留真实标题，否则插件库会一直停留在过期占位符，导致 `stats`（读插件库）与 `list`（读 daemon 实时标题）标题对不上。占位判断与上游一致（`packages/app/src/utils/session-title.ts`）。

---

## 6. 统计分析设计

统计分析的定位是**投入产出评估与资源规划的数据基础**，服务于三个明确目标：

1. **算力预算规划** — Token 消耗按场景/模型/组拆分，为下一次预算申请提供数据支撑
2. **质量监控** — 跟踪一次通过率、返工率、覆盖率，确保提效不以牺牲质量为代价
3. **流程优化** — 阶段耗时与迭代次数分析，识别瓶颈环节

### 6.1 数据来源（零额外采集）

```mermaid
graph LR
    subgraph Source["数据来源（上游已有 + 插件库 + 聚合库）"]
        WF["workflow.transitions[]<br/>时间戳（插件库）"]
        REV["workflow.stages.*.revision<br/>迭代次数（插件库）"]
        COST["cost<br/>费用（上游已有）"]
        TOK["tokens_*<br/>Token（上游已有）"]
        DIFF["代码量<br/>（上游已有）"]
        ACCT["api_key 哈希<br/>（身份标识，组/组织由收集服务解析）"]
        QM["workflow.quality<br/>质量指标（插件库）"]
        RV["workflow.stages.review<br/>审查数据（插件库）"]
        BL["workflow.baseline<br/>基线预估工时（插件库）"]
    end

    subgraph Metrics["统计指标"]
        M1["阶段耗时"]
        M2["迭代/回退次数"]
        M3["费用分布"]
        M4["完成率"]
        M5["效率指标"]
        M6["质量指标"]
    end

    WF --> M1
    WF --> M2
    REV --> M2
    COST --> M3
    TOK --> M3
    DIFF --> M5
    BL --> M5
    ACCT --> M4
    QM --> M6
    RV --> M6
```

### 6.2 三级统计输出示例

**会话级**：

```
📋 会话 "用户认证模块" (sess_abc123)
开发者: N/A（身份以 api_key 哈希标识，组/组织由收集服务解析）
周期: 3.25 天

工作流:
  需求分析  ████████░░  2.1h   ✓ approved (修改2次)
  设计     ██████░░░░  1.5h   ✓ approved (修改1次)
  编码     ████████████████  4.2h  ✓ approved (编码-测试循环3次)
  测试     ██████████░░  2.8h  ✓ approved
  审查     ██████░░░░  1.2h  ✓ approved (一次通过率 92%, 理解确认 5/5)

质量:
  一次通过率: 92%  |  迭代轮次: 2 轮（单文件被 AI 编辑的最高次数）  |  测试覆盖率: 82%
  AI 净增行数: 业务 620 / 测试 310 / 配置 45（合计 975）
  基线对比: 预估 120h / 实际 3.3d → AI 提效 35%
  返工标记: 无  |  审查清单: ✓全部通过(4/4)  |  理解确认: 5片段 ✓已确认

AI 使用: 对话 47轮 | $0.36 | 85K tokens
```

> 注：会话级输出首行 `开发者` 恒为 `N/A`。插件库 schema 仍保留旧 `account_id` 列，但身份已改为以 `api_key` 的 SHA-256 哈希标识，该列不再写入；开发者归属由收集服务据哈希解析，故本机 `opencode-sm stats` 不展示具体开发者，仅外部收集服务看板可见（见 3.1、collector-spec.md 2.3）。

**reqdoc 会话级（需求书）**：见 workflow-reqdoc.md 9 章（reqdoc 会话不产出代码，sdlc 专属指标——AI 代码行数三分类 / 覆盖率 / 返工率——为 `null`，显示 N/A）。

**项目级**：

```
📊 项目 "用户系统" - 最近 7 天
会话: 12 | 完成率: 75% | 平均周期: 2.3 天
阶段耗时: 分析 2.1h | 设计 1.5h | 编码 4.2h | 测试 2.8h | 审查 1.2h
迭代: 需求修改 avg 1.3次 | 编码-测试循环 avg 2.7次
费用: $4.32 总计 | $0.36/会话 | $0.02/行

质量:
  平均一次通过率: 91%  |  一次通过率过低会话: 1/12 ⚠
  AI 净增行数: 业务 5.8K / 测试 2.9K / 配置 0.4K（合计 9.1K）
  平均 AI 提效: 58%（基线会话 8/12）
  返工率: 8%  |  变更失败率: 2%  |  平均测试覆盖率: 78%
  高迭代会话(≥5轮): 0
```

**组级**（以下由外部收集服务 `performance_dashboard` 看板提供，CLI 不直查）：

```
👥 组 "前端组" - 最近 30 天
成员: 5 | 总会话: 42 | 完成率: 85%

  alice  12会话 92%完成 $6.30  2.1天/会话 一次通过率92% 覆盖率84%
  bob     8会话 78%完成 $3.80  2.8天/会话 一次通过率72% ⚠ 覆盖率71%
  carol  10会话 89%完成 $5.20  2.3天/会话 一次通过率89% 覆盖率79%

质量:
  组平均一次通过率: 91%  |  一次通过率过低成员: 1/5 ⚠
  AI 净增行数: 业务 18.2K / 测试 9.5K / 配置 1.2K（合计 28.9K）
  组平均 AI 提效: 62%（基线会话 31/42）
  组返工率: 6%  |  变更失败率: 2%  |  高迭代会话: 1/42 (2.4%)

趋势: 需求迭代 ↓1.5→0.9 | 单行成本 ↓$0.04→$0.02 | 返工率 ↓10%→6% | 提效 ↑55%→68%
```

**组织级**（以下由外部收集服务 `performance_dashboard` 看板提供）：

```
👥 组织 "Engineering" - 最近 30 天
成员: 8 | 总会话: 156 | 完成率: 82%

  alice  24会话 92%完成 $12.30 2.1天/会话 一次通过率92% 覆盖率84%
  bob    18会话 78%完成 $9.80  2.8天/会话 一次通过率72% ⚠ 覆盖率71%
  carol  22会话 85%完成 $11.20 2.3天/会话 一次通过率89% 覆盖率79%

质量:
  组织平均一次通过率: 91%  |  一次通过率过低成员: 1/8 ⚠
  AI 净增行数: 业务 62K / 测试 31K / 配置 4K（合计 97K）
  组织平均 AI 提效: 64%（基线会话 120/156）
  组织返工率: 7%  |  变更失败率: 3%
  高迭代会话: 2/156 (1.3%)

趋势: 需求迭代 ↓1.3→0.8 | 单行成本 ↓$0.03→$0.02 | 返工率 ↓12%→7% | 提效 ↑58%→70%
```

### 6.3 质量维度指标定义

质量维度数据用于验证"提效"不是建立在牺牲质量的基础上，同时支撑退出风险管控中的质量衰减监控（措施三）。

| 指标 | 定义 | 计算公式 | 数据来源 | 告警阈值 |
|------|------|----------|----------|----------|
| 一次通过率 | 代码片段免重写即被接受的返工信号（会话内统计） | 未重写即被接受的片段数 / 全部定论片段数 × 100% | 插件自动统计（review 闭环） | 无硬阈值；作为返工信号展示，过低提示流程质量 |
| AI 代码行数 | AI 净增代码量，按业务/测试/配置三分类（会话内统计） | write 整文件、edit 新行−旧行、apply_patch +行−−行，逐文件去重累计后分类汇总（逐文件 clamp ≥0） | 插件自动统计（tool.execute.after） | 无阈值；纯展示型指标（产出量参考，不与质量/绩效挂钩） |
| AI 提效率 | 相对预估人工工时的提效百分比（会话级，6.3） | （预估人工工时 − 实际周期）÷ 预估人工工时 × 100%（实际周期由阶段时间戳推算，6.1） | 插件 `workflow_baseline` 录入 + 阶段时间戳自动计算 | 无阈值；仅展示（可为负，实际超预估即为负值） |
| 返工率 | 合并后触发修改/Bug 修复的比例 | 返工提交数 / 总会话提交数 × 100% | Git + CI 管道 | 连续 2 个月上升触发审查 |
| 变更失败率 | 因 AI 生成代码引发的测试缺陷或生产故障 | 失败变更数 / 总变更数 × 100% | CI/CD + 缺陷跟踪 | 月度环比上升 >5% 触发告警 |
| 测试覆盖率 | AI 参与模块的增量测试覆盖率 | 覆盖行数 / 总行数 × 100% | SonarQube / CI | <70% 触发告警，<80% 不可 approve review |
| 迭代轮次 | 单文件被 AI 编辑的最高次数 | workflow.quality.iterationCount | Agent 追踪 | 统计展示用；重复模式检测由内存短记忆独立处理 |
| 审查清单通过率 | review.checklist 四项全部通过的会话比例 | 全部通过的会话数 / 总会话数 × 100% | workflow.stages.review.checklist | <90% 触发流程审查 |

> sdlc 专属指标：`AI 代码行数`（三分类）、`返工率`、`测试覆盖率` 在 reqdoc 会话中为 `null`（显示 N/A）。`一次通过率` 为通用字段——sdlc 语义为「代码片段一次通过率」、reqdoc 语义为「PRD 要点一次确认通过率」（口径见 3.2）；`迭代轮次`、`AI 提效率` 亦为通用字段。

这些指标在三个统计层级中的呈现方式不同：
- **会话级**：展示具体数值，一次通过率过低时提示（如一次通过率 72% ↓）
- **项目级**：展示平均值和分布，标记过低会话数
- **组织级**：展示成员排行，标记过低成员，展示趋势
- **AI 代码行数**为累加型指标：会话级展示三分类数值，项目/组/组织级展示各会话行数**求和**（不做平均），全层级仅展示、不告警
- **AI 提效率**为比率型指标（同一次通过率/返工率）：项目/组/组织级对「有基线且有有效周期」的会话**求平均**；无基线会话不参与，全无基线时显示 N/A（并以基线会话数 0/N 示覆盖率）；组/组织级另按汇报时间分**早/近半段**展示均值走向（如 提效 ↑55%→68%），即研发提效曲线在纯文本 CLI 下的呈现

### 6.4 多流程统计分区（type 感知）

不同工作流（sdlc / reqdoc）的指标不同，但**报告形状保持单一**，不建 union/meta-schema：

- **报告**：`QualitySummary` 单一形状——sdlc 填足（含行数三分类、rework、coverage），reqdoc 填通用字段（firstPassRate/iterationCount/baseline），code 专属字段（行数三分类、rework、coverage）为 `null` → 收集/展示侧自动作为 N/A。
- **聚合**：collector 的 `reports` 表落 `workflow_type` 列（+ 索引，见 3.1），写入侧从 `report.workflow.type` 取；查询侧 `GET /api/stats` 与 CLI `opencode-sm stats --workflow <type>` 按类型过滤——**两条流程的指标绝不混算**。
- **本机统计**：会话级/项目级（`stats.ts`）同样按 `workflow.type` 分区——sdlc 专属指标（行数三分类、一次通过率、返工、覆盖率）仅 sdlc 会话计算；reqdoc 会话这些字段为 null。
- **不预建** union/meta-schema（reqdoc 专属指标未定，定义即臆测）；扩展时新增可选字段（如 `docStats`）即可，分区管道已就位。

---

## 7. Agent 工作流约束

### 7.1 实现机制

工作流约束不修改 OpenCode 核心引擎，而是通过**插件 + 会话级系统提示（system prompt）**实现：插件通过上游已有的 `experimental.chat.system.transform` hook（上游在组装 system prompt 时触发，见 2.4），每轮将工作流规则与当前状态注入 system prompt；状态变更通过插件注册的工具完成，写入插件库。

```mermaid
flowchart TD
    subgraph Turn["每轮对话"]
        SP["上游 System Prompt 组装"]
        SP -->|"触发 system.transform hook"| RULES["插件注入：<br/>通用+当前阶段规则<br/>+ 阶段状态条"]
    end

    subgraph Agent["Agent 循环"]
        LLM["LLM（遵循规则）"]
        ACTION["Agent 执行动作"]
        WRITE["调用插件工具<br/>workflow_advance /<br/>comprehension_confirm ..."]
    end

    subgraph Storage["持久化"]
        DB["插件 SQLite<br/>workflow_session.workflow"]
    end

    RULES --> LLM
    LLM --> ACTION
    ACTION --> WRITE
    WRITE --> DB
    DB -->|"每轮刷新"| RULES
```

关键点：
- **规则注入**：上游每一步 Agent 循环都会重新组装 system prompt 并触发 `experimental.chat.system.transform`，插件在此 hook 中从插件库读取当前会话的 `WorkflowState`，将**阶段化规则（global + 当前 in_progress 阶段）**与**阶段状态条**追加到 `output.system`——弱模型只读当前需要的规则与压缩状态，降低遵循负担（7.4、7.3）。插件注入逻辑在 `packages/plugin/src/prompt.ts`，上游引擎 `prompt.ts` 零修改。`stage===null`（无 in_progress）**分三态**：**全未启动**（起步提示）/**空档态**（部分阶段 approved、无进行中：提示「继续→进入下一未启动阶段 / 回退→revisit」，不再误判为「尚未开始」）/**完成态**（全部 approved：走**专用完成块**，给全三条可行动作「提交（如尚未，commit_gate_check）→ 开新需求（/new，保持统计隔离）→ 改本需求（workflow_revisit）」，不注入常规全局规则）。同时 `workflow_advance` 对已 approved 阶段的 enter 报错也区分「返工（revisit）」与「开新需求（/new）」，避免弱模型被推向返工路径复用本会话污染统计（完成瞬间 `review_submit` 返回也直接带出该提示，双保险）。**合并 open-ide 后**：完成态注入块与 `review_submit` 返回额外读锁表（`store.listLocks`），仍有文件被人工锁定时提示开发者确认后逐个 `unlock_file`（仅 sdlc，`hasCommitGate` 门控，reqdoc 不提示）；锁提示由插件硬数据驱动，不依赖弱模型主动查 `list_locked_files`
- **状态持久化**：Agent 通过插件工具（4.1）写入 `WorkflowState`（阶段变更、审查清单、理解记录），不依赖 LLM 记忆
- **状态同步**：每轮 hook 触发时读取的都是插件库中的最新状态，确保 Agent 始终知道当前进度

### 7.2 实际效果：开发者看到什么

交互场景已按工作流拆分到各自文件：
- **sdlc 场景一~四**（阶段推进 / 审查理解确认逐段交互 / 提交门禁 / 重复编辑检测）见 **workflow-sdlc.md 4 章**。
- **reqdoc 场景五**（业务确认，PRD 要点逐段确认）见 **workflow-reqdoc.md 9 章**。

### 7.3 规则可靠性

"系统提示"方案的局限在于 LLM 可能不遵守规则。通过以下措施提高可靠性：

| 风险 | 措施 |
|------|------|
| Agent 忘记当前阶段 | 每轮 `system.transform` hook 将最新状态压缩为阶段状态条刷新到 system prompt |
| Agent 自行推进阶段 | 规则重复强调"绝不自行判断"，且 `workflow_advance` 工具在服务端（插件 handler）校验：`approve` 必须 `developer_confirmed=true`（开发者明确确认），否则拒绝 |
| Agent 跳过审查交互 | 审查阶段是独立的系统提示块，规则优先级最高；`review_submit` 工具在服务端二次校验审查清单（`def.checklist`）与前序阶段，未全部通过则拒绝 |
| Agent 批量跳过逐段确认 | **服务端防篡改**：`comprehension_confirm` 工具单次调用只接受一个 `codeSegmentId`，批量传入直接报错，防止 LLM 在开发者回复"看起来不错"时将全部片段批量设为 `confirmed` |
| Agent 绕过门禁直接提交 | `tool.execute.before` hook 拦截 `bash` 中的 `git commit`，未通过 `commit_gate_check` 时抛错阻断——这是插件层的硬约束，不依赖 LLM 自觉 |
| Agent 重复 enter 已 approved 阶段 | `applyTransition` 服务端校验：`enter` 已 approved 阶段抛错（须 `workflow_revisit` 回退），`enter` 已 in_progress 阶段幂等 no-op（不追加 transition） |
| 弱模型完成后不知收尾 / 在新会话复用当前会话致统计混入 | 完成态注入**专用完成块**给全「提交 → /new 开新需求 → revisit 改本需求」三条可行动作，且 `review_submit` 通过（门禁 allowed）时返回直接带出 /new 提示——完成瞬间即可见；对已 approved 阶段 enter 的报错也明确「开始下一个需求请执行 /new」，防止弱模型被引导走返工路径复用本会话。合并 open-ide 后完成块另读锁表提示解锁（仅 sdlc） |
| LLM 上下文窗口不足 | 工作流状态压缩为阶段状态条，system prompt 只注入当前阶段规则（global + 当前 in_progress 阶段，见 7.4），历史规则不重复注入 |

reqdoc 无 `git commit` 门禁，表中「绕过门禁直接提交」风险不适用；其 review 语义为**业务确认 PRD 要点**，防批量走过场的约束（`comprehension_confirm` 单次只接受一个要点）同样生效。

### 7.4 规则注入机制与规则全文指引

规则以 `WorkflowDefinition.rules: RuleItem[]` 存储（见 3.2），每项带 `stage` 归属（`"global"` 或阶段键）。插件每轮经 `rulesForStage(def, currentInProgressStage(workflow))` **只注入 global + 当前 in_progress 阶段的规则**（弱模型遵循负担最小化，见 7.3）；无进行中阶段时只给 global + 起步提示。规则文本只承载**模型可行动作**（调用哪个工具、何时、确认语义）；插件内部机制（行数统计、stuck 检测、一次通过率计算）由代码强制，不进注入文本。

**sdlc 12 条规则**（sdlc-r1~r12：6 global + 1 requirements + 5 review）的完整表格（含注入时机）已移至 **workflow-sdlc.md 3 章**，此处不再重复。

**reqdoc 30 条规则**（reqdoc-r1~r31，r29 预留未用：9 global + 3 goal + 2 rules + 5 edge + 6 prd + 5 review）的完整表格（含注入时机）已移至 **workflow-reqdoc.md 4 章**；需求资料目录契约见 **workflow-reqdoc.md 3 章**。

### 7.5 reqdoc 需求资料目录契约（双通道）

**需求资料目录契约（双通道：文档扫描 + 对话补缺）已整章移至 workflow-reqdoc.md**：三大支柱设计要点与价值链 mermaid 见 **workflow-reqdoc.md 1 章**；目录骨架（01~06，业务投放材料区 + AI 工作区）、目录 → 阶段映射、初始化与引导闭环 mermaid、模板送达、打分卡门禁、追问探针清单与柔性一致校验、渲染结构校验门禁、产出归档、渲染铁律、多模态边界、明确不做清单，见 **workflow-reqdoc.md 3 章**。

---

## 8. 文件清单

### 上游 OpenCode（零修改）

不修改、不新增任何上游包（`packages/*`）内的文件。仅依赖上游已有的插件 Hook 体系与 session REST API（见 2.4、4.2）。

### 契约包 `opencode-session-mgmt/packages/shared/`（新建，三包共用）

| 文件 | 用途 |
|------|------|
| `src/workflow.ts` | WorkflowDefinition 注册表（WorkflowType/ChecklistItem/RuleItem/WorkflowDefinition/getDefinition/resolveWorkflowType + rulesForStage/currentInProgressStage 阶段化注入选择）+ WorkflowState schema（含泛化 stages/checklist、ComprehensionRecord、QualityMetrics、BaselineEstimate）与 efficiencyRatio 提效率口径；删除 STAGE_ORDER/STAGE_LABELS/StageName——插件写、收集服务收、CLI 读，单点定义 |
| `src/loc.ts` | AI 代码行数：行数计算、业务/测试/配置三分类（classifyFile）与分类汇总（sumLinesByCategory）（sdlc 专属） |
| `src/report.ts` | 汇报与 CI 回写 payload schema（WorkflowSummary 含 type + 泛化 stages，按 type 驱动） |
| `src/identity.ts` | identity.json 类型与读写（含 workflowType 第五属性，缺省 sdlc） |
| `src/merge.ts` | DeepPartial 增量合并语义（插件工具与收集服务共用） |
| `src/reqdoc-render.ts` | reqdoc 渲染结构校验共享契约（质量飞轮 P2）：结构 schema / 解析 / 复核违规 / rubric 注入，见 **workflow-reqdoc.md 7 章** |

### 插件包 `opencode-session-mgmt/packages/plugin/`（新建，我们拥有）

| 文件 | 用途 |
|------|------|
| `src/index.ts` | 插件入口：注册 hooks（`experimental.chat.system.transform`、`tool`、`tool.execute.before/after`、`chat.message`），启动后台任务延后触发 |
| `src/startup.ts` | 启动后台任务：共用一次 `session.list` 完成 孤儿清理 + 标题回填（延后 2 秒，减少启动耗时） |
| `src/db/schema.ts` | 插件库表定义（仅 `workflow_session` 一张表） |
| `src/db/index.ts` | 插件 SQLite 初始化与迁移（bun:sqlite，WAL 模式） |
| `src/identity.ts` | 读全局 `identity.json`，解析 `api_key`（上送前转 SHA-256 哈希）；不再打标 account_id |
| `src/prompt.ts` | system prompt 注入片段：阶段化注入（rulesForStage 取 global + 当前阶段规则）+ buildStateBar 阶段状态块替代冗长 JSON（含阶段表头「当前阶段（第 N/Y 步）+ 目的 + 状态」、来源覆盖 [文档]x/[问答]y、渲染校验、追问覆盖多行）；`stage===null` 三态化：未启动（起步）/ 空档态（部分 approved：继续→进入下一阶段 / 回退→revisit）/ 完成态（专用完成块：「提交 commit_gate_check / 开新需求 /new / 改本需求 workflow_revisit」，不注入常规全局规则；合并 open-ide 后完成态另读锁表提示解锁，仅 sdlc） |
| `src/tools/workflow.ts` | `workflow_advance`（含 reqdoc 进入 prd 的打分卡门禁）/ `workflow_revisit` / `workflow_baseline` / `commit_gate_check` / `commit_force_unlock` 工具 |
| `src/tools/review.ts` | `comprehension_add` / `comprehension_confirm` / `comprehension_reject` / `comprehension_rewrite` / `comprehension_manual` / `comprehension_ask` / `review_submit` 工具（含防批量确认校验、终态门禁、reqdoc 定稿打分卡 + P1 探针 + P2 渲染复核兜底校验） |
| `src/tools/reqdoc-scan.ts` / `reqdoc-features.ts` / `reqdoc-score.ts` / `reqdoc-check.ts` / `reqdoc-export.ts` | reqdoc 专属工具（文档扫描 / 功能点拆解确认 / 八维打分卡 / 渲染结构校验 / Word 导出），用途与服务端校验见 **workflow-reqdoc.md 8 章** 完整表格 |
| `src/tools/quality.ts` | 迭代计数 + AI 代码行数累计逻辑（`quality_report` 已移除，firstPassRate 由 review.ts 自动计算） |
| `src/workflow-ops.ts` | 阶段转换（enter/approve/revisit，3.3）与提交门禁重算（3.4），工具与门禁共用的状态机 |
| `src/gate.ts` | `tool.execute.before` 提交门禁拦截（git commit 阻断） |
| `src/report.ts` | 会话摘要汇报：推送至 `collector_url`，不可用时本地缓冲、恢复补推（fetch 带 5 秒超时，防止不可达时无界挂起） |
| `src/stats.ts` | 本机统计聚合查询（按 workflow.type 分区，sdlc 专属指标仅 sdlc 计算；供 opencode-sm 复用） |
| `test/*.test.ts` | 工具校验逻辑、合并语义、门禁、汇报缓冲的单元测试 |
| `package.json` | 插件包定义（入口、依赖） |

### 独立 CLI `opencode-session-mgmt/packages/cli/`（新建，我们拥有）

| 文件 | 用途 |
|------|------|
| `src/index.ts` | 入口与命令注册 |
| `src/commands/init.ts` | 交互式两问 + 可选工作流类型，写全局 `identity.json` |
| `src/commands/stats.ts` | 会话/项目级本机聚合（读插件库 + 上游 SDK 的 cost/tokens）；组/组织级由收集服务对外提供，CLI 不再直查 |
| `src/commands/list.ts` | 会话列表（上游 list + 插件库 status/tag 过滤） |
| `src/api.ts` | 上游 opencode SDK 封装（本机聚合用） |
| `test/*.test.ts` | 格式化与聚合的单元测试 |

### 后台收集服务（外部项目 `performance_dashboard`）

收集服务作为**外部独立项目**维护：[`performance_dashboard`](https://github.com/karsonto/performance_dashboard)（Go/Netty 后端，org 内网部署），承担汇报接收（`POST /api/report`）、CI 回写（`POST /api/ci-quality`）与组/组织级聚合（`GET /api/stats`）。`opencode-session-mgmt` 本仓库已退役 `packages/collector`，不再包含收集服务代码；其接口契约见 `collector-spec.md`。

### 部署配置

项目级 `opencode.json`（或等效配置）启用插件，无需改动上游：

```json
{ "plugin": ["./opencode-session-mgmt/packages/plugin"] }
```

### 已交付记录

多流程就绪与 reqdoc 工作流已交付（2026-08-08/09）：契约层多流程化（`WorkflowDefinition` 注册表、`WorkflowState.type`、stages/checklist 泛化、identity 两问）→ 各包消费方 def-driven（插件 / CLI / 收集服务）→ 文档同步与回归，均已落地。

启动耗时优化已交付（2026-08-12）：汇报 `fetch` 加 5 秒超时（`AbortSignal.timeout`，不可达时不再无界挂起）；孤儿清理与标题回填合并为一次 `session.list` 并延后 2 秒执行（错开 TUI 首屏 / daemon 启动竞态），逻辑移入 `src/startup.ts` 便于单测。

---

## 9. 部署与分发

**核心原则：开发者零编译**。三个包由团队构建发布一次，开发者只做安装与配置。

| 包 | 分发方式 | 开发者侧动作 |
|---|---|---|
| 插件 `session-mgmt` | 发布到 npm（或内部 registry）；daemon 基于 bun，TS 可直接加载，建议团队侧预编译为 JS 发布以屏蔽 bun 版本差异 | 无——OpenCode 按 `config.plugin` 自动拉取 |
| `opencode-sm` CLI | npm 包，或 `bun build --compile` 单文件二进制经内部分发 | `npm i -g @yourorg/opencode-sm`（或接收二进制） |
| 后台收集服务 `performance_dashboard` | 运维在 org 内网服务器部署一次（见外部项目） | 无——仅在 init 时填写其地址 |

### 9.1 组织管理员（一次性）

```bash
# 内网服务器部署收集服务（外部项目 performance_dashboard，详见其仓库）
# 镜像/编排以 performance_dashboard 仓库为准；部署后将其内网地址
# （如 http://10.0.1.20:8787）告知全体成员，作为 init 的收集服务地址
```

### 9.2 开发者（一次性，约 2 分钟）

```bash
npm i -g @yourorg/opencode-sm                    # 1. 装独立 CLI
# 2. opencode 配置启用插件（opencode.json，可由团队标准配置预置）：
#    { "plugin": ["@yourorg/opencode-session-mgmt"] }
opencode-sm init                                  # 3. 两问：api_key / 收集服务地址（+ 可选工作流类型）
```

此后开发者照常使用 `opencode`（TUI）——工作流规则随 system prompt 自动注入，阶段推进、审查、理解确认全部在对话中完成；外部查看用 `opencode-sm stats`。

### 9.3 升级路径

| 场景 | 操作 | 影响面 |
|------|------|--------|
| 插件 / CLI 升级 | 团队发新版；开发者 `npm update`（插件亦可由 OpenCode 启动时自动拉新） | 仅定制三包 |
| OpenCode 上游升级 | 开发者照常升级本体 | 与定制互不干扰，无合并、无迁移（见第 10 章） |

### 9.4 环境决策点

- **有内部 npm registry**：插件与 CLI 均走 npm，最省心；**无 registry**：插件以 git 路径/本地目录分发（上游 loader 支持本地路径），CLI 以 `bun build --compile` 二进制分发
- **插件发布形态**：建议团队侧编译为 JS 后发布（不受目标机 bun 版本影响）；此构建对开发者透明

---

## 10. 升级兼容性（上游同步）

本方案的核心目标是**让后续同步 OpenCode 上游更新没有合并冲突**：

- **上游零修改**：不改任何上游包内文件，上游版本升级等同正常更新，无核心文件冲突、无核心 schema 迁移对齐负担
- **数据独立**：定制数据全部在插件自有 SQLite 与 org 聚合库，表结构迁移各自自管，与上游 schema 演进互不影响；对上游会话仅以 `sessionID` 逻辑关联
- **接口稳定面小**：仅依赖上游插件 Hook 与 session REST API 两类公开接口；**插件不直读上游数据库**，上游内部表结构变化对定制无影响
- **experimental hook 风险受控**：`experimental.chat.system.transform` 若被上游调整签名，影响面仅插件包 `src/prompt.ts` 一处适配层，升级后回归测试即可，成本远低于核心合并
- **上游行为不变**：TUI、上游 CLI、上游 API 消费者均不受影响；卸载插件（移除 `config.plugin` 条目）即完全还原
- **快照语义**：身份（`apiKey` 哈希）随汇报固化，调整 `identity.json` 不追溯历史统计（见 3.1）

---

## 11. 安全与隐私

- 本机会话数据存储于本地插件 SQLite；跨机汇聚仅传输**流程摘要**（阶段时间戳、cost/tokens、质量指标、身份字段），**不含代码内容**
- 迭代计数明细 `iterationByFile`、行数明细 `linesByFile`（键均为文件路径）仅存本机插件库，汇报投影（`summarizeWorkflow`）已剥离——与理解确认片段剥离 `file`/`lines`/`explanation` 的口径一致，文件路径不上行；行数仅以业务/测试/配置三类聚合数字上行
- reqdoc 打分卡 `score`（含 `deductions.evidence` 证据引用的文件路径）整体**不进入汇报投影**（`summarizeWorkflow` 未包含 `score` 字段），仅存本机插件库供状态条展示——比文件路径剥离更保守
- 强制提交授权 `commit.force`（原因、时间、是否已用）随汇报上行：原因是开发者口述的流程元数据、非代码内容；上行是为让"绕过审查的提交"在组/组织统计中可见，服务于退出风险监控
- 汇报携带的 `apiKey` 哈希为身份标识、不含个人明文信息：收集服务应仅内网可达、最小化留存，访问权限限于组/组织管理者
- 组织级分析基于收集服务聚合库（各人汇报快照），不读上游账号体系
- 开发者可关闭汇报（不配置/停用 `collector_url`），退化为本机会话/项目级统计，功能不受影响
- 上游 Daemon 仅绑定 `127.0.0.1`，opencode-sm 经本机回环访问，不暴露网络端口
- reqdoc 会话的 PRD 要点 / 解释等理解确认正文与 sdlc 代码片段同属「不含代码内容」口径（汇报仅含流程摘要，剥离 comprehension 正文）；需求资料目录（01~06）仅存在于项目目录，不进插件库、不进汇报

---

## 12. 验证方式

上游命令与 `opencode-sm` 均通过 daemon 自动启动机制工作，无需手动操作。


```bash
# 首次使用（每台机器一次）
opencode-sm init    # 两问：api_key / 收集服务地址（+ 可选工作流类型）

# 上游命令（复用，验证未被定制影响）
opencode session list
opencode stats --days 7

# 定制命令（opencode-sm）
opencode-sm list                                   # 叠加插件库 status/tag 过滤
opencode-sm stats <id>                             # 单会话级（含 cost/tokens）
opencode-sm stats --project "用户系统" --period 7d  # 项目级（本地库 + 上游 SDK 聚合）
opencode-sm stats <id> --workflow sdlc --period 30d
opencode-sm stats --project "用户系统" --period 30d --json

# TUI 内对话验证（工作流推进、理解确认、提交门禁按 workflow-sdlc.md 4 章 / workflow-reqdoc.md 9 章场景走通）
opencode
```

单元测试：插件包 `opencode-session-mgmt/packages/plugin/test/`（工具校验、防批量确认、合并语义、门禁拦截）、`opencode-session-mgmt/packages/cli/test/`（格式化与聚合）。

上游回归：因上游零修改，只需确认插件启用/卸载两种状态下上游既有测试（`packages/core/test/session-*.test.ts`、`packages/tui/test/`、`packages/sdk/js`）均通过。

规则遵循度评测与数据驱动的规则迭代是**独立的验证方法论**，见第 13 章（重要：改规则前必须跑基线对比，不随 `bun test` 走）。

## 13. 评测驱动规则迭代（数据驱动优化）

规则文本优化（阶段化注入、状态条、审查清单引导）以**数据驱动**验证：量化弱模型对注入规则的遵循度，改前跑基线、改后对比。这是本方案的**核心方法论**——规则的每一步措辞调整都必须先有基线数据支撑，避免凭直觉改规则伤害弱模型。脚本 `scripts/eval-rules/`（不入 `bun test`，需真实模型端点）。**通用方法论**（适用于所有 AI 深度绑定开发）见 `plugin-guide/eval-driven-rule-iteration.md`；本章为其在 opencode-session-mgmt 的落地实例。**评测与质量飞轮实操手册（技能）见 `.opencode/skills/workflow-rules-eval/SKILL.md`**——冻结基线 / 三级验证 / 八维 delta 读法 / 归因地图 / 收敛判据可直接照其执行。

### 13.1 运行方式

```bash
# 冻结的 baseline 快照在 scripts/eval-rules/fixtures/baseline/（改造前的规则全文，可复现旧注入格式）
bun run scripts/eval-rules/run.ts --variant baseline --dry   # 只打印注入片段与判定期望，不调模型
bun run scripts/eval-rules/run.ts --variant baseline         # 跑基线通过率 → results/baseline.json
bun run scripts/eval-rules/run.ts --variant new              # 改造后 → results/new.json，自动对比 baseline
```

分三级验证（对应 13.6 决策图的 ①②③，何时跑哪级见「改动分级决策图」）：

- **① 干跑（秒级，每次改完必做）**：`--variant new --dry` 与 `--variant baseline --dry` 各跑一次，验证 46 场景注入片段与判定期望渲染正常，不调模型。
- **② mock 冒烟（仅改评测脚本时）**：临时起一个 mock OpenAI 端点返回罐装 tool_calls（针对新增场景命中其判定路径，如 r20 返回 `reqdoc_probe(asked=[...])`、r22 返回 `workflow_advance(enter prd)`），`EVAL_BASE_URL` 指过去非 dry 跑一遍，确认判定与聚合/对比路径不炸；跑完删掉 mock、`git checkout` 还原 `results/*.json`。
- **③ 真实模型对比（重闸，合入前必过）**：
  ```bash
  # 本地 vLLM（默认端点 http://localhost:8086/v1，qwen3.6）
  bun run scripts/eval-rules/run.ts --variant new --repeat 3
  # 远端推理模型（deepseek-v4-flash 等，EVAL_MAX_TOKENS=4096 留 thinking 空间；deepseek-v4-pro-0813 等长 reasoning 推理模型实测须 16384，否则 thinking 截断发不出工具调用）
  EVAL_BASE_URL=https://<端点>/v1 EVAL_API_KEY=<key> EVAL_MODEL=<model-id> EVAL_MAX_TOKENS=16384 \
  bun run scripts/eval-rules/run.ts --variant new --repeat 3
  ```

**读输出与合入门槛**：per-scenario 通过表（`✅`/`❌`，r20-r24 在 reqdoc 段）→ 聚合通过率（整体 / sdlc / reqdoc）→ `=== 对比(baseline → new) ===` 的 PRD 八维逐维 delta（仅 `--variant new` 且库里已有 baseline.json 时打印）。**八维任何一维回退（负号）就不合入**，回滚改动；全过或持平才沉淀资产合入。

**baseline 冻结纪律**：`results/baseline.json` 是**入库冻结参照**（fixtures 里改造前规则快照 + 指定模型实测结果），`--variant new` 自动读它对比。只有首次搭评测 / 换模型 / 换端点时才跑 `--variant baseline` 重新冻结并 commit；日常改动**只跑 `--variant new`，不要重跑 baseline 覆盖参照**，否则对比失效。

**陷阱**：改了 `packages/shared` 后必须 `rm -rf node_modules/sm-shared && bun install`（hoisted 拷贝残留，见 13.5），否则评测读到旧规则文本而 `bun test` 仍全绿，易漏。

- 环境变量：`EVAL_BASE_URL`（OpenAI 兼容端点，默认 `http://localhost:8086/v1`，本地 vLLM）、`EVAL_API_KEY`、`EVAL_MODEL`（默认 `/models/qwen3`，本地 vLLM 的模型 id）、`EVAL_MAX_TOKENS`（输出上限，默认 2048；推理模型须按需留 thinking 空间——deepseek-*-flash 4096，deepseek-v4-pro-0813 等长 reasoning 模型实测 16384 才够发出工具调用，4096 下 thinking 截断、content 与 tool_calls 双双为空导致误判失败；慢速弱模型 2048 防拖超时）、`EVAL_TIMEOUT_MS`（单请求超时，默认 180000，含网络/超时错误重试 3 次；16k token 渲染长输出的 reqdoc 场景须提至 300000）；`--repeat N` 重复多次取通过率（聚合按**运行次数**统计，防单次抖动掩盖趋势）
- **baseline 与 new 共用同一状态夹具**（`finish()` 重算 commit），保证可对等比较

### 13.2 场景集

46 个场景（sdlc s1-s22 + reqdoc r1-r24），覆盖关键规则：基线录入、确认后 approve、无确认不 approve、回到XX→revisit、审查逐段不批量、前序未完成不 submit、提交前查门禁、完成后提示 /new 与开新需求、空档态继续、审查全流程、open_ide 手工锁定与解锁、reqdoc 渐进引导 / 双通道功能点拆解 / 打分卡门禁 / 评分 / 追问 / 渲染。

- **sdlc 场景 s1-s22 明细**（含完成态 /new、空档态继续、审查全流程、open_ide 锁定、SDLC 完结解锁）见 **workflow-sdlc.md 8 章**。
- **reqdoc 场景 r1-r24 明细**（渐进引导、双通道功能点拆解、打分卡门禁、评分模式、追问可测化、渲染可测化）与质量飞轮见 **workflow-reqdoc.md 10 章**。

### 13.3 判定方式（rule-based，不用 LLM judge）

判定类分两类：**behavior 类**（`tool_use` / `no_tool` / `text`，断言「模型调了什么工具、怎么调、回复含什么」，sdlc 与 reqdoc 全部场景共用）与 **output 类**（`score` 质量飞轮 P0 / `render` 质量飞轮 P2，断言「模型渲染产出的 PRD 文本质量」，**reqdoc 专属**——reqdoc 用它将「通过/不通过」升级为 0-100 八维度量，sdlc 不跑 output 类、只走 behavior 类的通过率）。

- 工具类比对 `tool_use` 名称与参数谓词（如 approve 时 `developer_confirmed` 必须 true）；`args` 为参数子集全等匹配，`argsContains`（质量飞轮 P1）为数组子集断言——期望每个元素须出现在实际数组参数中（如断言 asked 覆盖核心探针），两者互不影响、零回归
- `no_tool` 类断言未调用某工具
- `text` 类（maxQuestions 问句计数、optionsABC 问句 ≤max 且含「默认」+ ≥2 个 A/B/C 标记、categoryKeywords 探针关键词）为关键词启发式，判定口径脆弱需人工复核
- `score` 类（质量飞轮 P0）：渲染标记命中 + `scorePrd()` 八维总分/维度上下限校验——同样是 rule-based，只是判定对象从「工具行为」换成「渲染产出质量」
- `render` 类（质量飞轮 P2）：共享 `parseRenderStructure` 解析模型回复文本，断言必查章节出现（requiredChapters，缺省=全部）、章节顺序正确（ordered）、功能点块数下限（minFeatures）、映射字段逐功能点全标来源（sourceAll）、至少一个 [缺省]（anyDefault，缺料不杜撰的结构信号）——与运行时 `reqdoc_check` 同源，只换「工具+文件」为「评测回复文本」（评测无文件系统）。**r23/r24 启用 `soft` 拆级降权（A3/D7）**：`sourceAll`/`anyDefault` 降为观察项不计通过率，硬门禁只剩章节/顺序/块数结构骨架；渲染/评分场景的模型输出原文落进结果 JSON（`outputs` 字段）供归因（A4）——只看 detail 无法区分「纯文本渲染/错层级标题/tool_call 占位」

### 13.4 实测记录与迭代闭环

**迭代闭环**：改规则前跑 `--variant baseline` 冻结基线 → 改规则/脚本 → 跑 `--variant new` 对比 → 通过率不降才保留；失败场景逐个归因（规则措辞 / 判定口径 / 场景二义性），优先调脚本与判定口径而非膨胀规则。reqdoc 侧质量飞轮轮次（打分卡补齐 39 / P0 41 / P1 44 / P2 46）见 workflow-reqdoc.md 10 章。

```mermaid
flowchart TD
    A(["迭代起点"]) --> B["冻结 baseline<br/>（仅首次搭评测 / 换模型 / 换端点时）"]
    B --> C["改动<br/>规则 / 探针 / 打分卡 / 模板<br/>或评测脚本 / 判定口径"]
    C --> D["跑 --variant new<br/>自动对比 baseline"]
    D --> E{"通过率 / 八维分数<br/>有回退？"}
    E -->|"是 · 回退"| F["失败场景逐个归因<br/>规则措辞 / 判定口径 / 场景二义性"]
    F --> G["优先调脚本与判定口径<br/>而非膨胀规则"]
    G --> C
    E -->|"否 · 全过或持平"| H["保留改动 · 沉淀资产<br/>新场景 / 探针 / 规则进 fixture"]
    H --> I(["合入"])
```

**实测结果一**（2026-08-12，deepseek-v4-flash，repeat 3，按运行次数）：整体 **76% → 93%**（reqdoc 61% → 100%，sdlc 88% 持平）。驱动改进的三处迭代：状态条列出**待确认项 id**（让模型知道要 confirm 什么）、规则显式排除模糊表态（「你看着办」不算确认）、review_submit 规则补「前序须全部 approved」。基线快照冻结于 `fixtures/baseline/`，`results/{baseline,new}.json` 入库作参照，任何模型/时刻可重跑对比。

**实测结果二**（2026-08-14，29 场景，repeat 1）：本地 qwen3.6（vLLM 8086）整体 **28/29（97%）**，唯一失败 `r1 渐进引导 ≤2 问`（问句 17 个超上限 2）；远端 deepseek-v4-flash（zen/go）整体 **28/29（97%）**，唯一失败 `r10 要点拒绝后重写`（userTurn「边界这块」存在二义——edge 阶段名 vs 要点 id，模型偶发改走 `workflow_revisit`）。

**实测结果三**（2026-08-14，31 场景含 s20-s21，repeat 1）：新增 `open_ide`/`unlock_file` 手工文件锁场景（sdlc-r12，open-ide 此后并入本工程）。远端 deepseek-v4-flash（zen/go，`EVAL_MAX_TOKENS=4096`）整体 **31/31（100%）**；本地 qwen3.6（`EVAL_MAX_TOKENS=2048`）整体 **28/31（90%）**，sdlc **21/21（100%）**（r12 改动零回归），reqdoc 仅 `r1 渐进引导`（既有稳定失败）与 `r2/r10 要点 id 参数匹配`（qwen3.6 对中文 id 精确复述波动，与 r12 无关）。s20/s21 初版 userTurn 未指明文件却期望模型杜撰 `file` 调 `open_ide`（与「未明确文件先询问」规则矛盾），两模型均失败；改为明确 `auth/service.ts` 后通过——**新增场景的 userTurn 须先满足规则触发前提**。

**实测结果四**（2026-08-17，46 场景含 P1/P2 质量飞轮，reqdoc 24 场景三模型对比）：reqdoc 工作流新增打分卡（reqdoc_score）、探针清单（reqdoc_probe）、渲染校验（reqdoc_check）后，三模型 reqdoc 通过率：**DeepSeek-V4-Flash 49/72 (68%)** > **qwen3.6 16/24 (67%, repeat 1)** > **mimo-v2.5 39/72 (54%)**。SDLC 未改动，mimo-v2.5 SDLC baseline 41/66 (62%) 与 deepseek 持平。关键发现：(1) r23/r24 渲染结构场景三模型均 0/3（模型不按模板生成结构化 PRD）；(2) qwen3.6 唯一通过 r24（缺料渲染+缺省标注）；(3) DeepSeek 在工具调用场景（r5/r11/r17/r20）显著更强。工具描述加 prd 门禁约束（reqdoc_score/reqdoc_confirm_features）对 mimo-v2.5 无显著效果（53%→54%），render judge 加 fuzzy 匹配对 r23/r24 无效果（模型不生成 markdown 标题）。

**实测结果五**（2026-08-17，deepseek-v4-pro-0813，repeat 3）：r12/r14 场景缺陷修复后的全量重跑，整体 **108/138 (78%)**（sdlc 57/66 (86%)，reqdoc 51/72 (71%)，PRD 评分 88.6/100）。**r12 确认语修复生效（3/3）**；**r14 仍未通过（0/3）**——注入已正确（edge 阶段注入打分门禁规则），但模型在「资料放好则 reqdoc_scan」与「进 prd 前 reqdoc_score」两条 edge 路径间优先走 scan，属 userTurn 二义性（未说明材料状态）而非注入缺陷。既有已知失败延续：r23/r24 渲染结构 0/3、r1 渐进引导 0/3；s15 拒绝后重写 0/3、r20 追问探针 0/3、r22 进 prd 0/3 为该模型新暴露。

**实测结果六**（2026-08-17，deepseek-v4-pro-0813，repeat 3，`EVAL_MAX_TOKENS=16384` + `EVAL_TIMEOUT_MS=300000`）：整体 **112/138 (81%)**（sdlc 59/66 (89%)，reqdoc 53/72 (74%)，PRD 评分 87.6/100）。**关键：EVAL_MAX_TOKENS 4096 → 16384 是必要前提**——r14 修复后模型 reasoning 极长，4096 下 thinking 截断、content 与 tool_calls 双双为空被误判失败；提升后**r14 0/3 → 2/3**、s12 1/3→3/3、s15 0/3→2/3、s19 2/3→3/3、r20 0/3→2/3。r14 仍偶发走 reqdoc_scan（userTurn 已给足材料+业务确认，2/3 稳定）。稳定失败延续：r1 渐进引导 0/3、r22 进 prd 0/3（workflow_advance 参数不匹配）、r23/r24 渲染结构 0/3（模型不逐字段标来源/不按模板结构）、s21/s22 解锁 2/3。**评测脚本加固**：run.ts 加 `--name` 场景过滤与 per-scenario 容错（单次请求重试耗尽记为失败并继续，不再中断整轮），长输出渲染场景须提 `EVAL_TIMEOUT_MS`。

**实测结果七**（2026-08-18，deepseek-v4-pro-0813，repeat 3）：整体 **125/138 (91%)**（reqdoc **62/72 (86%)**，sdlc **63/66 (95%)**，PRD 评分 87.6/100）。两处场景前提修复带来 reqdoc +12%：**r6 判定关键词矛盾修复**（0/3→3/3）——reqdoc-r2 明文要求业务语言、禁止技术词，旧判定却查「超时/驳回/失败/补单」等技术词，模型问「连点提交/断网」匹配不上；改为业务说法（谁能看/连点/断网/留痕/复核）后自洽；**r22 场景前提修复**（0/3→3/3）——edge 若 in_progress 模型会先 `approve(edge)` 再 `enter(prd)`，单轮评测无法模拟两阶段，judge 期望单轮 enter 会误判；edge 改 approved 后模型直接 enter(prd)。**r19 缺省遵循**（1/3→3/3，模型正确标 [缺省]、edgeControl 5）、**r14**（→3/3）随之前 userTurn 修复稳定。稳定失败收敛为：**r23/r24 渲染结构**（0/3，单轮 vs 多轮思维方差，用户定「接受现状」；后经 A3/D7 `soft` 拆级降权——来源标注降观察项不计通过率，硬门禁只剩结构骨架）、r1 渐进引导（1/3，推理模型英文 thinking 风格）、r17/r20/s15/s16/s22（2/3，低频偶发）。

### 13.5 关键教训（多次迭代沉淀）

- **判定关键词须与规则要求的语言自洽**：reqdoc-r2 明文要求业务语言、禁止技术词，r6 判定却查「超时/驳回/失败/补单」等技术词——模型按规则用业务说法问「连点提交/断网」就匹配不上，误判失败。判定词表须与规则约束的语言一致（业务说法），否则评测测的是「违背规则的措辞」而非「遵循规则」。
- **单轮评测无法模拟多阶段状态机动作**：r22 场景 edge 若 in_progress，模型按状态机正确先 `approve(edge)` 再 `enter(prd)`，但 judge 期望单轮直接 enter——场景前提须把前置阶段设为已 approved，让期望动作成为单轮可达的一步（同理 r23/r24 渲染属「先 scan/确认再渲染」的多轮思维，单轮评测呈高方差）。
- **规则文本保持简洁**：曾尝试给 r9/r11/r17/r19 补「须调用工具、逐段各调用一次」等详细措辞，实测发现弱模型对复杂措辞敏感（qwen3.6 出现 r2 确认要点不再调工具、r10 要点 id 错填），已全部回滚——提升应走脚本适配与判定口径，而非规则膨胀。
- **评测脚本对推理模型的适配**：`msg.content` 为空时回退 `reasoning_content`（推理模型正文可能在 thinking，text 类判定读不到 content）；输出上限用 `EVAL_MAX_TOKENS` 可配——推理模型显式留 thinking 空间（deepseek-*-flash 4096，**deepseek-v4-pro-0813 等长 reasoning 模型实测须 16384**，否则 thinking 截断致 content 与 tool_calls 双双为空、工具场景被误判「未调用」），**慢速弱模型默认 2048**（本地 qwen3.6 实测 ~16 tok/s，4096 下长生成场景拖到超时）；16k token 长输出的 reqdoc 渲染场景须提 `EVAL_TIMEOUT_MS` 至 300000，并给 run.ts 加 per-scenario 容错防单场景超时中断整轮。
- **评测请求须带超时 + 重试**：`client.ts` 用 `EVAL_TIMEOUT_MS`（默认 180s）+ 网络/超时错误重试 3 次（HTTP 4xx/5xx 不重试），否则偶发超时中断整轮评测（曾丢 25 分钟全量结果）。
- **新增场景的 userTurn 须与规则前提一致**：先满足规则触发条件再期望动作——s20 曾用未指明文件的发言却期望模型杜撰 `file` 调 `open_ide`（规则要求「先询问」），两模型均失败；明确文件后通过。
- **判定口径适配模型能力**：`exactCount`（恰 N 次）对单轮单发 tool_call 的推理模型过苛，可放宽为「≥1 次 confirm 且 `distinctArg` 不重复」，反映能力基线而非单次抖动。
- **场景 userTurn 避免二义性**：发言词不要同时是阶段名与要点 id（如「边界这块」既像 edge 阶段又像要点 id），否则强模型可能误走 `workflow_revisit`。
- **hoisted 拷贝残留影响评测**：评测脚本经 `node_modules/sm-shared` 解析共享包，`node-linker=hoisted` 下它是真实拷贝；修改 `packages/shared` 后须删除 `node_modules/sm-shared` 并 `bun install` 重同步，否则评测读到旧规则文本（`typecheck`/`bun test` 仍全绿，易漏）。

### 13.6 改动分级决策图（两个工作流共用评测门）

不是任何改动都跑评测门——只有碰触「模型行为面」的改动才需要（模型读进上下文的内容：规则文本 / 探针清单 / 打分卡 / 模板 / 工具描述 / 状态条注入格式；**评测脚本不属于行为面**——它是对照物/量尺，改判定口径是「换尺子」不是「改被测内容」，但同样要过评测门，判据变了结果不可直接对比）；机制面改动（工具逻辑 / 门禁 / 状态机 / DB / 汇报 / CLI / collector / 纯注释文档）由 `bun test` + `typecheck` 兜底，不跑评测门。行为面改动的分级验证（①②是③的前置自检，**③真实模型对比是合入前唯一不可省的重闸**）：

```mermaid
flowchart LR
    A(["改动"]) --> B{"碰触模型行为面？"}
    B -->|"否 · 机制面<br/>工具逻辑/门禁/状态机/DB<br/>CLI/collector/纯注释文档"| C["bun test + typecheck<br/>（346 单测，秒级）"]
    C --> Z(["合入 · 不跑评测门"])
    B -->|"是 · 行为面<br/>规则/探针/打分卡/模板<br/>工具描述/注入格式；<br/>评测脚本=换尺子也须过评测门"| D["进入评测门"]
    D --> E["① --dry 渲染验证<br/>（46 场景，秒级，不调模型）"]
    E --> F{"改动类别？"}
    F -->|"规则/探针/打分卡/模板<br/>（模型看到的实质内容）"| H
    F -->|"评测脚本/判定口径/注入格式<br/>（换尺子：评测自身或形态）"| G["② mock 冒烟<br/>（验证判定与聚合路径）"]
    G --> H
    H["③ 真实模型 baseline→new 对比<br/>（重闸，必过）"] --> I{"对比基线：有回退？"}
    I -->|"是"| J(["不合入 · 回退改动"])
    I -->|"否"| K["沉淀资产<br/>（新场景/探针/规则进 fixture）"]
    K --> L(["合入"])
```

①②③ 各级的**具体命令、读输出口径与 baseline 冻结纪律**见 13.1 运行方式。本决策图两个工作流共用，但第③步比对口径不同：**sdlc 只看通过率**（baseline→new 不降即可），**reqdoc 额外看打分卡八维分数**（打分卡 0-100 八维度量是 reqdoc 专属度量）。质量飞轮的三支柱机制（把 reqdoc 打分卡接进评测）、reqdoc 落地节奏（P0/P1/P2）与 reqdoc 实测轮次见 **workflow-reqdoc.md 10 章**。

**可持续的保障**

- **一切改动必须过回归**：每次改规则 / 探针 / 模板跑 eval，对比 baseline，任何回退都不合入——reqdoc 以打分卡八维分数不降为准，sdlc 以通过率不降为准（13.4 迭代闭环从「通过率不降」升级为「八维分数不降」）。
- **改进必须资产化**：新场景进 `scenarios.ts`、新探针进清单、新规则进 fixture——沉淀为可重复资产而非一次性修改。
- **三同步铁律照旧**：规则 / 工具 / 文档 / mermaid 同步。
