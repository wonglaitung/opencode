# 工作流四：websec（轻量级 WEB 安全测试）

> 面向开发者的安全自测工作流：先确认范围与边界，再枚举入口、做只读/低风险检查、取证定级并输出可修复报告。内部开发自测不需要工单、邮件或合同，只需确认目标属于你负责或获准自测的范围。
> 默认只读；写/破坏性动作必须显式授权并逐次确认。无证据结论不得标 confirmed。

## 1. 定位与边界

websec 不是自动化扫描器，也不替代专业渗透测试。它把“人工登录 + Edge/CDP 辅助 + Agent 编排”的轻量测试过程固化为可审计阶段，重点解决：

- 测试前范围、边界、账号、停止条件未记录；
- 入口枚举靠记忆、覆盖不全；
- 结论没有证据、把猜测写成漏洞；
- 报告不可修复、敏感信息外泄；
- 测试过程与工时统计混在普通任务里。

**不做**：爆破、批量利用、真实数据导出、生产环境破坏性验证、绕过测试边界。

## 2. 阶段与清单

| 阶段 | 中文名 | 目的 |
|------|--------|------|
| `scope` | 范围与边界 | 确认目标、环境、账号、时间窗、限速、停止条件 |
| `surface` | 资产与接口 | 枚举页面、接口、参数、身份与触发方式 |
| `checks` | 安全检查 | 按清单做只读/低风险检查 |
| `verify` | 验证与定级 | 复现、取证、排除误报并定级 |
| `report` | 报告与修复 | 输出结构化报告并经开发者确认 |

审查阶段为 `report`，清单五项：

- `scopeAuthorized`：测试范围与边界已确认；
- `surfaceCovered`：入口与接口已覆盖；
- `checksEvidenced`：每项结论有证据；
- `falsePositiveReviewed`：误报已复核；
- `remediationActionable`：修复建议可执行。

`hasCommitGate=false`，不参与 git 提交门禁。`requiresComprehension=false`：报告由结构化 `websec_report` 承担，不要求代码片段理解确认。

## 3. 专属工具

| 工具 | 阶段 | 作用 |
|------|------|------|
| `websec_scope` | `scope` | 记录范围与边界；可选 `evidence_dir` 指定项目内证据目录（默认 `websec-evidence`）；必须 `developer_confirmed=true` |
| `websec_evidence` | `checks` / `verify` | 登记证据索引：URL、方法、身份、时间、哈希、本地路径；只存元数据，不存正文 |
| `websec_report` | `report` | 提交结构化报告；每条 finding 必须引用已登记 `evidenceRef`；`verdict=passed` 时不得有 findings |
| `websec_edge_capture` | `surface` / `checks` | 可选：`start(mode)` 打开 Edge；普通测试 `capture(single)`，越权测试 `capture(baseline/privileged)` + `switch_identity`；`finish` 确认完成，`stop` 关闭；只回摘要 |
| `websec_authz_compare` | `checks` | 越权测试专用：按 method + URL 对比 baseline/privileged 的状态码、正文有无、哈希差异；不返回正文 |

Edge/CDP 是可选外部能力：若当前环境启用 `websec_edge_capture`，它会复用 `edge-debug-core` 接管已登录会话；websec 不绑定具体浏览器实现，也不采集正文上送。没有该工具时退回人工浏览/curl。

报告门禁：Edge 启动后必须先 `finish` 才能提交报告；越权 `confirmed` 必须同时引用 baseline/privileged 证据，普通测试 `confirmed` 必须有正文证据。

## 4. 规则要点

- 进入范围阶段会问预估工时；未录入时 `review_submit` 会被拦截。
- 完成口令统一为「本次录入已完成」；只说「完成」时，Agent 会先确认「本次录入是否已完成？」。
- 启动 Edge 前先问「普通测试还是越权测试」；普通测试只做一轮采集（single），越权测试做 baseline/privileged 两轮采集。这里的 single/baseline/privileged 是采集阶段，不是工作流五阶段。
- 越权测试切换身份后必须重新登录，不能沿用上一个账号的 Cookie。
- 只测试你负责或获准自测的目标；默认只读（GET/HEAD/OPTIONS）。
- 写操作、删除、批量提交、爆破、越权写、上传利用须开发者显式授权并逐次确认。
- 越权至少需要两个身份对照；只有一个身份时只能标 `suspected`。
- 没有请求/响应、身份、时间与复现步骤的结论不得标 `confirmed`。
- 发现越界、真实数据影响、告警或可用性风险时立即停止并回报。
- 报告敏感信息脱敏；证据正文留在本地，不上行。

## 5. 数据与隐私

`WorkflowState.websec` 只存：

- `scope`：目标、环境、账号代号/角色、时间窗、限速、停止条件、证据目录（`evidenceDir`）；
- `testMode` / `edge`：普通/越权模式与 start/finish 状态；
- `evidence[]`：证据 id、URL、方法、身份、阶段（single/baseline/privileged）、采集时间、哈希、本地路径、备注、状态码/正文有无；
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

## 7. 用户使用指南

### 7.1 开始前准备

1. 执行 `opencode-sm init`，工作流类型选择 `websec`，重启 OpenCode，并开新会话。
2. 准备四类信息：
   - 目标 URL 与环境（dev / staging / prod）；
   - 测试账号与角色（普通测试至少一个；越权测试必须两个：普通 + 高权）；
   - 时间窗与限速；
   - 停止条件（如触发告警、需要写操作、遇到真实用户数据）。
3. 证据正文默认落在项目根 `websec-evidence/<sessionID>/`，目录内自动生成 `.gitignore`；可用 `websec_scope(evidence_dir="...")` 改到项目内其它目录。系统只存 URL、方法、身份、时间、哈希和本地路径。
4. 进入范围阶段会问预估工时，请回「预估 xx 小时」；未录入时不能定稿。

内部开发自测不需要工单、邮件或合同；只要确认目标属于你负责或获准自测的范围即可。

### 7.2 启动与阶段动作

直接对 Agent 说：

> 启动 WEB 安全测试工作流，目标是 `https://staging.example.com`，账号 `u1/普通用户`，停止条件：触发告警或需要写操作。

若环境启用了 `websec_edge_capture`，Agent 会先问：

> 这次是普通测试，还是越权测试？

- **普通测试**：启动 Edge，你登录后正常操作；完成后说「本次录入已完成」，Agent 采集证据并生成报告。
- **越权测试**：你先用普通/低权账号操作，说「本次录入已完成」；Agent 清除登录态后，你用高权账号重新登录并走同样流程，再说一次「本次录入已完成」；Agent 对比两组证据后生成报告。

> 注意：系统工作流固定五阶段（范围与边界 → 资产与接口 → 安全检查 → 验证与定级 → 报告与修复）。普通测试/越权测试是 Edge 采集模式，不是阶段定义；普通测试的用户操作可简化为三步：确认范围与预估 → 登录操作 → 说「本次录入已完成」，中间阶段由 Agent 内部推进。

websec 模式会保留同源 2xx 页面/接口、3xx 和 4xx/5xx，缓冲 500 条；脚本只留元数据，正文落本地。

| 阶段 | 用户要做什么 | Agent 会做什么 |
|------|--------------|----------------|
| 范围与边界 | 提供目标、账号、停止条件，并明确说「确认范围」；按提示给出预估工时 | 记录 scope；询问预估工时；没有 scope 不允许进入检查 |
| 资产与接口 | 人工登录目标系统，或确认可以接管已登录浏览器 | 枚举页面、接口、参数、身份；排除 logout/delete 等破坏性入口 |
| 安全检查 | 明确同意只读检查；任何写操作单独说「允许执行某操作」 | 做鉴权、越权、输入、配置、轻量业务逻辑检查；登记证据 |
| 验证与定级 | 帮助确认复现步骤或补充身份 | 做 baseline/proof 对比，排除误报，按 critical/high/medium/low/info 定级 |
| 报告与修复 | 审阅报告和修复建议 | 调 `websec_report` 生成结构化报告，再调 `review_submit` 定稿 |

### 7.3 常用对话

- 选模式：`普通测试` / `越权测试`
- 推进阶段：`确认以上范围，进入资产与接口阶段。`
- 普通测试完成：`本次录入已完成`
- 越权测试：每个阶段结束都说 `本次录入已完成`
- 允许一次低风险写操作：`允许对 /api/profile 执行一次 POST 测试，其它写操作不允许。`
- 标记证据不足：`这条没有两个身份对照，只能标 suspected，不要标 confirmed。`
- 定稿：`报告没问题，五项清单都确认，提交审查。`

### 7.4 完成之后

- `review_submit` 通过后工作流完成。
- 执行 `/new` 开始下一次测试，保持统计隔离。
- 修复后复测也建议新会话，不要在同一会话追加第二轮。

### 7.5 安全边界

- 默认只读（GET/HEAD/OPTIONS）。
- 写、删除、批量提交、爆破、上传利用必须逐次明确授权。
- 无证据只能标 suspected，不能标 confirmed。
- 发现越界、真实数据影响、告警或可用性风险时立即停止。

## 8. 已知限制

- 工作流类型是 daemon/identity 级，切换需重新 `init` 并重启，不能会话内切换。
- 证据正文默认落 `<项目>/websec-evidence/<sessionID>/`，目录内 `.gitignore` 忽略正文；文件权限 0600（Windows 忽略）。
- 不内置漏洞库、Payload 库或自动化利用能力；结论质量取决于测试者的判断与证据。
- 越权测试需要至少两个不同角色的账号；切换身份后必须重新登录，不能沿用上一个账号的 Cookie。baseline 日志未采集完时不能切换身份。
- `switch_identity` 会清 Cookie/storage/cache 并刷新，但仍共用同一个浏览器 profile；高安全场景建议使用独立 profile/无痕窗口。
- Edge 采集为可选能力：需要安装 Edge 并启用 `edge-debug-core`；websec 模式保留同源 2xx Document/XHR/Fetch、3xx、4xx/5xx（缓冲 500），脚本仅元数据，静态资源丢弃；仍受单标签页、响应体按需读取等限制。
