# OpenCode 插件开发规范

版本: 1.6.0
最后更新: 2026-08-14
来源: opencode-session-mgmt 实践（参见 `opencode-session-mgmt/packages/plugin` 与 `opencode-session-mgmt/packages/shared`）

说明
- 本文档提炼自仓内实践，适用于在本仓库中新增的所有 OpenCode 插件（`opencode-session-mgmt`、`opencode-edge-debug`）。注：原 `opencode-open-ide` 插件已于 2026-08 物理合并进 `opencode-session-mgmt`（`packages/plugin/src/open-ide/`），不再作为独立工程。
- 目标：统一约定、降低侵入性、确保安全与可测试性。
- 位置：本文件为**跨插件通用规范**，独立存放于仓库根 `plugin-guide/`（不隶属任一插件工程），避免被埋没于某工程 docs 下。文中的 `opencode-session-mgmt/...` 路径均以仓库根为基准；「设计文档 X 章」指 `opencode-session-mgmt/docs/session-management.md`。

目录
1. 总则
2. 工程分层
3. 插件骨架（示例）
4. Hook 使用规范
5. 工具 (tool) 开发规范（含目标文件识别 + 5.1 跨插件协作）
6. 数据存储规范
7. 健壮性与降级策略
8. 安全与隐私
9. 测试规范（含评测驱动规则迭代标准作法）
10. 编码与文档风格
11. 打包与分发
12. 验证清单（合并前必查，含规则改动评测对比）
附录：示例模板与快速检查脚本（见 plugin-guide/plugin-examples/）

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
- 启动任务延后执行：工厂放出的后台任务应错开启动瞬间（延后数秒）再跑，避免与首屏/daemon 启动竞态抢资源；同类全量拉取尽量合并（如共用一次 `session.list` 完成多项清理/回填）。先例：`opencode-session-mgmt/packages/plugin` 的 `startup.ts`。

---

## 4. Hook 使用规范

约定表：

| Hook                             | 约定说明 |
|----------------------------------|---------|
| experimental.chat.system.transform | 只能向 `output.system.push()` 追加内容，绝不可改写上游已存在的 system 内容；注入内容应为规则 + 从 Store 读取的实时状态（不得依赖 LLM 的上下文记忆作为唯一状态来源） |
| tool.execute.before              | 唯一的硬拦截方式为 `throw` 错误；若会话未被插件显式追踪，应放行（宁漏勿误拦） |
| tool.execute.after               | 仅用于观测或计数，不得阻断工具后续流转 |
| chat.message                     | 副作用必须幂等（例如：仅当字段为空时才写入） |

**tool.execute.before 是全局广播**：上游在**任何工具执行前**统一触发（`session/tools.ts`），对所有插件注册的 before hook 逐一调用——无论该工具是上游内置（write/edit/apply_patch/bash）还是其它插件注册的。因此**单个插件的 before hook 就能拦截全部工具的调用**，无需跨插件共享状态即可实施全局约束（如人工文件锁：一个插件锁文件，就能拦下所有插件对它的写操作，见 open-ide 的 `lock-gate.ts`）。这是「插件间不耦合、约束仍全局生效」的关键机制。

实践建议：
- 把 experimental.* 的签名适配集中在单一文件（例如 `src/hooks/prompt.ts`），以便未来上游签名同步时集中维护。
- 当需要识别上游工具名或解析上游数据格式（如 apply_patch 的补丁文本）时，在代码中注释清楚依据的上游文件或注册处（给出文件路径/函数名/行号），并在文档中引用对齐依据，便于上游变更时定位。
- 对弱模型，注入的规则应**按阶段裁剪**：只注入通用规则 + 当前阶段规则，状态压缩为一行阶段条而非整块 JSON；注入文本只保留模型可行动作（工具名、时机、确认语义），插件内部机制（统计、检测）由代码强制、不进 prompt。先例：`opencode-session-mgmt/packages/shared` 的 `rulesForStage`/`currentInProgressStage`（规则为带 `stage` 归属的 `RuleItem[]`）与 `opencode-session-mgmt/packages/plugin` 的 `buildStateBar`，见设计文档 7.1/7.3/7.4。
- **无 in_progress 阶段时区分三态注入**：`currentInProgressStage` 返回 null 不只代表「未开始」，还可能是「空档态」（部分阶段 approved 但无进行中）与「完成态」（全部阶段 approved）。**完成态不得再注入常规阶段规则**——全局规则的「初始化工作流」等会与「已全部完成」自相矛盾，误导弱模型重启流程；应注入专用完成块：「提交（如尚未，先查门禁）→ 开新需求（引导 /new 保持统计隔离）→ 改本需求（workflow_revisit）」。空档态应提示进入第一个未启动阶段并给回退路径，勿误判为「尚未开始」。先例：`opencode-session-mgmt/packages/plugin` 的 `buildSystemFragment`（`isComplete` 判定），见设计文档 7.1。
- 识别并跳过子代理会话：上游子代理会话带 `parentID`，插件应据此对其跳过规则注入/建记录/统计/汇报，避免污染本地与聚合统计；识别结果按会话缓存（避免每个消息都调一次 `session.get`），上游不可达时保守按主会话处理（宁漏勿误拦）。先例：`opencode-session-mgmt/packages/plugin` 的 `subagent.ts`，见设计文档 2.4。

---

## 5. 工具 (tool) 开发规范

- 使用 `tool()` + `tool.schema`（zod）定义工具；每个参数必须调用 `.describe()` 描述其语义，工具名使用 snake_case。
- 校验在服务端强制，不信任 LLM：关键前提（如 “需开发者确认”）应作为必填参数并在服务端校验其值，避免仅靠 prompt 控制逻辑。
- 硬约束必须有程序级兜底：凡属于必须/禁止的规则，除了在 prompt 中说明外，还要在 hook 或工具实现层面强制检查与阻断。
- 校验失败抛自定义 Error 子类（参考 `WorkflowOpError`），错误信息用中文并指明当前状态与修复路径。
- 返回值为中文可读：输出应包含「结果」与「下一步指引」（例如门禁结果、未完成项）。
- 幂等保证：语义重复的调用应安全（例如重复确认、重复提交审查不应导致错误）。
- 留痕替代删除：审计类状态（例如强制授权）应标记为 `used` 或记录使用历史，而不是物理删除记录。

**识别工具目标文件（拦截类功能的核心）**：要在 `tool.execute.before` 里判断「AI 这次要改哪些文件」，须从工具入参提取目标路径，三个代码编辑工具的入参形态不同（先例 `opencode-session-mgmt/packages/plugin/src/open-ide/patched.ts`）：

| 工具 | 数据来源 | 说明 |
|------|---------|------|
| `write` / `edit` | `args.filePath` | 上游保证为绝对路径（edit.ts:48 注释原话） |
| `apply_patch` | `patchText` 的 `*** Add/Update/Delete File:` 头部 | 入参只有 patch 文本，文件在 File 头里；`Move to` 不重置、`*** Begin/End Patch` 重置 |

- 提取后**与锁集合比对须同一归一化口径**：锁以项目目录为基准 `resolve()` 成绝对路径，提取侧同样以项目目录解析，保证相对/绝对路径都能正确匹配（open-ide `createLockRegistry(directory)`）。
- 入参缺失/畸形返回空（宁漏勿误拦，同 gate 哲学）；只拦目标明确的工具，不拦 read/grep/bash 等。

---

## 5.1 跨插件协作（通用规范独立存放 + 文本契约）

当功能需要两个独立插件配合（如 session-mgmt 引导 AI 调 open-ide 的人工文件锁）：

- **通用规范独立存放**：跨插件共享的约定/规范文档应放仓库根独立目录（如 `plugin-guide/`），不要埋在某一个插件工程的 docs 下——否则其它插件维护者容易忽略它的存在。三插件引用统一指向该目录（`opencode.json` 的 `references` + README 链接）。
- **仅文本契约，零代码依赖**：跨插件配合时，被调插件的**工具名/参数契约**由调用方（session-mgmt）的规则文本引用（如 sdlc-r12 提到 `open_ide`/`unlock_file`）。这是可接受的**单向文本耦合**——调用方改动工具契约时需同步更新规则文本与评测脚本的 `tool-defs`；但不允许代码级 import 对方模块。先例：`opencode-session-mgmt` 的 sdlc-r12 规则 + `scripts/eval-rules/src/tool-defs.ts` 引用 open_ide 工具契约（原 `opencode-open-ide` 已合并进本工程，契约现为仓库内一处定义）。
- **规则措辞要精确到工具参数**：若某工具「不传关键参数就达不到目的」（如 `open_ide` 不带 `file` 不会锁定），规则文本必须显式写出「必须携带 file 参数」，否则弱模型会调成无效形态，闭环从源头断开。

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
- 对外 fetch 一律带超时：后台/启动期的 HTTP 请求应携带 `AbortSignal.timeout`（如 5 秒），服务不可达时快速放弃并留待补推，不得挂到 TCP 连接超时（可达数十秒）拖慢插件启动或阻塞请求。先例：`opencode-session-mgmt/packages/plugin` 的 `report.ts`。
- 删除与清理操作保守化：在不能确保完整清单时不执行删除，避免因短暂不可达而误删。
- 外部进程调用静默化：若需 spawn 外部命令（例如定位浏览器、taskkill 等），一律使用 `spawn`/`spawnSync` 并把 stdio 设为 `"ignore"` 或显式捕获 stderr；所有外部调用应显式捕获并记录可能的错误，但不得把 stderr 泄露到上游或上传日志中。
- **跨平台二进制定位，win32 的 `where` 会返回多行**：同名命令常同时有无后缀的 POSIX sh 脚本（如 VS Code 的 `...\bin\code`，供 WSL/linux）与真正的 Windows shim（`code.cmd`/`code.exe`）。`where` 返回的**第一行可能是 sh 脚本**——cmd.exe 无法执行，`spawn` 加 `shell: true` 时静默失败（stdio ignore + unref 吞错误，表现为「工具返回成功但程序没起来」）。**必须跳过无后缀行**：按扩展名优先级 `.exe` → `.cmd` → `.bat` 挑选，全部无后缀才兜底第一行（不破坏仅有无后缀可执行程序的场景）。抽取为纯函数便于单测（先例 open-ide 的 `pickWindowsExecutable`，`src/ide.ts`）。
- **win32 用 `shell: true` 时，binary 与参数都须加引号**：`spawn(binary, args, { shell: true })` 下 node 经 cmd.exe 执行**整条命令**，若只转义 args、漏掉 binary，含空格的 binary 路径（如 `...\Microsoft VS Code\bin\code.cmd`）会被拆词（'Microsoft' is not recognized）而静默失败。**凡是 shell 拼接出的每条目都要转义，包括命令本身**；把「binary + args 统一加引号」抽成纯函数（先例 open-ide 的 `buildSpawnCommand`）。

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
- 注入规则/提示词的遵循度建议建**评测基线**：用脚本对真实模型端点批量跑场景，对比改前/改后通过率，量化弱模型对规则文本的遵循度（先例 `opencode-session-mgmt/scripts/eval-rules`，见设计文档第 13 章；此类评测需真实模型端点，不随 `bun test` 跑）。

**评测驱动规则迭代的标准作法**（实测于 2026-08-12/14，见设计文档 13.4、13.5）：改任何注入规则前必须走以下闭环，凭数据而非直觉：

1. **写场景集**（rule-based 判定，不用 LLM judge）：每个关键规则一个场景，`userTurn` 是对应触发语，判定断言「模型应调用哪个工具 + 哪些参数谓词」（如 approve 时 `developer_confirmed` 必须 true）。状态夹具直接构造（不跑真实工具循环），隔离「规则遵循度」与「工具机制」两个变量；baseline 与 new 共用同一夹具保证可对等比较。
2. **冻结基线**：跑 `--variant baseline` 记录通过率快照（结果 json 入库 + 必要时冻结旧规则全文，可复现旧注入格式）；`--dry` 只打印注入片段与判定期望，不调模型，先验证渲染。
3. **改规则/脚本**：一次只改一处，避免多变量无法归因。
4. **对比**：跑 `--variant new` 自动对比 baseline，通过率不降才保留改动。
5. **逐个归因失败场景**：按「规则措辞 / 判定口径 / 场景二义性」三类归因——优先调**脚本适配与判定口径**，其次修场景，**规则文本保持简洁**（弱模型对复杂措辞极敏感，为提升某模型把规则写细实测反而伤害弱模型）；多模型验证（本地弱模型 + 远端强模型），避免过拟合单一模型。
6. **`--repeat N` 多次取通过率**（聚合按运行次数统计），防单次抖动掩盖趋势。

**项目中可参考的实例**（`opencode-session-mgmt` 为完整落地，新插件可照抄骨架）：

| 步骤 | 参考文件/示例 |
|------|--------------|
| 场景集 | `opencode-session-mgmt/scripts/eval-rules/src/scenarios.ts`（46 场景：sdlc s1-s22 + reqdoc r1-r24，每场景 = name + workflowType + 状态夹具 state + userTurn + judge）；judge 形态见 `src/types.ts`——行为类 `tool`/`no_tool`/`text`（sdlc 与 reqdoc 共用），产出类 `score`/`render`（reqdoc 专属，五维打分与渲染 diff，见 `opencode-session-mgmt/docs/workflow-reqdoc.md` 10 章） |
| 工具契约同步 | `opencode-session-mgmt/scripts/eval-rules/src/tool-defs.ts`——评测用精简工具定义须与插件真实工具 description/参数名一致（改插件工具时同步改这里，否则测的不是真实契约）；跨插件工具（如 open-ide 的 `open_ide`/`unlock_file`）也在此声明 |
| 状态夹具 | `scenarios.ts` 顶部辅助：`enter`/`approve`/`addSegment`/`rejectSegment`/`finish()`（按阶段重算 commit）——直接构造 WorkflowState，不跑真实工具循环 |
| 运行入口 | `opencode-session-mgmt/scripts/eval-rules/run.ts`（`--variant baseline\|new`、`--repeat N`、`--dry`；环境变量 `EVAL_BASE_URL`/`EVAL_MODEL`/`EVAL_API_KEY`） |
| 冻结快照 | `opencode-session-mgmt/scripts/eval-rules/fixtures/baseline/`（旧规则全文）+ `results/{baseline,new}.json`（通过率快照入库，可重跑对比） |
| 模型适配 | `opencode-session-mgmt/scripts/eval-rules/src/client.ts`（content 空回退 `reasoning_content`、`max_tokens` 可配、超时/重试） |
| 判定口径适配 | `opencode-session-mgmt/scripts/eval-rules/src/judge.ts`（如 s5 放宽为「≥1 次 confirm + `distinctArg` 不重复」） |
| 方法论文档 | `opencode-session-mgmt/docs/session-management.md` 第 13 章（运行/场景集/判定/实测记录/教训） |

沉淀的实践要点：

- **规则文本保持简洁，改前必须数据驱动 + 多模型验证**：弱模型对复杂措辞极敏感——为提升某模型而把规则写细（如补「须调用 X 工具」「逐段各调用一次」）实测反而伤害弱模型（不再调工具、要点 id 错填）。为特定模型（如推理模型）提升应优先走**脚本适配与判定口径**，而非规则膨胀。
- **评测脚本对推理模型的适配**：`msg.content` 为空时回退 `reasoning_content`（推理模型正文可能在 thinking，`text` 类判定读不到 content）；输出上限用 `EVAL_MAX_TOKENS` 可配——推理模型显式 4096 留 thinking 空间，**慢速弱模型（本地 qwen3.6 实测 ~16 tok/s）默认 2048**，4096 会让长生成场景拖到超时。
- **评测请求须带超时 + 重试**：弱/推理模型单请求可达数十秒、vLLM 排队时更久；`client.ts` 用 `EVAL_TIMEOUT_MS`（默认 180s）+ 网络/超时错误重试 3 次（HTTP 4xx/5xx 不重试），否则偶发超时会中断整轮评测（曾丢 25 分钟全量结果）。
- **新增场景的 userTurn 须与规则前提一致**：场景输入要先满足规则触发条件再期望动作——s20 曾用未指明文件的发言却期望模型杜撰 `file` 调 `open_ide`（规则要求「先询问要改哪个文件」），两模型均失败；改为 userTurn 明确 `auth/service.ts` 后通过。
- **判定口径适配模型能力**：`exactCount`（恰 N 次）对单轮单发 tool_call 的推理模型过苛，可放宽为「≥1 次 + `distinctArg` 不重复」，反映能力基线而非单次抖动。
- **场景 userTurn 避免二义性**：发言词不要同时是阶段名与要点 id（如「边界这块」既像 edge 阶段又像要点 id「边界策略」），否则强模型可能误走 `workflow_revisit`。
- **hoisted 拷贝残留影响评测**：评测脚本经 `opencode-session-mgmt/node_modules/sm-shared` 解析共享包，`node-linker=hoisted` 下它是真实拷贝；修改 `opencode-session-mgmt/packages/shared` 后须删除 `opencode-session-mgmt/node_modules/sm-shared` 并 `bun install` 重同步，否则评测读到旧规则文本（`typecheck`/`bun test` 仍全绿，易漏）。

---

## 10. 编码与文档风格

- TypeScript strict，禁止 `any`；代码风格遵循仓内约定：无分号、双引号（由根 prettier 管理）。
- 文件命名：文件 kebab-case，DB 字段 snake_case，类型 PascalCase。
- 魔法数字应提为具名常量并注明出处；复杂正则与边界逻辑必须注释设计取舍。
- 源文件顶部应注一行注释，标注对应设计文档章节；实现变更时同步更新设计文档与流程图。
- 文档、注释与 commit 使用中文；禁止使用 `§` 符号（使用“第 3.4 节”或裸编号）。commit 遵循 conventional commits（例如 `feat(plugin): ...`、`fix(plugin): ...`、`docs(...): ...`）。
- **用户可编辑的 JSON 配置含文件路径时，文档必须要求正斜杠 `/` 或双反斜杠 `\\`**：JSON 里 `\` 是转义符——`\P` 等非法转义导致解析失败（回退默认但用户不明所以）；更隐蔽的是 `\b`/`\n`/`\t` 是**合法**转义，`"C:\bin\..."` 会被静默转成控制字符，路径错但 JSON 解析"成功"。文档示例与代码侧解析失败的 warning 都要点出这个诱因（先例 open-ide 的 `config.json`，见其 `src/config.ts`）。
- **配置文档示例须显式标注字段语义**（覆盖 / 新增 / 缺省用默认），避免用户误以为所有项都要写全才生效（先例 open-ide `tools` 示例标注「cursor=新增、idea=覆盖」）。

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
- **源码目录拷贝用 `cp -rL` 解引用符号链接**：普通 `cp -r` 会保留符号链接本身，若源码树内有人 `ln -s` 共享文件（如 AGENTS.md → CLAUDE.md），解压后链接目标缺失即断链。`-L` 把链接跟随为真实文件进包。打包后应 `find "$bundle_dir" -type l` 检查（排除 node_modules/.bin 的命令 shim）确认无残留（先例 `opencode-session-mgmt` 的 `pack-bundle.sh`）。
- 打包脚本应完成：清旧依赖 → hoisted 重装 → 组装含 node_modules 的目录 → 附带 setup.sh / setup.ps1 / setup.cmd（内网纯 cmd 用）的环境校验与离线依赖种子（见 11.1）。setup.cmd 的源文件为 `opencode-session-mgmt/scripts/templates/setup.cmd`（LF 行尾），打包时拷入并转 CRLF。**setup.cmd 内部消息必须保持纯 ASCII（英文）**：cmd 批处理按活动控制台代码页（中文系统为 GBK/CP936）解析，UTF-8 中文在 rem/echo 行会被拆错并当作命令执行（报「不是内部或外部命令」）；曾因此踩坑，勿改回中文。
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
8. 改动 `opencode-session-mgmt/packages/shared`（契约）后重装 workspace 依赖（`rm -rf node_modules/<共享包> && bun install`），确认测试与评测脚本读到最新契约而非 hoisted 旧拷贝。
9. 改动注入规则/提示词文本时，按第 9 章「评测驱动规则迭代标准作法」跑基线对比（改前 baseline → 改后 new → 通过率不降才合并），不得凭直觉改规则。

---

附录（建议放在 plugin-guide/plugin-examples/）
- 插件骨架代码模板（可直接复制）
- Store 内存实现示例
- MIGRATIONS 模板与示例
- tool.schema（zod）参数示例
- 简单的合并前自检脚本（bash / ps1）
