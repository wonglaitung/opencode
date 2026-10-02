import { describe, expect, test } from "bun:test"
import { createWorkflowState, requiredSlots, type WorkflowState } from "sm-shared"
import { buildStateBar, buildSystemFragment } from "../src/prompt"
import { applyTransition } from "../src/workflow-ops"

/** 推进到全部阶段 approved（完成态）。 */
function completeSdlc(): WorkflowState {
  const s = createWorkflowState("sdlc")
  s.baseline = { estimatedHours: 8, setAt: 1 }
  for (const name of ["requirements", "design", "implementation", "testing", "review"]) {
    applyTransition(s, name, "enter", 1)
    applyTransition(s, name, "approve", 2)
  }
  return s
}

function completeReqdoc(): WorkflowState {
  const s = createWorkflowState("reqdoc")
  for (const name of ["goal", "rules", "edge", "prd", "review"]) {
    applyTransition(s, name, "enter", 1)
    applyTransition(s, name, "approve", 2)
  }
  return s
}

describe("buildSystemFragment", () => {
  test("未开始：注入起步提示，不出现完成态横幅与矛盾文案", () => {
    const s = createWorkflowState("sdlc")
    const text = buildSystemFragment(s)
    expect(text).toContain("工作流尚未开始")
    expect(text).toContain("需求分析")
    // 完成态横幅不出现（避免「尚未开始」与「已完成」自相矛盾）
    expect(text).not.toContain("Workflow 已完成")
    expect(text).not.toContain("已全部完成")
  })

  test("进行中：只注入 global + 当前阶段规则，不出现完成态横幅", () => {
    const s = createWorkflowState("sdlc")
    applyTransition(s, "requirements", "enter", 1)
    const text = buildSystemFragment(s)
    // 当前阶段专属规则（需求阶段问基线）被注入
    expect(text).toContain("workflow_baseline")
    // 其它阶段的专属规则不注入（如审查的 comprehension_add）
    expect(text).not.toContain("comprehension_add")
    expect(text).not.toContain("Workflow 已完成")
  })

  test("空档态：部分 approved 无进行中 → 提示进入下一阶段而非「尚未开始」", () => {
    const s = createWorkflowState("sdlc")
    applyTransition(s, "requirements", "enter", 1)
    applyTransition(s, "requirements", "approve", 2)
    // 尚未 enter design → 无 in_progress、非完成态（stage===null 空档态）
    const text = buildSystemFragment(s)
    expect(text).toContain("当前无进行中阶段")
    expect(text).toContain("需求分析")
    expect(text).toContain("设计")
    expect(text).toContain("workflow_revisit")
    expect(text).not.toContain("工作流尚未开始")
    expect(text).not.toContain("Workflow 已完成")
  })

  test("SDLC 完成：提示 /new + revisit，且不再出现「尚未开始」或误导性「初始化工作流」", () => {
    const text = buildSystemFragment(completeSdlc())
    expect(text).toContain("/new")
    expect(text).toContain("统计隔离")
    expect(text).toContain("commit_gate_check")
    expect(text).toContain("workflow_revisit") // 完成态也给「改本需求」路径
    expect(text).not.toContain("尚未开始")
    expect(text).not.toContain("初始化工作流")
    expect(text).toContain("提交状态：allowed")
  })

test("reqdoc 完成：提示 /new + revisit，无 git 门禁相关文案", () => {
      const text = buildSystemFragment(completeReqdoc())
      expect(text).toContain("/new")
      expect(text).toContain("workflow_revisit")
      expect(text).not.toContain("commit_gate_check")
      expect(text).not.toContain("尚未开始")
    })

    test("★ reqdoc 完成：给出「新增功能」第三动作，并点名不要用 /new 重开", () => {
      const text = buildSystemFragment(completeReqdoc())
      // 迭代最常被误选成 /new（丢掉全部已确认槽位 → 业务被迫重述整份需求），故须显式给出正确动作
      expect(text).toContain("在这份需求上新增功能")
      expect(text).toContain("workflow_revisit(stage=prd)")
      expect(text).toContain("末尾追加")
      expect(text).toContain("不要用 /new 重开")
    })

    test("sdlc 完成：不出 reqdoc 的迭代动作（阶段动作按类型隔离）", () => {
      const text = buildSystemFragment(completeSdlc())
      expect(text).not.toContain("在这份需求上新增功能")
    })

  test("进行中 stuck 警告仅在非完成态注入", () => {
    const s = createWorkflowState("sdlc")
    applyTransition(s, "implementation", "enter", 1)
    const active = buildSystemFragment(s, { "src/a.ts": 3 })
    expect(active).toContain("重复编辑模式")
    const done = buildSystemFragment(completeSdlc(), { "src/a.ts": 3 })
    expect(done).not.toContain("重复编辑模式")
  })

  test("SDLC 完成 + 有锁文件 → 注入解锁提示（列文件清单）", () => {
    const text = buildSystemFragment(completeSdlc(), {}, ["/home/dev/project/src/A.java"])
    expect(text).toContain("人工锁定")
    expect(text).toContain("src/A.java")
    expect(text).toContain("unlock_file")
  })

  test("SDLC 完成 + 无锁文件 → 不注入解锁提示", () => {
    const text = buildSystemFragment(completeSdlc())
    expect(text).not.toContain("人工锁定")
  })

  test("reqdoc 完成 + 有锁文件 → 不注入解锁提示（hasCommitGate 护栏）", () => {
    const text = buildSystemFragment(completeReqdoc(), {}, ["/home/dev/project/src/A.java"])
    expect(text).not.toContain("人工锁定")
  })

  test("SDLC 进行中（未完成）+ 有锁文件 → 不注入解锁提示", () => {
    const s = createWorkflowState("sdlc")
    applyTransition(s, "requirements", "enter", 1)
    const text = buildSystemFragment(s, {}, ["/home/dev/project/src/A.java"])
    expect(text).not.toContain("人工锁定")
  })




  describe("PRD 产出指引注入（重构 2c：prd 阶段按槽位流程，不指示手写渲染）", () => {
    const NO_OVERLAY = "/tmp/opencode-sm-conv-not-exist"
    /** 推进 reqdoc 至 prd 进行中（goal/rules/edge 均已 approve）。 */
    function reqdocAtPrd(): WorkflowState {
      const s = createWorkflowState("reqdoc")
      for (const name of ["goal", "rules", "edge"]) {
        applyTransition(s, name, "enter", 1)
        applyTransition(s, name, "approve", 2)
      }
      applyTransition(s, "prd", "enter", 3)
      return s
    }

    test("reqdoc prd 阶段 + kb 已建：注入槽位流程三步", () => {
      const s = reqdocAtPrd()
      s.kb = {
        slots: [],
        features: [{ no: 1, name: "名单排查", priority: "high", confirmedAt: 1 }],
        containers: {},
        askCounts: {},
        updatedAt: 1,
      }
      const text = buildSystemFragment(s, {}, [], NO_OVERLAY)
      expect(text).toContain("# 需求知识库流程")
      expect(text).toContain("reqdoc_ingest")
      expect(text).toContain("reqdoc_answer")
      expect(text).toContain("reqdoc_assemble")
      // 重构 2c：不再注入已删工具的指引
      expect(text).not.toContain("reqdoc_render_skeleton")
      expect(text).not.toContain("reqdoc_patch")
    })

    test("★ reqdoc prd 阶段 + kb 缺省（revisit 回退）：注入建库指引，不注入旧手写渲染指引", () => {
      const text = buildSystemFragment(reqdocAtPrd(), {}, [], NO_OVERLAY)
      expect(text).toContain("# 需求知识库未建")
      expect(text).toContain("reqdoc_ingest")
      // 关键护栏：旧分支曾让模型去调已删的 render_skeleton/patch
      expect(text).not.toContain("reqdoc_render_skeleton")
      expect(text).not.toContain("reqdoc_patch")
      expect(text).not.toContain("# 渲染目标结构")
    })

    test("reqdoc 非 prd 阶段 → 不注入 PRD 产出指引", () => {
      const s = createWorkflowState("reqdoc")
      applyTransition(s, "edge", "enter", 1)
      const text = buildSystemFragment(s, {}, [], NO_OVERLAY)
      expect(text).not.toContain("# 需求知识库流程")
      expect(text).not.toContain("# 需求知识库未建")
    })

    test("reqdoc 完成态 → 不注入结构摘要", () => {
      expect(buildSystemFragment(completeReqdoc(), {}, [], NO_OVERLAY)).not.toContain("# 渲染目标结构")
    })

    test("sdlc → 恒不注入结构摘要（仅 reqdoc）", () => {
      const s = createWorkflowState("sdlc")
      applyTransition(s, "implementation", "enter", 1)
      expect(buildSystemFragment(s, {}, [], NO_OVERLAY)).not.toContain("# 渲染目标结构")
    })
  })

  describe("绑定规约送达（按工作流类型 + 阶段门控，只注入）", () => {
    // 传一个不存在的 projectRoot，避免项目覆盖层干扰基线（基线来自插件包）。
    const NO_OVERLAY = "/tmp/opencode-sm-conv-not-exist"

    test("reqdoc goal 阶段 → 注入 goal 规约，不含 rules 阶段规约", () => {
      const s = createWorkflowState("reqdoc")
      applyTransition(s, "goal", "enter", 1)
      const text = buildSystemFragment(s, {}, [], NO_OVERLAY)
      expect(text).toContain("《reqdoc 编写规约》自遵循清单")
      expect(text).toContain("显式 in scope") // goal 阶段：范围与边界
      expect(text).not.toContain("术语须引用原文") // rules 阶段：不注入
    })

    test("★ 已有稿分流（r8）+ 增量红线（r35）：goal 阶段即可见，且不新增一轮问答", () => {
      const s = createWorkflowState("reqdoc")
      applyTransition(s, "goal", "enter", 1)
      const text = buildSystemFragment(s, {}, [], NO_OVERLAY)
      // r8 承载分流判定：分三类（自己的稿/上一版定稿 → 接着完善；别家文档 → 参考件；空 → 常规）
      expect(text).toContain("先判定其定位再选路径")
      expect(text).toContain("参考_")
      // 分流并入既有那一次提问，不得为分流单独多问一轮（用户零额外打断）
      expect(text).toContain("不要为此单独多问一轮")
      // r35 三条红线：追加末尾 / 不得整篇重提 / 参考件语义
      expect(text).toContain("功能点只能追加到末尾")
      expect(text).toContain("不得把旧稿/上一版 PRD 整篇重新 `reqdoc_ingest`")
      expect(text).toContain("不作记忆匹配证据、不消缺口、不计入溯源")
    })

    test("sdlc implementation 阶段 → 注入 global + implementation(代码期)，不含 design/reqdoc", () => {
      const s = createWorkflowState("sdlc")
      applyTransition(s, "implementation", "enter", 1)
      const text = buildSystemFragment(s, {}, [], NO_OVERLAY)
      expect(text).toContain("《sdlc 编写规约》自遵循清单")
      expect(text).toContain("复杂度与代码异味") // implementation（安全-代码期）
      expect(text).toContain("AI 编写代码须带 [AI] 标记") // global
      expect(text).not.toContain("凭证与密钥") // design（安全-设计期）不泄漏
      expect(text).not.toContain("避免竞态") // design（并发）不泄漏
      expect(text).not.toContain("术语须引用原文") // reqdoc 隔离
    })

    test("sdlc design 阶段 → 注入 global + design(安全设计/并发/日志)，不含代码期指标", () => {
      const s = createWorkflowState("sdlc")
      applyTransition(s, "design", "enter", 1)
      const text = buildSystemFragment(s, {}, [], NO_OVERLAY)
      expect(text).toContain("《sdlc 编写规约》自遵循清单")
      expect(text).toContain("凭证与密钥") // 安全-设计
      expect(text).toContain("避免竞态") // 并发-设计
      expect(text).toContain("不打敏感信息") // 日志-设计
      expect(text).toContain("AI 编写代码须带 [AI] 标记") // global
      expect(text).not.toContain("复杂度与代码异味") // 代码期不注入
      expect(text).not.toContain("术语须引用原文") // reqdoc 隔离
    })

    test("sdlc 完成态 → 仅注入 global 提交信息规约，不含 implementation", () => {
      const text = buildSystemFragment(completeSdlc(), {}, [], NO_OVERLAY)
      expect(text).toContain("AI 编写代码须带 [AI] 标记") // global 提交信息规约（提交发生在完成态）
      expect(text).not.toContain("凭证与密钥") // implementation 阶段规约不注入
    })
  })
})

describe("buildStateBar 渲染校验行（质量飞轮 P2）", () => {
  /** 结构合规的单功能点 render 记录。 */




  test("sdlc → 不出现渲染校验行（仅 reqdoc 提示，不打扰）", () => {
    const s = createWorkflowState("sdlc")
    applyTransition(s, "implementation", "enter", 1)
    expect(buildStateBar(s, "implementation")).not.toContain("渲染校验")
  })

  describe("阶段可见性表头（阶段指示，用户可见前提）", () => {
    test("reqdoc edge 进行中 → 表头含 第 3/5 步 + 阶段名 + 目的", () => {
      const s = createWorkflowState("reqdoc")
      applyTransition(s, "edge", "enter", 1)
      const bar = buildStateBar(s, "edge")
      expect(bar).toContain("当前阶段：边界与异常（第 3/5 步），状态 进行中")
      expect(bar).toContain("目的：补全异常、逆向与权限合规")
    })

    test("sdlc implementation 进行中 → 表头含 第 3/5 步 + 阶段名 + 目的", () => {
      const s = createWorkflowState("sdlc")
      applyTransition(s, "implementation", "enter", 1)
      const bar = buildStateBar(s, "implementation")
      expect(bar).toContain("当前阶段：编码（第 3/5 步），状态 进行中")
      expect(bar).toContain("目的：编码实现")
    })

    test("全未开始（stage=null）→ 表头含 未开始 + 第 1/5 步 + 首阶段", () => {
      const s = createWorkflowState("reqdoc")
      const bar = buildStateBar(s, null)
      expect(bar).toContain("当前阶段：未开始（第 1/5 步），请从「目标与场景」开始")
    })

    test("空档态（部分 approved 无进行中）→ 表头含 空档 + 下一步", () => {
      const s = createWorkflowState("reqdoc")
      applyTransition(s, "goal", "enter", 1)
      applyTransition(s, "goal", "approve", 1)
      applyTransition(s, "rules", "enter", 1)
      applyTransition(s, "rules", "approve", 1)
      const bar = buildStateBar(s, null)
      expect(bar).toContain("当前阶段：空档（已 approved：目标与场景、流程与规则），下一步：「边界与异常」")
    })
  })
})

describe("buildStateBar · 知识库覆盖（2c）", () => {
  const kbOf = (filled: number): NonNullable<WorkflowState["kb"]> => {
    const features = [{ no: 1, name: "名单排查", priority: "high" as const, confirmedAt: 1000 }]
    const req = requiredSlots(features)
    return {
      slots: req.slice(0, filled).map((address) => ({
        kind: "prose" as const,
        address,
        content: `${address} 内容`,
        source: "文档" as const,
        status: "confirmed" as const,
      })),
      features,
      containers: {
        "4.1": { required: false, reason: "无特殊术语" },
        "5.1.2.1": { required: false, reason: "无结构化字段" },
      },
      askCounts: {},
      updatedAt: 1000,
    }
  }

  test("槽位全填 → 状态条显示满覆盖且门禁可过", () => {
    const s = createWorkflowState("reqdoc")
    s.kb = kbOf(requiredSlots(kbOf(0).features).length)
    const bar = buildStateBar(s, "prd")
    expect(bar).toContain("知识库：必填槽位")
    expect(bar).toContain("门禁可通过 ✓")
  })

  test("槽位未填满 → 状态条显示未就绪原因", () => {
    const s = createWorkflowState("reqdoc")
    s.kb = kbOf(2)
    const bar = buildStateBar(s, "prd")
    expect(bar).toContain("知识库：必填槽位 2/")
    expect(bar).toContain("未就绪")
  })

  test("未建知识库 → 提示先 reqdoc_ingest", () => {
    const s = createWorkflowState("reqdoc")
    const bar = buildStateBar(s, "prd")
    expect(bar).toContain("知识库：未建")
  })
})
