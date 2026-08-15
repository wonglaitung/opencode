/**
 * PRD 产出确定性评分（质量飞轮 P0「eval 评分模式」，设计文档 workflow-reqdoc.md 10 章；打分卡标准见 workflow-reqdoc.md 5 章）。
 * 镜像 REQDOC_SCORE_DIMS 的五维扣分标准（workflow.ts），把每个扣分条件映射为
 * 纯文本谓词，对模型渲染出的 PRD 文本逐维扣分——无需 LLM 判卷，弱模型即可跑。
 *
 * 设计要点：
 * - 与 reqdoc_score 工具的「模型自评」是两条独立通道。自评是门禁输入（edge 阶段，
 *   决定能否进 prd）；本评分器是产出度量（prd 渲染后），供评测回归使用：
 *   注入规则/模板改动后，渲染产出质量是否随分数上升，以及自评分数是否「诚实」
 *   （高分自评却渲染不出对应内容 → 由产出度量暴露）。
 * - 关键词必须是「内容专属词」：模板正文本身含「异常处理要求」「差错处理」等标题，
 *   若用模板里出现的词会误判扣分。本文件所有词表经手工核对，与
 *   docs/reqdoc-prd-template.md 的结构词无交集——改动模板时须复查本文件。
 * - 与场景 judge（kind="score"）配合：judge 管「渲染没渲染、达不达标」，本评分器
 *   返回的 PrdScore 同时供 run.ts 聚合五维平均分（baseline→new 逐维对比）。
 */
import { REQDOC_SCORE_DIMS, type ReqdocScoreDimKey } from "sm-shared"

export interface PrdDimScore {
  score: number
  max: number
  /** 命中的扣分条件（如「未提及任何异常」），供归因展示 */
  deductions: string[]
}

export interface PrdScore {
  dims: Record<ReqdocScoreDimKey, PrdDimScore>
  total: number
}

/**
 * 扣分条件 → 文本谓词（返回 true = 该条扣分成立）。
 * 条件 key 与 REQDOC_SCORE_DIMS[].deductionRules[].condition 逐字一致（含「」）。
 */
const PREDICATES: Record<string, (text: string) => boolean> = {
  // businessValue：缺使用角色（柜员/客户/运营等角色词一个都没有）→ 扣 10
  "缺失使用角色": (t) =>
    !["柜员", "客户", "操作员", "出纳", "主管", "管理员", "经理", "经办", "运营", "审批", "审核", "复核"].some((k) =>
      t.includes(k),
    ),
  // businessValue：缺量化目标（没有 % / 降低提升等效果词）→ 扣 5
  "缺乏量化目标": (t) =>
    !["%", "％", "降低", "提升", "减少", "提高", "缩短", "节省", "省去", "小时", "工作日", "分钟"].some((k) =>
      t.includes(k),
    ),
  // flowClosure：流程有头无尾（没有收尾/产出词）→ 扣 15
  "流程有头无尾": (t) =>
    !["提交后", "成功后", "完成后", "返回结果", "入库", "生效", "归档", "流程结束", "通知结果", "落库"].some((k) =>
      t.includes(k),
    ),
  // flowClosure：缺触发条件（没有触发/发起词）→ 扣 10
  "步骤缺少触发条件": (t) =>
    !["点击", "发起", "触发", "提交时", "收到", "到账", "到期", "申请时"].some((k) => t.includes(k)),
  // edgeControl：未提及任何异常（模板标题词「异常处理要求」除外，用内容专属词）→ 扣 25
  "未提及任何异常": (t) =>
    !["超时", "并发", "重复提交", "冲正", "重试", "降级", "失败重试", "回滚", "撤销", "异常恢复"].some((k) =>
      t.includes(k),
    ),
  // compliance：未定义脱敏（敏感字段遮罩 / 留痕 / 复核 / 加密）→ 扣 10
  "未定义脱敏": (t) => !["脱敏", "遮罩", "留痕", "复核", "审计", "加密", "密文"].some((k) => t.includes(k)),
  // authority：描述为「所有人均可使用」（无权限限制措辞）→ 扣 10
  "描述为「所有人均可使用」": (t) =>
    ["所有人均可", "所有人可", "任何人可", "任意人", "人人可", "所有用户", "所有员工", "不设权限", "无权限", "不限制", "都能看"].some(
      (k) => t.includes(k),
    ),
}

/** 对模型渲染的 PRD 文本逐维评分：每维 = max − 命中的扣分，总分 = Σ 各维（下限 0）。 */
export function scorePrd(text: string): PrdScore {
  const dims = {} as Record<ReqdocScoreDimKey, PrdDimScore>
  for (const d of REQDOC_SCORE_DIMS) {
    const deductions: string[] = []
    let score = d.max
    for (const p of d.deductionRules) {
      if (PREDICATES[p.condition]?.(text)) {
        score -= p.points
        deductions.push(p.condition)
      }
    }
    dims[d.key] = { score: Math.max(0, score), max: d.max, deductions }
  }
  const total = Object.values(dims).reduce((sum, d) => sum + d.score, 0)
  return { dims, total }
}
