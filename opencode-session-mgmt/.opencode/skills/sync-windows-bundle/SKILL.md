---
name: sync-windows-bundle
description: Use when syncing local (WSL/Linux) source changes into the Windows-side opencode bundles so the Windows opencode (running on Node 22 at D:\Tools\node-v22.23.2-win-x64) picks up plugin/CLI/docs changes without manual copy. Covers all three sibling projects — opencode-session-mgmt (opencode-sm-bundle), opencode-edge-debug (opencode-edge-debug-bundle), opencode-server-debug (opencode-server-debug-bundle). Also asks whether to rebuild the Windows binary and copies the result into node_modules/opencode-ai/bin/opencode.exe. Triggers 同步 / sync / 同步到 Windows / 重建二进制 / D:\Tools / node-v22 / bundle / 重启守护进程 / edge-debug / server-debug.
---

# 同步到 Windows bundle（sync-bundle）

把本机（WSL/Linux）改动的**插件 / CLI / 文档**镜像进 Windows 上已解压的 bundle，免去手工 copy。本工程改动后、要在 Windows 侧 opencode 生效前必跑。

## 三个工程 × 三个 bundle（同处 Windows 便携 runtime）

根仓库 `/data/opencode` 下有三个独立工程，各带自己的 `scripts/sync-bundle.sh`，默认都指向 `D:\Tools\node-v22.23.2-win-x64` 下的同名 bundle：

| 工程（仓库子目录） | 脚本 | 默认 bundle（WSL） | 默认 bundle（Windows） |
|---|---|---|---|
| opencode-session-mgmt | scripts/sync-bundle.sh | /mnt/d/Tools/node-v22.23.2-win-x64/opencode-sm-bundle | D:\Tools\node-v22.23.2-win-x64\opencode-sm-bundle |
| opencode-edge-debug | scripts/sync-bundle.sh | /mnt/d/Tools/node-v22.23.2-win-x64/opencode-edge-debug-bundle | D:\Tools\node-v22.23.2-win-x64\opencode-edge-debug-bundle |
| opencode-server-debug | scripts/sync-bundle.sh | /mnt/d/Tools/node-v22.23.2-win-x64/opencode-server-debug-bundle | D:\Tools\node-v22.23.2-win-x64\opencode-server-debug-bundle |

换目标：`BUNDLE="/mnt/d/其它路径/xxx-bundle" bash scripts/sync-bundle.sh`。

## 同步前：先问是否重建二进制（必做）

每次执行本技能前，必须先问用户：

- 只同步插件/CLI/文档；
- 还是同时重建 Windows opencode 二进制。

不要默认重建，也不要在用户未确认时替换 `opencode.exe`。

推荐执行顺序：

1. 先询问本次是否重建二进制。
2. 如需重建：构建 → 复制到目标路径 → `--version` 校验。
3. 运行三个 `sync-bundle.sh`。
4. 依赖有变化时，在 Windows 侧 bundle 执行 `bun install`。
5. 重启 Windows 侧 opencode 守护进程。

### 如需重建

使用项目当前 Windows 构建流程。普通包不加 `--offline`；离线包加 `--offline`。构建完成后，必须把产物复制到：

```text
D:\Tools\node-v22.23.2-win-x64\node_modules\opencode-ai\bin\opencode.exe
```

WSL 等价路径：

```bash
cp <实际构建产物>/opencode.exe /mnt/d/Tools/node-v22.23.2-win-x64/node_modules/opencode-ai/bin/opencode.exe
```

复制后校验：

```bash
/mnt/d/Tools/node-v22.23.2-win-x64/node_modules/opencode-ai/bin/opencode.exe --version
```

注意：

- 目标不是 runtime 根目录，而是 `node_modules/opencode-ai/bin/opencode.exe`。
- 用户未要求时不要创建 `.bak` 备份。
- 如果用户要离线包，构建时加 `--offline`。
- 复制后仍要继续执行下面的 bundle 同步与重启。

## 同步 bundle（三个都跑，漏一个那个插件就看不到改动）

每个工程各自跑一次（脚本会 `cd` 到自身仓库根，从哪运行都行）：

```bash
bash /data/opencode/opencode-session-mgmt/scripts/sync-bundle.sh
bash /data/opencode/opencode-edge-debug/scripts/sync-bundle.sh
bash /data/opencode/opencode-server-debug/scripts/sync-bundle.sh
```

## 它做了什么（关键点）

bundle 是 **hoisted 模式**打包：每个 workspace 包在 bundle 里存在**两份**——

- `packages/<ws>` 与 `node_modules/<pkgname>`

插件实际 `import` 的是 `node_modules/<pkgname>`，**所以改了包必须两处都更新，否则不生效**。脚本用 rsync（`-aL --delete --exclude node_modules`，优先）或回退 cp，把 `packages/{shared,plugin,cli}` 同步到这两处，再同步 `docs/`，最后幂等安装 vendor/mermaid-cli。结尾校验同步目录**无符号链接**（整包须为真实文件，否则 Windows 上软链易断链致插件加载失败）。

edge-debug / server-debug 两个脚本只**镜像插件源码**（保留 `node_modules` 与 `setup.*` 不被覆盖或删除），机制比 session-mgmt 简单，但同样结尾校验无符号链接、同样要求同步后重启守护进程。

## 前置条件

- bundle 目录须已存在（脚本找不到会报错退出）。
- 优先 `rsync`；缺失则回退 `cp -rL`。
- 工作树建议先干净（`git status`），避免把未提交改动意外同步出去——脚本不检查 git 状态，它只管镜像当前文件。

## 收尾（必做）

同步完成后，**重启 Windows 侧 opencode 守护进程**（关闭再开），插件才会重新加载这批内容。只同步不重启 = 改动看不到。

如果本次重建了二进制，重启前先确认：

- `opencode.exe` 已复制到 `D:\Tools\node-v22.23.2-win-x64\node_modules\opencode-ai\bin\opencode.exe`。
- `opencode.exe --version` 输出符合预期。

## 排错

- `错误：找不到 BUNDLE 目录` → bundle 路径不对或没解压；用 `BUNDLE=` 覆盖。
- `⚠ 发现符号链接` → 源码里混入了软链，脚本拒绝继续；改为真实文件后重试（bundle 跨机器/Windows 不能带软链）。
