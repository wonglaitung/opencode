# OpenCode 插件开发规范

版本: 1.2.0
最后更新: 2026-08-13
来源: opencode-session-mgmt 实践（参见 packages/plugin 与 packages/shared）

说明
- 本文档提炼自仓内实践，适用于在本仓库中新增的所有 OpenCode 插件。
- 目标：统一约定、降低侵入性、确保安全与可测试性。

目录
1. 总则
2. 工程分层
3. 插件骨架（示例）
4. Hook 使用规范
5. 工具 (tool) 开发规范
6. 数据存储规范
7. 健壮性与降级策略
8. 安全与隐私
9. 测试规范
10. 编码与文档风格
11. 打包与分发
12. 验证清单（合并前必查）
附录：示例模板与快速检查脚本（见 docs/plugin-examples/）

---

## 1. 总则

1. 上游零修改：不得修改 `packages/*`（上游）下的任何文件；插件所有代码应收敛在插件目录内，保证可整体删除并恢复上游到原始状态。
2. 可插拔：通过 `opencode.json` 的 `"plugin"` 条目启用；移除该条目后应完全还原，不得留下上游状态或行为改变。
3. 最小依赖面：插件仅依赖上游公开接口：
   - Plugin Hook（`@opencode-ai/plugin`）
   - session REST API（通过 `@opencode-ai/sdk`）
   禁止直接访问上游数据库或内部模块实现细节。
4. 独立 workspace：插件为独立 bun workspace，不应被上游根 package.json 的 workspace glob 收录。改动后务必复查 workspace 配置，防止插件代码被上游工程无意包含。

---

## 2. 工程分层

推荐目录结构（单一插件工程）：

```
src/index.ts                # 入口：仅做组装（打开存储、装配依赖、注册 hooks、返回 handlers）
src/hooks/<hook>.ts         # 每个 hook 的适配与签名转换（experimental hook 兼容集中管理）
src/tools/*.ts              # 工具注册（按功能域拆分）
src/<pure_logic>.ts         # 纯函数：状态转换/聚合等（不触碰存储，便于复用与单测）
src/db/                     # 存储层：schema（迁移） + Store（类型化读写）
test/                       # 测试文件（bun test 可直接运行）
```

- 契约先行：凡被两个以上消费方（插件、CLI、服务）使用的类型/payload，应抽到 shared 契约包。契约变更需跨包同步；新增字段应为可选以保持向后兼容。
- 写侧可选 + 读侧容忍：写入方为新增字段使用可选属性；读侧必须容忍字段缺失（降级或使用默认值），避免因历史数据或旧实现缺字段而失败。
- 依赖注入：采用闭包工厂模式，如 `createXxx(store) => handler`。所有运行时依赖通过闭包持有，不在模块顶层保留可变状态。

---

## 3. 插件骨架（示例）

```ts
import { Plugin } from "@opencode-ai/plugin"
import { Store } from "./db/store"

const MyPlugin: Plugin = async (input) => {
  const store = await Store.open(input.directory)
  // 启动非阻塞副作用（应自容错），不得阻塞插件加载或抛出未捕获错误
  // 比如：启动 outbox 补推、定时清理，但这些必须在 dispose 中清理
  return {
    "experimental.chat.system.transform": /* handler */,
    tool: /* tools 定义 */,
    "tool.execute.before": /* handler */,
    "tool.execute.after": /* handler */,
    "chat.message": /* handler */,
    dispose: async () => {
      // 清理所有定时器、flush 未完成工作、关闭 store 等
      await store.close()
    },
  }
}
export default MyPlugin
```

要点：
- 将 `@opencode-ai/plugin` 声明为 peerDependency（版本为 `*`），并在 devDependencies 中锁具体开发时版本。
- 所有定时器/长期任务必须在 `dispose` 中清理，保证卸载或上下文切换时无泄漏。
- 启动任务延后执行：工厂放出的后台任务应错开启动瞬间（延后数秒）再跑，避免与首屏/daemon 启动竞态抢资源；同类全量拉取尽量合并（如共用一次 `session.list` 完成多项清理/回填）。先例：`packages/plugin` 的 `startup.ts`。

---

## 4. Hook 使用规范

约定表：

| Hook                             | 约定说明 |
|----------------------------------|---------|
| experimental.chat.system.transform | 只能向 `output.system.push()` 追加内容，绝不可改写上游已存在的 system 内容；注入内容应为规则 + 从 Store 读取的实时状态（不得依赖 LLM 的上下文记忆作为唯一状态来源） |
| tool.execute.before              | 唯一的硬拦截方式为 `throw` 错误；若会话未被插件显式追踪，应放行（宁漏勿误拦） |
| tool.execute.after               | 仅用于观测或计数，不得阻断工具后续流转 |
| chat.message                     | 副作用必须幂等（例如：仅当字段为空时才写入） |

实践建议：
- 把 experimental.* 的签名适配集中在单一文件（例如 `src/hooks/prompt.ts`），以便未来上游签名同步时集中维护。
- 当需要识别上游工具名或解析上游数据格式（如 apply_patch 的补丁文本）时，在代码中注释清楚依据的上游文件或注册处（给出文件路径/函数名/行号），并在文档中引用对齐依据，便于上游变更时定位。
- 对弱模型，注入的规则应**按阶段裁剪**：只注入通用规则 + 当前阶段规则，状态压缩为一行阶段条而非整块 JSON；注入文本只保留模型可行动作（工具名、时机、确认语义），插件内部机制（统计、检测）由代码强制、不进 prompt。先例：`packages/shared` 的 `rulesForStage`/`currentInProgressStage`（规则为带 `stage` 归属的 `RuleItem[]`）与 `packages/plugin` 的 `buildStateBar`，见设计文档 7.1/7.3/7.4。
- **无 in_progress 阶段时区分三态注入**：`currentInProgressStage` 返回 null 不只代表「未开始」，还可能是「空档态」（部分阶段 approved 但无进行中）与「完成态」（全部阶段 approved）。**完成态不得再注入常规阶段规则**——全局规则的「初始化工作流」等会与「已全部完成」自相矛盾，误导弱模型重启流程；应注入专用完成块：「提交（如尚未，先查门禁）→ 开新需求（引导 /new 保持统计隔离）→ 改本需求（workflow_revisit）」。空档态应提示进入第一个未启动阶段并给回退路径，勿误判为「尚未开始」。先例：`packages/plugin` 的 `buildSystemFragment`（`isComplete` 判定），见设计文档 7.1。
- 识别并跳过子代理会话：上游子代理会话带 `parentID`，插件应据此对其跳过规则注入/建记录/统计/汇报，避免污染本地与聚合统计；识别结果按会话缓存（避免每个消息都调一次 `session.get`），上游不可达时保守按主会话处理（宁漏勿误拦）。先例：`packages/plugin` 的 `subagent.ts`，见设计文档 2.4。

---

## 5. 工具 (tool) 开发规范

- 使用 `tool()` + `tool.schema`（zod）定义工具；每个参数必须调用 `.describe()` 描述其语义，工具名使用 snake_case。
- 校验在服务端强制，不信任 LLM：关键前提（如 “需开发者确认”）应作为必填参数并在服务端校验其值，避免仅靠 prompt 控制逻辑。
- 硬约束必须有程序级兜底：凡属于必须/禁止的规则，除了在 prompt 中说明外，还要在 hook 或工具实现层面强制检查与阻断。
- 校验失败抛自定义 Error 子类（参考 `WorkflowOpError`），错误信息用中文并指明当前状态与修复路径。
- 返回值为中文可读：输出应包含「结果」与「下一步指引」（例如门禁结果、未完成项）。
- 幂等保证：语义重复的调用应安全（例如重复确认、重复提交审查不应导致错误）。
- 留痕替代删除：审计类状态（例如强制授权）应标记为 `used` 或记录使用历史，而不是物理删除记录。

---

## 6. 数据存储规范

- 使用 bun 提供的 sqlite（bun:sqlite），数据库文件位于 `<project>/.opencode/<plugin>.db`，打开 WAL 模式；SQL 预处理统一使用 `?` 占位符绑定参数。
- 迁移自管：在代码中维护 `MIGRATIONS: string[]`，只追加不修改现有条目；迁移版本记录在 meta 表中，迁移脚本不得依赖上游 schema。
- JSON 列语义：
  - raw：原始字符串
  - row：解析后的结构
  更新复杂状态时区分两类语义：
  - 增量合并（适合指标类字段）：对象递归合并、数组整体替换
  - 命令式读-改-写（适合数组追加/计数）：明确的 mutateWorkflow 模式
- Store API 必须提供 `Store.memory()`（内存实现）用于测试。
- 只读打开注意事项：使用 `{ readonly: true }` 来打开只读连接，不要用 `{ create: false }`（在 bun 1.3.14 中后者导致 open flags 错误并抛 SQLITE_MISUSE；只读连接也无法执行迁移写入，因此只读路径不应用于会执行迁移的打开流程）。

---

## 7. 健壮性与降级策略

- 静默降级：若缺少身份或配置，关闭相应功能但不影响其他功能；与上游通信失败时跳过本次操作，避免故障扩散。
- outbox 模式：上报外部服务必须配备本地 outbox 缓冲：
  - 服务不可用时写本地缓冲并启动补推与定时重试机制。
  - HTTP 4xx 视为永久失败（记录日志并丢弃）；5xx 或网络错误应保留并重试。
  - 对相同键进行去重以防堆积。
- 对外 fetch 一律带超时：后台/启动期的 HTTP 请求应携带 `AbortSignal.timeout`（如 5 秒），服务不可达时快速放弃并留待补推，不得挂到 TCP 连接超时（可达数十秒）拖慢插件启动或阻塞请求。先例：`packages/plugin` 的 `report.ts`。
- 删除与清理操作保守化：在不能确保完整清单时不执行删除，避免因短暂不可达而误删。
- 外部进程调用静默化：若需 spawn 外部命令（例如定位浏览器、taskkill 等），一律使用 `spawn`/`spawnSync` 并把 stdio 设为 `"ignore"` 或显式捕获 stderr；所有外部调用应显式捕获并记录可能的错误，但不得把 stderr 泄露到上游或上传日志中。

---

## 8. 安全与隐私

- 任何离开本机的数据必须是显式构造的白名单投影：不得包含代码内容、文件路径或其他敏感内容（文件路径的明细仅保留于本机）。
- 投影与契约同步维护：当契约中新增可能包含文件路径或内容的字段时，汇报投影必须显式排除；不要依赖通用的 Omit 清单自动覆盖新增字段，遗漏会导致数据泄露。为此建议：
  - 明确列举允许上报的字段（白名单）
  - 在 CI 中加入投影字段变更告警（对比 shared 契约）
- 纯数字/时间戳字段可直接上行：判断标准为“该字段是否可能携带文件路径或代码内容”。例如：预估工时、时间戳、金额、Token 数等纯数值字段可以直接上行。
- 个人信息最小化：涉及个人信息的字段应最小化，相关服务建议仅内网部署；daemon 与服务交互仅走 127.0.0.1。

---

## 9. 测试规范

- 使用 `bun test`；测试放在插件包的 `test/*.test.ts` 中，并在插件目录下运行（不要在仓库根目录运行插件包的测试）。
- 优先测真实实现，尽量零 mock：存储使用内存库，依赖通过构造注入。
- 用例名称用中文描述行为；对于每个硬约束（拦截、幂等、上限等），应包含正反两组用例（验收与拒绝路径）。
- 建议增加 CI 步骤：`bun test`、`bun run typecheck`（strict）与一个轻量的插件启停脚本（启用插件、触发核心路径、移除插件并确认恢复）。
- 注入规则/提示词的遵循度建议建**评测基线**：用脚本对真实模型端点批量跑场景，对比改前/改后通过率，量化弱模型对规则文本的遵循度（先例 `scripts/eval-rules`，见设计文档 12.1；此类评测需真实模型端点，不随 `bun test` 跑）。

评测驱动规则迭代的实践要点（实测于 2026-08-14，见设计文档 12.1 双模型实测）：

- **规则文本保持简洁，改前必须数据驱动 + 多模型验证**：弱模型对复杂措辞极敏感——为提升某模型而把规则写细（如补「须调用 X 工具」「逐段各调用一次」）实测反而伤害弱模型（不再调工具、要点 id 错填）。为特定模型（如推理模型）提升应优先走**脚本适配与判定口径**，而非规则膨胀。
- **评测脚本对推理模型的适配**：`msg.content` 为空时回退 `reasoning_content`（推理模型正文可能在 thinking，`text` 类判定读不到 content）；`max_tokens` 需预留推理空间（如 4096），否则 reasoning 占满被截断，吞掉工具调用或参数。
- **判定口径适配模型能力**：`exactCount`（恰 N 次）对单轮单发 tool_call 的推理模型过苛，可放宽为「≥1 次 + `distinctArg` 不重复」，反映能力基线而非单次抖动。
- **场景 userTurn 避免二义性**：发言词不要同时是阶段名与要点 id（如「边界这块」既像 edge 阶段又像要点 id「边界策略」），否则强模型可能误走 `workflow_revisit`。
- **hoisted 拷贝残留影响评测**：评测脚本经 `node_modules/sm-shared` 解析共享包，`node-linker=hoisted` 下它是真实拷贝；修改 `packages/shared` 后须删除 `node_modules/sm-shared` 并 `bun install` 重同步，否则评测读到旧规则文本（`typecheck`/`bun test` 仍全绿，易漏）。

---

## 10. 编码与文档风格

- TypeScript strict，禁止 `any`；代码风格遵循仓内约定：无分号、双引号（由根 prettier 管理）。
- 文件命名：文件 kebab-case，DB 字段 snake_case，类型 PascalCase。
- 魔法数字应提为具名常量并注明出处；复杂正则与边界逻辑必须注释设计取舍。
- 源文件顶部应注一行注释，标注对应设计文档章节；实现变更时同步更新设计文档与流程图。
- 文档、注释与 commit 使用中文；禁止使用 `§` 符号（使用“第 3.4 节”或裸编号）。commit 遵循 conventional commits（例如 `feat(plugin): ...`、`fix(plugin): ...`、`docs(...): ...`）。

---

## 11. 打包与分发

统一两层打包流程（参见各插件工程的 `scripts/pack-bundle.sh`）：

- build:plugin
  - 示例：`bun build src/index.ts --outdir dist/plugin --target bun`
  - 目标：编译为自包含 JS，屏蔽目标机 bun 版本差异。
- pack:bundle
  - 示例：`scripts/pack-bundle.sh`
  - 目标：生成可移植 tarball（`dist/<plugin>-bundle-<version>.tgz`），支持内网/离线部署（解压即用）。
要点：
- 根目录必须有 `.npmrc`（`node-linker=hoisted`），避免 bun 在 Windows 上使用硬链接导致打包后依赖丢失。
- 打包脚本应完成：清旧依赖 → hoisted 重装 → 组装含 node_modules 的目录 → 附带 setup.sh / setup.ps1 / setup.cmd（内网纯 cmd 用）的环境校验与离线依赖种子（见 11.1）。setup.cmd 的源文件为 `scripts/templates/setup.cmd`（LF 行尾），打包时拷入并转 CRLF。**setup.cmd 内部消息必须保持纯 ASCII（英文）**：cmd 批处理按活动控制台代码页（中文系统为 GBK/CP936）解析，UTF-8 中文在 rem/echo 行会被拆错并当作命令执行（报「不是内部或外部命令」）；曾因此踩坑，勿改回中文。
- 打包时保证 bundle 根 package.json 的 `main` 指向插件入口，便于解压后直接加载。
- 注意 hoisted 模式下 workspace 包为真实拷贝，修改 shared 契约后需要重新打包/重装以避免旧拷贝残留。

### 11.1 内网/离线部署（Windows 纯 cmd）

现象：内网机配置插件后，opencode 启动到输入栏慢约 1-2 分钟。根因：opencode 配置插件后，启动会对每个 config 目录（全局 `~/.config/opencode`、项目 `.opencode` 等）执行插件 SDK `@opencode-ai/plugin` 的依赖安装（`waitForDependencies`）；内网机无法联网、无 registry 镜像，安装卡到超时（日志出现 `background dependency install failed`）。

安装是幂等前置检查（opencode `core/src/npm.ts` 的 install）：`node_modules` 存在 **且** `package-lock.json` 根 `packages[""].dependencies` 列出 `@opencode-ai/plugin` 时直接 no-op，否则联网 reify。因此修复 = 预填这两个文件，让判定变 no-op。

- `scripts/pack-bundle.sh` 打包时生成 `seed/`（从 bundle 自身拷贝 `node_modules/@opencode-ai/plugin` + 最小 `package-lock.json`/`package.json`，版本与 bundle 一致），随 tgz 分发，内网机无需联网或 npm。
- `setup.cmd`（纯 cmd，无需 PowerShell、无需网络）把 `seed/` 铺进 config 目录：`setup.cmd seed <项目目录>` 种**全局 `%USERPROFILE%\.config\opencode\`（存在 `~/.opencode` 也种）+ 该项目 `.opencode`**——**每个要用插件的项目各跑一次**（命令幂等、可重复）。
- 验证：内网机种后启动 <5s，日志不再出现 `background dependency install failed`；对照实验为去掉插件配置计时。

---

## 12. 验证清单（新插件合并前）

必要检查项（合并前强制通过）：
1. `bun test` 与 `bun run typecheck`（strict）全绿。
2. 启用插件跑通核心路径；移除插件条目后上游行为应完全还原（无残留）。
3. 验证依赖缺失场景（无配置 / 远程服务不可达）下的静默降级逻辑。
4. 确认未修改任何上游文件，且插件工程不被上游 workspace glob 收录。
5. experimental hook 的兼容/适配代码集中于单一文件以便集中维护。
6. 安全审计：确保上传数据为白名单投影，已列举允许上报字段并在 CI 中有变更告警。
7. 打包校验：执行一次 `pack:bundle` 并在干净环境中验证解压即用（含依赖）。
8. 改动 `packages/shared`（契约）后重装 workspace 依赖（`rm -rf node_modules/<共享包> && bun install`），确认测试与评测脚本读到最新契约而非 hoisted 旧拷贝。

---

附录（建议放在 docs/plugin-examples/）
- 插件骨架代码模板（可直接复制）
- Store 内存实现示例
- MIGRATIONS 模板与示例
- tool.schema（zod）参数示例
- 简单的合并前自检脚本（bash / ps1）
