# OpenCode 升级时的本地修改清单

版本: 1.0.0
最后更新: 2026-10-24
适用范围: 本仓 fork 从上游 OpenCode `vX.Y.Z` 升级到新版本时，需要复查、重放或删除的本地修改。

说明
- 本仓不是纯上游：为了插件加载排查、离线构建和三个自定义插件兼容性，对 `packages/*` 做了少量本地修改。
- 本文是「升级时本地需要改什么」的**单一事实源**。升级前先读，升级后逐项勾选。
- 本文只记录上游代码补丁、随版本必须同步的插件依赖与验证；插件业务设计仍以各工程 `docs/` 为准。
- 本仓日常只同步 `origin`；只有明确要求「同步上游」时才按 `opencode-session-mgmt/docs/upstream-sync.md` 拉取上游。

---

## 1. 升级前冻结基线

先记录当前已知可用状态，避免升级后无法对比：

```bash
git status --short
git log --oneline -10
git log --oneline <当前上游tag>..HEAD -- packages packages/core packages/opencode
git diff <当前上游tag>..HEAD -- packages packages/core packages/opencode > /tmp/opencode-local-patches.diff
```

同时备份：

- 当前 Windows `opencode.exe`（普通版和离线版，如果已构建）。
- 当前三个插件 bundle 的 `node_modules/@opencode-ai/plugin` 版本。
- 当前 `opencode-session-mgmt`、`opencode-edge-debug`、`opencode-server-debug` 的锁文件。

升级前先跑一遍基线（命令见第 5 章），确认失败不是升级引入的。

---

## 2. 本地改动总表

| 类别 | 本地文件 | 作用 | 升级时检查 | 可删除条件 |
|------|----------|------|------------|------------|
| 插件加载诊断日志 | `packages/opencode/src/plugin/index.ts`、`loader.ts`、`tui/runtime.ts`；`plugin-guide/plugin-loading-debug.md` | 补齐 server/TUI 插件加载事件、依赖等待和失败日志 | 上游是否已提供等价日志；事件名、字段、日志路径是否仍一致 | 上游已合并等价能力后删除本地补丁，并更新排查文档 |
| legacy 插件 hooks 统计修复 | `packages/opencode/src/plugin/index.ts` 的 `applyPlugin` legacy 分支 | 统计插件实际返回的 Hook 对象，修正 `plugin.applied hooks=[]` | 上游 legacy loader 是否已修复；本地插件 Hook 是否仍为空 | 上游已修复后删除本地修改 |
| 离线构建开关 | `packages/core/src/installation/version.ts`、`packages/core/src/flag/flag.ts`、`packages/opencode/src/config/config.ts`、`packages/opencode/src/config/tui.ts`、`packages/opencode/script/build.ts`、`packages/opencode/test/config/config.test.ts` | `--offline` 构建默认跳过 `@opencode-ai/plugin` 自动安装，支持内网离线包 | 上游是否新增配置目录安装点；两个 install 调用是否仍存在；`OPENCODE_OFFLINE_BUILD` 是否仍被注入 | 上游原生支持离线/跳过安装后删除本地补丁 |
| 项目工具加载容错 | `packages/opencode/src/tool/registry.ts`、`packages/opencode/test/tool/registry.test.ts` | 项目 `.opencode/tool` 依赖解析失败时记录 `tool.load.failed` 并跳过该工具，不再拖垮整个工具注册表与会话 | 上游是否已改为单个工具导入失败非致命；`tool.load.failed` 是否仍存在；回归测试是否仍覆盖缺失依赖工具 | 上游已提供等价容错后删除本地修改与测试 |
| 自定义插件 SDK 版本 | 三个插件的 `package.json` 与 `bun.lock` | `@opencode-ai/plugin`、`@opencode-ai/sdk` 与 opencode 二进制版本对齐 | 按新版本统一升级 devDependencies；lockfile 重装 | 不删除，每次升级都要同步 |
| session 工具按工作流注册 | `opencode-session-mgmt/packages/plugin/src/index.ts`、`src/tools/toolset.ts`、`test/toolset.test.ts` | sdlc 只注册 17 个工具；reqdoc 注册 28 个 | `Plugin`/`Hooks`/`ToolDefinition` 签名是否变化；工具数是否仍符合预期 | 不删除，属于定制功能 |
| Windows 插件加载实测 | `.opencode/skills/verify-windows-plugin-load/` | 校验 3 个插件加载、Hook、工具数和注册表一致性 | `EXPECT_VERSION`、示例工具数、`EXPECT_NO_PLUGIN_INSTALL` 是否需更新 | 不删除，作为升级后的固定验收 |
| Windows bundle 同步 | 三个插件的 `scripts/sync-bundle.sh` | 把源码同步到 Windows bundle 的 `packages/*` 与 `node_modules/*` | 目标路径是否变化；同步后是否需要在 Windows 侧重装依赖 | 不删除，每次升级/改插件后执行 |

---

## 3. 升级步骤

### 3.1 合并上游

```bash
git fetch upstream --tags
git merge <新上游tag>
```

只解决冲突，不顺手重构。冲突优先按本文第 4 章逐项恢复本地语义。

### 3.2 重放/核对本地补丁

重点搜索以下标记，确认上游变更后仍存在且行为正确：

```bash
git grep -n "OPENCODE_OFFLINE_BUILD\|InstallationOffline\|OPENCODE_DISABLE_PLUGIN_INSTALL" -- packages
git grep -n "npmSvc.install\|npm\.install" -- packages/opencode/src/config
git grep -n "plugin.load.summary\|plugin.applied\|plugin.dependencies" -- packages/opencode/src/plugin
git grep -n "tool.load.failed" -- packages/opencode/src/tool
git grep -n "createToolset\|EXPECT_NO_PLUGIN_INSTALL" -- opencode-session-mgmt .opencode/skills
```

如果上游新增了配置目录安装点，必须把离线开关同样包进去；否则离线包只会在新路径上继续报警。

### 3.3 升级三个插件的 SDK 依赖

把三个工程的 `devDependencies` 改成新版本：

- `opencode-session-mgmt/packages/plugin/package.json`：`@opencode-ai/plugin`、`@opencode-ai/sdk`
- `opencode-edge-debug/package.json`：`@opencode-ai/plugin`、`@opencode-ai/sdk`
- `opencode-server-debug/package.json`：`@opencode-ai/plugin`

然后在各工程执行 `bun install` 更新锁文件。不要手改 `bun.lock` 的版本号。

### 3.4 构建与同步

1. 用现有 Windows 构建流程构建普通 `opencode.exe`，确认 `--version` 等于新版本。
2. 需要离线包时，用同一构建流程加 `--offline`；确认二进制在无 npm 缓存环境不出现 `background dependency install failed`。
3. 备份旧二进制，替换 Windows runtime 中的 `opencode.exe`。
4. 同步三个插件 bundle：

```bash
bash opencode-session-mgmt/scripts/sync-bundle.sh
bash opencode-edge-debug/scripts/sync-bundle.sh
bash opencode-server-debug/scripts/sync-bundle.sh
```

如果实际运行的是另一个 runtime（例如 `C:\Users\...\OpenCode\runtime`），用 `BUNDLE=` 指向实际 bundle，不要只同步 `D:\Tools\...`。

5. 依赖版本变化时，在 Windows 侧对 bundle 执行 `bun install`，并确认 `node_modules/@opencode-ai/plugin` 版本正确。
6. 重启 Windows 侧 opencode 守护进程；只同步不重启不会加载新代码。

### 3.5 更新验证基线

- 把 `.opencode/skills/verify-windows-plugin-load/scripts/verify.sh` 的默认 `EXPECT_VERSION` 更新为新版本。
- 如果工具集变化，更新 `SKILL.md` 的示例数字；实际数量以脚本输出为准。
- 离线构建验证时使用 `EXPECT_NO_PLUGIN_INSTALL=1`。

---

## 4. 逐项检查

### 4.1 插件加载诊断日志

本地文件：

- `packages/opencode/src/plugin/index.ts`
- `packages/opencode/src/plugin/loader.ts`
- `packages/opencode/src/plugin/tui/runtime.ts`
- `plugin-guide/plugin-loading-debug.md`

升级时检查：

1. `plugin.load.start`、`plugin.load.resolved`、`plugin.load.summary`、`plugin.applied`、`plugin.load.failed` 等事件是否仍存在。
2. `plugin.applied` 是否仍输出 `hooks`，legacy 插件是否按实际返回对象统计。
3. TUI 日志事件是否仍写入 `tui-plugin.log`，字段是否与排查文档一致。
4. 上游是否已提供等价日志；若已提供，删除本地补丁并更新 `plugin-loading-debug.md`，避免两份事实源。

常见冲突：上游重写 `PluginLoader` 或 `applyPlugin` 后，本地日志代码可能整段消失。合并后至少保留 `plugin.load.summary` 与 `plugin.applied`，并用日志实测确认 3 个插件都能看到。

### 4.2 legacy 插件 hooks 统计修复

文件：`packages/opencode/src/plugin/index.ts` 的 `applyPlugin` legacy 分支。

正确语义：

```ts
const applied: Hooks[] = []
for (const server of legacy) {
  const hook = await server(input, load.options)
  hooks.push(hook)
  applied.push(hook)
}
return { id: undefined, hooks: applied.flatMap((hook) => Object.keys(hook ?? {})) }
```

升级时检查：

- 上游是否已经改成统计返回的 Hook 对象；如果已修复，删除本地修改。
- 是否又变回对插件函数本身取 `Object.keys`；如果是，重新应用修复并补测试/日志验证。
- 验证方式：启动 Windows smoke，确认 `plugin.applied` 的 `hooks` 非空，而不是 `hooks=[]`。

### 4.3 离线构建开关

涉及文件：

- `packages/core/src/installation/version.ts`：`OPENCODE_OFFLINE_BUILD`、`InstallationOffline`
- `packages/core/src/flag/flag.ts`：`OPENCODE_DISABLE_PLUGIN_INSTALL`
- `packages/opencode/src/config/config.ts`：server 配置目录安装块
- `packages/opencode/src/config/tui.ts`：TUI 配置目录安装块
- `packages/opencode/script/build.ts`：`--offline` 构建标记
- `packages/opencode/test/config/config.test.ts`：跳过/不跳过成对测试

升级时检查：

1. `git grep -n "npmSvc.install\|npm\\.install" -- packages/opencode/src/config` 是否仍只有已知调用点；新调用点也要用 `Flag.OPENCODE_DISABLE_PLUGIN_INSTALL` 包住。
2. `config.ts` 与 `tui.ts` 的安装块是否都被条件包裹。
3. `build.ts` 是否仍把 `OPENCODE_OFFLINE_BUILD` 注入 `Bun.build` 的 `define`。
4. 离线构建是否仍默认 `InstallationOffline=true`；环境变量 `OPENCODE_DISABLE_PLUGIN_INSTALL=1` 是否仍可作为普通构建的测试/应急开关。
5. 成对测试是否仍覆盖「设置开关不安装」与「未设置开关会安装」。

离线构建命令：

```bash
OPENCODE_VERSION=<新版本> bun run build --single --offline
```

在 Windows 上使用 `--single`；从 WSL 构建 Windows 目标时，沿用现有 Windows target 过滤流程，并传入 `--offline`。

行为边界：

- 离线构建不再为全局、项目 `.opencode`、`OPENCODE_CONFIG_DIR` 安装 `@opencode-ai/plugin`。
- 三个 bundle 插件自带依赖，不受影响。
- 项目级 `.opencode/plugin` 如 import `@opencode-ai/plugin`，需要自带依赖；升级后若新增此类插件，必须重新评估是否需要普通构建或手工预置依赖。
- `plugin-dev-guide.md` 11.1 的 seed/package-lock 方案仍可作为普通构建或项目级插件的补充手段。

### 4.4 自定义插件 SDK 依赖

升级后三个插件的 `@opencode-ai/plugin` 必须与新二进制主版本一致，否则可能出现 Hook 类型或运行时行为不一致。

检查：

```bash
node -e 'console.log(require("./opencode-session-mgmt/node_modules/@opencode-ai/plugin/package.json").version)'
node -e 'console.log(require("./opencode-edge-debug/node_modules/@opencode-ai/plugin/package.json").version)'
node -e 'console.log(require("./opencode-server-debug/node_modules/@opencode-ai/plugin/package.json").version)'
```

Windows bundle 侧也要检查：

```text
<bundle>/node_modules/@opencode-ai/plugin/package.json
```

版本不对时先重装依赖，再同步 bundle，不要只改 `package.json` 不更新 `node_modules`。

### 4.5 session 工具按工作流注册

涉及文件：

- `opencode-session-mgmt/packages/plugin/src/index.ts`
- `opencode-session-mgmt/packages/plugin/src/tools/toolset.ts`
- `opencode-session-mgmt/packages/plugin/test/toolset.test.ts`

升级时检查：

1. `Plugin`、`Hooks`、`ToolDefinition`、`tool` 的类型是否变化。
2. `createToolset` 的 sdlc/reqdoc 分支是否仍返回预期工具数：sdlc 17、reqdoc 28。
3. 入口文件 `src/index.ts` 是否仍只有 default export；新增辅助函数不要直接 export 到入口文件，否则 legacy loader 会把它们当插件工厂。
4. 运行 `bun test test/toolset.test.ts`，确认 sdlc 不含 `reqdoc_*`，reqdoc 不含 `commit_gate_check` / `commit_force_unlock`。

### 4.6 Windows bundle 与验证技能

升级后固定执行：

```bash
VERBOSE=1 EXPECT_NO_PLUGIN_INSTALL=1 \
bash .opencode/skills/verify-windows-plugin-load/scripts/verify.sh
```

预期（以当前 1.19.4 基线为例）：

```text
OK sm-plugin tools=17 registered=17
OK edge-debug tools=8 registered=8
OK server-debug tools=7 registered=7
OK binary=1.19.4 configured=3 loaded=3 tools=32 failed=0
```

普通构建对照实验应能看到 `background dependency install failed`；离线构建不应出现。若普通构建也没有警告，说明缓存或 `.npmrc` 状态变了，不代表离线开关生效，需先清理对照组环境。

### 4.7 项目工具加载容错

涉及文件：

- `packages/opencode/src/tool/registry.ts`
- `packages/opencode/test/tool/registry.test.ts`

背景：离线构建按设计不为配置目录安装 `@opencode-ai/plugin`，三个 bundle 插件自带依赖不受影响。但项目自带的 `.opencode/tool/*.ts` 如果 `import "@opencode-ai/plugin"`，离线环境下会解析失败。旧行为会让整个 `ToolRegistry` 报错，导致会话不可用。

本地修复：单个工具文件导入失败时记录 `tool.load.failed` 警告并跳过，同目录其他工具和内置工具继续注册。

升级时检查：

1. `registry.ts` 中项目工具导入是否仍使用 `Effect.tryPromise` + `Effect.catchCause` 容错；上游若改成其他写法，确认失败不会向上抛出。
2. `tool.load.failed` 日志是否保留 `file` 与 `cause` 字段，便于定位缺失依赖。
3. 运行 `bun test test/tool/registry.test.ts`（`packages/opencode`，Bun 1.4.4），确认缺失依赖工具被跳过、健康工具仍加载。
4. 不要用 `NODE_PATH`、Bun 全局目录或 `Bun.plugin` 运行时映射替代：编译后的 `opencode.exe` 均不生效，已在 1.19.4 实测排除。
5. 若某项目确实需要该工具可用，须由项目自带依赖（例如在 `.opencode` 下提供 `node_modules`），或改用普通构建；这是离线模式的既定边界。

---

## 5. 验证矩阵

| 检查 | 命令 | 期望 |
|------|------|------|
| 全仓类型检查 | `bun run typecheck`（仓库根，Bun 1.4.4） | 30/30 通过 |
| session 全量测试 | `bun test`（`opencode-session-mgmt` 根） | 全绿；当前基线 795 pass |
| edge 测试 | `bun test`（`opencode-edge-debug`） | 全绿；当前基线 52 pass |
| server 测试 | `bun test`（`opencode-server-debug`） | 全绿；当前基线 44 pass |
| 验收派生 | `bun run acceptance:derive`（session-mgmt） | 11/11 通过 |
| 评测 dry run | `bun run eval:dry`（session-mgmt） | 58 个场景正常输出 |
| Windows 普通构建 | `verify.sh` | 3/3 插件加载；允许安装 WARN |
| Windows 离线构建 | `EXPECT_NO_PLUGIN_INSTALL=1 verify.sh` | 3/3 插件加载；无安装 WARN |
| 工具注册表 | `VERBOSE=1 verify.sh` | 每个插件工具数等于 `registered` |
| 项目工具容错 | `bun test test/tool/registry.test.ts`（`packages/opencode`，Bun 1.4.4） | 16 pass；缺失依赖工具被跳过，健康工具仍加载 |

数字会随工具集/评测场景变化；升级后更新本文与验证技能里的示例数字，但不要把「当前基线」当成永久断言。

---

## 6. 常见冲突与处理

| 现象 | 处理 |
|------|------|
| 合并后 `config.ts` 安装块冲突 | 保留新上游逻辑，只在外面加 `if (!Flag.OPENCODE_DISABLE_PLUGIN_INSTALL)`；不要整段回退上游 |
| 上游重写 `PluginLoader`，本地日志消失 | 先保留上游新实现，再把 `plugin.load.summary` / `plugin.applied` 按新结构补回；更新排查文档 |
| `plugin.applied hooks=[]` 回归 | 检查 legacy 分支是否又对插件函数取 `Object.keys`，重新应用 hooks 统计修复 |
| 插件加载失败 `stage=install` | 先按 `plugin-loading-debug.md` 排查；离线包应使用离线构建，而不是继续依赖 npm cache |
| 插件加载失败 `stage=compatibility` | 三个插件的 `@opencode-ai/plugin` / `engines.opencode` 与新版本不匹配，升级依赖并重装 |
| Windows 侧看不到改动 | 检查是否只同步了 `D:\Tools` 而实际运行 `C:\Users\...\OpenCode\runtime`；用 `BUNDLE=` 指向真实 bundle |
| 离线包启动仍报警 | 确认二进制是 `--offline` 构建；用 `EXPECT_NO_PLUGIN_INSTALL=1` 验证；检查是否有新安装调用点未包裹 |
| 项目工具报 `Cannot find package '@opencode-ai/plugin'` | 离线构建按设计不装配置目录依赖；新版会记 `tool.load.failed` 并跳过该工具，不影响会话。要让该工具可用，需项目自带依赖或改用普通构建 |

---

## 7. 当前基线（1.19.4）

| 项目 | 值 |
|------|-----|
| 上游 tag | `v1.19.4` |
| 本地分支 | `dev` |
| 上游合并提交 | `70ab0ba33e` |
| 插件加载日志补丁 | `b1ee64fef4` |
| legacy hooks 统计修复 | `4e14dc9e80` |
| 三个插件依赖对齐 | `8251218f01` |
| session 工具按工作流注册 | `57760f35ec` |
| Windows 插件加载实测技能 | `a5078ca0a8` |
| 离线构建 | `--offline`，`InstallationOffline=true`，跳过配置目录的 `@opencode-ai/plugin` 安装 |
| 项目工具加载容错 | `packages/opencode/src/tool/registry.ts` 导入失败告警并跳过（本地工作树补丁） |
| 当前 sdlc 工具数 | sm 17 + edge 8 + server 7 = 32 |
| 当前 reqdoc 工具数 | sm 28 + edge 8 + server 7 = 43（Windows smoke 默认 sdlc） |

提交号只用于追溯当前基线；升级后不必强行复用旧提交号，按第 2 章重新记录。

---

## 8. 维护约定

1. 每次升级完成后，更新本文的「最后更新」、基线表和验证数字。
2. 新增任何对 `packages/*` 的本地修改，必须先在总表登记：文件、作用、升级检查方式、可删除条件。
3. 本地补丁被上游合并后，删除代码与总表对应行，并更新 `plugin-loading-debug.md` / `plugin-dev-guide.md` 的指针。
4. 升级验证结果优先写入本文或对应工程 docs，不只留在对话里。
