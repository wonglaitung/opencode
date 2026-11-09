# 工作流四：websec（轻量级 WEB 安全测试）

> 面向开发者的授权范围内安全测试工作流：先确认授权，再枚举入口、做只读/低风险检查、取证定级并输出可修复报告。
> 默认只读；写/破坏性动作必须显式授权并逐次确认。无证据结论不得标 confirmed。

## 1. 定位与边界

websec 不是自动化扫描器，也不替代专业渗透测试。它把“人工登录 + Edge/CDP 辅助 + Agent 编排”的轻量测试过程固化为可审计阶段，重点解决：

- 测试前授权、范围、账号、停止条件未记录；
- 入口枚举靠记忆、覆盖不全；
- 结论没有证据、把猜测写成漏洞；
- 报告不可修复、敏感信息外泄；
- 测试过程与工时统计混在普通任务里。

**不做**：爆破、批量利用、真实数据导出、生产环境破坏性验证、绕过授权边界。

## 2. 阶段与清单

| 阶段 | 中文名 | 目的 |
|------|--------|------|
| `scope` | 授权与范围 | 确认授权、目标、环境、账号、时间窗、限速、停止条件 |
| `surface` | 资产与接口 | 枚举页面、接口、参数、身份与触发方式 |
| `checks` | 安全检查 | 按清单做只读/低风险检查 |
| `verify` | 验证与定级 | 复现、取证、排除误报并定级 |
| `report` | 报告与修复 | 输出结构化报告并经开发者确认 |

审查阶段为 `report`，清单五项：

- `scopeAuthorized`：授权与范围已确认；
- `surfaceCovered`：入口与接口已覆盖；
- `checksEvidenced`：每项结论有证据；
- `falsePositiveReviewed`：误报已复核；
- `remediationActionable`：修复建议可执行。

`hasCommitGate=false`，不参与 git 提交门禁。`requiresComprehension=false`：报告由结构化 `websec_report` 承担，不要求代码片段理解确认。

## 3. 专属工具

| 工具 | 阶段 | 作用 |
|------|------|------|
| `websec_scope` | `scope` | 记录授权与范围；必须 `developer_confirmed=true`；未记录 scope 不得进入 `checks` |
| `websec_evidence` | `checks` / `verify` | 登记证据索引：URL、方法、身份、时间、哈希、本地路径；只存元数据，不存正文 |
| `websec_report` | `report` | 提交结构化报告；每条 finding 必须引用已登记 `evidenceRef`；`verdict=passed` 时不得有 findings |

Edge/CDP 是可选外部能力：若当前环境启用 `opencode-edge-debug` 等插件，可用其 start/evaluate/network logs 工具接管已登录会话；websec 不绑定具体浏览器实现，也不采集正文上送。

## 4. 规则要点

- 只测试已授权目标；默认只读（GET/HEAD/OPTIONS）。
- 写操作、删除、批量提交、爆破、越权写、上传利用须开发者显式授权并逐次确认。
- 越权至少需要两个身份对照；只有一个身份时只能标 `suspected`。
- 没有请求/响应、身份、时间与复现步骤的结论不得标 `confirmed`。
- 发现越界、真实数据影响、告警或可用性风险时立即停止并回报。
- 报告敏感信息脱敏；证据正文留在本地，不上行。

## 5. 数据与隐私

`WorkflowState.websec` 只存：

- `scope`：目标、环境、授权依据、账号代号/角色、时间窗、限速、停止条件；
- `evidence[]`：证据 id、URL、方法、身份、采集时间、哈希、本地路径、备注；
- `report`：方法、findings、局限性、结论、提交时间。

不存请求/响应正文、Cookie、令牌、真实用户数据。汇报投影（`WorkflowSummary`）不包含 `websec` 字段，收集端无需数据库迁移。

## 6. 规约注入

`packages/plugin/conventions/websec/` 下按阶段注入：

- `00-测试纪律.md`（global）
- `01-资产与接口.md`（surface）
- `02-鉴权与越权.md`（checks）
- `03-输入与配置.md`（checks）
- `04-证据与定级.md`（verify）
- `05-报告与修复.md`（report）

## 7. 使用方式

1. `opencode-sm init` 选择 `websec`，重启 OpenCode；
2. 新会话说「启动 WEB 安全测试工作流」；
3. 按阶段推进：`workflow_advance` 进入阶段，`websec_*` 落库，`review_submit` 定稿；
4. 报告通过后 `/new` 开始下一个测试。

## 8. 已知限制

- 工作流类型是 daemon/identity 级，切换需重新 `init` 并重启，不能会话内切换。
- 证据正文需由开发者/Agent 落本地文件；本工作流只维护索引。
- 不内置漏洞库、Payload 库或自动化利用能力；结论质量取决于测试者的判断与证据。
