# docs/ 文档索引

本目录是 `opencode-session-mgmt` 的文档与运行时资源所在。**新增文件进 docs/ 时，先在此登记分类**，
避免「逐个增加、无规律」——见文末「维护约定」。

三类文件混列同一目录：**设计文档**（给人与后续会话读的说明）、**运行时资源**（代码/打包脚本/模型
实际消费的文件，改动须连带改消费方）、**部署参考**（部署用配置样例）。

## 索引总表

| 文件 | 类别 | 作用 | 被谁消费 | 能否改名 / 移动 |
|------|------|------|----------|----------------|
| [session-management.md](session-management.md) | 设计文档 | **主设计文档**（架构、7.x 规则、reqdoc/打分卡/模板送达等全部行为） | [CLAUDE.md](../CLAUDE.md)、[README.md](../README.md)、[.opencode/agent/rules-reviewer.md](../.opencode/agent/rules-reviewer.md)、[deployment.md](deployment.md)、[collector-spec.md](collector-spec.md) 引用其内容 | 改名需同步 5 处引用；一般不主张 |
| [collector-spec.md](collector-spec.md) | 设计文档 | 收集服务（collector）规范：三端点、聚合、容错 | 无入站引用（独立规范） | 可，但内容被作为部署/开发依据 |
| [deployment.md](deployment.md) | 设计文档 | **部署与使用手册**（新人先看）：装 OpenCode、启用插件、CLI、收集服务、内网隔离、FAQ | [README.md](../README.md) 链接；自身引用 [qwen3.6-27b.chat-template.jinja](qwen3.6-27b.chat-template.jinja) | 改名需同步 README.md |
| [upstream-sync.md](upstream-sync.md) | 设计文档 | 上游同步方案：remote 布局、同步命令、冲突预案、同步记录 | [README.md](../README.md)、[CLAUDE.md](../CLAUDE.md)、[.opencode/command/sync-upstream.md](../.opencode/command/sync-upstream.md)、[deployment.md](deployment.md) | 改名需同步 4 处引用 |
| [mixed-development-workflow.md](mixed-development-workflow.md) | 设计文档 | 混合开发工作流参考（人机协同写码的边界约定） | 无入站引用 | 可 |
| [reqdoc-prd-template.md](reqdoc-prd-template.md) | 运行时资源 | reqdoc PRD 模板的 **md 渲染载体**（[模版.docx](模版.docx) 的运行时形态，prd 阶段由插件注入） | **代码硬引用**：[template.ts](../packages/plugin/src/template.ts)（`TEMPLATE_FILENAME` 常量拼接候选路径）、[workflow.ts](../packages/shared/src/workflow.ts)（r14/r20 规则文本）、[pack-bundle.sh](../scripts/pack-bundle.sh)（拷 docs/ 到 bundle 根）、[template.test.ts](../packages/plugin/test/template.test.ts) | **不可改名 / 不可移出 docs/ 根**（模板送达机制按 `docs/<此文件名>` 解析，移动即破坏） |
| [模版.docx](模版.docx) | 运行时资源 | reqdoc PRD 模板的 **权威源**（内容以本文件为准，三处已知瑕疵已修复） | [pack-bundle.sh](../scripts/pack-bundle.sh)（整目录拷入 bundle）、[session-management.md](session-management.md)、[reqdoc-prd-template.md](reqdoc-prd-template.md) 头部标注 | 可改名（同步 3 处引用）；**改 docx 必须同步重渲染 md** |
| [实施方案.docx](实施方案.docx) | 运行时资源（输入源） | 银行业务需求智能引导实施方案（reqdoc 重构的来源依据，历史决策输入） | **无引用（孤儿）** | 可改名 / 可归档至子目录 / 可删（仅历史决策依据） |
| [qwen3.6-27b.chat-template.jinja](qwen3.6-27b.chat-template.jinja) | 部署参考 | 部署模型 qwen3.6-27b 的 chat template（vLLM 部署用） | [deployment.md](deployment.md) | 可（同步 deployment.md） |

## 关键约束速览

- **[reqdoc-prd-template.md](reqdoc-prd-template.md) 与 [模版.docx](模版.docx) 是同一模板的两个形态**：docx 为权威源、md 为运行时载体。
  看文件名可能误以为两者无关——**任何对 docx 的修改必须同步重渲染 md**，否则「渲染严格逐字遵循模板」
  名不副实（reqdoc-r20 铁律，见 [session-management.md](session-management.md) 7.5 维护约定）。
- **[reqdoc-prd-template.md](reqdoc-prd-template.md) 的位置是代码契约**：[template.ts](../packages/plugin/src/template.ts) 按 `packages/plugin/src` 上溯三级解析到
  `docs/reqdoc-prd-template.md`，[pack-bundle.sh](../scripts/pack-bundle.sh) 把整个 `docs/` 拷到 bundle 根。改名/移动会破坏
  「模板送达」机制，**不要动**。
- **[模版.docx](模版.docx) 是模板权威源**：内容以本文件为准（第二章重复标题、3.0 附件编号、优先级默认不一致三处已知瑕疵已修复为规范模板）；若要改名，同步 [pack-bundle.sh](../scripts/pack-bundle.sh) 注释、
  [session-management.md](session-management.md)、[reqdoc-prd-template.md](reqdoc-prd-template.md) 头部三处即可。
- **[实施方案.docx](实施方案.docx) 是输入源不是产出**：零代码引用，仅作为需求决策的历史依据；与 [collector-spec.md](collector-spec.md)、
  [mixed-development-workflow.md](mixed-development-workflow.md) 两个「无入站引用的独立文档」不同，它不会被任何人消费。

## 维护约定

1. **新增文件进 docs/，先在本表登记一行**（文件 / 类别 / 作用 / 消费方 / 约束），并更新上面的
   「关键约束速览」——「逐个增加无规律」的观感由此消除。
2. 类别判定：被代码/打包脚本/模型运行时消费 → **运行时资源**；部署配置样例 → **部署参考**；
   其余给人读的说明 → **设计文档**。
3. 命名偏好：新增文档默认英文 kebab-case（如 `xxx-guide.md`）；与业务交付强绑定的冻结输入
   （docx）保留中文原名，但必须在表中标注「冻结源 / 输入源」身份。
4. 改文件名的唯一红线：先查「被谁消费」列，消费方全部同步后再动；`reqdoc-prd-template.md` 除外，
   **一律不改**。
5. 文件名在索引中一律包成相对链接（表首列 / 消费方 / 约束速览），新增登记时同步给新文件名加链接。
