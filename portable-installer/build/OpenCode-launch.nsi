; OpenCode 启动器 (NSIS 编译, 零运行时依赖, 不用 PowerShell)
; 用途: 双击后弹原生目录选择框, 可改工作流/终端/插件开关, 选定项目目录后启动 opencode;
;       工作流说明区提供短提示与按工作流变化的「使用说明」弹窗
; 构建: makensis OpenCode-launch.nsi  ->  OpenCode-launch.exe

Unicode true                    ; 生成 Unicode 安装包, 正确显示中文
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "WinMessages.nsh"

Name "数字程序员"
Caption "数字程序员"
BrandingText " "
OutFile "OpenCode-launch.exe"
Icon "icon.ico"
RequestExecutionLevel user
ShowInstDetails nevershow

Var Dialog
Var hDir
Var DirPath
Var LastDir
Var TerminalMode
Var WorkflowType
Var PluginSm
Var PluginEdge
Var PluginServer
Var ConfigOk
Var IdentityOk
Var Plugins
Var hWorkflow
Var hWfTask
Var hWfSdlc
Var hWfReqdoc
Var hWfWebsec
Var hTerminal
Var hSm
Var hEdge
Var hServer
Var Rc
Var Cmd
Var ErrCode
Var ErrText
Var HintText
Var hHint
Var hHelp
Var HelpText
Var hResume
Var hResumeHint
Var Resume
Var ResumeFlag
Var PromptFlag
Var LastProject
Var LastWorkflow
Var CanResume
Var ResumeHintText
Var TitleFont
Var SubFont
Var SectionFont
Var HintTitleFont
Var BodyFont
Var ButtonFont

Function .onInit
  ; SysLink 控件用于「查看使用说明」文字链接（WinXP+）
  ${NSD_InitCommonControl_SysLink}

  ; 内嵌配置助手, 运行期释放到 $PLUGINSDIR
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "${__FILEDIR__}\launcher-config.js"

  ; 读取上次选择的目录与工作流, 用于判断能否继续上次会话
  StrCpy $LastProject ""
  StrCpy $LastWorkflow ""
  StrCpy $Resume "0"
  StrCpy $ResumeFlag ""
  ClearErrors
  FileOpen $0 "$PROFILE\.config\opencode\last_project.txt" r
  ${If} $0 != ""
    FileRead $0 $LastProject
    FileClose $0
    StrCpy $1 $LastProject "" -1
    ${If} $1 == "$\n"
      StrCpy $LastProject $LastProject -1
    ${EndIf}
    StrCpy $1 $LastProject "" -1
    ${If} $1 == "$\r"
      StrCpy $LastProject $LastProject -1
    ${EndIf}
    StrCpy $LastDir $LastProject
    ${If} $LastDir == ""
      StrCpy $LastDir "$PROFILE"
    ${EndIf}
  ${Else}
    StrCpy $LastDir "$PROFILE"
  ${EndIf}
  ClearErrors
  FileOpen $0 "$PROFILE\.config\opencode\last_workflow.txt" r
  ${If} $0 != ""
    FileRead $0 $LastWorkflow
    FileClose $0
    StrCpy $1 $LastWorkflow "" -1
    ${If} $1 == "$\n"
      StrCpy $LastWorkflow $LastWorkflow -1
    ${EndIf}
    StrCpy $1 $LastWorkflow "" -1
    ${If} $1 == "$\r"
      StrCpy $LastWorkflow $LastWorkflow -1
    ${EndIf}
  ${EndIf}

  ; 默认值
  StrCpy $WorkflowType "sdlc"
  StrCpy $TerminalMode "native"
  StrCpy $PluginSm "1"
  StrCpy $PluginEdge "0"
  StrCpy $PluginServer "0"
  StrCpy $ConfigOk "0"
  StrCpy $IdentityOk "0"

  ; 读取现有配置; 助手不可用时退回上面的默认值
  ExecWait '"$PROFILE\OpenCode\runtime\node.exe" "$PLUGINSDIR\launcher-config.js" --dump "$PLUGINSDIR" --home "$PROFILE"' $Rc
  ${If} $Rc == 0
    ReadINIStr $WorkflowType "$PLUGINSDIR\state.ini" "state" "workflow"
    ReadINIStr $TerminalMode "$PLUGINSDIR\state.ini" "state" "terminal"
    ReadINIStr $PluginSm "$PLUGINSDIR\state.ini" "state" "sm"
    ReadINIStr $PluginEdge "$PLUGINSDIR\state.ini" "state" "edge"
    ReadINIStr $PluginServer "$PLUGINSDIR\state.ini" "state" "server"
    ReadINIStr $ConfigOk "$PLUGINSDIR\state.ini" "state" "config_ok"
    ReadINIStr $IdentityOk "$PLUGINSDIR\state.ini" "state" "identity_ok"
  ${Else}
    ; 助手不可用时退回直接读终端文件
    ClearErrors
    FileOpen $0 "$PROFILE\.config\opencode\terminal_mode.ini" r
    ${If} $0 != ""
      FileRead $0 $TerminalMode
      FileClose $0
      StrCpy $1 $TerminalMode "" -1
      ${If} $1 == "$\n"
        StrCpy $TerminalMode $TerminalMode -1
      ${EndIf}
      StrCpy $1 $TerminalMode "" -1
      ${If} $1 == "$\r"
        StrCpy $TerminalMode $TerminalMode -1
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ; 归一化, 防止空值或异常值把界面带偏
  ${If} $WorkflowType == "task"
  ${ElseIf} $WorkflowType == "websec"
  ${ElseIf} $WorkflowType == "reqdoc"
  ${Else}
    StrCpy $WorkflowType "sdlc"
  ${EndIf}
  ${If} $TerminalMode != "dedicated"
    StrCpy $TerminalMode "native"
  ${EndIf}
  ${If} $PluginSm != "0"
    StrCpy $PluginSm "1"
  ${EndIf}
  ${If} $PluginEdge != "0"
    StrCpy $PluginEdge "1"
  ${EndIf}
  ; WEB 安全自测使用会话管理内置的 Edge 桥接，自动关闭独立 Edge 调试插件。
  ${If} $WorkflowType == "websec"
    StrCpy $PluginEdge "0"
  ${EndIf}
  ${If} $PluginServer != "0"
    StrCpy $PluginServer "1"
  ${EndIf}
  ${If} $ConfigOk != "1"
    StrCpy $ConfigOk "0"
  ${EndIf}
  ${If} $IdentityOk != "1"
    StrCpy $IdentityOk "0"
  ${EndIf}

  ; 配置不可解析时不知道插件真实状态, 界面按全部关闭显示且不允许改动
  ${If} $ConfigOk != "1"
    StrCpy $PluginSm "0"
    StrCpy $PluginEdge "0"
    StrCpy $PluginServer "0"
  ${EndIf}
  Call SetWorkflowHint
FunctionEnd

Function SetWorkflowHint
  ${If} $ConfigOk != "1"
    StrCpy $HintText "配置文件缺失或无法解析，插件开关不可用。$\r$\n请重新运行安装包修复。"
  ${ElseIf} $IdentityOk != "1"
    StrCpy $HintText "身份文件缺失，工作流暂时不可选。$\r$\n请先在命令窗口运行 opencode-sm init。"
  ${ElseIf} $PluginSm != "1"
    StrCpy $HintText "未启用「会话管理」，工作流选择和工时统计都不会生效。$\r$\n请勾选上方「会话管理」。"
  ${ElseIf} $WorkflowType == "task"
    StrCpy $HintText "适合文档、排查、整理、代码审核等轻量任务。$\r$\n新会话自动发送「启动一般任务」；继续上次会话直接恢复。完成后说「本次任务已完成」。$\r$\n代码审核也选这里：启动后说明审核范围；AI 只读审查。"
  ${ElseIf} $WorkflowType == "reqdoc"
    StrCpy $HintText "适合业务写需求书：口述或投放材料，AI 追问补全后生成 PRD。$\r$\n新会话自动发送「启动 REQDOC 工作流」；继续上次会话直接恢复。定稿前逐条确认要点。$\r$\n目标阶段会问预估工时；点「查看使用说明」看详细步骤。"
  ${ElseIf} $WorkflowType == "websec"
    StrCpy $HintText "适合开发人员安全自测：只读检查接口越权、配置与敏感数据。$\r$\n新会话自动发送「启动 WEB 安全测试工作流」；拉起 Edge 后先选普通测试/越权测试。$\r$\n范围阶段会问预估工时；未录入不能定稿。证据正文默认保存在项目 websec-evidence/。"
  ${Else}
    StrCpy $HintText "适合完整开发：需求 → 设计 → 编码 → 测试 → 审查。$\r$\n新会话自动发送「启动 SDLC 工作流」；继续上次会话直接恢复。每阶段需你确认。$\r$\n会问预估工时；点「查看使用说明」看详细步骤。"
  ${EndIf}
FunctionEnd

Function SetHelpText
  ${If} $WorkflowType == "task"
    StrCpy $HelpText "一般任务$\r$\n$\r$\n适合：写文档、排查问题、整理资料、配置环境、代码审核等轻量工作。$\r$\n$\r$\n1. 新会话自动发送「启动一般任务」；勾选「继续上次会话」时直接恢复原会话，不再发送启动短语。$\r$\n2. 启动后描述任务；AI 会归类任务类型。一般分类只影响统计，代码审核例外。$\r$\n3. 会问预估工时，请回「预估 2 小时」；完成后说「本次任务已完成」。$\r$\n4. 不需要逐阶段确认；普通任务不拦截提交，代码审核任务只读、不可提交。$\r$\n$\r$\n代码审核也选「一般任务」：$\r$\n- 新会话自动发送「启动一般任务」后，说明审核范围，例如「帮我审核这次 diff」$\r$\n  「审核 src/auth.ts 的登录改动」或「审核这个 commit：<commit>」。$\r$\n- AI 只读：不改代码、不提交、不跑 build/test/lint。$\r$\n- AI 先用只读 git 检查范围，必要时做规则扫描。$\r$\n- 按六维输出报告，逐条列出发现与修复建议；结论为 approved 或 changes_requested。$\r$\n- 报告提交后才能完成审核任务；changes_requested 不代表自动修改代码。$\r$\n- 非 Git 项目请直接指定文件；扫描是辅助，可能误报。$\r$\n- 超过 20 文件/500 行会提示拆分审核。$\r$\n$\r$\n默认新会话；勾选「继续上次会话」可回到上次进度。"
  ${ElseIf} $WorkflowType == "reqdoc"
    StrCpy $HelpText "REQDOC 需求书$\r$\n$\r$\n适合：业务人员通过口述或投放材料，由 AI 追问补全并生成 PRD。$\r$\n$\r$\n1. 新会话自动发送「启动 REQDOC 工作流」；勾选「继续上次会话」时直接恢复原会话，不再发送启动短语。$\r$\n2. 系统创建 00~07 资料目录，按目标 → 规则 → 边界 → PRD → 审查推进。$\r$\n3. 目标阶段会问预估工时，请回「预估 2 小时」。$\r$\n4. 材料可投放到对应目录，AI 扫描后追问缺失信息。$\r$\n5. PRD 由系统按模板生成，不要手工编辑产物。$\r$\n6. 定稿前业务需逐条确认要点；只改某一章时使用定点修订。$\r$\n7. 默认新会话；勾选「继续上次会话」可回到上次进度。$\r$\n$\r$\n提示：必填槽位未确认或有未收口项时，进入 PRD/定稿会被拦截。"
  ${ElseIf} $WorkflowType == "websec"
    StrCpy $HelpText "WEB 安全自测$\r$\n$\r$\n适合：开发人员对自己负责的系统做上线前安全自测，不替代专业渗透测试。$\r$\n$\r$\n系统内部固定五阶段：范围与边界 → 资产与接口 → 安全检查 → 验证与定级 → 报告与修复。普通测试/越权测试是 Edge 采集模式，不是阶段定义；普通测试你只需三步：确认范围与预估 → 登录操作 → 说「本次录入已完成」，中间阶段由 Agent 内部推进。$\r$\n$\r$\n1. 新会话自动发送「启动 WEB 安全测试工作流」；勾选「继续上次会话」时直接恢复原会话，不再发送启动短语。$\r$\n2. 先记录范围：目标、环境、测试账号、停止条件；按提示给出预估工时（如「预估 8 小时」）。内部自测不需要工单/邮件/合同。$\r$\n3. 拉起 Edge 后先选择模式：$\r$\n   - 普通测试：登录后正常操作，完成说「本次录入已完成」。$\r$\n   - 越权测试：$\r$\n     · 普通账号登录并操作 → 说「本次录入已完成」。$\r$\n     · Agent 采集 baseline 后自动清除登录态，状态条显示「高权账号（privileged）」。$\r$\n     · 用高权账号重新登录并走同样流程 → 再说「本次录入已完成」。$\r$\n     · 也可直接说「切换到高权账号阶段」，Agent 会执行切换；不需要手动清 Cookie。$\r$\n   Agent 会提示当前是普通账号还是高权账号阶段。$\r$\n4. 普通测试需要 1 个账号；越权测试需要至少 2 个不同角色账号（普通 + 高权）。$\r$\n5. 证据正文默认保存在项目 websec-evidence/<sessionID>/，目录内 .gitignore 忽略正文；可用 websec_scope(evidence_dir=...) 改到项目内其它目录。$\r$\n6. 默认只读（GET/HEAD/OPTIONS）；写、删除、爆破、上传利用需逐次明确授权。$\r$\n7. 未录入预估工时时不能定稿；报告通过后执行 /new 开始下一次测试；修复后复测也建议新会话。$\r$\n$\r$\n提示：websec 使用「会话管理」插件内置的 Edge 桥接，不需要额外启用「Edge 调试」插件。没有 Edge 时退回人工浏览/curl。"
  ${Else}
    StrCpy $HelpText "SDLC 开发流程$\r$\n$\r$\n适合：从需求到设计、编码、测试、审查的完整开发。$\r$\n$\r$\n1. 新会话自动发送「启动 SDLC 工作流」；勾选「继续上次会话」时直接恢复原会话，不再发送启动短语。$\r$\n2. 按 需求 → 设计 → 编码 → 测试 → 审查 推进。$\r$\n3. 每阶段完成时需你明确确认，AI 不会自行确认。$\r$\n4. 需求阶段会问预估工时，请回「预估 2 小时」。$\r$\n5. 提交代码前必须完成全部阶段，提交门禁会检查。$\r$\n6. 需要人工改文件时，AI 会先锁定文件；改完确认后解锁。$\r$\n7. 默认新会话；勾选「继续上次会话」可回到上次进度。$\r$\n$\r$\n提示：阶段未确认不会自动推进；切换工作流会新建会话。"
  ${EndIf}

  ${If} $ConfigOk != "1"
  ${OrIf} $IdentityOk != "1"
    StrCpy $HelpText "当前配置不完整，以下步骤需先修复配置/身份文件后使用。$\r$\n$\r$\n$HelpText"
  ${EndIf}

  ${If} $PluginSm != "1"
    StrCpy $HelpText "未启用「会话管理」，工作流与工时统计不会生效。请先勾选「会话管理」。$\r$\n$\r$\n$HelpText"
  ${EndIf}
FunctionEnd

Function ShowUsageHelp
  Call SetHelpText
  MessageBox MB_OK|MB_ICONINFORMATION "$HelpText"
FunctionEnd

Function RefreshWorkflowHint
  Call SetWorkflowHint
  ${If} $hHint != ""
    ${NSD_SetText} $hHint "$HintText"
    ; 透明 STATIC 控件换文本时不会擦掉旧字形，强制重绘页面避免新旧说明叠在一起。
    System::Call 'user32::RedrawWindow(i $Dialog, i 0, i 0, i 0x185)'
  ${EndIf}
  Call SyncWorkflowLabels
FunctionEnd

; 判断当前选择是否可以安全续接上次会话：必须同项目、同工作流且会话管理已启用。
Function CalcCanResume
  StrCpy $CanResume "0"
  ${If} $DirPath == ""
    StrCpy $ResumeHintText "请先选择项目目录"
  ${ElseIf} $ConfigOk != "1"
    StrCpy $ResumeHintText "配置文件不可用，无法继续"
  ${ElseIf} $IdentityOk != "1"
    StrCpy $ResumeHintText "身份文件缺失，无法继续"
  ${ElseIf} $PluginSm != "1"
    StrCpy $ResumeHintText "需启用「会话管理」"
  ${ElseIf} $LastWorkflow == ""
  ${OrIf} $LastProject == ""
    StrCpy $ResumeHintText "暂无可继续的上次会话"
  ${ElseIf} $WorkflowType != $LastWorkflow
    StrCpy $ResumeHintText "工作流已变化，将新建会话"
  ${Else}
    ; 去掉结尾分隔符再比较，避免同一个目录因尾斜杠不同而误判。
    StrCpy $0 $DirPath
    StrCpy $1 $0 "" -1
    ${If} $1 == "\"
      StrCpy $0 $0 -1
    ${EndIf}
    StrCpy $1 $0 "" -1
    ${If} $1 == "/"
      StrCpy $0 $0 -1
    ${EndIf}
    StrCpy $1 $LastProject
    StrCpy $2 $1 "" -1
    ${If} $2 == "\"
      StrCpy $1 $1 -1
    ${EndIf}
    StrCpy $2 $1 "" -1
    ${If} $2 == "/"
      StrCpy $1 $1 -1
    ${EndIf}
    ${If} $0 == $1
    ${AndIf} $0 != ""
      StrCpy $CanResume "1"
      StrCpy $ResumeHintText "可回到上次进度"
    ${Else}
      StrCpy $ResumeHintText "项目已变化，将新建会话"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function UpdateResumeState
  ${If} $hResume == ""
    Return
  ${EndIf}
  ${NSD_GetText} $hDir $DirPath
  Call CalcCanResume
  ${If} $CanResume == "1"
    EnableWindow $hResume 1
  ${Else}
    EnableWindow $hResume 0
    ${NSD_Uncheck} $hResume
    StrCpy $Resume "0"
  ${EndIf}
  ${If} $hResumeHint != ""
    ${NSD_SetText} $hResumeHint "$ResumeHintText"
  ${EndIf}
FunctionEnd

Function OnDirChange
  Call UpdateResumeState
FunctionEnd

Function DirBrowse
  nsDialogs::SelectFolderDialog "选择项目目录" "$LastDir"
  Pop $0
  ${If} $0 != "error"
  ${AndIf} $0 != "cancel"
  ${AndIf} $0 != ""
    ${NSD_SetText} $hDir $0
    StrCpy $LastDir $0
    Call UpdateResumeState
  ${EndIf}
FunctionEnd

Function OnSmToggle
  ${NSD_GetState} $hSm $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $PluginSm "1"
  ${Else}
    StrCpy $PluginSm "0"
  ${EndIf}
  ${If} $0 == ${BST_CHECKED}
  ${AndIf} $IdentityOk == "1"
    EnableWindow $hWorkflow 1
  ${Else}
    EnableWindow $hWorkflow 0
  ${EndIf}
  Call UpdateWorkflowEnabled
  ${If} $hHelp != ""
    ${If} $PluginSm == "1"
      SetCtlColors $hHelp 000080 transparent
      EnableWindow $hHelp 1
    ${Else}
      SetCtlColors $hHelp 0x9CA3AF transparent
      EnableWindow $hHelp 0
    ${EndIf}
  ${EndIf}
  Call RefreshWorkflowHint
  Call UpdateResumeState
FunctionEnd

Function OnWorkflowChange
  ${NSD_CB_GetSelectionIndex} $hWorkflow $0
  ${If} $0 == 0
    StrCpy $WorkflowType "task"
  ${ElseIf} $0 == 2
    StrCpy $WorkflowType "reqdoc"
  ${ElseIf} $0 == 3
    StrCpy $WorkflowType "websec"
  ${Else}
    StrCpy $WorkflowType "sdlc"
  ${EndIf}
  ; 选中 WEB 安全自测时自动取消 Edge 调试插件；切回其它工作流不自动恢复。
  ${If} $WorkflowType == "websec"
    ${NSD_Uncheck} $hEdge
    StrCpy $PluginEdge "0"
  ${EndIf}
  Call RefreshWorkflowHint
  Call UpdateResumeState
FunctionEnd

Function DoLaunch
  ${NSD_GetText} $hDir $DirPath
  ${If} $DirPath == ""
    MessageBox MB_OK "请先选择项目目录"
    Return
  ${EndIf}
  ${IfNot} ${FileExists} "$DirPath\*.*"
    MessageBox MB_OK "目录不存在: $DirPath"
    Return
  ${EndIf}
  ${IfNot} ${FileExists} "$PROFILE\OpenCode\runtime\opencode.cmd"
    MessageBox MB_ICONSTOP "未找到运行环境, 请重新运行安装包。"
    Return
  ${EndIf}

  ; 读取三个选择
  ${NSD_CB_GetSelectionIndex} $hWorkflow $0
  ${If} $0 == 0
    StrCpy $WorkflowType "task"
  ${ElseIf} $0 == 2
    StrCpy $WorkflowType "reqdoc"
  ${ElseIf} $0 == 3
    StrCpy $WorkflowType "websec"
  ${Else}
    StrCpy $WorkflowType "sdlc"
  ${EndIf}
  ${NSD_CB_GetSelectionIndex} $hTerminal $0
  ${If} $0 == 1
    StrCpy $TerminalMode "dedicated"
  ${Else}
    StrCpy $TerminalMode "native"
  ${EndIf}
  ${NSD_GetState} $hSm $PluginSm
  ${NSD_GetState} $hEdge $PluginEdge
  ${NSD_GetState} $hServer $PluginServer

  ; 组装启用的插件列表
  StrCpy $Plugins ""
  ${If} $PluginSm == ${BST_CHECKED}
    StrCpy $Plugins "sm"
  ${EndIf}
  ${If} $PluginEdge == ${BST_CHECKED}
    ${If} $Plugins == ""
      StrCpy $Plugins "edge"
    ${Else}
      StrCpy $Plugins "$Plugins,edge"
    ${EndIf}
  ${EndIf}
  ${If} $PluginServer == ${BST_CHECKED}
    ${If} $Plugins == ""
      StrCpy $Plugins "server"
    ${Else}
      StrCpy $Plugins "$Plugins,server"
    ${EndIf}
  ${EndIf}

  ; 只有用户勾选且项目/工作流与上次启动一致时才续接旧会话
  ${NSD_GetState} $hResume $Resume
  Call CalcCanResume
  StrCpy $ResumeFlag ""
  ${If} $Resume == ${BST_CHECKED}
  ${AndIf} $CanResume == "1"
    StrCpy $ResumeFlag " -c"
  ${EndIf}

  ; 只有新会话注入启动短语；续接会话直接恢复，不预填也不自动发送。
  StrCpy $PromptFlag ""
  ${If} $ResumeFlag != " -c"
    StrCpy $PromptFlag ' --prompt=启动一般任务'
    ${If} $WorkflowType == "sdlc"
      StrCpy $PromptFlag ' --prompt=启动SDLC工作流'
    ${ElseIf} $WorkflowType == "reqdoc"
      StrCpy $PromptFlag ' --prompt=启动REQDOC工作流'
    ${ElseIf} $WorkflowType == "websec"
      StrCpy $PromptFlag ' --prompt=启动WEB安全测试工作流'
    ${EndIf}
  ${EndIf}

  ; 只改用户实际可改的项: 配置文件不可解析时不动插件, 身份不可用时不动工作流
  StrCpy $Cmd '"$PROFILE\OpenCode\runtime\node.exe" "$PLUGINSDIR\launcher-config.js" --apply --error-file "$PLUGINSDIR\apply-error.txt"'
  ${If} $ConfigOk == "1"
    StrCpy $Cmd '$Cmd --plugins "$Plugins" --root "$PROFILE\OpenCode"'
  ${EndIf}
  ${If} $ConfigOk == "1"
  ${AndIf} $IdentityOk == "1"
  ${AndIf} $PluginSm == ${BST_CHECKED}
    StrCpy $Cmd '$Cmd --workflow "$WorkflowType"'
  ${EndIf}
  StrCpy $Cmd '$Cmd --terminal "$TerminalMode"'
  ExecWait '$Cmd' $Rc

  ${If} $Rc != 0
    StrCpy $ErrText "配置写入失败, 已取消启动。"
    ClearErrors
    FileOpen $0 "$PLUGINSDIR\apply-error.txt" r
    ${If} $0 != ""
      FileRead $0 $ErrCode
      FileClose $0
      StrCpy $1 $ErrCode "" -1
      ${If} $1 == "$\n"
        StrCpy $ErrCode $ErrCode -1
      ${EndIf}
      StrCpy $1 $ErrCode "" -1
      ${If} $1 == "$\r"
        StrCpy $ErrCode $ErrCode -1
      ${EndIf}
      ${If} $ErrCode == "CONFIG_MISSING"
        StrCpy $ErrText "$ErrText$\r$\n未找到 opencode.jsonc, 请重新运行安装包。"
      ${ElseIf} $ErrCode == "CONFIG_PARSE"
        StrCpy $ErrText "$ErrText$\r$\nopencode.jsonc 无法解析, 未做修改。"
      ${ElseIf} $ErrCode == "CONFIG_WRITE_BAD"
        StrCpy $ErrText "$ErrText$\r$\n改写后的 opencode.jsonc 校验失败, 未写入。"
      ${ElseIf} $ErrCode == "IDENTITY_MISSING"
        StrCpy $ErrText "$ErrText$\r$\n未找到 identity.json, 请先运行 opencode-sm init 或重新运行安装包。"
      ${ElseIf} $ErrCode == "IDENTITY_PARSE"
        StrCpy $ErrText "$ErrText$\r$\nidentity.json 无法解析, 未做修改。"
      ${ElseIf} $ErrCode == "IDENTITY_INVALID"
        StrCpy $ErrText "$ErrText$\r$\nidentity.json 不完整, 请先运行 opencode-sm init。"
      ${ElseIf} $ErrCode == "PLUGIN_UNKNOWN"
        StrCpy $ErrText "$ErrText$\r$\n插件名不在安装包范围内。"
      ${ElseIf} $ErrCode == "WORKFLOW_UNKNOWN"
        StrCpy $ErrText "$ErrText$\r$\n工作流类型无效。"
      ${ElseIf} $ErrCode == "TERMINAL_UNKNOWN"
        StrCpy $ErrText "$ErrText$\r$\n终端类型无效。"
      ${Else}
        StrCpy $ErrText "$ErrText$\r$\n请检查配置文件权限后重试。"
      ${EndIf}
    ${EndIf}
    MessageBox MB_ICONSTOP "$ErrText"
    Return
  ${EndIf}

  ; 记忆上次目录与真正生效的工作流, 供下次判断能否继续会话
  CreateDirectory "$PROFILE\.config\opencode"
  FileOpen $3 "$PROFILE\.config\opencode\last_project.txt" w
  FileWrite $3 "$DirPath"
  FileClose $3
  ${If} $ConfigOk == "1"
  ${AndIf} $IdentityOk == "1"
  ${AndIf} $PluginSm == ${BST_CHECKED}
    FileOpen $3 "$PROFILE\.config\opencode\last_workflow.txt" w
    FileWrite $3 "$WorkflowType"
    FileClose $3
  ${Else}
    ClearErrors
    Delete "$PROFILE\.config\opencode\last_workflow.txt"
  ${EndIf}

  ; 在该目录启动 opencode (cwd 即项目根)
  SetOutPath "$DirPath"
  ${If} $TerminalMode == "dedicated"
    Exec '"$PROFILE\OpenCode\terminal\OpenConsole.exe" cmd /c "title 数字程序员 && $PROFILE\OpenCode\runtime\opencode.cmd$ResumeFlag$PromptFlag"'
  ${Else}
    Exec '"$PROFILE\OpenCode\runtime\opencode.cmd"$ResumeFlag$PromptFlag'
  ${EndIf}
  ; 关闭向导窗口, 让 nsDialogs 的消息循环退出
  SendMessage $HWNDPARENT ${WM_CLOSE} 0 0
FunctionEnd

Function DoCancel
  SendMessage $HWNDPARENT ${WM_CLOSE} 0 0
FunctionEnd

Function SyncWorkflowLabels
  ${If} $hWfTask == ""
    Return
  ${EndIf}
  ${If} $WorkflowType == "task"
    SetCtlColors $hWfTask 0x60A5FA 0x0F172A
  ${Else}
    SetCtlColors $hWfTask 0xCBD5E1 0x0F172A
  ${EndIf}
  ${If} $WorkflowType == "sdlc"
    SetCtlColors $hWfSdlc 0x60A5FA 0x0F172A
  ${Else}
    SetCtlColors $hWfSdlc 0xCBD5E1 0x0F172A
  ${EndIf}
  ${If} $WorkflowType == "reqdoc"
    SetCtlColors $hWfReqdoc 0x60A5FA 0x0F172A
  ${Else}
    SetCtlColors $hWfReqdoc 0xCBD5E1 0x0F172A
  ${EndIf}
  ${If} $WorkflowType == "websec"
    SetCtlColors $hWfWebsec 0x60A5FA 0x0F172A
  ${Else}
    SetCtlColors $hWfWebsec 0xCBD5E1 0x0F172A
  ${EndIf}
FunctionEnd

Function UpdateWorkflowEnabled
  ${If} $hWfTask == ""
    Return
  ${EndIf}
  ${If} $PluginSm == "1"
  ${AndIf} $IdentityOk == "1"
    EnableWindow $hWfTask 1
    EnableWindow $hWfSdlc 1
    EnableWindow $hWfReqdoc 1
    EnableWindow $hWfWebsec 1
  ${Else}
    EnableWindow $hWfTask 0
    EnableWindow $hWfSdlc 0
    EnableWindow $hWfReqdoc 0
    EnableWindow $hWfWebsec 0
  ${EndIf}
FunctionEnd

Function SelectTaskWorkflow
  ${NSD_CB_SetSelectionIndex} $hWorkflow 0
  Call OnWorkflowChange
FunctionEnd

Function SelectSdlcWorkflow
  ${NSD_CB_SetSelectionIndex} $hWorkflow 1
  Call OnWorkflowChange
FunctionEnd

Function SelectReqdocWorkflow
  ${NSD_CB_SetSelectionIndex} $hWorkflow 2
  Call OnWorkflowChange
FunctionEnd

Function SelectWebsecWorkflow
  ${NSD_CB_SetSelectionIndex} $hWorkflow 3
  Call OnWorkflowChange
FunctionEnd

Function LaunchPage
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}

  ; 参考 GUI.png：深色侧栏 + 浅色主区 + 大输入卡片。
  ; 内容页 1080x680；窗口 1120x720（含标题栏与隐藏的向导按钮区）
  System::Call 'user32::SetWindowPos(i $HWNDPARENT, i 0, i 0, i 0, i 1120, i 720, i 0x0006)'
  System::Call 'user32::SetWindowPos(i $Dialog, i 0, i 0, i 0, i 1080, i 680, i 0x0004)'

  CreateFont $TitleFont "$(^Font)" 20 700
  CreateFont $SubFont "$(^Font)" 10 400
  CreateFont $SectionFont "$(^Font)" 10 700
  CreateFont $HintTitleFont "$(^Font)" 10 700
  CreateFont $BodyFont "$(^Font)" 10 400
  CreateFont $ButtonFont "$(^Font)" 11 700


  ; 品牌区
  ${NSD_CreateLabel} 24 24 212 28 "数字程序员"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $TitleFont 1
  SetCtlColors $0 0xFFFFFF 0x0F172A
  ${NSD_CreateLabel} 24 58 212 18 "Digital Programmer"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $SubFont 1
  SetCtlColors $0 0x94A3B8 0x0F172A

  ${NSD_CreateLabel} 24 104 212 18 "工作流"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $SectionFont 1
  SetCtlColors $0 0x64748B 0x0F172A

  ${NSD_CreateButton} 20 130 220 24 "一般任务"
  Pop $hWfTask
  SendMessage $hWfTask ${WM_SETFONT} $SectionFont 1
  ${NSD_OnClick} $hWfTask SelectTaskWorkflow
  ${NSD_CreateButton} 20 174 220 24 "SDLC 开发流程"
  Pop $hWfSdlc
  SendMessage $hWfSdlc ${WM_SETFONT} $SectionFont 1
  ${NSD_OnClick} $hWfSdlc SelectSdlcWorkflow
  ${NSD_CreateButton} 20 218 220 24 "REQDOC 需求书"
  Pop $hWfReqdoc
  SendMessage $hWfReqdoc ${WM_SETFONT} $SectionFont 1
  ${NSD_OnClick} $hWfReqdoc SelectReqdocWorkflow
  ${NSD_CreateButton} 20 262 220 24 "WEB 安全自测"
  Pop $hWfWebsec
  SendMessage $hWfWebsec ${WM_SETFONT} $SectionFont 1
  ${NSD_OnClick} $hWfWebsec SelectWebsecWorkflow

  ; 隐藏的原生下拉框：保留既有配置/续接判断逻辑，不参与视觉。
  ${NSD_CreateDropList} -100 -100 1 1 ""
  Pop $hWorkflow
  ${NSD_CB_AddString} $hWorkflow "一般任务"
  ${NSD_CB_AddString} $hWorkflow "SDLC 开发流程"
  ${NSD_CB_AddString} $hWorkflow "REQDOC 需求书"
  ${NSD_CB_AddString} $hWorkflow "WEB 安全自测"
  ${If} $WorkflowType == "task"
    ${NSD_CB_SetSelectionIndex} $hWorkflow 0
  ${ElseIf} $WorkflowType == "reqdoc"
    ${NSD_CB_SetSelectionIndex} $hWorkflow 2
  ${ElseIf} $WorkflowType == "websec"
    ${NSD_CB_SetSelectionIndex} $hWorkflow 3
  ${Else}
    ${NSD_CB_SetSelectionIndex} $hWorkflow 1
  ${EndIf}
  ShowWindow $hWorkflow ${SW_HIDE}

  ${NSD_CreateLabel} 24 616 212 18 "本地设置 · 工作流与插件"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $SubFont 1
  SetCtlColors $0 0x64748B 0x0F172A

  ; 主区标题与输入卡片
  ${NSD_CreateLabel} 320 76 600 30 "需要帮你做什么？"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $TitleFont 1
  SetCtlColors $0 0x0F172A transparent
  ${NSD_CreateLabel} 320 112 620 18 "选择项目目录与工作流，然后打开 Digital Programmer"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $SubFont 1
  SetCtlColors $0 0x64748B transparent

  ${NSD_CreateLabel} 320 156 200 18 "项目目录"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $SectionFont 1
  SetCtlColors $0 0x334155 transparent
  ${NSD_CreateDirRequest} 320 180 560 28 "$LastDir"
  Pop $hDir
  ${NSD_CreateButton} 890 180 100 28 "浏览…"
  Pop $0
  ${NSD_OnClick} $0 DirBrowse

  ${NSD_CreateButton} 320 228 650 44 "打开 Digital Programmer"
  Pop $2
  SendMessage $2 ${WM_SETFONT} $ButtonFont 1
  ${NSD_OnClick} $2 DoLaunch
  ${NSD_CreateButton} 980 236 80 28 "取消"
  Pop $3
  SendMessage $3 ${WM_SETFONT} $SubFont 1
  ${NSD_OnClick} $3 DoCancel

  ; 工作流说明卡片
  ${NSD_CreateGroupBox} 320 292 660 160 "工作流说明"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $HintTitleFont 1
  ${NSD_CreateLabel} 340 316 410 96 "$HintText"
  Pop $hHint
  SendMessage $hHint ${WM_SETFONT} $BodyFont 1
  SetCtlColors $hHint 0x334155 0xFFFFFF
  ${NSD_CreateLink} 770 316 190 20 "查看使用说明 ›"
  Pop $hHelp
  SendMessage $hHelp ${WM_SETFONT} $SubFont 1
  SetCtlColors $hHelp 0x2563EB 0xFFFFFF
  ${NSD_OnClick} $hHelp ShowUsageHelp
  ${NSD_CreateLabel} 770 340 190 40 "含示例、步骤与限制说明"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $SubFont 1
  SetCtlColors $0 0x94A3B8 0xFFFFFF

  ; 底部运行选项
  ${NSD_CreateLabel} 320 466 50 18 "终端"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $SectionFont 1
  SetCtlColors $0 0x334155 transparent
  ${NSD_CreateDropList} 380 460 150 120 ""
  Pop $hTerminal
  ${NSD_CB_AddString} $hTerminal "原生"
  ${NSD_CB_AddString} $hTerminal "专用"
  ${If} $TerminalMode == "dedicated"
    ${NSD_CB_SetSelectionIndex} $hTerminal 1
  ${Else}
    ${NSD_CB_SetSelectionIndex} $hTerminal 0
  ${EndIf}

  ${NSD_CreateCheckBox} 560 466 100 18 "会话管理"
  Pop $hSm
  ${If} $PluginSm == "1"
    ${NSD_Check} $hSm
  ${Else}
    ${NSD_Uncheck} $hSm
  ${EndIf}
  ${NSD_OnClick} $hSm OnSmToggle
  ${NSD_CreateCheckBox} 670 466 110 18 "Edge 调试"
  Pop $hEdge
  ${If} $PluginEdge == "1"
    ${NSD_Check} $hEdge
  ${Else}
    ${NSD_Uncheck} $hEdge
  ${EndIf}
  ${NSD_CreateCheckBox} 790 466 130 18 "服务器调试"
  Pop $hServer
  ${If} $PluginServer == "1"
    ${NSD_Check} $hServer
  ${Else}
    ${NSD_Uncheck} $hServer
  ${EndIf}

  ${NSD_CreateCheckBox} 320 500 230 18 "继续上次会话"
  Pop $hResume
  ${NSD_Uncheck} $hResume
  ${NSD_CreateLabel} 550 500 430 18 ""
  Pop $hResumeHint
  SendMessage $hResumeHint ${WM_SETFONT} $SubFont 1
  SetCtlColors $hResumeHint 0x64748B transparent
  ${NSD_OnChange} $hDir OnDirChange

  ${NSD_CreateLabel} 320 548 660 18 "会话管理默认启用 · 审核与工时数据保存在本机"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $SubFont 1
  SetCtlColors $0 0x94A3B8 transparent

  Call RefreshWorkflowHint
  Call UpdateResumeState
  Call UpdateWorkflowEnabled

  ; 背景图压到底层，交互控件保持在上层。

  ; 配置文件或身份不可用时，只开放仍然安全的选项
  ${If} $ConfigOk != "1"
    EnableWindow $hSm 0
    EnableWindow $hEdge 0
    EnableWindow $hServer 0
  ${EndIf}

  ; 窗口居中（GetSystemMetrics 0/1 = 屏幕宽/高）
  System::Call 'user32::GetSystemMetrics(i 0) i .r0'
  System::Call 'user32::GetSystemMetrics(i 1) i .r1'
  IntOp $0 $0 - 1120
  IntOp $0 $0 / 2
  IntOp $1 $1 - 720
  IntOp $1 $1 / 2
  System::Call 'user32::SetWindowPos(i $HWNDPARENT, i 0, i $0, i $1, i 1120, i 720, i 0x0004)'

  ; 页面自绘底部按钮，隐藏向导默认按钮避免重复
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_HIDE}

  ShowWindow $HWNDPARENT ${SW_SHOW}
  nsDialogs::Show
FunctionEnd

Page custom LaunchPage

Section ""
  ; 空段, 实际启动逻辑在 LaunchPage 的按钮回调中
SectionEnd
