---
name: workflow-rules-eval
description: Use when running or analyzing the rule-following evaluation baseline (eval-rules, 规则遵循度评测, 13.1) in the opencode-session-mgmt project — how well weak models follow the injected workflow rules (pass-rate, sdlc + reqdoc) plus the reqdoc 质量飞轮 five-dimension PRD score iteration (46 scenarios, multi-model baseline freeze, --variant new 五维 delta, attribution to 追问探针/打分卡/模板, convergence) and scorecard changes (改评分标准 → 评测迭代 → 重冻结基线).
---

# 规则遵循度评测与质量飞轮（eval-rules）

量化两个度量：① 弱模型对注入规则的遵循度（**通过率**，sdlc 与 reqdoc 共用）；② reqdoc 打分卡五维 PRD 质量分（**0-100 五维度量**，reqdoc 专属）。改前跑 baseline（冻结快照），改后跑 new，对比通过率与五维分数，数据驱动决定回滚或调整注入文本。方法论单一事实源见 `plugin-guide/eval-driven-rule-iteration.md`；reqdoc 质量飞轮机制见 `docs/workflow-reqdoc.md` 10 章；运行方式与改动分级决策图见 `docs/session-management.md` 13.1 / 13.6。

## 入口

脚本在 `scripts/eval-rules/`，不随 `bun test` 跑（需真实模型端点）。用法见脚本头注释：

- `bun run scripts/eval-rules/run.ts --variant baseline|new [--repeat 3] [--dry] [--workflow sdlc|reqdoc] [--name 场景名子串]`
- `--dry`：只打印各场景注入片段与判定期望，不调模型（验证渲染用）。
- `--workflow`：只跑单个工作流（reqdoc 提速常用）；`--name`：只跑匹配的场景（单场景调试用）。
- 输出：控制台 per-scenario 表 + 聚合通过率；`--variant new` 且 baseline 带 score 快照时追加 PRD 五维逐维对比。结果落 `results/{variant}.json`。

## 标准操作流程（改评分标准 → 评测迭代 → 完成修改）

改评分标准的完整主线（加银行特定要求等新扣分标准走这条）。**提示词是自动派生的**——`reqdocScoreRubric()` 把打分卡同源注入 reqdoc-r21 规则文本 + `reqdoc_score` 工具描述，你改的是**源 + 评测镜像**，不是提示词文本。按序走：

1. **定改动规模**——A 给既有维度加扣分条件（最常见，加业务特定要求走这条）还是 B 新增维度（大改）？（→「改评分标准」）
2. **改源**——`REQDOC_SCORE_DIMS`（`packages/shared/src/workflow.ts`）加 / 改扣分条件；**同步 `score.ts` `PREDICATES` 镜像**（condition 逐字一致含「」，无测试保护、最易漏）；B 还牵动探针 / 模板字段 / 场景阈值（→「改评分标准」A/B）
3. **机制面验证**——`bun test` + `typecheck`；`shared.test.ts` 硬编码 `toContain` 断言对不上要同步改；改了 `sm-shared` 先 `rm -rf node_modules/sm-shared && bun install`（→「注意事项」）
4. **基线状态确认**——首次改前先冻结 46 场景多模型基线（已冻结，见「质量飞轮·现状」）；已冻结则只跑 new、不重跑 baseline（→「质量飞轮·现状 / 冻结基线」）
5. **跑评测门得报告**——dry →（改评测脚本时）mock → 真实模型 `--variant new` 双模型；报告 = per-scenario 通过率 + 五维 delta（→「质量飞轮·迭代循环」）
6. **读报告归因**——打分卡已变，报告反映**新标准**下模型表现；哪维掉 → 调三支柱哪根（→「质量飞轮·归因地图」）
7. **多轮迭代**——改一处 → 再跑 → 直到收敛（→「质量飞轮·收敛判据」）
8. **完成修改收尾**——**重冻结基线**（打分卡变了旧基线失效）+ 沉淀资产（新场景进 `scenarios.ts`、新探针进清单、新规则进 fixture）+ 文档同步（`docs/workflow-reqdoc.md` 5 章打分卡表格）

## 环境变量

- `EVAL_BASE_URL`：OpenAI 兼容端点，默认 `http://localhost:8086/v1`（本地 vLLM）
- `EVAL_API_KEY`：可选
- `EVAL_MODEL`：评测模型 id，默认 `/models/qwen3`（本地 vLLM）
- `EVAL_MAX_TOKENS`：输出上限，默认 2048；推理模型（deepseek-*-flash）显式 4096 留 thinking 空间；**长 reasoning 模型（deepseek-v4-pro-0813）实测须 16384**——4096 下 thinking 截断、content 与 tool_calls 双双为空被误判「未调用」
- `EVAL_TIMEOUT_MS`：单请求超时（默认 180000）；16k token 长输出的 reqdoc 渲染场景须提至 300000，网络/超时错误自动重试 3 次

当前主力远端模型：`deepseek-v4-pro-0813`（token-plan 端点）；本地弱模型：`/models/qwen3`（vLLM 8086）。

## 文件布局

- `src/scenarios.ts`：场景定义（46 个：sdlc s1-s22 + reqdoc r1-r24，每场景 = name + workflowType + 状态夹具 state + userTurn + judge）
- `src/render-baseline.ts` / `src/render-new.ts`：两种注入格式的渲染器
- `src/judge.ts`：判定逻辑——行为类 `tool`/`no_tool`/`text`（两工作流共用），产出类 `score`/`render`（仅 reqdoc）
- `src/score.ts`：reqdoc 五维确定性评分器 `scorePrd()`（镜像 `REQDOC_SCORE_DIMS` 扣分标准，非 LLM 判卷）
- `src/tool-defs.ts`：评测用精简工具定义（须与插件真实工具 description/参数名一致，否则测的不是真实契约）
- `fixtures/baseline/`：改造前冻结的规则全文快照（可复现旧注入格式）
- `results/baseline.json`、`results/new.json`：运行结果，`new` 自动对比 `baseline`；多模型跑互覆盖，用 `cp` 保存第二份（如 `new-<model>.json`）。当前已保存：`baseline-deepseek-v4-pro-0813.json`、`new-deepseek-v4-pro-0813.json`、`new-qwen3.json`、`baseline-deepseek-v4-flash.json`、`new-deepseek-v4-flash.json`。

## 工作流（通过率评测，两工作流共用）

1. 改注入文本前，先 `--variant baseline --dry` 确认旧格式可复现。
2. 改完后 `--variant new --dry` 检查新渲染，再正式跑 `--variant new`。
3. 对比通过率：提升/持平即可合入；下降须定位到具体场景并调整，或回滚。

## 质量飞轮（reqdoc 五维度量，进阶应用）

reqdoc 工作流把「过/不过」升级为 **0-100 五维数字度量**——打分卡（业务价值 / 流程闭环 / 异常边界 / 合规脱敏 / 权限隔离）接进评测，让 `scorePrd()` 对每个场景渲染出的 PRD 自动评分，获得每维数字基线、回归检测（哪维掉了）与归因（哪个维度系统性薄弱 → 对应三支柱哪一根）。**不是全自动优化**：跑 → 看归因 → 改一处 → 再跑，人始终在环里。

### 现状：基线已冻结

`results/` 已含 46 场景基线快照：`baseline.json` 为 **deepseek-v4-pro-0813**（token-plan 端点）旧格式对照（reqdoc 18/24 (75%)、sdlc 15/22 (68%)、整体 72%），`new.json` 为当前改造后收敛结果（reqdoc 86%、sdlc 95%、整体 91%）。多模型副本用 `baseline-<model>.json` / `new-<model>.json` 保存。**后续改评分标准/规则前只需跑 new 对比，别重跑 baseline 覆盖参照。**

### 冻结 46 场景基线（一次性，换模型/换端点后才重跑）

```bash
# ① 干跑，验证 46 场景注入渲染，不调模型（秒级）
bun run scripts/eval-rules/run.ts --variant baseline --dry

# ② 远端推理模型冻结（五维分数的基准参照；长 reasoning 模型须 16384 + 300000 超时）
EVAL_BASE_URL=https://<端点>/v1 EVAL_API_KEY=<key> EVAL_MODEL=deepseek-v4-pro-0813 EVAL_MAX_TOKENS=16384 EVAL_TIMEOUT_MS=300000 \
  bun run scripts/eval-rules/run.ts --variant baseline --repeat 3

# ③ 本地弱模型再冻结一份（弱模型是主要回归面），先复制走免得被覆盖
cp scripts/eval-rules/results/baseline.json scripts/eval-rules/results/baseline-qwen3.json
EVAL_BASE_URL=http://localhost:8086/v1 EVAL_MODEL=/models/qwen3 EVAL_MAX_TOKENS=2048 \
  bun run scripts/eval-rules/run.ts --variant baseline --repeat 3
```

冻结结果 `baseline.json` **入库 commit** 作参照。日常改动只跑 `--variant new`，不要重跑 baseline 覆盖参照，否则对比失效。**只跑单个工作流用 `--workflow reqdoc|sdlc` 提速，跑完用 cp 合并两批**（baseline/new 一次只落一个 workflow，会互相覆盖）。

### 迭代循环（每次改行为面，三级验证）

行为面改动 = 规则文本 / 探针清单 / 打分卡 / 模板 / 工具描述 / 注入格式 / 评测脚本自身；机制面（工具逻辑 / 门禁 / 状态机 / DB / CLI / collector / 纯注释文档）走 `bun test` + typecheck，不进评测门。③是合入前唯一不可省的重闸：

1. **① 干跑**（每次改完必做，秒级）：`--variant new --dry`。
2. **② mock 冒烟**（只改评测脚本 / 判定口径时）：临时起 mock OpenAI 端点返回罐装 tool_calls，`EVAL_BASE_URL` 指过去非 dry 跑一遍，确认判定 / 聚合 / 对比路径不炸；跑完删 mock、还原 `results/*.json`。
3. **③ 真实模型回归**（重闸）：主模型 + 弱模型各一遍，双模型结果分开保存。
   ```
   EVAL_BASE_URL=... EVAL_MODEL=deepseek-v4-pro-0813 EVAL_MAX_TOKENS=16384 EVAL_TIMEOUT_MS=300000 \
     bun run scripts/eval-rules/run.ts --variant new --repeat 3
   cp scripts/eval-rules/results/new.json scripts/eval-rules/results/new-deepseek-v4-pro-0813.json
   EVAL_BASE_URL=http://localhost:8086/v1 EVAL_MODEL=/models/qwen3 EVAL_MAX_TOKENS=2048 \
     bun run scripts/eval-rules/run.ts --variant new --repeat 3
   ```

**读输出（三块）**：per-scenario ✅/❌ 表（reqdoc 段 r1-r24，r18-r24 是质量飞轮加的评分 / 探针 / 渲染场景）→ 聚合通过率（整体 / sdlc / reqdoc）→ `=== 对比(baseline → new) ===` 五维 delta（仅 reqdoc）。**合入门槛**：五维任何一维回退（负号）就不合入，回滚改动；全过或持平才沉淀资产（新场景进 `scenarios.ts`、新探针进清单、新规则进 fixture）。

### 归因地图（哪维掉 → 改哪根支柱）

| 掉的分 | 归因到 | 改什么 |
|---|---|---|
| flowClosure / edgeControl（流程闭环、异常边界） | 追问探针 | `REQDOC_PROBES`（`main_flow`/`flow_trigger`/`exception`/`reverse`）round 前移 |
| compliance / authority（合规脱敏、权限隔离） | 追问探针 + 打分卡 | 探针 `desensitize`/`audit`/`authority` + 扣分标准 `REQDOC_SCORE_DIMS` |
| 渲染结构（r23/r24 不过） | 模板 | `REQDOC_TEMPLATE_CHAPTERS`/`REQDOC_TEMPLATE_FIELDS` schema |

失败场景逐个归因按「规则措辞 / 判定口径 / 场景二义性」三类——**优先调脚本与判定口径**，规则文本保持简洁（弱模型对复杂措辞极敏感，为单模型把规则写细实测伤害弱模型）。弱模型是主要回归面，多模型验证防过拟合。

**两条高频归因（近两轮实测沉淀）**：
- **判定关键词须与规则要求的语言自洽**——reqdoc-r2 禁止技术词、要求业务语言，r6 判定却查「超时/驳回/失败/补单」等技术词，模型按规则用业务说法（「连点提交/断网」）就匹配不上；判定词表须用规则同侧语言。
- **单轮评测无法模拟多阶段状态机动作**——前置阶段若 in_progress，模型按状态机先 `approve` 再 `enter`，judge 期望单轮直接 enter 会误判；场景前提把前置阶段设 approved，让期望动作成为单轮可达一步。渲染场景（r23/r24）同理：模型「先 scan/确认再渲染」属多轮思维，单轮评测呈高方差，这类已按用户决策「接受现状」。

### 收敛判据

连续几轮五维分数稳定、回归检测无回退、场景全部达标 → **停手**，重新 `--variant baseline` 冻结新基线并 commit。别无限跑——场景集有限，跑到后期只是过拟合场景集本身。

## 改评分标准（打分卡迭代的操作清单）

改评分标准 = 一处源 + 自动传播 + 一处手工镜像 + 两级验证。传播链路：

```
REQDOC_SCORE_DIMS        ← 单一事实源（packages/shared/src/workflow.ts）
   │  reqdocScoreRubric()
   ├─▶ reqdoc-r21 规则文本 + reqdoc_score 工具描述   ← 自动同源，不用管
   └─▶ scorePrd() 评测镜像（scripts/eval-rules/src/score.ts PREDICATES）  ← 手工镜像！
```

**最大的坑**：`score.ts` 的 `PREDICATES` 是手写词表，condition 字符串须与 `REQDOC_SCORE_DIMS[].deductionRules[].condition` **逐字一致（含「」）**，且**无测试强制同步**（`score.ts` 无测试文件；`shared.test.ts` 只验 rubric 文本、不验评测镜像）——漏改它 `bun test` 全绿但评测测的是旧打分卡。

**A. 加扣分条件到既有维度（最常见，加业务特定要求走这条）**

1. `workflow.ts` 该维 `deductionRules` 加 `{ points, condition }`。
2. **同步 `score.ts` `PREDICATES`** 加同 condition 的文本谓词。
3. `bun test` + `typecheck`——`shared.test.ts` 会验 points>0 且 ≤max、rubric 文本；condition 文本变了其硬编码 `toContain` 断言要同步改。
4. **评测门**（改了 r21 规则文本 + 工具描述 = 行为面）：dry → 真实模型 `--variant new` → 看相关维 delta。
5. 文档同步 `docs/workflow-reqdoc.md` 5 章打分卡表格。

**B. 新增维度（大改，牵动面按序）**

1. `workflow.ts` 加条目，**Σ max 必须仍 = 100**（服务端 `total = Σ dims` 硬契约），加维即压缩其它维 max。
2. `REQDOC_PROBES` 加该维 `dim` 映射的探针（否则缺口无法归因，r22 一致校验）。
3. `REQDOC_TEMPLATE_FIELDS` 映射新维到模板字段（渲染缺口 vs 打分一致性，r24）。
4. `score.ts` PREDICATES 加新谓词；**r18/r19 的 `dimMin`/`dimMax` 阈值要调**（max 重分配后阈值跟着变）。
5. `bun test` + `typecheck`：新 key 扩展 `ReqdocScoreDimKey` 类型，消费方遍历自动适配，确认 typecheck 全过。
6. `REQDOC_SCORE_PASS=85` 重新审视（新维摊薄总分）。
7. 文档：workflow-reqdoc.md 5/10 章，「五维」字样全局核对。
8. **收敛后重新冻结基线**——打分卡变了，旧基线失效。

**推荐顺序 checklist**：改源 → 同步 PREDICATES → `bun test` + `typecheck` → 修 shared.test.ts 断言 → 文档 → 评测门 → 重冻结基线。

## 注意事项

- 评测调用真实模型、成本与耗时不可忽略，仅在明确要求时运行，勿在常规开发流程中触发。
- 结果 JSON 为对比依据，改动规则文本后应更新对应的 results 快照并提交。
- **改了 `sm-shared` 后**：`rm -rf node_modules/sm-shared && bun install`（hoisted 拷贝残留，`bun test` 全绿但评测读到旧规则文本）。
- **打分卡门禁与评测同源**：打分卡判据经 `reqdocScoreRubric()` 单点注入工具描述与规则文本，改打分卡后两侧同步生效，勿只在一边改。
- 改动分级决策图（何时跑评测门 / ①②③ 各口径）见 `docs/session-management.md` 13.6；reqdoc 实测轮次见 `docs/workflow-reqdoc.md` 10 章。
