/**
 * 评测用精简工具定义(OpenAI JSON schema)。
 * 与 packages/plugin/src/tools/workflow.ts、review.ts 的 description/参数名保持一致——
 * 改插件工具时须同步这里,确保评测测的是真实插件暴露给模型的工具契约。
 * 评测只判 tool_use、不执行工具,故省略插件的 Store/execute 上下文。
 *
 * 以下工具为**运行时专用、不入 EVAL_TOOLS**：
 * 它读取真实文件（Bun.file + context.worktree），评测沙箱无文件系统，模型调它只会拿到
 * 不存在的路径；渲染达标性改由 judge.kind="render" 判定——用共享 parseRenderStructure 解析
 * 模型回复文本里的 PRD 渲染骨架（评测模型无 write 工具，须在文本中渲染），与运行时同源。
 * 运行时契约供参考：reqdoc_export(source) 把 PRD md 导出为 docx。
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
          force_kb: bool("仅知识库门禁(kbGate)未通过时使用：业务明确「不想再补」时放行。必须同时给 force_reason。默认 false"),
          force_reason: str("force_kb=true 时必填：业务给的不再补齐的理由(模型不得代填)"),
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
    // 人工文件锁工具契约（open-ide 已合并进本工程，规则 sdlc-r12）。评测只判 tool_use 契约。
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
  {
    type: "function",
    function: {
      name: "list_locked_files",
      description: "查看当前会话被人工锁定的文件清单。",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    // reqdoc 双通道：文档扫描工具（重构核心，7.5）。评测只判 tool_use 契约。
    type: "function",
    function: {
      name: "reqdoc_scan",
      description:
        "reqdoc 需求资料扫描：列出指定需求资料目录下的文件，解析并提取文本内容供分析。" +
        "单目录参数，按阶段分步调用：goal→01_背景与目标、rules→03_流程与数据、edge→02_制度与合规 与 04_角色与权限、prd→06_需求规格产出。" +
        "支持 docx/pdf/xlsx/txt/md/json/csv 等文本类；图像与不支持格式会明确提示降级。",
      parameters: {
        type: "object",
        properties: {
          directory: str("需求资料目录名(01_背景与目标 / 02_制度与合规 / 03_流程与数据 / 04_角色与权限 / 06_需求规格产出)"),
        },
        required: ["directory"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reqdoc_confirm_features",
      description:
        "reqdoc prd 阶段：功能点拆解确认。AI 已向业务展示拟定的功能点清单(编号/名称/优先级)，业务明确确认后调用本工具记录清单，并在 05_功能点 下为每个功能点建子目录作为渲染来源区。**prd 门禁：进入 prd 前必须先调用本工具确认功能点清单**。仅 reqdoc 工作流有效。",
      parameters: {
        type: "object",
        properties: {
          features: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: str("功能点名称(如：名单排查)"),
                priority: { type: "string", enum: ["high", "medium", "low"], description: "优先级" },
                note: str("备注(可选)"),
              },
              required: ["name", "priority"],
            },
            description: "业务已确认的功能点清单(至少一个)",
          },
        },
        required: ["features"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reqdoc_ingest",
      description:
        "reqdoc 槽位批量提交：把从材料中提取的内容一次提交为**槽位**（不是直接写文档）。" +
        "服务端按模板派生「哪些槽位还开着」，只让你填这些地址；status 一律记为待确认，业务确认请用 reqdoc_answer。" +
        "分批调用：每次提交后看返回的「本轮该填」清单，一次最多 8 项。仅 reqdoc 工作流有效。",
      parameters: {
        type: "object",
        properties: {
          slots: {
            type: "array",
            description: "本批提交的槽位（地址必须来自上一次的「本轮该填」清单）",
            items: {
              type: "object",
              properties: {
                address: str("槽位地址（服务端给出的待填地址，如 3.1 / 5.1.2.3 / 4.1.CRD）"),
                kind: { type: "string", enum: ["prose", "term", "field"], description: "prose=小节正文；term=术语条目；field=字段定义" },
                content: str("该槽位的内容（业务语言正文；术语填释义；字段填定义说明）"),
                source: { type: "string", enum: ["文档", "问答", "缺省"], description: "来源：文档=材料可循 / 问答=业务口述 / 缺省=本次不涉及（须给 reason）" },
                reason: { type: "string", description: "source=缺省 时必填：本次不涉及的理由" },
                ref: { type: "string", description: "材料出处（文件名或段落，便于溯源）" },
              },
              required: ["address", "kind", "content", "source"],
            },
          },
          features: {
            type: "array",
            description: "功能点清单（首次提交时给；已确认过则省略）",
            items: {
              type: "object",
              properties: {
                name: str("功能点名称（如：名单排查）"),
                priority: { type: "string", enum: ["high", "medium", "low"], description: "优先级" },
              },
              required: ["name", "priority"],
            },
          },
          containers: {
            type: "object",
            description: "容器声明（如 4.1/5.1.2.1 声明 required:false 表示本次无术语/无结构化字段，须给 reason）",
            additionalProperties: {
              type: "object",
              properties: { required: { type: "boolean" }, reason: { type: "string" } },
              required: ["required"],
            },
          },
        },
        required: ["slots"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reqdoc_answer",
      description:
        "reqdoc 槽位确认：把某一项请业务确认后的结论落定（状态转 confirmed）。" +
        "只接受派生清单给出的地址；业务未答满 2 轮的项会被停问，此时应显式收口（source=缺省 + reason 写明未确认原因），而不是反复追问。",
      parameters: {
        type: "object",
        properties: {
          address: str("槽位地址（来自本轮该填清单或停问清单）"),
          content: str("业务确认后的内容（业务语言，不照搬口语）"),
          source: { type: "string", enum: ["文档", "问答", "缺省"], description: "来源：文档 / 问答（业务口述）/ 缺省（本次不涉及）" },
          reason: { type: "string", description: "source=缺省 时必填（如「本次无清算处理」）" },
        },
        required: ["address", "content", "source"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reqdoc_assemble",
      description:
        "reqdoc PRD 组装：把槽位投影成整篇 PRD（md）并归档到 07_需求规格产出。" +
        "结构与来源标签由服务端保证，你不需要也不应手工编辑产物。" +
        "产物内嵌槽位摘要，定稿时据此校验一致性（摘要不符 = 过期产物或被手改）。",
      parameters: {
        type: "object",
        properties: {
          source: str("输出文件名（相对 07_需求规格产出，默认 PRD.md）；功能点子目录由服务端按功能点建"),
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reqdoc_export",
      description:
        "reqdoc prd 阶段：将已渲染的 PRD Markdown 导出为 Word（.docx）交付件，与源 md 同目录归档。" +
        "在 PRD 渲染（write 到 06_需求规格产出）定稿后调用。",
      parameters: {
        type: "object",
        properties: {
          source: str("PRD Markdown 相对项目根路径（06_需求规格产出/N_名称/xxx.md）"),
        },
        required: ["source"],
      },
    },
  },
]
