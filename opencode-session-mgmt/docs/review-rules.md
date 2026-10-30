# code_review 扫描规则

`task_scan` 是 TASK 工作流 `code_review` 分类的可选**纯只读**辅助：只读取文件文本做 regex 匹配，不执行 build/test/lint，不联网，不修改项目文件。它不是完整静态分析器，也不会给出“测试已通过”之类的背书。

## 允许的输入

- `scope: "diff"`（默认）：用只读 git 读取工作区 staged/unstaged/untracked 改动文件；非 Git 项目直接返回 `skipped`。
- `scope: "files"`：显式文件列表，必须提供 `files`；路径限制在项目根内。
- `scope: "all"`：项目内文本候选文件（仅 Git 项目；非 Git 项目请用 `scope: "files"`）。跳过默认目录、符号链接、超大/二进制文件，最多 2000 个文件。
- `rules`：只跑指定规则 id。
- `severity`：最低严重度阈值（`blocker` > `critical` > `major` > `minor` > `info`）。

## 内置规则

内置目录：`packages/plugin/review-rules/catalog.json`。当前规则覆盖多语言高信号项：

| 规则 | 严重度 | 维度 | 说明 |
|---|---|---|---|
| `SEC-001` | blocker | security | PEM 私钥内容 |
| `SEC-002` | critical | security | 疑似硬编码凭据 |
| `SEC-003` | critical | security | 关闭 TLS 证书校验 |
| `SEC-004` | major | security | 外部命令执行入口 |
| `SEC-005` | major | security | `eval` 动态执行 |
| `SEC-006` | major | security | 疑似 SQL 拼接 |
| `SEC-007` | major | security | 日志可能泄露敏感信息 |
| `COR-001` | major | correctness | 空 catch 吞掉异常 |
| `COR-002` | major | correctness | catch 仅含注释 |
| `DES-001` | minor | design | 遗留 TODO/FIXME |
| `DES-002` | major | design | 压制类型检查 |
| `DES-003` | minor | design | 显式 any |
| `READ-001` | minor | readability | 超长代码行 |
| `TEST-001` | major | tests | 跳过/忽略的测试 |
| `IMP-001` | major | impact | 废弃的 `new Buffer()` |

`blocker` / `critical` 视为高严重度；它们必须逐条出现在 `task_review` 的 `findings` 中（提及 `ruleId`），并写清发现与修复建议，不能静默忽略。

## 项目覆盖

项目可创建 `.opencode/review-rules/catalog.json`：

```json
{
  "rules": [
    { "id": "SEC-001", "enabled": false },
    {
      "id": "PRJ-001",
      "title": "禁止 MAGIC",
      "severity": "major",
      "dimension": "design",
      "globs": ["src/**/*.ts"],
      "pattern": "MAGIC",
      "flags": "i",
      "message": "自定义规则命中",
      "remediation": "移除 MAGIC"
    }
  ]
}
```

- 按 `id` 覆盖内置规则；只写 `{ "id": "...", "enabled": false }` 可禁用内置规则。
- 自定义规则字段：`id`、`title`、`severity`、`dimension`、`globs`、`pattern`；可选 `flags`、`excludeGlobs`、`message`、`remediation`、`sonarKey`。
- `severity ∈ {blocker, critical, major, minor, info}`；`dimension ∈ {correctness, security, design, tests, impact, readability}`。
- `globs` 使用 Bun.Glob；不写时默认 `**/*`。默认排除 `node_modules`、`.git`、构建产物、锁文件、压缩/映射文件等。
- 正则无法编译或字段非法的规则会被跳过，并在扫描摘要的 `warnings` 中说明。

## 边界

- 扫描结果只写插件本地 `WorkflowState.taskScan`，不进入收集端汇报投影。
- 单文件超过 1 MB 跳过；二进制/含 NUL 文件跳过；findings 最多 500 条，每规则每文件最多 20 条。
- 扫描摘要带 `reviewSize`：diff 用 `git diff --numstat`，显式文件用实际文件数/行数。超过 20 文件/500 行给出建议；超过 50 文件/1500 行时，`task_review` 要求在 findings 或 scope 中说明拆分理由。
- `task_scan` 的 findings 是线索，不是结论；审核报告仍需按六维做代码阅读与判断。
