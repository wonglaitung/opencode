# OpenCode 插件开发规范

> 提炼自 opencode-session-mgmt 项目实践,适用于本仓库内任何新增 OpenCode 插件。
> 参照实现:`packages/plugin`(hook 注册 / 工具 / 门禁 / 存储)、`packages/shared`(契约包)。

## 1. 总则

1. **上游零修改**:不修改 `packages/*`(上游)下任何文件;插件全部代码收敛在自己的目录内,可整体删除。
2. **可插拔**:插件经 `opencode.json` 的 `"plugin"` 条目启用,移除条目即完全还原,上游行为不得有任何残留变化。
3. **最小依赖面**:只依赖上游两类公开接口——**Plugin Hook**(`@opencode-ai/plugin`)与 **session REST API**(经 `@opencode-ai/sdk`)。**禁止**读上游数据库、上游内部模块、上游登录账号。
4. **独立 workspace**:插件工程是独立 bun workspace,不得被上游根 `package.json` 的 workspace glob 收录;改动后须复查这一点。

## 2. 工程分层

```
src/index.ts        # 入口:只做组装——打开存储、装配依赖、注册 hooks、返回 handlers
src/<hook 适配层>.ts # 每个 hook 一个文件;experimental hook 的兼容逻辑集中于此
src/tools/*.ts      # 工具注册,按域分文件
src/<纯逻辑>.ts      # 状态转换/聚合等纯函数,不触碰存储,供工具复用与单测
src/db/             # 存储层:schema(迁移) + Store(类型化读写)
```

- **契约先行**:类型/payload 凡被两个以上消费方(插件、CLI、服务)使用,一律抽到 shared 契约包;契约变更必须多包同步,新增字段用可选字段保持向后兼容。
- 依赖注入用**闭包工厂**:`createXxx(store) → handler`,store 等依赖经闭包持有,不在模块顶层持有状态。

## 3. 插件骨架

```ts
const MyPlugin: Plugin = async (input) => {
  const store = Store.open(input.directory)   // input.directory = 项目目录
  // 启动副作用:void 触发 + 自身容错(如补推缓冲、惰性清理),不得阻塞/抛错
  return {
    "experimental.chat.system.transform": ...,
    tool: { ... },
    "tool.execute.before": ...,
    "tool.execute.after": ...,
    "chat.message": ...,
    dispose: async () => { /* 必须实现:清定时器、flush 未竟工作、store.close() */ },
  }
}
export default MyPlugin
```

- `@opencode-ai/plugin` 声明为 **peerDependency(`*`)**,devDependency 锁具体版本。
- 定时器、长任务必须在 `dispose` 中清理。

## 4. Hook 使用规范

| Hook | 约定 |
|------|------|
| `experimental.chat.system.transform` | 只向 `output.system.push()` **追加**,不得改写上游内容;注入内容 = 规则 + 从库中读到的实时状态(状态不依赖 LLM 记忆) |
| `tool.execute.before` | 硬拦截唯一手段是 `throw`;**未被插件追踪的会话一律放行**,宁漏勿错杀 |
| `tool.execute.after` | 只做观测/计数,不得阻断 |
| `chat.message` | 副作用必须幂等(如「仅当字段为空时写入」) |

- **experimental hook 风险隔离**:`experimental.*` hook 的签名适配集中在单独一个文件(参照 `prompt.ts`),上游同步后优先核对该文件即可,不散落各处。
- 识别上游工具名(如哪些是代码编辑工具)时,以注释记录依据的上游注册位置,上游升级后需复核。

## 5. 工具(tool)开发规范

- 用 `tool()` + `tool.schema`(zod)定义,每个 arg 必须 `.describe()`;工具名 snake_case。
- **校验在服务端强制,不信任 LLM**:关键前提(如「需开发者确认」)作为必填参数并校验取值,防绕过逻辑落在工具实现里,不能只写进 prompt 规则。
- **硬约束不依赖 LLM 自觉**:凡是「必须/禁止」类规则,prompt 注入之外必须有 hook 或工具层的机制兜底。
- 校验失败抛自定义 Error 子类(参照 `WorkflowOpError`),消息用中文写明**当前状态 + 修复路径**。
- 返回值是人类可读中文:**结果 + 下一步指引**(如门禁状态、未完成项)。
- **幂等**:语义重复的调用不报错(重复确认、重复提交审查均应安全)。
- **留痕不删除**:审计相关状态(如强制操作授权)标记 `used` 而非删除。

## 6. 数据存储规范

- 用 **bun:sqlite**,库文件放 `<项目>/.opencode/<插件名>.db`,开 WAL;统一 `?` 位置绑定。
- **迁移自管**:`MIGRATIONS: string[]` 只追加不修改,版本号记 meta 表;不与上游 schema 发生任何耦合。
- JSON 列存序列化状态时区分 raw(字符串)与 row(解析后)类型;复杂状态的更新区分两种语义:
  - 增量合并(对象递归合并、数组整体替换)——适合指标类字段;
  - 命令式读-改-写(`mutateWorkflow` 模式)——适合数组追加/计数。
- Store 必须提供 `Store.memory()`(内存库)供测试。

## 7. 健壮性与降级

- **静默降级**:身份/配置缺失 → 关闭对应功能但不影响其余功能;上游不可达 → 跳过本次操作。故障不得扩散。
- **远程上报必配 outbox**:服务不可用时写本地缓冲,启动补推 + 定时补推;**4xx 视为永久失败丢弃(留日志),5xx/网络错误保留重试**;同键去重防堆积。
- **删除/清理操作保守化**:拿不到确切列表时不清理,防瞬时不可达导致误删。
- **子进程副作用必须静默**:需 spawn 外部命令(定位浏览器、taskkill 强杀、which 探活等)时,一律用 `spawn`/`spawnSync` + `stdio:"ignore"`(或显式捕获 stderr)。**不要用 `execFileSync`/`execFileSync` 跑可能失败的命令**——实测它失败时会一并把子进程 stderr 泄漏打印到父进程 stderr,被 OpenCode 捕获后逐条显示在 TUI、盖住输入框。edge-debug 曾因此让 Windows `taskkill` 的 "ERROR: ... could not be terminated." 刷屏 TUI;成功路径的 stderr 同理丢弃。

## 8. 安全与隐私

- 任何离开本机的数据必须是**显式构造的白名单投影**:不含代码内容、不含文件路径(含路径的明细只存本机)。
- 涉及个人信息的字段最小化;配套服务仅内网部署,daemon 交互只走 `127.0.0.1`。

## 9. 测试规范

- `bun test`,测试放各包 `test/*.test.ts`;在插件目录内跑,不在仓库根跑。
- **测真实实现、零 mock**:存储用内存库,依赖经构造注入。
- 用例名用中文描述行为;每个硬约束(拦截、单次语义、上限)都要有正反两组用例。

## 10. 编码与文档风格

- TypeScript strict,零 `any`;无分号、双引号(根 prettier);文件 kebab-case,DB 字段 snake_case,类型 PascalCase。
- 魔法数字提为具名常量并注明出处;正则等易误伤逻辑必须注释边界取舍。
- **每个源文件头部注释标注对应设计文档章节**,实现前先读该章节;行为变更同步更新设计文档与流程图。
- 文档、注释、commit 用**中文**;禁用 `§` 符号(用「3.4 节」/裸编号);commit 遵循 conventional:`feat(plugin):`、`fix(plugin):`、`docs(...):`。

## 11. 打包与分发

两个插件已对齐统一的两层打包(参见各自工程根的 `scripts/pack-bundle.sh`):

- **`build:plugin`**:`bun build src/index.ts --outdir dist/plugin --target bun`——把插件编译成自包含 JS,屏蔽目标机 bun 版本差异。
- **`pack:bundle`**:`scripts/pack-bundle.sh`——打成可移植 tarball(`dist/<插件>-bundle-<版本>.tgz`),供内网/离线「解压即用」。要点:
  - 根目录必须有 `.npmrc`(`node-linker=hoisted`),否则 bun 默认 `isolated` 模式在 Windows 上使用硬链接,打包/移动后硬链接断裂、传递依赖丢失;
  - 脚本自动完成「清旧依赖 → hoisted 重装 → 组装含 node_modules 的目录 → 附带 setup.sh/setup.ps1 环境校验」;
  - **bundle 根直接可加载**:打包时给根 `package.json` 注入 `main` 指向插件入口(单插件工程为 `src/index.ts`,monorepo 为 `packages/plugin/src/index.ts`),opencode 直接指向解压目录即可,无需指到深层子目录,与 edge-debug 直接指根一致。

## 12. 验证清单(新插件合并前)

1. `bun test` 与 `bun run typecheck`(strict)全绿;
2. 启用插件跑通核心路径,**移除插件条目后上游行为完全还原**;
3. 依赖缺失场景(无配置/服务不可达)验证静默降级;
4. 确认未修改任何上游文件、未被上游 workspace glob 收录;
5. experimental hook 适配集中于单一文件。
