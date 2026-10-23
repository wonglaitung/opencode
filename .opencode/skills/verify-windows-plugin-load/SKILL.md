---
name: verify-windows-plugin-load
description: Verify the three custom opencode plugins (sm-plugin, edge-debug, server-debug) actually load and register their hooks and tools on the Windows opencode.exe. Use after rebuilding or replacing the Windows binary, syncing Windows plugin bundles, or upgrading @opencode-ai/plugin dependencies. Triggers include 插件实测加载, configured=3 loaded=3, hooks 注册, 插件工具数, and Windows 1.19.4 smoke test.
---

# Verify Windows Plugin Load

Runs a disposable `opencode serve` instance on Windows with only the three custom
plugin bundles configured, triggers instance creation, and asserts that every
plugin loaded and registered hooks.

This verifies the **deployed Windows bundles** against the **deployed Windows
binary**. It does not test the source tree. Run the relevant build and
`sync-windows-bundle` steps first.

## Prerequisites

- WSL with the Windows runtime under `/mnt/d/Tools/node-v22.23.2-win-x64`
  (override with `OPENCODE_WIN_ROOT`).
- `opencode.exe` already replaced with the build under test.
- Windows bundles already synced and installed with Windows Bun:
  - `opencode-sm-bundle-*/packages/plugin`
  - `opencode-edge-debug-bundle-*`
  - `opencode-server-debug-bundle-*`
- Windows `cmd.exe`, `powershell.exe`, `curl.exe`, and `taskkill.exe`.
- Windows Bun at `$OPENCODE_WIN_ROOT/node_modules/bun/bin/bun.exe`
  (override with `BUN`).

## Run

From any directory:

```bash
bash .opencode/skills/verify-windows-plugin-load/scripts/verify.sh
```

Expected success output:

```text
OK sm-plugin hooks=["experimental.chat.system.transform","tool",...]
OK edge-debug hooks=["tool","dispose"]
OK server-debug hooks=["tool","dispose"]
OK sm-plugin tools=30 registered=30
OK edge-debug tools=8 registered=8
OK server-debug tools=7 registered=7
OK binary=1.19.4 configured=3 loaded=3 tools=45 failed=0
```

Counts above are current for the three bundles and may change as plugins evolve;
the check is that every exported tool is present in the live registry.

The script exits non-zero on a version mismatch, load failure, missing plugin,
empty hooks, missing expected hooks, or tools missing from the live registry.
On failure it keeps the temporary project and logs and prints their path.

## What It Checks

1. `opencode.exe --version` matches `EXPECT_VERSION` (default `1.19.4`).
2. `plugin.load.summary` reports `configured == loaded`, `skipped=0`,
   `missing=0`, `failed=0`.
3. Each bundle has a `plugin.applied` line whose `spec=` matches the configured
   bundle path.
4. Expected hooks are present: session plugin has
   `experimental.chat.system.transform`; all three have `dispose`; edge and
   server have `tool`.
5. Each deployed bundle is constructed with Windows Bun to list the tools it
   exports, and every exported tool name is found in the live
   `/experimental/tool/ids` registry.

`opencode serve` loads plugins lazily, so the script requests `/config` to force
instance creation. The first request may take several seconds; the script polls
until it returns HTTP 200.

## Overrides

```bash
OPENCODE_WIN_ROOT=/mnt/d/Tools/node-v22.23.2-win-x64 \
EXPECT_VERSION=1.19.4 \
PORT=4100 \
SM_PLUGIN=/mnt/d/Tools/opencode-sm-bundle-0.1.0/packages/plugin \
EDGE_PLUGIN=/mnt/d/Tools/opencode-edge-debug-bundle-0.0.1 \
SERVER_PLUGIN=/mnt/d/Tools/opencode-server-debug-bundle-0.0.1 \
BUN=/mnt/d/Tools/node-v22.23.2-win-x64/node_modules/bun/bin/bun.exe \
VERBOSE=1 \
bash .opencode/skills/verify-windows-plugin-load/scripts/verify.sh
```

`PORT` is optional; by default the script picks the first free port in
`4097-4199`. It refuses to start if an explicitly requested port is occupied,
so it never kills a pre-existing opencode instance. Set `VERBOSE=1` to print
the tool names behind each count.

## Safety

- Uses a temporary project under `$OPENCODE_WIN_ROOT/opencode-plugin-smoke.<pid>`
  so the real global/project config is untouched.
- Cleans up by killing only the process tree it started, plus any process still
  listening on its chosen free port.
- Keeps logs only when verification fails.

## Interpreting Failures

- `plugin.load.failed ... stage=...`: the bundle could not be imported. Check
  the Windows bundle's `node_modules`, especially `@opencode-ai/plugin`,
  `@opencode-ai/sdk`, and native optional dependencies such as
  `@resvg/resvg-js-win32-x64-msvc`.
- `missing=1`: the configured path does not resolve on Windows. Check the path
  in `opencode.json` and whether the bundle exists.
- `plugin.applied ... hooks=[]`: the export shape or legacy hook detection is
  wrong for that version.
- `tools=N registered=M` with `N != M`: the bundle exports tools that opencode
  did not register. Check whether the plugin throws during construction or
  whether its tool names are filtered.
- `TOOLS_ERROR`: constructing the deployed bundle failed. Run Windows Bun
  manually in the kept temp directory and inspect `tools.err`.
- Server never becomes ready: inspect the kept `stderr.log` for startup errors
  and confirm the binary is not blocked by Windows.
