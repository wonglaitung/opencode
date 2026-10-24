<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">开源的 AI Coding Agent。</p>
<p align="center">
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="npm" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

> **非官方 fork 说明**：本仓库是 [anomalyco/opencode](https://github.com/anomalyco/opencode) 的定制 fork，
> 用于内部 Windows 交付，并非 OpenCode 官方项目。上游安装方式与文档仍保留在下方。

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

## 本仓定制与使用

本仓库是 [anomalyco/opencode](https://github.com/anomalyco/opencode) 的**非官方定制 fork**，用于内部
Windows 交付。上游 OpenCode 是基础，以下新增能力由本仓维护，不属于官方项目。其他语言 README 为
上游翻译，可能未覆盖本仓定制。

### 本仓新增

- **`opencode-session-mgmt/`**：工作流引擎、规则、本机统计 CLI（`opencode-sm`）与外部收集服务上报客户端。
- **三种工作流**：
  - `task`：写文档、分析错误等一般任务。单阶段，无审查、无提交门禁；记录预估工时与实际用时，
    在会话中明确说 **「完成」** 结束计时。
  - `sdlc`：五阶段软件开发流程，含审查与 git 提交门禁。
  - `reqdoc`：五阶段业务需求书流程，产出 PRD 供业务逐条确认。
- **`opencode-edge-debug/`、`opencode-server-debug/`**：可选调试插件。
- **`portable-installer/`**：Windows 便携安装包与启动器；启动器可选择工作流，界面使用 **AI Assistant** 品牌。
- **离线构建**：`--offline` 构建跳过配置目录依赖安装。
- **`.opencode/skills/`**：本机安装包与 Windows 插件加载实测技能。

### 快速开始（Windows）

1. 从 `portable-installer/` 构建或运行 `OpenCode-Setup.exe` / `OpenCode-launch.exe`。
2. 首次运行 `opencode-sm init`：填写 api_key、收集服务地址与默认工作流（`task` / `sdlc` / `reqdoc`）。
3. 打开应用，在启动器选择工作流：
   - `task`：直接输入任务内容；按「预估 xx 小时」报预估；完成后说「完成」结束计时。
   - `sdlc`：输入「启动 SDLC 工作流」。
   - `reqdoc`：输入「启动 REQDOC 工作流」。
4. 用 `opencode-sm stats --workflow task`（或 `sdlc` / `reqdoc`）查看本机统计。

### 工作流选择

启动器把选择写入 `~/.config/opencode/session-mgmt/identity.json`，影响本次 opencode 进程启动后的
所有新会话，不是按单个会话切换。切换任务时请用 `/new`。

### 仓库结构

| 路径 | 用途 |
|---|---|
| `packages/*` | 上游 OpenCode 包（基础） |
| `opencode-session-mgmt/` | 工作流引擎、CLI、文档与测试 |
| `opencode-edge-debug/` | Edge 调试插件 |
| `opencode-server-debug/` | 服务器调试插件 |
| `portable-installer/` | Windows 安装包 / 启动器 |
| `plugin-guide/` | 本仓维护与上游升级说明 |

### 文档

- [会话管理与架构](opencode-session-mgmt/docs/session-management.md)
- [task 一般任务工作流](opencode-session-mgmt/docs/workflow-task.md)
- [SDLC 工作流](opencode-session-mgmt/docs/workflow-sdlc.md)
- [REQDOC 工作流](opencode-session-mgmt/docs/workflow-reqdoc.md)
- [部署手册](opencode-session-mgmt/docs/deployment.md)
- [上游升级清单](plugin-guide/opencode-upgrade-checklist.md)

### 上游同步

日常开发只同步 `origin`；`upstream`（anomalyco/opencode）仅在明确要求时手工同步。本地补丁记录在
升级清单中。不要把本仓 README 的定制章节当成上游文档。

### 隐私

上报内容仅包含会话摘要（工作流状态、周期、cost/tokens），不包含代码正文；api_key 上送前做
SHA-256 哈希。

### 已知限制

- `task` 已有单元/文本契约测试，并纳入 5 个规则遵循场景（`t1`–`t5`）；用 `--workflow task --variant new` 运行。
- Windows 安装包在启动器/运行时变更后必须重新打包；构建产物不入 git。
- 收集服务是外部项目：<https://github.com/karsonto/performance_dashboard>。
- 启动器选择是 daemon 级；同一进程内跨历史会话混用不同工作流类型暂不支持。

---

## 上游 OpenCode

> 以下为上游项目 README，可能未覆盖本仓定制。

### 安装

```bash
# 直接安装 (YOLO)
curl -fsSL https://opencode.ai/install | bash

# 软件包管理器
npm i -g opencode-ai@latest        # 也可使用 bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS 和 Linux（推荐，始终保持最新）
brew install opencode              # macOS 和 Linux（官方 brew formula，更新频率较低）
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # 任意系统
nix run nixpkgs#opencode           # 或用 github:anomalyco/opencode 获取最新 dev 分支
```

> [!TIP]
> 安装前请先移除 0.1.x 之前的旧版本。

### 桌面应用程序 (BETA)

OpenCode 也提供桌面版应用。可直接从 [发布页 (releases page)](https://github.com/anomalyco/opencode/releases) 或 [opencode.ai/download](https://opencode.ai/download) 下载。

| 平台                  | 下载文件                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`、`.rpm` 或 AppImage         |

```bash
# macOS (Homebrew Cask)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### 安装目录

安装脚本按照以下优先级决定安装路径：

1. `$OPENCODE_INSTALL_DIR` - 自定义安装目录
2. `$XDG_BIN_DIR` - 符合 XDG 基础目录规范的路径
3. `$HOME/bin` - 如果存在或可创建的用户二进制目录
4. `$HOME/.opencode/bin` - 默认备用路径

```bash
# 示例
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode 内置两种 Agent，可用 `Tab` 键快速切换：

- **build** - 默认模式，具备完整权限，适合开发工作
- **plan** - 只读模式，适合代码分析与探索
  - 默认拒绝修改文件
  - 运行 bash 命令前会询问
  - 便于探索未知代码库或规划改动

另外还包含一个 **general** 子 Agent，用于复杂搜索和多步任务，内部使用，也可在消息中输入 `@general` 调用。

了解更多 [Agents](https://opencode.ai/docs/agents) 相关信息。

### 文档

更多配置说明请查看我们的 [**官方文档**](https://opencode.ai/docs)。

### 参与贡献

如有兴趣贡献代码，请在提交 PR 前阅读 [贡献指南 (Contributing Docs)](./CONTRIBUTING.md)。

### 基于 OpenCode 进行开发

如果你在项目名中使用了 “opencode”（如 “opencode-dashboard” 或 “opencode-mobile”），请在 README 里注明该项目不是 OpenCode 团队官方开发，且不存在隶属关系。

---

**加入我们的社区** [飞书](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=52ao9352-5623-4fa0-b7dd-3407c392c1af&qr_code=true) | [X.com](https://x.com/opencode)
