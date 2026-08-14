---
description: 打包可移植 tarball（bun run pack:bundle）
---

在项目根目录运行 `bun run pack:bundle` 生成可移植 tarball → `dist/opencode-edge-debug-bundle-<版本>.tgz`（含 hoisted node_modules 依赖与离线 seed，供内网/离线部署）。

注意：打包前若有依赖变更，先 `bun install` 确保 `node_modules` 为最新 hoisted 状态。打包产物确认存在并报告路径。
