# 部署与使用手册

> 面向「完全没接触过 OpenCode 与本项目」的读者，从零讲到能用。
> 设计原理见 [`session-management.md`](session-management.md)；本手册只讲**怎么装、怎么跑、怎么验、坏了怎么办**。

---

## 0. 先看懂全景：到底要装什么、装在哪

整套东西分**四块**，分布在三种机器上。先有这张图，后面的步骤才不会晕：

```
┌───────────────────────────────  每位开发者的电脑  ───────────────────────────────┐
│                                                                                │
│  ① OpenCode 本体（上游，我们不修改）                                                │
│     - opencode 命令 + TUI + 一个自动启动的本地 Daemon（只绑 127.0.0.1）            │
│     - 需要一个「大模型提供方」（Anthropic/OpenAI，或内网自建模型网关）                │
│                                                                                │
│  ② session-mgmt 插件（本项目的 packages/plugin，已合并原 open-ide 插件）            │
│     - 由 OpenCode 通过 opencode.json 的 plugin 配置加载，跑在 Daemon 进程内         │
│     - 自动在每个项目下建一个本地库：<项目>/.opencode/session-mgmt.db                 │
│     - 含人工文件锁（open_ide/lock_file/unlock_file，锁持久化在该库 file_lock 表）    │
│                                                                                │
│  ③ opencode-sm 命令行（本项目的 packages/cli）                                    │
│     - 独立命令，用于在 TUI 之外查看工作流 / 统计，以及首次配置身份                     │
│     - 全局身份文件：~/.config/opencode/session-mgmt/identity.json                 │
│                                                                                │
└──────────────────────────────────────┬─────────────────────────────────────────┘
                                       │ 定期汇报会话摘要（不含代码）
                                       ▼
┌───────────────────────────────  组织内网服务器（每组织一个）  ──────────────────────┐
│  ④ 后台收集服务 performance_dashboard（外部项目，不随本仓库分发）                  │
│     - 内网 HTTP 服务，默认端口 8787                                               │
│     - 三个端点：POST /api/report（汇报）、POST /api/ci-quality（CI 回写）、          │
│       GET /api/stats（统计查询，组/组织级聚合看板）；外加 GET /healthz（探活）       │
└────────────────────────────────────────────────────────────────────────────────┘
```

**谁干什么（角色速查）**：

| 角色 | 要做的事 | 对应章节 |
|------|----------|----------|
| 组织管理员 / 运维 | 内网服务器上部署 ④ 收集服务（外部项目 performance_dashboard）；把收集服务地址告诉全员 | 第 5、9 章 |
| 开发者 | 装 ① OpenCode、启用 ② 插件、装 ③ CLI、跑一次 `opencode-sm init` | 第 1–4、6 章 |
| 组长 / 领导 | 装 ③ CLI、跑一次 `opencode-sm init`（配好收集服务地址），即可用收集服务看板查组/组织级聚合统计（无需装 OpenCode/插件） | 4.2、6.3 节 |

> **依赖互联网的部分只有三处**：① OpenCode 本体的安装、② 插件的 npm 依赖（`bun install`）、③ 大模型。
> CLI 经 `pack:cli` 打成**自包含压缩包**，目标机安装**不需要任何 npm 依赖**。本项目自己的代码（插件、CLI）**完全不需要外网**；收集服务为外部项目 `performance_dashboard`。内网隔离环境怎么把这三处搬进去，见第 9 章。

---

## 1. 前置条件

| 工具 | 用途 | 检查命令 | 说明 |
|------|------|----------|------|
| **bun** ≥ 1.1 | 运行插件源码、构建、跑收集服务 | `bun --version` | 核心依赖。安装：`curl -fsSL https://bun.sh/install \| bash`，或 `npm install -g bun`（需先有 node，跨平台可用） |
| **node + npm**（可选） | 用 npm 装 OpenCode、`npm install -g` 装 CLI 压缩包 | `node -v && npm -v` | **运行时**不需要 node（CLI 压缩包自包含）；只是安装动作要 npm，也可手动解包把二进制放进 PATH |
| **git** | 拉取本项目代码 | `git --version` | |
| **docker + compose**（仅管理员） | 部署收集服务 | `docker --version` | 不用 docker 也能跑（见 5.3 节） |
| **大模型提供方** | OpenCode 的大脑 | — | 公司账号的 API key，或内网自建模型网关（9.3 节） |

> Windows 用户：建议在 WSL2（Ubuntu）里操作，命令与 Linux 一致。原生 Windows 装 bun：已有 node 的话 `npm install -g bun` 最省事，或用官方 PowerShell 安装脚本；**装完重开一个终端** PATH 才生效（当前窗口仍会报「不是内部或外部命令」）。
>
> **Windows 打包便携必读**：bun 默认使用 `isolated` 链接策略，在 Windows 上通过硬链接从全局缓存引用包文件——打包（tar/zip）后硬链接断裂，导致传递依赖丢失、插件加载失败。本项目已在根目录放置 `.npmrc`（`node-linker=hoisted`），让 `bun install` 生成真实文件拷贝而非硬链接，使 `node_modules` 可直接打包搬运。**务必不要删除 `.npmrc`**。

---

## 2. 第一步：安装并跑通 OpenCode 本体

这一步与本项目无关，先把「上游 OpenCode」本身装好、能对话。

### 2.1 安装 OpenCode

任选其一（官方推荐第一种；**注意 JS 包名是 `opencode-ai` 不是 `opencode`**）：

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

验证：

```bash
opencode --version
```

### 2.2 配置大模型提供方

OpenCode 需要一个模型后端。两种方式：

```bash
# 方式 A：交互式登录（会引导你选提供方、填 key）
opencode auth login

# 方式 B：环境变量（以 Anthropic 为例；其它提供方类似）
export ANTHROPIC_API_KEY=sk-ant-xxxx
```

> **内网自建模型**（如公司内部 vLLM / Ollama / OpenAI 兼容网关）：在 `opencode.json` 里配置一个自定义 provider，指向内网地址，见 9.3 节。

### 2.3 首次启动，确认 Daemon 正常

在任意项目目录里：

```bash
cd ~/work/your-project
opencode        # 进入 TUI
```

- 首次运行会**自动启动本地服务**（只绑 `127.0.0.1`，不暴露到网络）。
- 在 TUI 里随便问一句「你好」，模型能回复，说明本体 OK。按 `Ctrl+C` 两次退出 TUI。
- 注意：该服务进程**随 TUI 退出而结束，并不常驻**，且默认启动时不监听网络端口（进程内通信）。因此外部的 `opencode-sm` CLI 无法直接连上 TUI 里的服务——会话**标题**已由插件同步进插件库、离线可读；但**费用/Token** 需另起常驻的 `opencode serve` 并配置地址，见 4.3 节。

> 到这里，**没有本项目你也能正常用 OpenCode**。下面三步是把「会话管理定制」加上去。

---

## 3. 第二步：启用 session-mgmt 插件

插件是一份代码，OpenCode 通过配置文件 `opencode.json` 按路径加载它——**不需要改 OpenCode 任何源码**。

### 3.1 拿到本项目代码

插件/CLI/收集服务都在同一个仓库里（一个 bun workspace）。把它放到你机器上，例如：

```bash
# 方式 A：在你的项目目录里克隆为子目录（这样 3.2 节 的示例路径开箱即用）
cd ~/work/your-project
git clone <本仓库地址> opencode-session-mgmt

# 方式 B：克隆到任意固定位置（后面配置要写绝对路径）
git clone <本仓库地址> ~/tools/opencode-session-mgmt
```

> 本仓库本身是独立 bun workspace，不会被 OpenCode 上游的 workspace 收录，放在上游源码树里也不会互相干扰。

在仓库目录装依赖（插件运行需要 `@opencode-ai/plugin`、`sm-shared` 等，内网环境见 9.2 节）：

```bash
cd opencode-session-mgmt
bun install
```

> **内网 / 离线机器？** 上面的 `bun install` 要连 npm registry。若目标机无外网：在联网机用 `bun run pack:bundle` 把依赖打进整包便携 tarball，拷入解压即用，内网机免再 `bun install`——详见 9.2 节第 2 步。

> **Windows / 整包便携用户**：本项目根目录的 `.npmrc` 已设置 `node-linker=hoisted`，`bun install` 会生成真实文件拷贝（非硬链接），`node_modules` 可直接打包搬运。若你之前已用默认模式安装过依赖（没有 `.npmrc`），须先删除旧 `node_modules` 再重装：`rm -rf node_modules packages/*/node_modules && bun install`。

### 3.2 写 opencode.json 启用插件

OpenCode 读取 `opencode.json` 配置。可放两处：

- **项目级**：`<你的项目>/opencode.json` —— 只对这一个项目生效（推荐，按项目开启）。
- **全局级**：`~/.config/opencode/opencode.json` —— 对所有项目生效。

内容（仓库里已有现成示例 [`deploy/opencode.json.example`](../deploy/opencode.json.example)）：

```json
{ "plugin": ["./opencode-session-mgmt/packages/plugin"] }
```

**路径规则**：`plugin` 里的路径是**相对于 opencode.json 所在目录**的。

- 若按 3.1 节 方式 A 把仓库克隆成项目子目录 `opencode-session-mgmt`，上面这行**原样可用**。
- 若克隆在别处（方式 B），改用**绝对路径**：

```json
{ "plugin": ["/home/alice/tools/opencode-session-mgmt/packages/plugin"] }
```

> **Windows 绝对路径注意**：JSON 里反斜杠 `\` 是转义字符，`C:\Users\...` 会因 `\U`、`\n` 等非法转义把配置读坏。两种正确写法——**反斜杠翻倍**：`"C:\\Users\\...\\packages\\plugin"`；或更省事，**改用正斜杠**（Windows 同样识别，且无需转义）：`"C:/Users/.../packages/plugin"`。路径里的空格（如 `My Tools`）是普通字符，不用处理。

### 3.2.1 编写规约（conventions/，可选）

插件按**工作流类型 + 当前阶段**自动加载「绑定规约」并注入系统提示（只注入、无门禁、阶段门控，设计见 `workflow-sdlc.md` 9 章 / `workflow-reqdoc.md` 11 章）。每个规约 `.md` 文件头部用 frontmatter 声明所属阶段：

```markdown
---
stage: global   # 常驻全程；或某个阶段键（如 implementation / prd），仅在该阶段注入
---
```

- **基线**：随插件打包在 `packages/plugin/conventions/<类型>/*.md`（`sdlc`、`reqdoc` 各一套）。
- **机构覆盖**：放在项目根 `<你的项目>/conventions/<类型>/*.md`，插件自动读取并追加到基线之后（按 `workflow.type` 隔离、按 `stage` 阶段门控，不跨工作流泄漏）。
- **通用/常驻规则**：写进项目/全局的 `AGENTS.md`（OpenCode 原生合并，适合跨工作流的机构约定），不放进 `conventions/` 目录。

无需在 `opencode.json` 加任何额外条目——规约送达由插件完成；新增/修改规约 = 往对应目录丢/改一个带 `stage:` 的 `.md`，零代码。

### 3.3 验证插件已加载

```bash
cd ~/work/your-project
opencode        # 进入 TUI
```

在 TUI 对话里输入（让 AI 调一下插件工具）：

```
看一下当前会话的工作流状态
```

若 AI 调用了 `commit_gate_check` / `workflow_advance` 之类工具并回显出「五个阶段、当前均 not_started」，说明插件已生效。
同时该项目目录下会出现本地库：`<项目>/.opencode/session-mgmt.db`（插件自动建表，无需手动操作）。

### 3.4 桌面版 / IDE 扩展同样适用（插件在服务端，与界面无关）

OpenCode 除 TUI 外还有**桌面版**和 **IDE 扩展**。它们与 TUI 一样，都只是连到同一个本地服务端（Daemon）的客户端外壳；而本插件经 `config.plugin` 加载、**运行在服务端进程内**，所有 Hook（system prompt 注入、工作流工具、`git commit` 门禁、迭代计数、api_key 身份与汇报）都在服务端触发——**与用哪个界面无关**。因此：

- TUI 里能用的一切（五阶段门禁、逐段理解确认、强制提交、统计），在桌面版 / IDE 扩展里**同样生效**，无需额外配置。
- 官方文档确认 `opencode.json`（含 `plugin`）在 TUI / 桌面 / IDE 之间共享，插件体系是跨界面共用的一套。
- 配套的 `opencode-sm` CLI、本机插件库、收集服务不依赖界面，照常工作。

**三个注意点**：

1. **前提**：桌面版 / IDE 要连到（或运行）那份加载了插件的服务端，即使用同一份 `opencode.json`；若连的是另一台远程服务端，那台也要配插件。
2. **experimental 签名**：`experimental.chat.system.transform` 是实验性接口，桌面版若附带不同版本的服务端，升级后回归一次即可（适配层集中在 `prompt.ts`）。
3. **唯一的 bun 耦合点**：整个插件包唯一的 bun 专属依赖是 `db/index.ts` 里的 `bun:sqlite`。当前 OpenCode 服务端基于 bun，无碍；社区方向是桌面 / 服务端逐步「去 bun 转原生 Node」，一旦服务端不再跑在 bun 上，需把 DB 适配层换成 `node:sqlite` 或 `better-sqlite3`——耦合只此一处，改动面很小。（收集服务另用 `Bun.serve`，但它是自带 bun 运行时的独立内网服务，不受影响。）

**桌面版冒烟验证**：进桌面版 → 让 AI「看一下当前工作流状态」（确认注入与工具生效）→ 让它提交一段未过审查的代码（确认门禁拦截）。三步都过即可放心。

---

## 4. 第三步：安装 opencode-sm CLI 并配置身份

### 4.1 安装 CLI

团队构建一次、开发者直接装：打包脚本生成**可用 `npm install` 安装的压缩包**——包内是自包含单二进制，目标机**无需 node/bun**。

```bash
# 团队侧（联网构建机，按目标平台各打一份）：
bun run pack:cli                       # 默认当前平台 → dist/opencode-sm-<版本>-<平台>.tgz
bash scripts/pack-cli.sh windows-x64   # 交叉编译其它平台：darwin-arm64 / darwin-x64 / windows-x64 / linux-arm64
VERSION=0.1.0 bash scripts/pack-cli.sh # 覆盖版本号（默认读 packages/cli/package.json）

# 开发者侧（把对应平台的 tgz 拷过去后；文件名里的 0.1.0 为当前版本，以 packages/cli/package.json 实际版本为准）：
npm install -g ./opencode-sm-0.1.0-linux-x64.tgz
opencode-sm --help                     # 全局可用
```

> 压缩包是**平台相关**的：一个 tgz 对应一个 OS/CPU（包内 `os`/`cpu` 字段会让 npm 在装错平台时报错提示）。多平台就各打各的、各装各的。

> 开发 / 维护者从源码跑：在 `packages/cli` 下 `bun link`（需 PATH 里有 bun）；只想要裸二进制见第 10 章 `build:cli`。

### 4.2 配置身份：opencode-sm init（每台机器一次）

```bash
opencode-sm init
```

交互式两问 + 可选工作流类型，**全部手工填写**（不读取任何上游登录账号）：

```
? api_key（明文仅存本机 identity.json；发送前转 SHA-256 哈希，网络不传明文）: <输入>
? 收集服务地址（如 http://10.0.1.20:8787）: http://【收集器地址】:8088
? 主要工作流类型（sdlc 开发 / reqdoc 需求书）[缺省 sdlc]: sdlc
✓ 已写入 ~/.config/opencode/session-mgmt/identity.json
```

要点：

- `api_key` 仅本机明文存储，插件上送前转 SHA-256(hex) 哈希；组/部门/组织等归属由后台收集服务据 `api_key` 哈希解析，客户端不再填写组名/组织名。
- 收集服务地址由**管理员告知**（即 `performance_dashboard` 的内网地址，见第 5 章）。暂时没部署收集服务也能填，插件会把汇报先缓存在本地。
- **工作流类型**决定本用户新会话走哪套流程（开发者 `sdlc` / 需求分析师 `reqdoc`），缺省 sdlc；不同角色 = 不同用户，改类型只影响之后的新会话（见 `session-management.md` 3.1）。
- **人员变动（换 api_key）时重跑 `opencode-sm init` 即可**；身份是「汇报快照」，只影响此后的统计归属，历史不追溯。

### 4.3 让 CLI 连上上游 daemon：`OPENCODE_SM_SERVER`（每机器一次）

`opencode-sm list` / `stats` 里的会话**标题**已由插件在会话活动时经 SDK 同步进插件库（启动后一次性回填 + 每条消息按需补），**离线（daemon 不可达）也能显示**；而**更新时间和费用/tokens**仍来自**上游 daemon**（费用由上游自动生成）。CLI 只通过环境变量 `OPENCODE_SM_SERVER` 获知 daemon 地址；**不设置就退化为本机数据**：`list` 标题用插件库存量值、`stats` 费用显示 `N/A`（是降级不是故障，见 8 节 FAQ）。

推荐做法：用固定端口跑一个常驻 daemon，再把地址写进环境变量，一次配好：

```bash
# 1) 先 cd 进项目目录，再固定端口起 daemon（需常驻：单独开一个终端窗口，或交给系统服务管理；
#    端口示例 4096，可自选）。请求未指明项目时 daemon 以「启动所在目录」为项目，
#    所以务必在项目目录里启动；多个项目就各起一个（换不同端口），或临时查哪个起哪个。
cd <你的项目目录>
opencode serve --port 4096
# 看到 "opencode server listening on http://127.0.0.1:4096" 即成功
```

```powershell
# 2) Windows（PowerShell）：写入用户环境变量，新开终端生效
[Environment]::SetEnvironmentVariable("OPENCODE_SM_SERVER", "http://127.0.0.1:4096", "User")
```

```bash
# macOS / Linux：写入 shell 配置文件（zsh 改为 ~/.zshrc）
echo 'export OPENCODE_SM_SERVER=http://127.0.0.1:4096' >> ~/.bashrc && source ~/.bashrc
```

验证：daemon 在跑的前提下执行 `opencode-sm list`，标题正常显示即配置成功。

> 用 TUI 时自动拉起的 daemon 也可以：把 `OPENCODE_SM_SERVER` 指向它实际的监听地址即可。但其地址由上游自管、可能变化，不如 `opencode serve` 固定端口稳定。

> **与 TUI 同时开着互不影响**：`opencode serve` 与 TUI 可共存——端口不冲突（默认 TUI 不监听网络端口），两者共享磁盘上的会话数据与插件库（WAL 模式），TUI 里跑过的会话从 serve 一样读得到；插件会在两个进程各加载一份，但汇报按会话幂等合并，不会脏数据。代价只是多一个常驻进程的内存。

---

## 5. 第四步：部署 org 收集服务（管理员，每组织一次）

收集服务是一个内网 HTTP 服务，把各开发者机器汇报的会话摘要汇聚成组/组织统计。**只有管理员/运维需要做这一步。** 收集服务是**外部独立项目** [`performance_dashboard`](https://github.com/karsonto/performance_dashboard)，不随本仓库分发；其接口契约见 `collector-spec.md`。本仓库已退役 `packages/collector`。

> 收集服务**只在内网可达**——部署后用防火墙把 8787 端口限制为内网可访问，不要暴露到公网（汇报里携带 `api_key` 的 SHA-256 哈希作为身份标识，虽不含明文密钥，仍属内部聚合数据）。

### 5.1 端点一览（performance_dashboard）

| 方法 | 路径 | 谁调用 | 作用 |
|------|------|--------|------|
| POST | `/api/report` | 插件 | 接收会话摘要汇报（不含代码，身份以 api_key 哈希标识） |
| POST | `/api/ci-quality` | CI 流水线 | 按 sessionID 回写 reworkRate/testCoverage |
| GET | `/api/stats?scope=group&group=前端组` 或 `?scope=org&org=Engineering` | 收集服务看板 | 组/组织级统计查询（CLI 不直接调用，由看板提供） |
| GET | `/healthz` | 探活 | 返回 `{ok:true}` |

### 5.2 部署（按外部项目说明）

参考 [`performance_dashboard`](https://github.com/karsonto/performance_dashboard) 仓库的部署指引（Docker / systemd 均可，默认端口 8787），部署后将其内网地址告知全体成员，作为 `opencode-sm init` 的收集服务地址。验证：

```bash
curl http://<服务器内网IP>:8787/healthz
# 期望输出：{"ok":true}
```

### 5.3 部署完成后，告诉全员

1. 收集服务地址（如 `http://10.0.1.20:8787`）——填进各自 `opencode-sm init` 的收集服务地址（第二问）。
2. 组/部门/组织归属由收集服务据 `api_key` 哈希解析，开发者无需也不填写组名；统一由后台配置。

---

## 6. 日常使用

核心原则：**开发者始终在 TUI 里用自然语言干活**；CLI 只用于「不进 TUI 也能查看/管理」。

### 6.1 在 TUI 里走工作流（开发者主路径）

插件会把工作流规则与当前状态**每轮自动注入** system prompt，AI 会主动引导你走完五阶段：需求分析 → 设计 → 编码 → 测试 → 审查。你只需用自然语言回应：

| 你说的话 | 发生什么 |
|----------|----------|
| 「需求就这些，确认」 | AI 标记需求阶段 approved，进入设计 |
| 「回到设计阶段，scope 要补」 | 立即回退（revision++） |
| 「代码写完了，进入审查」 | AI 把代码变更拆成片段，**逐段**给你解释，你逐段确认理解 |
| 「L22 为什么用 Map 不用 Redis？」 | AI 解答，并把问答追加进该片段的解释（沉淀为知识库） |
| 「帮我提交代码」 | 触发提交门禁：五阶段全 approved 才放行；否则列出未完成项 |

几条硬规则（由插件在服务端强制，不靠 AI 自觉）：

- **审查是唯一不能由 AI 自己通过的阶段**，必须你逐段确认理解 + 审查清单四项全过。
- **提交门禁是硬拦截**：即便 AI「想」提交，`git commit` 也会被插件拦下，除非走完审查；确有特殊情况可让 AI 调 `commit_force_unlock`（需你确认 + 填原因，一次性，且会留痕进统计）。
- **同一段代码 AI 迭代到 3 轮**会被要求停手、转人工重写。

完整对话示例见 workflow-sdlc.md 4 章（场景一~四）；reqdoc 场景五见 workflow-reqdoc.md 9 章。

### 6.2 在 TUI 之外查看（opencode-sm）

```bash
opencode-sm stats <sessionID>                    # 当前会话工作流状态 + 质量指标 + AI 用量
opencode-sm list --status review --tag feature      # 按状态/标签过滤会话列表
```

> 会话的创建/删除/恢复用**上游原生命令**，本项目不重复包装：`opencode session list`、`opencode session delete <id>`、`opencode -c`（回到本目录最近会话）、`opencode -s <id>`（按 ID 恢复）。

> `stats` 的费用/tokens 需连上游 daemon（配置见 4.3 节），未连上时费用显示 `N/A`；会话**标题**已由插件同步进插件库，离线可读（`list` 同样用库存量标题兜底）。本机状态/标签数据不受影响。

### 6.3 统计（四级）

```bash
opencode-sm stats <sessionID>                 # 会话级：五阶段详情 + 质量指标 + AI 用量（含 cost/tokens）
opencode-sm stats --period 7d                 # 项目级：聚合摘要 + 逐会话明细表（省略 --project 即按当前目录）
opencode-sm stats --project ~/work/user-service   # 项目级：--project 接【目录路径】（只读打开）
```

组/组织级聚合由外部收集服务 `performance_dashboard` 看板提供，CLI 不再直查。

数据来源（**按级别分工、多源组合，不是逐级回退**；时序见设计文档 5.2 节）：

| 级别 | 本机插件库 | 上游 daemon | 收集服务 |
|------|-----------|-------------|----------|
| 会话级 `stats <sessionID>` | ✅ 主源：五阶段工作流、质量指标 | ➕ 补 cost/tokens（不可达 → `N/A`） | ❌ 不参与 |
| 项目级 `stats [--period]` | ✅ 主源（聚合整库） | ➕ 补 cost/tokens（不可达 → `N/A`） | ❌ 不参与 |
| 组/组织级 | ❌ CLI 不参与 | ❌ | ✅ 由收集服务看板提供（CLI 不直查） |

- 会话级 / 项目级**离线可用**：永远先读本机插件库（第一数据源），daemon 只补费用；daemon 不可达时费用显示 `N/A`（而非误导的 $0）。daemon 地址配置见 4.3 节。

---

## 7. 端到端验证清单

按顺序走一遍，全部打勾即部署成功：

```bash
# ① OpenCode 本体
opencode --version                         # 有版本号

# ② 插件：进 TUI 让 AI 看工作流状态，能回显五阶段即 OK；并确认本地库已生成
ls <你的项目>/.opencode/session-mgmt.db

# ③ CLI + 身份
opencode-sm --help                         # 列出 init/stats/list
cat ~/.config/opencode/session-mgmt/identity.json   # 两问结果都在（含 workflowType）

# ④ 收集服务（管理员，外部项目 performance_dashboard）
curl http://<内网IP>:8787/healthz          # {"ok":true}

# ⑤ 打通汇报链路：在 TUI 里走完一个小会话，稍等（插件启动即推、之后每 5 分钟补推），
#    收集服务看板应能看到该会话（按 api_key 哈希归属）
```

单元测试（开发/维护者）：

```bash
cd opencode-session-mgmt
bun test             # 53 个测试，覆盖工具校验/门禁/汇报缓冲/合并语义
bun run typecheck    # 四包严格类型检查
```

---

## 8. 常见问题（FAQ / 故障排查）

| 现象 | 原因与处理 |
|------|-----------|
| TUI 里 AI 完全不提工作流 | 插件没加载。检查 `opencode.json` 的 `plugin` 路径是否相对 opencode.json 正确、该目录下有 `package.json`、且已 `bun install`。 |
| 加了插件后启动变慢（首屏卡几秒到几十秒） | 历史版本（早于 2026-08）插件在**启动瞬间**就做三件事：向收集服务补推缓冲汇报（`fetch` 无超时，收集服务不可达时挂到 TCP 连接超时，可达数十秒）、两次全量 `session.list`（孤儿清理 + 标题回填，与 TUI 首屏抢资源）。**已修复**：汇报 `fetch` 加 5 秒超时（`AbortSignal.timeout`）；三件启动任务合并成一次 `session.list` 并**延后 2 秒**执行（错开首屏）。升级插件 bundle 后生效；若仍慢，先 `curl {collector_url}/healthz` 确认收集服务可达，并核对 `identity.json` 的 `collector_url`（不可达时只会静默放弃补推，不影响启动）。 |
| `opencode-sm: command not found` | CLI 没装好。正式用：`npm install -g ./opencode-sm-<版本>-<平台>.tgz`（见 4.1 节）；开发期在 `packages/cli` 下 `bun link`；或把构建出的 `dist/opencode-sm` 放进 PATH。从源码跑还需 PATH 里有 `bun`。 |
| 统计里费用显示 `N/A` | 上游 daemon 不可达（没在跑 / 未设置 `OPENCODE_SM_SERVER`，见 4.3 节），或该会话没有 usage 数据。工作流/质量数据不受影响，仍读本机库。 |
| `opencode-sm list` 标题显示「(无标题)」 | 该会话从未在插件运行期间被同步过标题（如旧库、或会话未在本机活动过）。插件在启动后回填与 `chat.message` 时经 SDK 同步标题；用 OpenCode 打开本项目跑一次即可补上，或按 4.3 节配置 `OPENCODE_SM_SERVER` 实时取。daemon 不可达时标题用插件库存量值，不报错。 |
| TUI 开着时再开 `opencode serve` 会有影响吗 | 没有。端口不冲突（默认 TUI 不监听网络端口），两者共享磁盘上的会话数据与插件库（WAL），插件双份加载但汇报按会话幂等合并，不脏数据；只是多一个常驻进程。注意 serve 要在项目目录里启动（见 4.3 节）。 |
| 收集服务看板的组/组织统计报错，但本机数据都在 | CLI 不再直查组/组织级；看板数据由收集服务 `performance_dashboard` 据 api_key 哈希解析提供。检查收集服务是否在跑、`identity.json` 的 `collector_url` 是否正确。 |
| 收集服务看板报错或为空 | 收集服务不可达，或 `identity.json` 里 `collector_url` 写错。先 `curl {collector_url}/healthz`。 |
| 收集端统计不到（会话走完了还是 sessions=0，本机库却正常） | 汇报被**静默跳过**：`readIdentity()` 要求 `identity.json` 的 `apiKey` 与 `collector_url` 非空，任一缺失/为空即返回 null，`flushOutbox()` 见 null 直接 `return 0`（不报错、不补推）。**先查 `~/.config/opencode/session-mgmt/identity.json` 的两个必填字段 `apiKey` / `collector_url` 是否齐全**——补全后重启插件（或等 5 分钟定时 flush），积压汇报自动补推，收集端数据立即补齐。 |
| 收集服务挂了会丢数据吗 | 不会。插件在本地缓冲未送达的汇报（同一会话只留最新一条），服务恢复后自动补推。 |
| 改了 `opencode-sm init` 后历史统计没变 | 正常。身份是**汇报快照**，只影响此后的汇报，历史归属不追溯。 |
| 先用了插件（已建库/走过会话）才跑 `init` | 不会出错。身份只用于 **api_key 标识**与**向收集服务汇报**，建库、五阶段门禁、理解确认、会话/项目级统计都与身份无关；无身份时汇报静默跳过。补配 `init` 后：本地数据全在；`api_key` 哈希会在该会话下次活动时随汇报带出（仅当原为空）；但 `init` 之前已结束、此后再没活动的会话不补汇报、不进组/组织统计。建议次序仍是先 `init` 再用。 |
| 想彻底还原成原生 OpenCode | 删掉 `opencode.json` 里的 `plugin` 条目即可；本项目数据都在插件自有库与收集服务，不碰上游任何数据。 |
| 收集服务端口/库路径要改 | 收集服务为外部项目 `performance_dashboard`，端口/库路径配置见其仓库。 |
| 会话能改名吗 | 不能。上游无标题更新 API，标题自动生成；用会话 ID 来辨认（标签功能已随 CLI 精简移除，状态仍存插件库）。 |
| 桌面版 / IDE 扩展能用吗 | 能。插件跑在服务端、与界面无关，TUI 能用的都生效；前提是用同一份 `opencode.json` 连到配了插件的服务端。详见 3.4 节。 |
| Windows 打包/移动目录后插件加载失败（`Cannot find package 'zod'` 等） | bun 默认 `isolated` 模式在 Windows 上使用硬链接引用全局缓存中的包文件，打包（tar/zip）或移动目录后硬链接断裂。**修复**：确保根目录有 `.npmrc`（内容 `node-linker=hoisted`），然后删除旧依赖重装：`rm -rf node_modules packages/*/node_modules && bun install`。之后重新打包即可。**预防**：打包前运行 `bun run pack:bundle`，脚本会自动完成清理→重装→打包（见 9.2 节）。 |

---

## 9. 内网隔离（air-gapped）环境部署

**核心判断**：本项目自己的代码（插件、CLI、收集服务）**天生不需要外网**——收集服务本就设计为内网服务，插件只跟本机 daemon 和内网收集服务通信。需要「搬进去」的只有三样：**OpenCode 本体、npm 依赖、大模型**。下面逐一给做法。

### 9.1 总体流程

```
联网区（构建机）                        内网隔离区
─────────────                         ───────────
1. 装 bun、拉本仓库、bun install
2. 下载 OpenCode 安装包/二进制  ──────►  拷入并安装到每台开发机
3. bun run pack:bundle 出整包便携包 ──►  拷入开发机，解压即用（9.2 节）
4. 构建 dist/opencode-sm（CLI 二进制分发）；收集服务为外部项目 performance_dashboard，按其一并搬运部署
5. 内网自建模型网关（vLLM/Ollama 等）──►  OpenCode 指向它（9.3 节）
```

### 9.2 把 OpenCode 本体与依赖搬进去

要搬两样：**OpenCode 本体**与**插件依赖**。按两步走：第 1 步逐机装好 OpenCode 本体，第 2 步用整包便携 tarball 搬插件依赖（解压即用）。

#### 第 1 步：搬入 OpenCode 本体

在联网机下载后拷入内网（三选一）：

```bash
# 选 A：官方安装脚本先下到联网机，内网执行本地脚本（脚本会去找二进制，需一并带入）
curl -fsSL https://opencode.ai/install -o install.sh

# 选 B：npm 离线包（联网机打包，内网离线安装）
npm pack opencode-ai                 # 得到 opencode-ai-<版本>.tgz
# 内网： npm i -g ./opencode-ai-<版本>.tgz

# 选 C：brew 离线瓶（macOS 内网常用）
brew fetch --bottle-tag=... anomalyco/tap/opencode
```

> 具体哪种最省事取决于内网基线操作系统；原则就是把「安装器 + 它要下载的二进制/包」一起在联网区备齐再拷入。

#### 第 2 步：搬入插件依赖（整包便携，解压即用）

在外网一台**与内网同平台**的机器上，用 `pack:bundle` 把「本仓库 + 依赖」打成自包含 tarball，拷入解压即用。一键打包脚本自动完成「清理旧依赖 → hoisted 重装 → 组装自包含目录 → 附带环境校验脚本 → 生成内网依赖种子 `seed/` 与 `setup.cmd`」，产物为可 `tar` 解压即用的 tarball：

```bash
# 外网打包机（务必与内网同 OS / 同架构 / glibc 相近）：
cd opencode-session-mgmt
bun run pack:bundle        # → dist/opencode-sm-bundle-0.1.0.tgz（版本号取自 packages/cli/package.json）
# 版本号可按需覆盖： VERSION=0.2.0 bash scripts/pack-bundle.sh

# 内网开发机（解压到固定位置，如 D:/tools/opencode/）：
tar xzf opencode-sm-bundle-0.1.0.tgz -C D:/tools/opencode
cd D:/tools/opencode/opencode-sm-bundle-0.1.0
setup.cmd seed D:\你的项目  # 每个要用插件的项目各跑一次：种全局 + 该项目 .opencode
# bash setup.sh           # 可选：仅校验环境（Windows 有 PowerShell 时也可用 .\setup.ps1）
```

**Windows 内网机务必用 `setup.cmd seed` 种依赖**（纯 cmd，无需 PowerShell、无需网络）。原因：opencode 配置插件后，启动会对各 config 目录联网安装插件 SDK `@opencode-ai/plugin`，内网机无网会卡 1-2 分钟（日志出现 `background dependency install failed`）。做法是把包内 `seed/`（打包机已生成的离线依赖种子：`node_modules/@opencode-ai/plugin` + 最小 `package-lock.json`/`package.json`，版本与 bundle 一致）铺进每个 config 目录，让安装判定变为 no-op：
1. 全局：每次 `setup.cmd seed <项目目录>` 都会一并种 `%USERPROFILE%\.config\opencode\`（存在 `~/.opencode` 也种）。
2. 逐项目：`setup.cmd seed <项目目录>` 种**全局 + 该项目的 `.opencode`**——**每个要用插件的项目各跑一次**即可（项目 `.opencode` 独立存在，命令幂等、可重复）。

然后配置 `opencode.json` **直接指向解压目录**——bundle 根 `package.json` 已注入 `main` 指向插件入口，无需再指到 `packages/plugin`（与 edge-debug 一致）。项目级或全局级均可；建议配在全局（`~/.config/opencode/opencode.json`），每台机一次、所有项目共用。

```json
{
  "plugin": ["D:/tools/opencode/opencode-sm-bundle-0.1.0"]
}
```

若同时用 edge-debug bundle，并列两条即可：

```json
{
  "plugin": [
    "D:/tools/opencode/opencode-sm-bundle-0.1.0",
    "D:/tools/opencode/opencode-edge-debug-bundle-0.0.1"
  ]
}
```

> Windows 注意：JSON 里路径用正斜杠 `/`（上面示例即如此），无需处理反斜杠转义。

最后每台机跑一次 `opencode-sm init` 配身份（两问 + 可选工作流类型，见 4.2 节）。

**「解压即用」的四个要点**（少一个就会装上却跑不起来）：

1. **同平台构建**：打包机与内网机须同 OS、同 CPU 架构、glibc 别差太多，否则运行时或原生依赖加载失败。
2. **`node_modules` 必须是 hoisted 模式**（Windows 关键）：bun 默认的 `isolated` 模式在 Windows 上使用硬链接，打包时硬链接无法保留，导致传递依赖（如 `zod`）断裂。本项目 `.npmrc` 已设 `node-linker=hoisted`（真实文件拷贝）——用 `bun run pack:bundle` 打包时脚本会自动处理；仅当手工打包时才需自查（之前用默认模式装过的，先 `rm -rf node_modules packages/*/node_modules && bun install` 重装）。
3. **插件无原生模块**：插件不带自己的原生模块（`bun:sqlite` 是 bun 内置），workspace 软链是相对路径、随 tar 走；只要 `opencode.json` 的 `plugin` 路径指对即可加载。
4. **内网必须种依赖种子**：Windows 内网机对每个项目跑一次 `setup.cmd seed <项目目录>`（自动一并种全局），否则 opencode 每次启动联网装 `@opencode-ai/plugin` 卡 1-2 分钟；Linux/macOS 内网机同理，手动把包内 `seed/` 拷进 `~/.config/opencode/` 与各项目 `.opencode` 即可。

> 注意：
> - **tarball 不含 OpenCode 本体**——本体在第 1 步单独搬入；**也不含 bun 运行时**，目标机若还没有 bun（前置条件，见第 1 章），同样从联网机带一份对应平台的 bun 二进制装入（单文件，放进 PATH 即可）。
> - **模型后端 tar 不进来**——软件搬进去 ≠ 能对话，内网仍须把 OpenCode 指向内部模型网关（见 9.3 节）。
> - OpenCode 配置（`~/.config/opencode`）与会话数据（`~/.local/share` 一带）在各人 home、不在包内，身份按机器配，故每台机解包后仍需 `opencode-sm init`（见 4.2 节）。

> 若内网有**私服 npm 镜像**（如 Verdaccio/Nexus），第 2 步也可跳过打包：内网机器把 registry 指向私服后直接 `bun install`。但本方案（`seed/` + `setup.cmd`）**完全不需要镜像**——种子在打包机一次生成、随包分发，内网机零网络。

> **配置层兜底（无需预填种子也能压住卡顿）**：若内网机没跑 `setup.cmd seed`、各 config 目录缺 `node_modules`，opencode 启动仍会对每个 config 目录发起 `@opencode-ai/plugin` 的 Arborist 安装（`packages/core/src/npm.ts` 的 `install` 仅在 `node_modules` 缺失或声明包未进 `package-lock.json` 时才真正联网 `reify`，见 `npm.ts:147`）。此时可在**用户级**放一份 `.npmrc` 让安装失败即停、不再等 registry 超时：
> ```
> echo offline=true > "%USERPROFILE%\.npmrc"
> ```
> `@npmcli/config` 会把 npm userconfig（`%USERPROFILE%\.npmrc`）合并进每次 Arborist 调用，故**只建这一份即可覆盖所有 config 目录**（`~/.config/opencode` 与各项目 `.opencode`），无需逐目录放。装依赖缺失时 `reify` 直接报错秒回（日志出现 `background dependency install failed` 警告，不影响启动）；若已用 `setup.cmd` 预填，`install` 在 `npm.ts:147` 短路、`.npmrc` 根本不被读到。唯一例外：某 config 目录内单独存在 `.npmrc` 且写了 `offline=false` 才会被它覆盖。需要联网但只压超时（而非彻底离线）时，改用 `fetch-retries=0` + `fetch-timeout=5000` 把最坏等待从 1-2 分钟压到约 5 秒。

### 9.3 大模型：指向内网自建网关

完全隔离的环境通常有**内部模型服务**（vLLM / Ollama / _one-api_ 等 OpenAI 兼容网关）。让 OpenCode 指向它，而非公网 Anthropic/OpenAI。在 `opencode.json` 里配置一个自定义 provider，形如（`plugin` 指向 9.2 节第 2 步的解压目录；建议配在全局 `~/.config/opencode/opencode.json`）：

```json
{
  "plugin": ["/opt/opencode-sm-bundle-0.1.0"],
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

> 字段名以你所用 OpenCode 版本的 provider schema 为准（不同版本可能略有差异；隔离区内无法查上游文档时，向内网 OpenCode 维护者索取一份可用配置）。配好后在 TUI 里能正常对话即生效。

### 9.4 CLI 与收集服务的离线分发

```bash
# 联网构建机：
# CLI 推荐打成 npm 安装包（内网逐机 npm install -g 即可，目标机无需 node/bun）
bun run pack:cli           # → dist/opencode-sm-<版本>-<平台>.tgz（按内网平台打，多平台见 4.1 节）
# 或仅出裸二进制：bun run build:cli → dist/opencode-sm（单文件，目标机无需 bun）
```

收集服务为外部项目 `performance_dashboard`，按其一并搬运部署到内网服务器（详见其仓库）。

> 不想用 docker：收集服务按 `performance_dashboard` 仓库说明，拷入内网服务器运行。

### 9.5 内网下的身份与汇报

- `opencode-sm init` 的「收集服务地址」填**内网收集服务**地址（如 `http://10.0.1.20:8787`）。
- 汇报只走内网，**绝不出网**；即便收集服务临时不可用，也只是本地缓冲，不会产生任何外网流量。
- 若某台机器**完全不配** `collector_url`，则退化为本机会话/项目级统计，功能不受影响（只是没有组/组织聚合）。

### 9.6 全量工具箱整包：一个目录装下全部（Windows 便携）

前面 9.2~9.4 是把「本体、插件、CLI/收集服务」分开搬入。想一步到位的话，也可在联网区把 **Node.js 便携版目录**直接扩成「全量工具箱」——bun、opencode 本体、opencode-sm CLI、插件整包（session-mgmt 已含 open-ide 功能；如用 Edge 调试再加 edge-debug 包）全放进同一目录，压缩后整包搬入内网，解压即用。

以 `D:\Tools\node-v22.23.2-win-x64` 为例：

1. **解压到固定路径**，路径避免空格/中文，位置定下后不再移动。zip 用 Windows 原生解压即可。

2. **配置 opencode.json**（内网机建议配**全局** `%USERPROFILE%\.config\opencode\opencode.json`，每台机一次）——写插件路径 + 内网模型网关，缺一不可：
   ```json
   {
     "plugin": [
       "D:/Tools/node-v22.23.2-win-x64/opencode-sm-bundle-0.1.0",
       "D:/Tools/node-v22.23.2-win-x64/opencode-edge-debug-bundle-0.0.1"
     ],
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
   > 模型网关字段名以所用 OpenCode 版本的 provider schema 为准（见 9.3 节）；缺了 provider 配置，OpenCode 启动后找不到可用模型，无法对话。
   > **内网机配好后，务必对每个项目在会话管理 bundle 解压目录跑一次 `setup.cmd seed <项目目录>`**（自动种全局 + 该项目，见 9.2 节第 2 步），否则每次启动会联网装插件 SDK、内网无网卡 1-2 分钟。

3. **每台机配一次身份**：`.\opencode-sm.cmd init`（两问 + 可选工作流类型，见 4.2 节）。**「收集服务地址」填组织已部署的内网收集服务地址**（如 `http://【收集器地址】:8088`），**绝不填公网地址**。
   > ⚠ init 后顺手核对两个必填字段齐全：`C:\Users\<你>\.config\opencode\session-mgmt\identity.json` 须含 `apiKey` / `collector_url` 两个非空值。缺任一汇报会被**静默丢弃**，收集端 sessions 恒为 0（见第 8 章排查项）。例如一个合法的身份文件长这样：
   >
   > ```json
   > {
   >   "apiKey": "<明文本机存储，发送前转 SHA-256 哈希>",
   >   "collector_url": "http://【收集器地址】:8088",
   >   "workflowType": "sdlc"
   > }
   > ```
   >
   > 其中 `workflowType` 为可选字段（缺省 sdlc，`init` 会写入）；缺失 `apiKey` 或 `collector_url` 时 `readIdentity()` 校验直接判 null、汇报静默丢弃。

4. **（可选）把工具根目录加入系统 PATH**：`D:\Tools\node-v22.23.2-win-x64` 进 PATH 后，任意目录可直接 `opencode` / `opencode-sm` / `bun` / `npm`，不用敲 `.\xxx.cmd`。

5. **开始使用并端到端验证**：
   ```Command Prompt
   cd <你的项目目录>
   D:\Tools\node-v22.23.2-win-x64\opencode
   ```
    进 TUI 让 AI 报工作流状态，应回显五阶段；走完一个小会话，等插件推送（启动即推 + 每 5 分钟补推）后，在收集服务看板（performance_dashboard）应能看到该会话（按 api_key 哈希归属）。

> ⚠ **qwen3.6-27b 经 vLLM 服务的已知坑**（已实证）：opencode 一提问即报 `System message must be at the beginning`（HTTP 400）。根因两层——① 模型自带 `chat_template` 里有硬抛 `raise_exception('System message must be at the beginning.')`，而 opencode 会发出第二条 system 消息；② vLLM 加载 tokenizer 时**不读**模型目录里被替换过的 `tokenizer_config.json`，只改文件无效。**处理**：用修复版模板（仓库 [`docs/qwen3.6-27b.chat-template.jinja`](qwen3.6-27b.chat-template.jinja)，已去掉两处硬抛），在 vLLM 启动时**显式指定**：
>
> ```bash
> vllm serve qwen3.6-27b --chat-template /path/to/qwen3.6-27b.chat-template.jinja
> ```
>
> 必须写进日常启动命令/脚本并固定模板路径；仅替换模型目录文件不会生效。修复对合法输入（system 在首位 + 有 user query）渲染结果与原始模板逐字节一致。

**更新维护**：将来升级任一组件，回到联网区在工具箱目录里重装/重打（会话管理整包用 `bun run pack:bundle`，见 9.2 第 2 步），重新压缩搬入即可；内网机器不联网也能持续使用——插件汇报只走内网收集服务，绝不出网（见 9.5 节）。

---

## 10. 速查附录

**关键路径**：

| 项 | 位置 |
|----|------|
| 全局身份 | `~/.config/opencode/session-mgmt/identity.json` |
| 插件本地库（每项目一个） | `<项目>/.opencode/session-mgmt.db` |
| OpenCode 配置 | `<项目>/opencode.json` 或 `~/.config/opencode/opencode.json` |
| 收集服务库 | 容器内 `/data/collector.db`（或 `OPENCODE_SM_COLLECTOR_DB` 指定处） |

**端口**：Daemon 仅 `127.0.0.1`（上游自管）；收集服务默认 `8787`（内网）。

**构建脚本**（仓库根 `package.json`）：

| 命令 | 产物 |
|------|------|
| `bun test` / `bun run typecheck` | 测试 / 四包严格类型检查 |
| `bun run build:plugin` | `dist/plugin/`（插件编译为 JS，屏蔽目标机 bun 版本差异） |
| `bun run build:cli` | `dist/opencode-sm`（单文件二进制） |
| `bun run pack:cli` | `dist/opencode-sm-<版本>-<平台>.tgz`（可 `npm install -g` 的安装包；`bash scripts/pack-cli.sh <平台>` 交叉编译多平台） |
| `bun run pack:bundle` | `dist/opencode-sm-bundle-<版本>.tgz`（整包便携 tarball，内网/离线分发，见 9.2 节） |

**进一步阅读**：设计原理 [`session-management.md`](session-management.md)；上游同步流程 [`upstream-sync.md`](upstream-sync.md)。
