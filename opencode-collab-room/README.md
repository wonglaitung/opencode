# opencode-collab-room

把当前 opencode 会话**实时分享**给同一局域网里的同事：他们只读旁观，
可以提建议、排队任务、看工具输出与审批内容，但**不消耗自己的模型额度**。

- **TUI 插件**：只注册在 `~/.config/opencode/tui.json` 的 `plugin` 数组，不写 `opencode.jsonc`。
- **零外部依赖**：WS 服务端用 `Bun.serve`，界面用 OpenTUI + Solid，不联网、不落盘播放记录。
- **不持久化**：房间随主机终端关闭而结束；重连后靠快照补齐。

## 两种角色

### 主持（host）

启动器「团队协作 → 协作房间 → 开协作房间」写入意图文件后启动 opencode，插件在
当前会话上开房：

- 起一个随机端口的 WS 服务（监听 `0.0.0.0`），生成随机 token（32 位十六进制），
  邀请码形如 `ws://192.168.x.x:54321?token=…`。
- 侧栏 / 首页底部出现「协作房间」卡片，显示邀请码、人数、队列与等待审批项。
- 广播会话快照、消息增量、工具输出、审批请求、AI 提问与会话错误。
- 访客建议以 `[昵称 的建议] …` 写入当前会话（`noReply`，不触发模型回答）；
  排队任务在主机空闲时按先后顺序提交给当前会话，并自动重置会话的轮次预算。

命令（Ctrl+P / `/` 均可）：`协作房间：状态`（`/room-status`）、`协作房间：关闭房间`（`/room-stop`）。

### 访客（guest）

启动器「加入协作房间」填邀请码、昵称与工作目录后启动，插件直接进入房间视图：

- 版面与正常会话页一致：用户消息、markdown 正文、思考、工具行（bash 输出、edit diff、
  read/grep 结果、todo、子代理）、权限卡、提问卡、会话错误。
- 底部显示主机 agent / 模型、Token 与成本、队列人数、连接状态。
- 输入框两种模式：**建议**（默认，直接进主机上下文）与**排队**（主机按顺序执行）；
  排队成功自动切回建议，避免下一句误发。
- 审批与提问只读展示，由主机确认；访客不能代表主机授权。

## 键位

| 键 | 作用 |
|---|---|
| `Alt+M` / `F3` | 切换建议 / 排队 |
| `PageUp` / `Ctrl+Alt+B` | 向上翻半页 |
| `PageDown` / `Ctrl+Alt+F` | 向下翻半页 |
| `Esc` | 退出房间视图（房间继续，主机不受影响） |

滚回历史后不会因新内容跳回底部；回到底部后恢复自动跟随。

## 协议

邀请码只带 URL 与 token；`hello` 之后由 host 推快照，之后增量。

客户端 → 主机：

| 类型 | 字段 |
|---|---|
| `hello` | `name` |
| `suggest` | `text` |
| `queue` | `id`、`text` |
| `queue.cancel` | `id` |
| `ping` | — |

主机 → 客户端：

| 类型 | 说明 |
|---|---|
| `hello` / `snapshot` / `state` | 房间信息、全量消息、状态与队列 |
| `message.updated` | 消息级信息（agent、model、cost、tokens、finish、error） |
| `part.delta` / `part.updated` | 文本增量与整段更新（工具状态、补丁） |
| `permission` / `permission.result` | 审批详情与结果（仅展示，不能代答） |
| `question` / `question.result` | AI 提问与主机选择 |
| `session.error` | 主机模型错误 |
| `bye` | 房间结束原因 |

保护上限：单段文本 `MAX_PART_TEXT = 64_000`、工具输出 `MAX_TOOL_OUTPUT = 32_000`，
超长截断并标注；访客侧对流式追加同样截断。队列最多 20 条，重复 id 去重。

看门狗：排队的任务提交后 90 秒没有任何输出，最多重排一次，之后丢弃并提示，
避免一条毒丸任务卡住整个队列。

## 安全边界

- 传输是明文 `ws://`，只在可信局域网使用；token 泄露等于拿到「旁观 + 建议 + 排队」权限。
- 访客不运行本机模型，也不能执行工具；所有写操作与审批都在主机侧。
- 房间内容包含完整会话正文（代码、路径），邀请码请走可信渠道。
- 断线自动重连（500ms 起指数退避，上限 15s；连接超时 8s），重连后靠快照补齐。

## 日志

主机与访客都写入 `~/.local/share/opencode/log/collab-room.log`
（`[host]` / `[guest]` 前缀），排查连接、按键与快照问题时先看这里。

## 目录

```
src/
├── tui.ts        # 插件入口：消费意图 → 开房或进房
├── host.tsx      # 主机侧：事件桥接、快照、审批/提问转发、侧栏卡片、命令
├── relay.ts      # WS 服务端、token 校验、广播、peer 管理
├── route.tsx     # 访客房间页（消息、输入、底部状态、键位）
├── feed.ts       # 访客状态合并（快照/增量/审批/提问/错误）
├── client.ts     # 访客 WS 客户端、重连与会话状态
├── protocol.ts   # 双向消息类型、解析与截断上限
├── room.ts       # 主机状态机（忙闲、审批、队列、看门狗）
├── queue.ts      # 队列（上限、去重）
├── intent.ts     # 启动器意图文件（host / join）
├── net.ts        # 局域网地址挑选
└── view/         # 与正常会话页对齐的渲染组件
```

## 开发

```bash
bun test          # 61 个测试
bun x tsc --noEmit
bun run build     # 产出 dist/tui.js
./script/sync-bundle.sh   # 同步到打包源目录并校验
```

构建必须使用 `@opentui/solid/bun-plugin` 的 `createSolidTransformPlugin()`：
否则 JSX 被编译成静态值，信号变化不重绘（消息列表停在首帧）。

bundle 保留 `from "solid-js"` / `from "@opentui/core"` 这类**带空格的裸导入**：
宿主 runtime plugin 依赖该形式把模块改写成宿主实例；压缩成 `from"x"` 会加载到
插件自己的副本，出现「同一 Solid 两个实例」或找不到包。`sync-bundle.sh` 会检查这两点。

宿主侧注入的组件（`SplitBorder`、`PermissionPrompt` 等）无法从插件 import，
`src/view/` 是按正常会话页移植的精简实现，样式参数保持一致。
