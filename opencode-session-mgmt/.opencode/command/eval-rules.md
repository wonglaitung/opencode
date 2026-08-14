---
description: 运行规则遵循度评测基线（设计文档 12.1，需真实模型端点，不随 bun test 跑）
---

规则遵循度评测量化弱模型对注入规则文本的遵循度，对比 baseline（冻结快照）与 new（当前注入格式）通过率。需真实模型端点，耗时不短，仅在明确要求时运行。

步骤：

1. 先 `--dry` 只打印注入片段与判定期望，确认渲染无误：
   `bun run scripts/eval-rules/run.ts --variant new --dry`
2. 跑当前格式并自动对比 baseline：
   `bun run scripts/eval-rules/run.ts --variant new [--repeat 3]`
3. 结果落 `scripts/eval-rules/results/new.json`，与 `baseline.json` 对比；通过率下降时分析场景、回滚或调整注入文本。

环境变量：`EVAL_BASE_URL`（默认 `http://localhost:8086/v1`，本地 vLLM）、`EVAL_API_KEY`、`EVAL_MODEL`（默认 `/models/qwen3`，本地 vLLM 的模型 id）、`EVAL_MAX_TOKENS`（默认 2048；推理模型如 deepseek-*-flash 显式 4096）、`EVAL_TIMEOUT_MS`（默认 180000，含网络/超时重试）。冻结的 baseline 快照在 `scripts/eval-rules/fixtures/baseline/`。
