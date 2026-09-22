# POST /api/report 上报格式说明

> 本文档说明插件向后台收集服务上报会话工作流摘要的 payload 格式与各阶段内容变化。

## 格式固定，内容随阶段变化

`POST /api/report` 的 **JSON 结构始终不变**，但 `workflow.stages` 内各字段的值随会话推进实时变化。每次上报是该会话**当前状态的完整快照**（非增量 diff）。

---

## 固定顶层结构

```json
{
  "sessionID": "sess_abc123",
  "apiKey": "9f86d08...",
  "workflow": { "type": "...", "stages": {...}, "commit": {...}, "quality": {...}, "baseline": null },
  "cost": 0.36,
  "tokensInput": 60000,
  "tokensOutput": 25000,
  "reportedAt": 1750000000000
}
```

顶层字段含义固定，详见 `collector-spec.md` 5.1 节。以下重点说明 `workflow` 内容在不同阶段的变化。

---

## 一、阶段状态变化

每个阶段的 `status` 按状态机流转：

```
not_started → in_progress → approved
                  ↑              │
                  └── revisit ───┘  （回退，revision +1）
```

**示例：会话从需求分析推进到设计阶段时**

| 阶段 | 上报时 status | 说明 |
|------|--------------|------|
| requirements | approved | 已通过 |
| design | in_progress | 正在进行 |
| implementation | not_started | 尚未开始 |
| testing | not_started | 尚未开始 |
| review | not_started | 尚未开始 |

**同一次会话后续上报（进入编码后）**

| 阶段 | 上报时 status | 说明 |
|------|--------------|------|
| requirements | approved | — |
| design | approved | — |
| implementation | in_progress | 正在进行 |
| testing | not_started | — |
| review | not_started | — |

---

## 二、transitions（阶段转换时间戳）

每次阶段状态变更都会在 `transitions` 数组中追加一条记录。

**action 取值**：

| action | 含义 | 何时产生 |
|--------|------|---------|
| `enter` | 进入阶段 | 首次进入或 revisit 后重新进入 |
| `revisit` | 回退 | 开发者要求回到已完成的阶段 |
| `approve` | 通过 | 开发者确认该阶段完成 |

**示例：requirements 阶段经历一次回退**

```json
"requirements": {
  "status": "approved",
  "revision": 1,
  "transitions": [
    { "action": "enter", "at": 1750000000000 },
    { "action": "approve", "at": 1750003600000 },
    { "action": "revisit", "at": 1750005000000, "note": "需求变更" },
    { "action": "enter", "at": 1750005000000 },
    { "action": "approve", "at": 1750007200000 }
  ]
}
```

- `revision` 字段记录回退次数（本例 = 1）
- `note` 为可选字段（revisit 时可附原因）

---

## 三、工作流类型决定阶段键

| workflow.type | 阶段键 | 审查清单键 |
|--------------|--------|-----------|
| `sdlc` | requirements / design / implementation / testing / review | businessIntent / logicExplainable / behaviorVerifiable / designRationale |
| `reqdoc` | goal / rules / edge / prd / review | completeness / clarity / edgeCoverage / resolution |

阶段键不同，但 `workflow.stages` 的 JSON 结构完全一致。

---

## 四、review 阶段特有字段

只有 `review` 阶段包含 `checklist` 和 `comprehension`：

```json
"review": {
  "status": "approved",
  "revision": 0,
  "transitions": [...],
  "checklist": {
    "businessIntent": true,
    "logicExplainable": true,
    "behaviorVerifiable": true,
    "designRationale": true
  },
  "comprehension": {
    "total": 5,
    "confirmed": 5
  }
}
```

| 字段 | 含义 |
|------|------|
| `checklist` | 四项审查清单，全部为 true 才可通过（sdlc = 代码理解四维度，reqdoc = PRD 四维度） |
| `comprehension.total` | 审查片段/要点总数 |
| `comprehension.confirmed` | 已确认数 |

---

## 五、其他字段随会话累积变化

| 字段 | 变化规律 |
|------|---------|
| `cost` | 随 token 消耗递增；daemon 不可达时为 null |
| `tokensInput` / `tokensOutput` | 随对话轮次递增 |
| `quality.firstPassRate` | 代码编辑/PRD 渲染后更新（0-100） |
| `quality.iterationCount` | 文件被 AI 编辑次数的最大值 |
| `quality.lines` | AI 净增行数三分类聚合（sdlc 专属，reqdoc 恒 null） |
| `quality.reworkRate` / `testCoverage` | 插件恒 null，CI 回写 |
| `commit.blocked_by` | 随阶段完成逐步缩短，全部 approved 后为空 |
| `commit.force` | 强制提交授权时出现（逃生口留痕） |
| `baseline` | 需求阶段录入后出现，后续不变 |

---

## 六、完整生命周期示例（sdlc）

以一次典型的 sdlc 会话为例，展示不同上报时刻的 `workflow.stages` 快照：

**时刻 1：进入需求分析**

```json
{
  "stages": {
    "requirements":  { "status": "in_progress", "revision": 0, "transitions": [{ "action": "enter", "at": 1750000000000 }] },
    "design":        { "status": "not_started", "revision": 0, "transitions": [] },
    "implementation":{ "status": "not_started", "revision": 0, "transitions": [] },
    "testing":       { "status": "not_started", "revision": 0, "transitions": [] },
    "review":        { "status": "not_started", "revision": 0, "transitions": [] }
  },
  "commit": { "status": "blocked", "blocked_by": ["requirements","design","implementation","testing","review"] }
}
```

**时刻 2：需求通过，进入设计**

```json
{
  "stages": {
    "requirements":  { "status": "approved", "revision": 0, "transitions": [{ "action": "enter", "at": 1750000000000 },{ "action": "approve", "at": 1750003600000 }] },
    "design":        { "status": "in_progress", "revision": 0, "transitions": [{ "action": "enter", "at": 1750003600000 }] },
    "implementation":{ "status": "not_started", "revision": 0, "transitions": [] },
    "testing":       { "status": "not_started", "revision": 0, "transitions": [] },
    "review":        { "status": "not_started", "revision": 0, "transitions": [] }
  },
  "commit": { "status": "blocked", "blocked_by": ["design","implementation","testing","review"] }
}
```

**时刻 3：编码阶段遇阻，回退到需求**

```json
{
  "stages": {
    "requirements":  { "status": "in_progress", "revision": 1, "transitions": [
      { "action": "enter", "at": 1750000000000 },
      { "action": "approve", "at": 1750003600000 },
      { "action": "revisit", "at": 1750010800000, "note": "发现需求遗漏" },
      { "action": "enter", "at": 1750010800000 }
    ]},
    "design":        { "status": "approved", "revision": 1, "transitions": [...] },
    "implementation":{ "status": "not_started", "revision": 0, "transitions": [] },
    "testing":       { "status": "not_started", "revision": 0, "transitions": [] },
    "review":        { "status": "not_started", "revision": 0, "transitions": [] }
  },
  "commit": { "status": "blocked", "blocked_by": ["requirements","implementation","testing","review"] }
}
```

> 注意：revisit 会**级联回退**该阶段之后所有已 approved 的下游阶段。

**时刻 4：全部通过，审查完成**

```json
{
  "stages": {
    "requirements":  { "status": "approved", "revision": 1, "transitions": [...] },
    "design":        { "status": "approved", "revision": 1, "transitions": [...] },
    "implementation":{ "status": "approved", "revision": 0, "transitions": [...] },
    "testing":       { "status": "approved", "revision": 0, "transitions": [...] },
    "review": {
      "status": "approved", "revision": 0,
      "transitions": [...],
      "checklist": { "businessIntent": true, "logicExplainable": true, "behaviorVerifiable": true, "designRationale": true },
      "comprehension": { "total": 5, "confirmed": 5 }
    }
  },
  "commit": { "status": "allowed", "blocked_by": [] }
}
```

---

## 七、完整生命周期示例（reqdoc）

reqdoc 阶段键不同（goal / rules / edge / prd / review），但结构一致：

```json
{
  "type": "reqdoc",
  "stages": {
    "goal":    { "status": "approved", "revision": 0, "transitions": [...] },
    "rules":   { "status": "approved", "revision": 0, "transitions": [...] },
    "edge":    { "status": "in_progress", "revision": 0, "transitions": [...] },
    "prd":     { "status": "not_started", "revision": 0, "transitions": [] },
    "review":  { "status": "not_started", "revision": 0, "transitions": [],
                 "checklist": { "completeness": false, "clarity": false, "edgeCoverage": false, "resolution": false },
                 "comprehension": { "total": 0, "confirmed": 0 } }
  },
  "commit": { "status": "blocked", "blocked_by": ["goal","rules","edge","prd","review"] }
}
```

reqdoc 无 git 门禁（`hasCommitGate=false`），但 `commit.status` 同样随阶段完成度更新——全部 approved 后为 `"allowed"`。
