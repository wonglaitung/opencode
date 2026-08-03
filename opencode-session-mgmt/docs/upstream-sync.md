# 上游同步方案

本仓库（`wonglaitung/opencode`）从 [anomalyco/opencode](https://github.com/anomalyco/opencode.git) 复制而来，以 fork 方式维护：**按需手动同步上游**（不自动、不随每次 git pull 同步），同时承载会话管理定制——**全部定制收敛在 `opencode-session-mgmt/` 一个目录内**（`docs/` 设计文档 + `packages/` 工程）。

## Remote 布局

| remote | 仓库 | 用途 |
|--------|------|------|
| `origin` | wonglaitung/opencode（自己的仓库） | 日常 pull / push，**日常唯一用到的 remote** |
| `upstream` | anomalyco/opencode（原项目） | 仅手工同步上游时 fetch；**push 已禁用**（`set-url --push upstream DISABLED`）防手滑。只配置 remote 不执行 fetch/merge 就不会发生任何同步 |

新机器初始化：

```bash
git clone https://github.com/wonglaitung/opencode.git
cd opencode
git remote add upstream https://github.com/anomalyco/opencode.git
git remote set-url --push upstream DISABLED-no-push-to-upstream
```

## 日常同步（默认只走 origin，不碰上游）

```bash
git pull                    # 只同步 origin（wonglaitung/opencode），并合入本地修改
```

**铁律：默认不同步 anomalyco/opencode。** 除非明确要求（例如说「同步上游」「合并上游更新」），不要主动执行 `git fetch upstream`、`git merge upstream/dev` 等任何上游同步命令；`git pull` 一律只针对 origin。

## 手工同步上游（仅在明确要求时执行）

```bash
git fetch upstream          # 取原项目更新
git merge upstream/dev      # 并入本地 dev（上游默认分支也是 dev）
git push origin dev         # 推到自己仓库
```

用 **merge 不用 rebase**：dev 是已发布分支，rebase 会改写历史。

## 为什么不会有合并冲突

零侵入架构（设计文档 2.4、11）保证全部定制收敛在上游**永远不会创建**的两个路径：

| 路径 | 内容 |
|------|------|
| `opencode-session-mgmt/` | 设计文档（`docs/`）+ 插件 / CLI / 收集服务工程（`packages/`，独立 bun workspace，不被上游根 workspace 收录） |

**铁律：不修改 `packages/*` 下任何上游文件。** 只要守住这条，每次同步都是 git 自动合并，无人工冲突。

## 同步节奏与版本策略

- **频率**：按需手工触发，无定时/自动同步；建议不宜积压过久（不冲突，但回归测试面随提交量变宽）
- **生产锚点**：跟随上游 tag（`git fetch upstream --tags`，合并 `v0.x.y`）锚定稳定版本，比追 dev 每个提交更稳
- **同步后检查清单**：
  1. 跑上游既有测试确认无回归
  2. 确认插件依赖的 hook 签名未变——唯一风险点是 `experimental.chat.system.transform`（experimental 前缀），变更时只需改插件 `packages/plugin/src/prompt.ts` 适配层
  3. 确认上游根 `package.json` 的 workspace glob 仍不匹配 `opencode-session-mgmt/`

## 万一出现冲突

仅两种可能，均有预案：

| 情形 | 处理 |
|------|------|
| 上游恰好新增了 `opencode-session-mgmt/` 同名路径（极小概率） | 保留上游版本，将我们的目录改名迁移，更新文档引用 |
| 有人违规改了 `packages/*` 上游文件 | 冲突解决时一律取上游版本，定制改回插件实现 |

## 同步记录

| 日期 | 上游提交 | 结果 |
|------|----------|------|
| 2026-08-01 | 4 个（`f67e80c275` 等，39 文件，均为 i18n/文档） | 零重叠零冲突，ort 策略自动合并（`f77a51ea08`） |
