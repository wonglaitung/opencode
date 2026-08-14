# 混合开发工作流：部分手工 + 部分 AI 生成

本页整理「需求/设计走工作流、代码部分手工写、再回到工作流完成测试与审查」的完整流程，
以及「AI 提出多处改动、开发者认领其中一处手工实现」时的推进方式。

## 1. 主干流程

```mermaid
graph TB
    Start["新需求会话"] --> Req["requirements 阶段<br/>workflow_advance enter → approve"]
    Req --> Des["design 阶段<br/>workflow_advance enter → approve"]
    Des --> Split{"是否部分代码手工写？"}

    Split -->|"否，全部 AI 生成"| Imp1["implementation 阶段<br/>AI 直接编码"]
    Split -->|"是，部分手工"| Lock["open_ide 锁定手工文件<br/>（必须带 file 参数，防 AI 覆盖）"]

    Lock --> Manual["开发者手工改锁定的文件"]
    Manual --> Unlock["开发者明确确认改完 → unlock_file<br/>AI 重新读取最新文件内容"]
    Unlock --> Imp2["AI 改剩余未锁定的文件"]

    Imp1 --> Tst["testing 阶段<br/>workflow_advance enter → approve"]
    Imp2 --> Tst

    Tst --> Rev["review 阶段（审查）"]
    Rev --> Comps["AI 只对其生成的改动 comprehension_add 逐段登记<br/>（手工改动不进理解确认片段）"]
    Comps --> Confirm["开发者逐段 comprehension_confirm 定论"]
    Confirm --> Checklist["审查清单确认<br/>businessIntent / logicExplainable / behaviorVerifiable"]

    Checklist --> Submit["review_submit"]
    Submit --> Gate["提交门禁放行 → git commit"]
    Gate --> New["/new 开新需求，保持统计隔离"]
```

## 2. 阶段推进的硬性约束

```mermaid
graph TB
    A["直接跳过 implementation 进入 testing？"] --> B{"implementation 是否 approved？"}
    B -->|"否（代码是手工写的）"| C["先 workflow_advance approve implementation<br/>developer_confirmed=true"]
    C --> D["review_submit 前置校验：<br/>requirements/design/implementation/testing<br/>全部 approved"]
    B -->|"是"| D
    D -->|"未全部 approved"| E["补齐前置阶段后重试"]
    D -->|"全部 approved"| F["审查可提交"]
```

- 阶段进入/批准/回退可任意跳转（完成门禁模型），无顺序硬拦截（`applyTransition` 仅约束单阶段状态机）。
- 唯二硬约束：`review_submit` 要求前置四阶段全部 approved；`git commit` 被门禁拦截直到五阶段全 approved。
- `workflow_advance approve` 必须 `developer_confirmed=true`；审查阶段不可用 `workflow_advance` approve，必须走 `review_submit`。

## 3. 审查内容：谁写的审谁

```mermaid
graph LR
    Review["review 阶段"] --> AI{"本会话有 AI 代码编辑？<br/>（iterationCount > 0）"}
    AI -->|"是"| Seg["AI 生成的改动拆分登记<br/>comprehension_add（file/行号/解释）<br/>review_submit 强制要求至少 1 段"]
    Seg --> Term["每段须终态：<br/>confirm 接受 / reject→rewrite / manual 自处理<br/>不允许 pending/rejected 悬空"]
    AI -->|"否（纯手工/纯讨论）"| NoSeg["无需片段，直接过清单"]
    Term --> Check["审查清单三项全 true<br/>（覆盖整体交付，含手工部分）"]
    NoSeg --> Check
    Check --> Rate["通过时自动计算一次通过率 firstPassRate"]
```

- **AI 生成的代码**：逐段理解确认（做了什么/为什么/替代方案/风险），是审查核心。
- **手工写的代码**：不进理解确认片段（AI 不解释它没写的代码），由开发者经清单项整体把关。
- 清单 `designRationale` 为 auto 项，全部片段定论即通过，不占具名参数。

## 4. 手工改动与设计冲突时的决策

```mermaid
graph TB
    A{"开发者手工改动的做法<br/>与已批准的设计一致？"} -->|"一致（仅分工）"| B["无需回退设计<br/>open_ide 锁定该文件直接改"]
    B --> F["继续测试 → 审查 → 提交"]
    A -->|"不一致（推翻方案）"| C["建议 workflow_revisit design<br/>更新设计方案"]
    C --> D{"开发者确认回退？"}
    D -->|"是"| E["design 回到 in_progress（revision++）<br/>更新方案后重新 approve"]
    D -->|"否，坚持强推"| F
    E --> F
    F --> G["说明：<br/>两种路径门禁都能跑通，<br/>区别在返工率统计与设计记录一致性"]
```

- **同一方案的分工**：不用回设计阶段，直接锁定文件手工改即可。
- **推翻已批准方案**：无硬性拦截（工作流不 diff 设计与代码），但正确做法是回退设计，否则 `designRationale` 与实际不符，返工率统计也漏记这次偏差。
