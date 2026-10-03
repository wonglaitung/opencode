/**
 * 评测用精简工具定义(OpenAI JSON schema)。
 * 与 packages/plugin/src/tools/workflow.ts、review.ts 的 description/参数名保持一致——
 * 改插件工具时须同步这里,确保评测测的是真实插件暴露给模型的工具契约。
 * 评测只判 tool_use、不执行工具,故省略插件的 Store/execute 上下文。
 *
 * 文件系统类工具（reqdoc_init / reqdoc_import / reqdoc_export / reqdoc_review_conventions）
 * **仍列入镜像**：它们是 r8/r32/r14 规则明确指示调用的工具，评测模型必须能看到契约才能遵循规则。
 * 评测沙箱无真实文件系统，调它们不会真的执行——评测只判 tool_use（见文件头）。
 *
 * 渲染达标性由 judge.kind="render" 判定：用共享 parseRenderStructure 解析模型回复文本里的
 * PRD 骨架（评测模型无 write 工具，须在文本中渲染），与运行时同源。
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
          force_kb: bool("仅知识库定稿门禁(kbGate)未通过时使用：业务明确「不想再补」时放行。必须同时给 force_reason。默认 false"),
          force_reason: str("force_kb=true 时必填：业务给的不再补齐的理由(模型不得代填)"),
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
        "reqdoc prd 阶段：功能点拆解确认。AI 已向业务展示拟定的功能点清单(编号/名称/优先级)，业务明确确认后调用本工具记录清单，并在 06_功能点 下为每个功能点建子目录作为渲染来源区。**prd 门禁：进入 prd 前必须先调用本工具确认功能点清单**。仅 reqdoc 工作流有效。",
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
          restated_term: {
            type: "object",
            description:
              "【记忆】仅当业务**主动口头解释了某个缩写/简称**时才填，且 business_quote 必填——" +
              "下一个需求材料出现该词将直接采信、不再追问。**业务只是点了「同意默认」时绝对不要填**，静默接受不入库。",
            properties: {
              term: str("业务刚刚口头复述释义的缩写/简称（如 CRD）"),
              definition: str("业务给出的释义（用业务原话，不要臆测润色）"),
              kind: { type: "string", enum: ["行业通用", "系统口径", "内部简称"], description: "分类：内部简称=行内叫法；系统口径=本系统约定；行业通用=通用行话" },
              business_quote: str("**业务刚才的原话**（照抄听到的那句，不要改写成书面语）——模型不得代填，留空按拒写处理"),
            },
            required: ["term", "definition", "kind", "business_quote"],
          },
        },
        required: ["address", "content", "source"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reqdoc_adopt_baseline",
      description:
        "reqdoc 承认基线：把一份已有需求书派生出的槽位一次性确认为已确认，业务不必把稿里已有的内容再说一遍。" +
        "不带 confirm 先调一次做预演（返回将确认的清单与覆盖率变化）；确认时必须给 authorized_by 与 confirm_note，模型不得代填。" +
        "不会豁免任何必填项：基线没覆盖到的必填地址照旧进「本轮该填」。仅 reqdoc 工作流有效。",
      parameters: {
        type: "object",
        properties: {
          file: str("基线文件路径（相对项目根；槽位的 ref 须指向它）"),
          addresses: { type: "array", items: { type: "string" }, description: "要确认的地址；省略 = 全部 ref 指向该文件且仍待确认的槽位" },
          confirm: { type: "boolean", description: "省略 = 预演（只报清单）；true = 执行" },
          authorized_by: str("confirm=true 时必填：确认人（业务方），模型不得代填"),
          confirm_note: str("confirm=true 时必填：业务确认原话摘要，模型不得代填"),
          unmapped: {
            type: "array",
            description: "必须申报（可为空数组）：稿里有、但本模板装不下的内容及处置",
            items: {
              type: "object",
              properties: {
                excerpt: str("稿里有、但模板装不下的内容（原文摘录）"),
                disposition: str("处置：本次不纳入（理由）/ 归入某地址 / 待业务决定"),
              },
              required: ["excerpt", "disposition"],
            },
          },
        },
        required: ["file", "unmapped"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reqdoc_memory_recall",
      description:
        "reqdoc 定稿记忆回顾：把本次收集到的组织知识候选（系统名/接口/产品线等）逐条列给业务**勾选**，" +
        "只有业务勾选的才写入 L2 组织记忆（供后续需求复用为默认值）。" +
        "定稿通过后调用一次即可；业务未勾选的**不会**写入。不影响任何门禁与判定。",
      parameters: {
        type: "object",
        properties: {
          facts: {
            type: "array",
            description: "业务勾选要记住的条目（由你从本次问答中提取候选，逐条给业务确认）",
            items: { type: "object", properties: { content: str("一条组织知识（如「交易走 CIPS，报文经 ESB」）") }, required: ["content"] },
          },
          prefs: {
            type: "array",
            description: "可选的表达偏好（只影响措辞与详略，不影响事实与门禁）",
            items: {
              type: "object",
              properties: { key: str("偏好键（如 详略/措辞/分工）"), value: str("偏好内容") },
              required: ["key", "value"],
            },
          },
        },
        required: ["facts"],
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
      name: "reqdoc_init",
      description:
        "reqdoc 目录骨架初始化：在需求资料根（项目根）幂等创建 00~07 八个约定目录（编号即五步编写流顺序）" +
        "（00_初稿需求书为已有初稿导入入口；01_背景与目标 / 02_流程与数据 / 03_制度与合规 / 04_角色与权限 / 05_系统现状与能力为业务投放材料区，" +
        "05_系统现状与能力 可选；06_功能点 / 07_需求规格产出为 AI 工作区）。已存在则跳过，绝不重建或覆盖业务已放材料。" +
        "goal 阶段目录就绪检查时，确认业务要搭建骨架后调用本工具。仅 reqdoc 工作流有效。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "reqdoc_import",
      description:
        "reqdoc 初稿导入：把业务已有的初稿需求书（文件或目录路径）解析为 [文档] 来源，落盘到 00_初稿需求书/，" +
        "并产出「按 7 项检查标准的初评」（逐项列 满足/缺失/矛盾）。导入后停在起点，等待业务看初评后逐阶段走工作流补全（不自动快进）。",
      parameters: {
        type: "object",
        properties: { path: str("初稿文件或目录路径（相对项目根，或绝对路径；须在需求资料工作区内）") },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reqdoc_review_conventions",
      description:
        "reqdoc 规约初评：对 00_初稿需求书/ 下已导入的初稿，按 7 项检查标准逐条点评（满足/缺失/矛盾）并标注每条缺失项的补全路径（AI 修/人工补材料/对话补）。",
      parameters: { type: "object", properties: {} },
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
