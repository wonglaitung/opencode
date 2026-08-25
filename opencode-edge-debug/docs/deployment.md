# 部署与使用手册

> 面向「完全没接触过 OpenCode 与本插件」的读者，从零讲到能用。
> 架构与决策记录见 [`design.md`](design.md)；本手册只讲**怎么装、怎么跑、怎么验、坏了怎么办**。
> 姊妹插件 `opencode-session-mgmt` 的部署手册见 [`../opencode-session-mgmt/docs/deployment.md`](../../opencode-session-mgmt/docs/deployment.md)，两者形式一致，本插件更简单——**只有一块，没有 CLI、没有收集服务**。

---

## 0. 先看懂全景：到底要装什么、装在哪

整套东西只有**一块**，全部落在**开发者自己的电脑**上：

```
┌───────────────────────────────  仅一台机器：开发者的电脑  ───────────────────────────────┐
│                                                                                        │
│  ① OpenCode 本体（上游，我们不修改）                                                      │
│     - opencode 命令 + TUI + 一个自动启动的本地 Daemon（只绑 127.0.0.1）                    │
│     - 需要一个「大模型提供方」（Anthropic/OpenAI，或内网自建模型网关）                        │
│                                                                                        │
│  ② edge-debug 插件（本工程）                                                             │
│     - 由 OpenCode 通过 opencode.json 的 plugin 配置加载，跑在 Daemon 进程内                 │
│     - 需要本机已装 Microsoft Edge；调试端口 9222（仅绑定 127.0.0.1）                        │
│                                                                                        │
│  ③ Microsoft Edge（本机浏览器，用来做调试目标）                                            │
│     - 插件用专用 profile 拉一个带调试端口的实例，与你日常浏览的数据完全隔离                    │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

**没有服务器要部署、没有跨机器组件**——这与 `opencode-session-mgmt`（插件 + CLI + 收集服务三件套）不同。你只需要在自己的机器上装好 OpenCode、启用插件、装好 Edge。

**依赖互联网的部分只有两处**：① OpenCode 本体的安装、② 插件开发依赖的 `bun install`。插件**运行期零依赖**——CDP 客户端用 bun 原生 WebSocket + fetch 实现，不引入 Playwright/Puppeteer 等任何运行时依赖；装好之后插件代码本身完全不需要外网。内网隔离环境怎么把这两处搬进去，见第 8 章。

---

## 1. 前置条件

| 工具 | 用途 | 检查命令 | 说明 |
|------|------|----------|------|
| **bun** ≥ 1.1 | OpenCode 本体运行在 bun 上，插件也由 bun 直接跑 TS | `bun --version` | 若你的 OpenCode 桌面版/二进制自带运行时，取决于其封装方式；从源码跑插件需 PATH 里有 bun |
| **OpenCode** | 宿主，加载插件 | `opencode --version` | 安装见 2.1，与本插件无关的上游工具 |
| **Microsoft Edge** | 调试目标浏览器 | linux 下 `which microsoft-edge`；macOS 看 `/Applications/Microsoft Edge.app` | 插件需本机已装；linux 需 `microsoft-edge` / `microsoft-edge-stable` / `microsoft-edge-dev` 任一在 PATH 中 |
| **端口 9222** | 调试端口 | `ss -ltn \| grep 9222`（应无输出） | 未占用即正常；若已被其他调试实例占用，插件会直接**复用**该实例（见 6 节 FAQ） |

> Windows 用户：建议在 WSL2（Ubuntu）里操作，命令与 Linux 一致。Edge 在 WSL2 里可用原生 Linux 版（`microsoft-edge-*`），或经 WSLg 跑 Windows 版——以你能在 WSL 里调起 `microsoft-edge` 为准。

---

## 2. 第一步：安装并跑通 OpenCode 本体

这一步与本插件无关，先把「上游 OpenCode」本身装好、能对话。

### 2.1 安装 OpenCode

任选其一（**注意 JS 包名是 `opencode-ai` 不是 `opencode`**）：

```bash
# 方式 A：官方安装脚本（推荐）
curl -fsSL https://opencode.ai/install | bash

# 方式 B：npm
npm i -g opencode-ai

# 方式 C：bun
bun add -g opencode-ai

# 方式 D：Homebrew（macOS/Linux）
brew install anomalyco/tap/opencode
```

验证：`opencode --version`。

### 2.2 配置大模型提供方

```bash
# 方式 A：交互式登录
opencode auth login

# 方式 B：环境变量（以 Anthropic 为例；其它提供方类似）
export ANTHROPIC_API_KEY=sk-ant-xxxx
```

> 内网自建模型（vLLM / Ollama / OpenAI 兼容网关）的配置见 8.3 节。

### 2.3 首次启动确认 Daemon 正常

在任意项目目录里：

```bash
cd ~/work/your-project
opencode        # 进入 TUI
```

随便问一句「你好」，模型能回复即本体 OK。按 `Ctrl+C` 两次退出。

> 到这里你是「只有 OpenCode、没有本插件」的状态。下面一道把插件加上去。

---

## 3. 第二步：启用 edge-debug 插件

插件是一份代码，OpenCode 通过配置文件 `opencode.json` 按路径加载它——**不需要改 OpenCode 任何源码**。

### 3.1 拿到本插件代码

```bash
# 在你的项目目录里克隆为子目录（这样 3.2 节的示例路径开箱即用）
cd ~/work/your-project
git clone <本仓库地址> opencode-edge-debug
```

> 本工程是独立 bun 工程，不被 OpenCode 上游的 workspace 收录，放在上游源码树里也不会互相干扰。

在插件目录装**开发依赖**（运行期零依赖；需要 `@opencode-ai/plugin` 编译期类型，见 8.2 节内网做法）：

```bash
cd opencode-edge-debug
bun install
```

> **内网 / 离线机器？** 上面的 `bun install` 要连 npm registry。若目标机无外网：在联网机装好依赖后连 `node_modules` 一起打包搬入、解包即用，内网机免再 `bun install`——详见 8.2 节。

### 3.2 写 opencode.json 启用插件

OpenCode 读取 `opencode.json` 配置。可放两处：

- **项目级**：`<你的项目>/opencode.json` —— 只对这一个项目生效（推荐，按项目开启）。
- **全局级**：`~/.config/opencode/opencode.json` —— 对所有项目生效。

内容：

```json
{ "plugin": ["./opencode-edge-debug"] }
```

**路径规则**：`plugin` 里的路径是**相对于 opencode.json 所在目录**的。

- 若按 3.1 节把仓库克隆成项目子目录 `opencode-edge-debug`，上面这行**原样可用**。
- 若克隆在别处，改用**绝对路径**：

```json
{ "plugin": ["/home/alice/tools/opencode-edge-debug"] }
```

> 插件目录里含 `package.json`，入口取 `main`（`src/index.ts`），OpenCode 会据此加载。

> **Windows 绝对路径注意**：JSON 里反斜杠 `\` 是转义字符，`C:\Users\...` 会因非法转义把配置读坏。两种正确写法——**反斜杠翻倍**：`"C:\\Users\\...\\opencode-edge-debug"`；或更省事**改用正斜杠**（Windows 同样识别，且无需转义）：`"C:/Users/.../opencode-edge-debug"`。路径里的空格（如 `My Tools`）是普通字符，不用处理。

### 3.3 验证插件已加载

```bash
cd ~/work/your-project
opencode        # 进入 TUI
```

在 TUI 对话里输入（让 AI 调一下插件工具）：

```
打开 Edge
```

若 AI 调用了 `start_edge_browser` 工具、Edge 弹出并回显加载地址，说明插件已生效。此时你的项目目录下会出现专用 profile 目录：`<项目>/.opencode/edge-debug/profile`（插件自动创建，无需手动操作）。

### 3.4 桌面版 / IDE 扩展同样适用（插件在服务端，与界面无关）

OpenCode 的**桌面版**和 **IDE 扩展**与 TUI 一样，都只是连到同一个本地服务端（Daemon）的客户端外壳；本插件经 `config.plugin` 加载、**运行在服务端进程内**，所有工具（启动/关闭浏览器、取日志）都在服务端执行——**与用哪个界面无关**。TUI 里能用的，桌面版 / IDE 扩展里同样生效，无需额外配置。前提是用**同一份 `opencode.json`** 连到配了插件的服务端；若连的是另一台远程服务端，那台也要配插件。

---

## 4. 日常使用

插件注册四个工具，全部由 Agent 通过自然语言调用，你不需要记命令：

| 工具 | 入参 | 作用 |
|------|------|------|
| `start_edge_browser` | `url?`（默认 `http://localhost:3000`） | 启动/复用 Edge 并建立 Console/Network 调试监听 |
| `close_edge_browser` | 无 | 优雅关闭浏览器与调试监听（未运行时仅提示，不报错） |
| `get_browser_console_logs` | 无 | 页面 console 日志与未捕获异常（最近 50 条） |
| `get_browser_network_logs` | 无 | 网络请求日志：仅 4xx/5xx 错误与疑似 API 请求（最近 50 条） |

典型用法（直接在 OpenCode 会话里说）：

| 你说的话 | 发生什么 |
|----------|----------|
| 「打开 Edge，地址 http://localhost:5173」 | 启动 Edge 并导航到该地址，建立调试监听 |
| 「帮我看看页面的控制台日志有没有报错」 | 返回最近 50 条 console 日志与未捕获异常 |
| 「查一下网络请求，有没有失败的 API 调用」 | 返回 4xx/5xx 错误与疑似 API 请求（URL 含 `/api/` 或 MIME 含 json） |
| 「关闭 Edge」 | 优雅关闭浏览器并清空日志缓冲 |

几点硬行为（由插件服务端保证，不靠 AI 自觉）：

- **关闭走优雅路径**：先 CDP `Browser.close` 让 Edge 自行落盘会话数据、正常退出，失败才杀进程树兜底。
- **网络日志降噪**：只保留 4xx/5xx 与疑似 API 请求，静态资源（css/png/字体）丢弃，为 Agent 减噪。
- **会话即失**：日志只存内存环形缓冲（每类最多 50 条），插件进程退出（会话结束、opencode 退出）即清空。

> **隐私**：日志**无任何上行、无落盘**，仅存内存；浏览器用专用 profile（`<项目>/.opencode/edge-debug/profile`），与你的日常浏览数据完全隔离。

---

## 5. 端到端验证清单

按顺序走一遍，全部打勾即部署成功：

```bash
# ① OpenCode 本体
opencode --version                         # 有版本号

# ② Edge 已装
#    linux: which microsoft-edge
#    macOS: ls "/Applications/Microsoft Edge.app"
#    win:   开始菜单里能看到 Edge

# ③ 插件已加载：进 TUI 让 AI「打开 Edge」，Edge 弹出并回显加载地址即 OK
#    并确认专用 profile 目录已生成
ls <你的项目>/.opencode/edge-debug/profile
```

验证调试链路（可选，更彻底）：

```
打开 Edge，地址 http://localhost:3000   # 若本机有服务；没有就让它开个空页
往页面控制台打印一条测试日志（或让 AI 在打开的页面上执行一段会 console.log 的脚本）
看看控制台日志有没有那条
关闭 Edge
```

单元测试（开发/维护者）：

```bash
cd opencode-edge-debug
bun test             # 零 mock：logs 纯函数全覆盖 + Bun.serve 假 CDP 服务真 WebSocket 验证
bun run typecheck    # 严格类型检查
```

---

## 6. 常见问题（FAQ / 故障排查）

| 现象 | 原因与处理 |
|------|-----------|
| TUI 里 AI 完全没有浏览器相关工具 | 插件没加载。检查 `opencode.json` 的 `plugin` 路径是否相对 opencode.json 正确、该目录下有 `package.json`、且已 `bun install`。 |
| 启动报「找不到 Edge」类错误 | Edge 未安装，或不在 PATH。按错误消息里的安装指引装好 Edge；linux 确保 `microsoft-edge` 系列在 PATH。 |
| 端口 9222 已被占用 | 插件会**复用**已在该端口调试的实例，不另起进程。若那是你想并肩使用的其它调试实例，可能互扰——关掉它再启动本插件即可。 |
| 启动了 Edge 但没导航到目标地址 | 插件 v1 只监听**启动时 attach 的单个 page target**，新开标签页不监听。用 `start_edge_browser` 指定 `url` 让它一次性导航到目标页。 |
| 日志一直为空 | 目标页没产生 console/网络活动，或相关请求被降噪规则过滤（如纯静态资源）。换个会打印日志/发 API 请求的页面再试。 |
| 想彻底还原成原生 OpenCode | 删掉 `opencode.json` 里的 `plugin` 条目即可；插件不碰上游任何数据，删除后浏览器调试行为完全消失。 |
| 想清掉专用 profile | 关闭浏览器后手动删除 `<项目>/.opencode/edge-debug/` 目录即可（见设计文档 6）。 |
| 桌面版 / IDE 扩展能用吗 | 能。插件跑在服务端、与界面无关，TUI 能用的都生效；前提是用同一份 `opencode.json` 连到配了插件的服务端。详见 3.4 节。 |
| Windows 打包/移动目录后插件加载失败（`Cannot find package 'xxx'`） | bun 默认 `isolated` 模式在 Windows 上使用硬链接引用全局缓存中的包文件，打包（tar/zip）或移动目录后硬链接断裂。**修复**：本工程根目录已有 `.npmrc`（`node-linker=hoisted`），删除旧依赖重装：`rm -rf node_modules && bun install`，之后重新打包。 |

---

## 7. 需要装什么到目标机（本插件特别简单）

与本插件的使用面相比，`[注册工具]` 之外**没有**以下任何东西：

- ❌ 没有需要部署的服务端（不同于 session-mgmt 的收集服务）
- ❌ 没有 CLI / 二进制要分发
- ❌ 没有数据库 / 需要落盘的状态（日志只在内存）

**目标机就三样**：OpenCode、Microsoft Edge、本插件目录（含 `node_modules`）。越简单，越不容易坏。

---

## 8. 内网隔离（air-gapped）环境部署

**核心判断**：本插件**运行期零依赖**——CDP 客户端用 bun 原生 WebSocket + fetch 实现，不引入任何第三方运行时库。因此软件本体搬进内网后**完全不需要外网**。需要「搬进去」的只有三样：**OpenCode 本体、插件开发依赖、大模型**。逐项给做法。

### 8.1 总体流程

```
联网区（构建机）                        内网隔离区
─────────────                         ───────────
1. 装 bun、拉本仓库、bun install
2. 下载 OpenCode 安装包/二进制  ──────►  拷入并安装到每台开发机
3. 打包插件（含 node_modules）  ──────►  拷入开发机，解压即用
4. 内网自建模型网关（vLLM/Ollama 等）──►  OpenCode 指向它（8.3 节）
```

### 8.2 把插件与依赖搬进去

由于零运行时依赖，插件只需**一份含 `node_modules` 的目录**即可运行。推荐用一键打包脚本（与 `opencode-session-mgmt` 的 `pack:bundle` 对齐），它会自动清理重装依赖、附带 `setup.sh`/`setup.ps1` 环境校验：

```bash
# 联网区：一键打成可移植 tarball（含 node_modules + 源码 + setup 脚本）
cd opencode-edge-debug
bun run pack:bundle        # → dist/opencode-edge-debug-bundle-<版本>.tgz

# 内网开发机：解包即用，无需联网
tar xzf opencode-edge-debug-bundle-0.0.1.tgz
cd opencode-edge-debug-bundle-0.0.1
bash setup.sh              # Windows 用 .\setup.ps1
# 然后在 opencode.json 中把 plugin 指向解压目录（含 package.json）
```

不想用脚本、只手动打包也可以——装好依赖后把整个含 `node_modules` 的插件目录 tar 走即可：

```bash
# 联网区
cd opencode-edge-debug && bun install && cd ..
tar czf opencode-edge-debug.tgz opencode-edge-debug

# 内网：解包即用，无需再联网安装
tar xzf opencode-edge-debug.tgz
```

> 本工程根目录的 `.npmrc` 已设 `node-linker=hoisted`（真实文件拷贝，非硬链接），`node_modules` 可直接打包搬运、解压即用。**不要删除 `.npmrc`**。
>
> 若内网有**私服 npm 镜像**（如 Verdaccio/Nexus），则内网机器可直接 `bun install`，把 registry 指向私服即可，无需打包 node_modules。

OpenCode 本体在联网机下载后拷入内网（三选一，见 session-mgmt 部署手册 9.2 节第 1 步）：

```bash
# 选 A：官方安装脚本先下到联网机，内网执行本地脚本
curl -fsSL https://opencode.ai/install -o install.sh

# 选 B：npm 离线包（联网机打包，内网离线安装）
npm pack opencode-ai                 # 得到 opencode-ai-<版本>.tgz
# 内网： npm i -g ./opencode-ai-<版本>.tgz
```

### 8.3 大模型：指向内网自建网关

在 `opencode.json`（项目级或全局级）里配置一个自定义 provider，指向内网网关：

```json
{
  "plugin": ["/opt/opencode-edge-debug"],
  "provider": {
    "internal": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "内网模型网关",
      "options": { "baseURL": "http://llm-gateway.intra/v1", "apiKey": "{env:INTERNAL_LLM_KEY}" },
      "models": { "your-model-id": { "name": "内部模型" } }
    }
  }
}
```

> 字段名以你所用 OpenCode 版本的 provider schema 为准（不同版本可能略有差异）。配好后在 TUI 里能正常对话即生效。

---

## 9. 速查附录

**关键路径**：

| 项 | 位置 |
|----|------|
| OpenCode 配置 | `<项目>/opencode.json` 或 `~/.config/opencode/opencode.json` |
| 插件专用 profile（每项目一个） | `<项目>/.opencode/edge-debug/profile` |
| 插件日志缓冲 | 仅内存（每类最多 50 条），进程退出即失 |

**端口**：调试端口固定 `9222`，仅绑定 `127.0.0.1`（Chromium `--remote-debugging-port` 默认行为，不暴露到网络）。

**构建/测试命令**（工程根 `package.json`）：

| 命令 | 用途 |
|------|------|
| `bun test` | 单测（logs 纯函数全覆盖 + Bun.serve 假 CDP 服务真 WebSocket 验证） |
| `bun run typecheck` | tsc 严格类型检查 |
| `bun run build:plugin` | `dist/plugin/index.js`（插件编译为自包含 JS，屏蔽目标机 bun 版本差异） |
| `bun run pack:bundle` | `dist/opencode-edge-debug-bundle-<版本>.tgz`（可移植 tarball，内网/离线分发，见 8.2 节） |

**进一步阅读**：架构与决策记录 [`design.md`](design.md)；工程规约 [`CLAUDE.md`](../CLAUDE.md)；跨插件通用开发规范 [`../../plugin-guide/plugin-dev-guide.md`](../../plugin-guide/plugin-dev-guide.md)。