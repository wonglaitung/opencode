<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent.</p>
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

> **Unofficial fork notice:** this repository is a customized fork of
> [anomalyco/opencode](https://github.com/anomalyco/opencode), used for an internal Windows delivery.
> It is not maintained by the OpenCode team. Upstream installation and documentation remain below.

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

## This fork

This repository is an **unofficial fork** of [anomalyco/opencode](https://github.com/anomalyco/opencode),
used for an internal Windows delivery. Upstream OpenCode is the base; the additions below are
maintained in this fork and are not part of the official project. Other language READMEs are
upstream translations and may not cover these customizations.

### What this fork adds

- **`opencode-session-mgmt/`** — workflow engine, rules, local statistics CLI (`opencode-sm`), and
  report client for the external collector.
- **Three workflows**:
  - `task` — general work such as writing documents or analyzing errors. One stage, no review or
    commit gate. Records estimated hours and actual duration; say **“完成”** in the session to finish.
  - `sdlc` — five-stage software development flow with review and git commit gates.
  - `reqdoc` — five-stage business requirements flow that produces a PRD for business confirmation.
- **`opencode-edge-debug/` and `opencode-server-debug/`** — optional debugging plugins.
- **`portable-installer/`** — Windows portable installer and launcher. The launcher selects the
  workflow and uses the **AI Assistant** branding.
- **Offline build support** — `--offline` builds skip config-directory dependency installation.
- **`.opencode/skills/`** — local installer and Windows plugin-load verification skills.

### Quick start (Windows)

1. Build or run `OpenCode-Setup.exe` / `OpenCode-launch.exe` from `portable-installer/`.
2. Run `opencode-sm init` once: API key, collector URL, and default workflow (`task` / `sdlc` / `reqdoc`).
3. Launch the app and pick the workflow in the launcher:
   - `task`: type the task directly; estimate with “预估 xx 小时”; say “完成” to stop the timer.
   - `sdlc`: enter “启动 SDLC 工作流”.
   - `reqdoc`: enter “启动 REQDOC 工作流”.
4. Inspect local statistics with `opencode-sm stats --workflow task` (or `sdlc` / `reqdoc`).

### Workflow selection

The launcher writes the selected type to `~/.config/opencode/session-mgmt/identity.json`.
It applies to all new sessions started by that opencode process; it is not a per-session switch.
Use `/new` when moving between tasks.

### Repository layout

| Path | Purpose |
|---|---|
| `packages/*` | Upstream OpenCode packages (the base) |
| `opencode-session-mgmt/` | Workflow engine, CLI, docs, tests |
| `opencode-edge-debug/` | Edge debugging plugin |
| `opencode-server-debug/` | Server debugging plugin |
| `portable-installer/` | Windows installer / launcher |
| `plugin-guide/` | Fork maintenance and upstream upgrade notes |

### Docs

- [Session management and architecture](opencode-session-mgmt/docs/session-management.md)
- [task workflow](opencode-session-mgmt/docs/workflow-task.md)
- [SDLC workflow](opencode-session-mgmt/docs/workflow-sdlc.md)
- [REQDOC workflow](opencode-session-mgmt/docs/workflow-reqdoc.md)
- [Deployment](opencode-session-mgmt/docs/deployment.md)
- [Upstream upgrade checklist](plugin-guide/opencode-upgrade-checklist.md)

### Upstream sync

Daily development syncs `origin` only. `upstream` (anomalyco/opencode) is pulled manually when
requested; local patches are tracked in the upgrade checklist. Do not treat this fork's README
sections as upstream documentation.

### Privacy

Reports contain session summaries (workflow state, duration, cost/tokens) and never code content.
The API key is SHA-256 hashed before upload.

### Known limitations

- `task` is covered by unit/text tests but is not yet in the model-evaluation set.
- The Windows installer must be rebuilt after launcher/runtime changes; build artifacts are not
  tracked in git.
- The collector is an external project: <https://github.com/karsonto/performance_dashboard>.
- The launcher selection is daemon-level; mixing different workflow types across historical
  sessions in one process is not supported.

---

## Upstream OpenCode

> Everything below is the upstream project README. It may not describe this fork's customizations.

### Installation

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest        # or bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS and Linux (recommended, always up to date)
brew install opencode              # macOS and Linux (official brew formula, updated less)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # Any OS
nix run nixpkgs#opencode           # or github:anomalyco/opencode for latest dev branch
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Desktop App (BETA)

OpenCode is also available as a desktop application. Download directly from the [releases page](https://github.com/anomalyco/opencode/releases) or [opencode.ai/download](https://opencode.ai/download).

| Platform              | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, or `.AppImage`     |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$OPENCODE_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if it exists or can be created)
4. `$HOME/.opencode/bin` - Default fallback

```bash
# Examples
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://opencode.ai/docs/agents).

### Documentation

For more info on how to configure OpenCode, [**head over to our docs**](https://opencode.ai/docs).

### Contributing

If you're interested in contributing to OpenCode, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on OpenCode

If you are working on a project that's related to OpenCode and is using "opencode" as part of its name, for example "opencode-dashboard" or "opencode-mobile", please add a note to your README to clarify that it is not built by the OpenCode team and is not affiliated with us in any way.

---

**Join our community** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
