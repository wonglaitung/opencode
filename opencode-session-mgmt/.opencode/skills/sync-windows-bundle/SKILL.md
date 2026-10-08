---
name: sync-windows-bundle
description: Use when syncing local (WSL/Linux) source changes into the Windows-side opencode bundle so the Windows opencode (running on Node 22 at D:\Tools\node-v22.23.2-win-x64) picks up plugin/CLI/docs changes without manual copy. Triggers 同步 / sync / 同步到 Windows / D:\Tools / node-v22 / bundle / 重启守护进程.
---

# 同步到 Windows bundle（sync-bundle）

把本机（WSL/Linux）改动的**插件 / CLI / 文档**镜像进 Windows 上已解压的 bundle，免去手工 copy。本工程改动后、要在 Windows 侧 opencode 生效前必跑。

## 单一事实源与默认目标

- 脚本：`opencode-session-mgmt/scripts/sync-bundle.sh`（脚本自身会 `cd` 到仓库根，从哪运行都行）。
- 默认 bundle（WSL 路径）：`/mnt/d/Tools/node-v22.23.2-win-x64/opencode-sm-bundle-0.1.0`
  等价于 Windows 侧 `D:\Tools\node-v22.23.2-win-x64\opencode-sm-bundle-0.1.0`。
- 换目标：`BUNDLE="/mnt/d/其它路径/opencode-sm-bundle-0.1.0" bash scripts/sync-bundle.sh`。

## 运行

```bash
cd opencode-session-mgmt
bash scripts/sync-bundle.sh
```

`FORCE_VENDOR=1` 强制重装 `vendor/mermaid-cli`（离线 Mermaid 渲染依赖，平时幂等跳过）。

## 它做了什么（关键点）

bundle 是 **hoisted 模式**打包：每个 workspace 包在 bundle 里存在**两份**——

- `packages/<ws>` 与 `node_modules/<pkgname>`

插件实际 `import` 的是 `node_modules/<pkgname>`，**所以改了包必须两处都更新，否则不生效**。脚本用 rsync（`-aL --delete --exclude node_modules`，优先）或回退 cp，把 `packages/{shared,plugin,cli}` 同步到这两处，再同步 `docs/`，最后幂等安装 vendor/mermaid-cli。结尾校验同步目录**无符号链接**（整包须为真实文件，否则 Windows 上软链易断链致插件加载失败）。

## 前置条件

- bundle 目录须已存在（脚本找不到会报错退出）。
- 优先 `rsync`；缺失则回退 `cp -rL`。
- 工作树建议先干净（`git status`），避免把未提交改动意外同步出去——脚本不检查 git 状态，它只管镜像当前文件。

## 收尾（必做）

同步完成后，**重启 Windows 侧 opencode 守护进程**（关闭再开），插件才会重新加载这批内容。只同步不重启 = 改动看不到。

## 排错

- `错误：找不到 BUNDLE 目录` → bundle 路径不对或没解压；用 `BUNDLE=` 覆盖。
- `⚠ 发现符号链接` → 源码里混入了软链，脚本拒绝继续；改为真实文件后重试（bundle 跨机器/Windows 不能带软链）。
