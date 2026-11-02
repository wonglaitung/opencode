# Promptfoo PoC

用 Promptfoo 承载 `scripts/eval-rules` 的场景夹具、注入、模型调用和现有判据，验证它能否作为外层评测编排。

## 运行

```bash
cd /data/opencode/opencode-session-mgmt
EVAL_BASE_URL=http://localhost:8086/v1 \
EVAL_MODEL=qwen3 \
EVAL_DISABLE_THINKING=1 \
EVAL_MAX_TOKENS=4096 \
EVAL_TIMEOUT_MS=300000 \
npx --yes promptfoo@0.125.1 eval \
  -c scripts/eval-rules/promptfoo/promptfooconfig.yaml \
  --no-cache -j 1
```

要求 Node >= 22.22.0（Promptfoo 自身的版本约束）。

## 范围

当前覆盖 11 个单轮场景：

- `t1`、`t2`、`t4`、`t5`、`t6`、`t7`、`t8`、`t9`、`t10`、`t11`、`t12`

不覆盖需要真实工具执行的 `rejected`、`render`、`score` 场景。这部分仍由 `scripts/eval-rules/run.ts` 负责，避免 PoC 把领域判据简化掉。

## PoC 结论

Promptfoo 可以承载场景、system prompt 渲染、模型调用、现有 `judgeScenario` 判据和结果 UI。

但当前 provider 只做单轮调用，不执行真实工具，因此：

- `t2`、`t4`、`t6`、`t9`、`t10`、`t11` 通过
- `t1`、`t5`、`t7`、`t8`、`t12` 失败，主要是模型没有产出正文，或调用了 `workflow_start` 而不是 `task_classify`

这与原 runner 在未开启 `EVAL_EXECUTE=1` 时的行为一致，说明差异来自**工具执行层**，不是 Promptfoo 断言层。

如果要迁移完整工作流评测，需要：

1. 把 `executeTurns` 包进 custom provider；
2. 在 Bun 或 sidecar 进程里执行 `bun:sqlite` 工具链；
3. 把 `toolResults`、artifact、状态变化传给 Promptfoo assertion。

当前 PoC 的定位是验证 Promptfoo 外层编排是否可行，不替代现有 runner。
