# 插件加载排查与日志

版本: 1.0.0
最后更新: 2026-10-23
适用范围: 使用本仓构建的 opencode 加载 server 插件（Hooks）与 TUI 插件时的排查。

说明
- 本文是插件加载日志与排查路径的**单一事实源**；`plugin-dev-guide.md` 第 7 章只保留指针。
- 日志实现位于 `packages/opencode/src/plugin/loader.ts`、`packages/opencode/src/plugin/index.ts`、`packages/opencode/src/plugin/tui/runtime.ts`。
- 日志**只记录插件配置项的 key，不记录 value**，避免 API key 等敏感信息落盘。

---

## 1. 日志落点与开关

| 类型 | 日志文件 | 说明 |
|------|----------|------|
| server 插件 | `~/.local/share/opencode/log/opencode.log`（默认路径） | Effect 结构化日志，随主进程写入 |
| TUI 插件 | `~/.local/share/opencode/log/tui-plugin.log`（默认路径） | JSONL，每行一条；TUI 备用屏幕下 stderr 不可见，必须看此文件 |
| 终端镜像 | stderr | 加 `--print-logs` 后 server 日志同时输出到 stderr |

日志目录位置随平台变化，统一用 `opencode debug paths` 查看（关注 `log` 一行）。

开关：

```bash
# 输出 DEBUG 级别的加载链路（start / resolved / summary 等）
OPENCODE_LOG_LEVEL=DEBUG opencode --print-logs

# 仅写文件、不打印到终端
OPENCODE_LOG_LEVEL=DEBUG opencode

# 禁用全部外部插件，用于隔离“是否插件导致”
opencode --pure
```

- 默认级别为 `INFO`：该级别下 `ERROR` / `WARN` 会记录，`DEBUG` 链路日志需显式开启。
- `--pure` 等价于 `OPENCODE_PURE=1`；会记录 `plugin.load.disabled`（server）或 `tui plugin load disabled`（TUI）。
- server 插件在应用 Hook 前会等待依赖安装；日志中先出现 `plugin.dependencies.wait`，完成后再出现 `plugin.dependencies.ready`。

---

## 2. server 插件日志事件

字段随阶段变化，可用字段包括 `spec`、`source`、`target`、`entry`、`package`、`version`、`optionKeys`、`retry`、`elapsedMs`，具体以各事件为准。

| 事件 | 级别 | 关键字段 | 含义 |
|------|------|----------|------|
| `plugin.dependencies.wait` / `plugin.dependencies.ready` | DEBUG | `count` | 开始/结束等待插件 SDK 依赖安装 |
| `plugin.load.disabled` | DEBUG | `reason`, `configured` | 因 `--pure` 跳过外部插件 |
| `plugin.internal.disabled` | DEBUG | `reason` | 内置插件被 `disableDefaultPlugins` 关闭 |
| `plugin.load.start` | DEBUG | `spec`, `optionKeys`, `deprecated`, `retry` | 单次加载尝试开始（重试会再次出现） |
| `plugin.load.skip` | DEBUG | `spec`, `reason` | 主动跳过；目前 `reason` 为 `deprecated` |
| `plugin.load.resolved` | DEBUG | `source`, `target`, `entry`, `package`, `version`, `elapsedMs` | 完成安装/入口解析并成功 import 模块 |
| `plugin.load.missing` | WARN | `target`, `message`, `elapsedMs` | 包存在但没有 server 入口 |
| `plugin.load.failed` | ERROR | `stage`, `message`, `error.type`, `error.message`, `error.stack`, `error.cause`, `elapsedMs` | 加载失败；`stage` 为 `install` / `entry` / `compatibility` / `load` |
| `plugin.load.summary` | DEBUG | `configured`, `loaded`, `skipped`, `missing`, `failed` | 本轮加载汇总 |
| `plugin.applied` | DEBUG | `spec`, `id`, `hooks` | 插件工厂执行成功，列出注册的 Hook 名 |
| `plugin hook failed` | ERROR | `hook`, `index`, `error` | 某个 Hook 执行失败（保留原失败语义） |
| `plugin event hook failed` | ERROR | `event`, `error` | `event` Hook 异步失败 |
| `failed to load plugin` | ERROR | `path`, `target`, `error` | 模块已 import，但插件工厂/导出校验失败 |

已有日志：`failed to load internal plugin`、`plugin config hook failed`、`plugin dispose hook failed`。

---

## 3. TUI 插件日志事件

`tui-plugin.log` 为 JSONL，公共字段 `timestamp`、`level`、`message`，其余字段随事件变化。

| 事件 | 级别 | 关键字段 | 含义 |
|------|------|----------|------|
| `tui plugin load disabled` | DEBUG | `reason`, `configured` | 因 `OPENCODE_PURE` 跳过外部 TUI 插件 |
| `tui plugin load start` | DEBUG | `spec`, `scope`, `config`, `retry` | 单次加载尝试开始 |
| `tui plugin skipped` | DEBUG | `spec`, `reason` | 主动跳过（如 deprecated） |
| `tui plugin resolved` | DEBUG | `source`, `target`, `entry`, `package`, `version`, `elapsedMs` | 入口解析并 import 成功 |
| `tui plugin ready` | DEBUG | `id`, `target`, `entry`, `themes` | 插件模块校验通过、准备注册 |
| `tui plugin theme-only package` | DEBUG | `id`, `target`, `themes` | 仅提供主题、没有代码入口 |
| `tui plugin has no entrypoint` | WARN | `spec`, `target`, `message`, `elapsedMs` | 包存在但没有 tui 入口 |
| `failed to resolve tui plugin` | ERROR | `spec`, `error`, `elapsedMs` | 安装/解析阶段失败；看 `error.stack` |
| `tui plugin incompatible` | ERROR | `spec`, `error` | `engines.opencode` 不满足 |
| `failed to resolve tui plugin entry` | ERROR | `spec`, `target`, `error` | 入口解析失败（如越出插件目录） |
| `failed to load tui plugin` | ERROR | `spec`, `target`, `error` | 模块形状错误或 import/执行失败 |
| `tui plugin dependency wait failed` | WARN | `error` | 等待 TUI 插件依赖安装失败（不再静默吞掉） |
| `tui plugin load summary` | DEBUG | `directory`, `configured`, `external`, `total`, `active` | 启动加载汇总 |
| `failed to load tui plugins` | ERROR | `directory`, `error` | 整体初始化异常 |

---

## 4. 典型故障排查路径

### 4.1 安装/网络阶段失败

现象：启动慢、插件不生效，`plugin.load.failed` 的 `stage` 为 `install`，或只有 `plugin.dependencies.wait` 没有 `ready`。

- 查 `plugin.load.failed` 的 `error.message` / `error.stack`，确认是 registry 不可达、版本不存在还是权限问题。
- 内网/离线环境先按 `plugin-dev-guide.md` 11.1 预填 `node_modules` 与 `package-lock.json`，避免联网 reify。
- 关注 `background dependency install failed`；它说明 SDK 依赖安装超时，不一定是插件本身的问题。

### 4.2 找不到入口 / 兼容性不满足

- `stage=entry`：核对 `package.json` 的 `exports["./server"]`（或 `main`）；file 插件还需目录内 `index.ts` / `index.js`。
- `stage=compatibility`：日志会带 `Plugin requires opencode <range> but running <version>`，升级插件或调整 `engines.opencode`。
- 只有 `plugin.load.missing`：包本身正常，但未声明对应 `server` / `tui` 入口；TUI 包可以仅提供 `oc-themes`。
- `plugin.load.skip` + `reason=deprecated`：旧包名已被内置实现取代，不是故障。

### 4.3 import / 运行时异常

- `stage=load` 且 `error.stack` 指向插件入口：优先检查顶层副作用（浏览器 API、原生绑定、缺失依赖）。
- 依赖浏览器 API 的库必须在插件内**动态 import**，不要顶层静态 import；参考 `plugin-dev-guide.md` 第 7 章。
- **Bun 会缓存失败的动态 import**：修复代码或重装依赖后，必须重启 opencode / TUI 进程再验证，不要只重新触发加载。

### 4.4 加载成功但 Hook 不生效

- 先确认有 `plugin.load.resolved`，再确认有 `plugin.applied`，且 `hooks` 数组包含预期 Hook 名。
- 有 `plugin.applied` 但 Hook 名缺失：检查插件导出形状与 Hook 名称拼写。
- 运行期报错看 `plugin hook failed` / `plugin event hook failed`；日志会带 Hook 名与错误栈。
- 配置类 Hook 失败看 `plugin config hook failed`；卸载清理失败看 `plugin dispose hook failed`。

### 4.5 TUI 内看不到报错

- 直接看 `tui-plugin.log`，不要依赖终端 stderr。
- 正常链路：`tui plugin load start` → `tui plugin resolved` → `tui plugin ready` → `tui plugin load summary`。
- 失败时按 `failed to resolve*` / `failed to load tui plugin` 的 `error.stack` 定位；`tui plugin load summary` 中 `external` 与 `total` 对不上说明部分插件未注册成功。

---

## 5. 常用命令

```bash
# 定位日志目录（跨平台）
opencode debug paths

# 开启 DEBUG 并镜像到终端
OPENCODE_LOG_LEVEL=DEBUG opencode --print-logs

# 实时查看
tail -f ~/.local/share/opencode/log/opencode.log
tail -f ~/.local/share/opencode/log/tui-plugin.log

# 只看 TUI 插件错误
jq 'select(.level == "ERROR")' ~/.local/share/opencode/log/tui-plugin.log

# 隔离外部插件
opencode --pure

# 查看当前配置声明的插件
opencode debug info
```

Windows PowerShell 下可用 `Get-Content -Wait` 替代 `tail -f`。

---

## 6. 注意事项

- 日志中的 `optionKeys` 只有键名；排查时不要为了“看清配置”把 value 加进日志。
- `ERROR` / `WARN` 日志可能包含本地路径；对外提交 issue 或日志前先脱敏。
- 加载失败只在当次进程内有效：修复后必须重启进程，尤其是 `stage=load` 的失败（Bun 模块缓存）。
- `--pure` 用于二分定位；确认是插件问题后再逐个启用插件复现。
- 升级 opencode 后如何复查本地日志补丁、插件 SDK 版本和离线构建开关，见 `opencode-upgrade-checklist.md`。
- 如果日志里完全没有对应插件的任何事件，先确认 `opencode.json` / `tui.json` 是否在生效目录、是否被更高优先级配置覆盖；再看 `plugin.load.summary` 的 `configured` 数量。
