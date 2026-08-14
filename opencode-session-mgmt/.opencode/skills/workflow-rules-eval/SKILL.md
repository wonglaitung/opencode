---
name: workflow-rules-eval
description: Use when running or analyzing the rule-following evaluation baseline (eval-rules, 规则遵循度评测, 12.1) that measures how well weak models follow the injected workflow rules in the opencode-session-mgmt project.
---

# 规则遵循度评测基线（设计文档 12.1）

量化工序：改造规则文本（阶段化注入、状态条）前后，量化弱模型对注入规则的遵循度。改前跑 baseline（冻结快照），改后跑 new，对比通过率，数据驱动决定是否回滚或调整注入文本。

## 入口

脚本在 `scripts/eval-rules/`，不随 `bun test` 跑（需真实模型端点）。用法见脚本头注释：

- `bun run scripts/eval-rules/run.ts --variant baseline|new [--repeat 3] [--dry]`
- `--dry`：只打印各场景注入片段与判定期望，不调模型（验证渲染用）。
- 输出：控制台 per-scenario 表 + 聚合通过率，落 `results/{variant}.json`。

## 环境变量

- `EVAL_BASE_URL`：OpenAI 兼容端点，默认 `http://localhost:8086/v1`（本地 vLLM）
- `EVAL_API_KEY`：可选
- `EVAL_MODEL`：评测模型 id，默认 `/models/qwen3`（本地 vLLM）
- `EVAL_MAX_TOKENS`：输出上限，默认 2048；推理模型（deepseek-*-flash）显式 4096 留 thinking 空间
- `EVAL_TIMEOUT_MS`：单请求超时（默认 180000），网络/超时错误自动重试 3 次

## 文件布局

- `src/scenarios.ts`：场景定义（各工作流状态组合）
- `src/render-baseline.ts` / `src/render-new.ts`：两种注入格式的渲染器
- `src/judge.ts`：判定逻辑
- `fixtures/baseline/`：改造前冻结的规则全文快照（可复现旧注入格式）
- `results/baseline.json`、`results/new.json`：运行结果，`new` 自动对比 `baseline`

## 工作流

1. 改注入文本前，先 `--variant baseline --dry` 确认旧格式可复现。
2. 改完后 `--variant new --dry` 检查新渲染，再正式跑 `--variant new`。
3. 对比通过率：提升/持平即可合入；下降须定位到具体场景并调整，或回滚。

## 注意事项

- 评测调用真实模型、成本与耗时不可忽略，仅在明确要求时运行，勿在常规开发流程中触发。
- 结果 JSON 为对比依据，改动规则文本后应更新对应的 results 快照并提交。
