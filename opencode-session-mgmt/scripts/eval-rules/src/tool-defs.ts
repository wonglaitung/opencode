/**
 * 评测用精简工具定义(OpenAI JSON schema)。
 * 与 packages/plugin/src/tools/workflow.ts、review.ts 的 description/参数名保持一致——
 * 改插件工具时须同步这里,确保评测测的是真实插件暴露给模型的工具契约。
 * 评测只判 tool_use、不执行工具,故省略插件的 Store/execute 上下文。
 */
export type OpenAITool = {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, any>
  }
}

const str = (description: string) => ({ type: "string", description })
const bool = (description: string) => ({ type: "boolean", description })

export const EVAL_TOOLS: OpenAITool[] = [
  {
    type: "function",
    function: {
      name: "workflow_advance",
      description:
        "推进工作流阶段：enter 进入某阶段(in_progress)，approve 在开发者明确确认后标记该阶段完成。" +
        "审查阶段不可用本工具 approve，必须经 review_submit。",
      parameters: {
        type: "object",
        properties: {
          stage: str("目标阶段(当前工作流类型的有效阶段之一)"),
          action: { type: "string", enum: ["enter", "approve"], description: "enter=开始该阶段；approve=确认完成" },
          developer_confirmed: bool("approve 时必须为 true，表示开发者已在对话中明确确认；否则调用将被拒绝"),
          note: str("本次转换的备注"),
        },
        required: ["stage", "action", "developer_confirmed"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "workflow_revisit",
      description: "回退到指定阶段(该阶段 revision++，状态回到 in_progress)。开发者说『回到XX』时调用。",
      parameters: {
        type: "object",
        properties: {
          stage: str("要回退到的阶段(当前工作流类型的有效阶段之一)"),
          note: str("回退原因"),
        },
        required: ["stage"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "workflow_baseline",
      description:
        "录入本会话的基线预估人工工时(项目经理在需求创建时给出的预估，如 8 小时)，用于会话结束后与实际周期对比、计算 AI 提效百分比。可重复调用以重设(幂等覆盖，记最新值)。",
      parameters: {
        type: "object",
        properties: {
          estimated_hours: { type: "number", description: "预估人工工时(小时，可小数)，由项目经理给出，如 8" },
          developer_confirmed: bool("必须为 true，表示开发者已在对话中明确给出/确认该预估值(防止 AI 杜撰基线)"),
        },
        required: ["estimated_hours", "developer_confirmed"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "commit_gate_check",
      description:
        "提交门禁检查：返回各阶段的完成状况；未全部 approved 时列出未完成阶段。提交前应调用。仅当前工作流类型有提交门禁时生效(sdlc)。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "comprehension_add",
      description:
        "审查阶段：登记一个 AI 生成的代码片段(sdlc)或 PRD 要点(reqdoc)及其自然语言解释。" +
        "sdlc 需填 file/lineStart/lineEnd；reqdoc(要点)不填代码位置。登记后 decision=pending，待开发者 confirm/reject 定夺。",
      parameters: {
        type: "object",
        properties: {
          codeSegmentId: str("标识：sdlc 为代码段 id(如 auth/service.ts:12-45)，reqdoc 为要点 id"),
          explanation: str("自然语言解释，含设计推导、替代方案与风险"),
          file: str("sdlc 专属：文件路径；reqdoc 不填"),
          lineStart: { type: "integer", description: "sdlc 专属：起始行；reqdoc 不填" },
          lineEnd: { type: "integer", description: "sdlc 专属：结束行；reqdoc 不填" },
        },
        required: ["codeSegmentId", "explanation"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "comprehension_confirm",
      description:
        "确认单个片段/要点一次通过(accepted)。单次调用只接受一个 codeSegmentId——批量确认在服务端被拒绝。" +
        "pending 与 rejected(开发者复议后接受)均可确认；已 manual 终态的不可再 confirm。",
      parameters: {
        type: "object",
        properties: {
          codeSegmentId: str("要确认的单个片段/要点标识"),
        },
        required: ["codeSegmentId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "comprehension_reject",
      description:
        "拒绝单个片段/要点：开发者有异议或需改动，feedback 必填(作为 rewrite 的依据)。进入 rejected 状态，须经 rewrite 重写或由开发者 manual 自处理，不允许悬空。",
      parameters: {
        type: "object",
        properties: {
          codeSegmentId: str("被拒绝的片段/要点标识"),
          feedback: str("拒绝意见：期望的改动、被误导的地方或风险点"),
        },
        required: ["codeSegmentId", "feedback"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "comprehension_rewrite",
      description: "按拒绝意见重写：AI 依据 feedback 修改后调用，回到 pending 重新审查，rewrites++。仅 rejected 可重写。",
      parameters: {
        type: "object",
        properties: {
          codeSegmentId: str("被拒绝待重写的片段/要点标识"),
        },
        required: ["codeSegmentId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "comprehension_manual",
      description:
        "开发者自行处理被拒绝的片段/要点(大改、废弃或人工接手)：声明 resolution 结果说明，进入 manual 终态。manual 不进入一次通过率分子，但计入定论分母。",
      parameters: {
        type: "object",
        properties: {
          codeSegmentId: str("被拒绝、由开发者自行处理的片段/要点标识"),
          resolution: str("处理结果说明，如『已废弃』『已人工重写』『保留但记入风险』"),
        },
        required: ["codeSegmentId", "resolution"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "comprehension_ask",
      description: "对某片段/要点追问：将开发者的问题与 AI 的解答追加到其 explanation(形成可检索知识库)。",
      parameters: {
        type: "object",
        properties: {
          codeSegmentId: str("被追问的片段/要点标识"),
          question: str("开发者的问题"),
          answer: str("AI 的解答"),
        },
        required: ["codeSegmentId", "question", "answer"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "review_submit",
      description:
        "提交审查清单。仅当清单各项均为 true，且所有已登记片段处于终态(accepted/manual，不允许 pending/rejected 悬空)时，审查阶段才会 approve；通过时自动计算一次通过率。",
      parameters: {
        type: "object",
        properties: {
          businessIntent: bool("业务意图清晰"),
          logicExplainable: bool("逻辑可解释"),
          behaviorVerifiable: bool("行为可验证"),
          completeness: bool("信息完整(背景/口径/字段齐全)"),
          clarity: bool("表达明确(无歧义、可落地)"),
          edgeCoverage: bool("边界覆盖(异常/权限/合规场景俱到)"),
          resolution: bool("职责清晰(技术初步可行性已确认)"),
        },
      },
    },
  },
  {
    // 来自姊妹插件 opencode-open-ide（人工文件锁，规则 sdlc-r12）。评测只判 tool_use 契约。
    type: "function",
    function: {
      name: "open_ide",
      description:
        "打开本机 IDE(默认 VS Code → IntelliJ IDEA)供开发者人工修改代码；指定 file 时自动锁定该文件。",
      parameters: {
        type: "object",
        properties: {
          file: str("要打开的文件路径(相对项目目录或绝对路径)"),
          line: str("定位行号(配合 file 使用)"),
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "unlock_file",
      description: "人工文件锁解锁：须开发者明确确认改完(developer_confirmed=true)才生效。",
      parameters: {
        type: "object",
        properties: {
          file: str("要解锁的文件路径(相对项目目录或绝对路径)"),
          developer_confirmed: bool("必须为 true，表示开发者已明确确认改完该文件"),
        },
        required: ["file", "developer_confirmed"],
      },
    },
  },
]
