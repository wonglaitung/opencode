; OpenCode 启动器 (NSIS 编译, 零运行时依赖, 不用 PowerShell)
; 用途: 双击后弹原生目录选择框, 可改工作流/终端/插件开关, 选定项目目录后启动 opencode
; 构建: makensis OpenCode-launch.nsi  ->  OpenCode-launch.exe

Unicode true                    ; 生成 Unicode 安装包, 正确显示中文
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "WinMessages.nsh"

Name "智能研发助手"
Caption "智能研发助手"
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
Var hResume
Var hResumeHint
Var Resume
Var ResumeFlag
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
    StrCpy $HintText "适合写文档、排查问题、整理资料等轻量工作。$\r$\n打开后直接输入要做的事，系统自动开始计时。$\r$\n若被问预估工时，请回「预估 2 小时」；做完说「完成」结束。$\r$\n不需要逐阶段确认，也不会拦截提交。$\r$\n默认新建会话；勾选「继续上次会话」可回到上次进度（已有窗口请先退出）。"
  ${ElseIf} $WorkflowType == "reqdoc"
    StrCpy $HintText "适合业务人员写需求书：口述或投放材料，AI 追问补全后生成 PRD。$\r$\n打开后输入「启动 REQDOC 工作流」，系统会创建资料目录并引导投放材料。$\r$\n目标阶段会问预估工时，请回「预估 2 小时」；文档由系统按阶段生成。$\r$\n定稿前业务需逐条确认要点。$\r$\n默认新建会话；勾选「继续上次会话」可回到上次进度（已有窗口请先退出）。"
  ${Else}
    StrCpy $HintText "适合完整开发：需求 → 设计 → 编码 → 测试 → 审查。$\r$\n打开后输入「启动 SDLC 工作流」，系统会带你逐阶段完成并检查产出。$\r$\n需求阶段会问预估工时，请回「预估 2 小时」；每阶段需你确认才推进。$\r$\n提交代码前须完成全部阶段（含审查）。$\r$\n默认新建会话；勾选「继续上次会话」可回到上次进度（已有窗口请先退出）。"
  ${EndIf}
FunctionEnd

Function RefreshWorkflowHint
  Call SetWorkflowHint
  ${If} $hHint != ""
    ${NSD_SetText} $hHint "$HintText"
    ; 透明 STATIC 控件换文本时不会擦掉旧字形，强制重绘页面避免新旧说明叠在一起。
    System::Call 'user32::RedrawWindow(i $Dialog, i 0, i 0, i 0x185)'
  ${EndIf}
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
  Call RefreshWorkflowHint
  Call UpdateResumeState
FunctionEnd

Function OnWorkflowChange
  ${NSD_CB_GetSelectionIndex} $hWorkflow $0
  ${If} $0 == 0
    StrCpy $WorkflowType "task"
  ${ElseIf} $0 == 2
    StrCpy $WorkflowType "reqdoc"
  ${Else}
    StrCpy $WorkflowType "sdlc"
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
    MessageBox MB_ICONSTOP "未找到 OpenCode 运行时, 请重新运行安装包。"
    Return
  ${EndIf}

  ; 读取三个选择
  ${NSD_CB_GetSelectionIndex} $hWorkflow $0
  ${If} $0 == 0
    StrCpy $WorkflowType "task"
  ${ElseIf} $0 == 2
    StrCpy $WorkflowType "reqdoc"
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
    Exec '"$PROFILE\OpenCode\terminal\OpenConsole.exe" cmd /c "title 智能研发助手 && $PROFILE\OpenCode\runtime\opencode.cmd$ResumeFlag"'
  ${Else}
    Exec '"$PROFILE\OpenCode\runtime\opencode.cmd"$ResumeFlag'
  ${EndIf}
  ; 关闭向导窗口, 让 nsDialogs 的消息循环退出
  SendMessage $HWNDPARENT ${WM_CLOSE} 0 0
FunctionEnd

Function DoCancel
  SendMessage $HWNDPARENT ${WM_CLOSE} 0 0
FunctionEnd

Function LaunchPage
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}

  ; 内容页 720x580；窗口 760x660（含标题栏与隐藏的向导按钮区）
  System::Call 'user32::SetWindowPos(i $HWNDPARENT, i 0, i 0, i 0, i 760, i 660, i 0x0006)'
  System::Call 'user32::SetWindowPos(i $Dialog, i 0, i 0, i 0, i 720, i 580, i 0x0004)'

  CreateFont $TitleFont "$(^Font)" 20 700
  CreateFont $SubFont "$(^Font)" 10 400
  CreateFont $SectionFont "$(^Font)" 10 700
  CreateFont $HintTitleFont "$(^Font)" 10 700
  CreateFont $BodyFont "$(^Font)" 10 400
  CreateFont $ButtonFont "$(^Font)" 11 700

  ${NSD_CreateLabel} 30 18 400 30 "智能研发助手"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $TitleFont 1
  SetCtlColors $0 0x111827 transparent

  ${NSD_CreateLabel} 30 50 540 18 "选择项目目录与工作流，然后打开 AI Assistant"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $SubFont 1
  SetCtlColors $0 0x6B7280 transparent

  ${NSD_CreateHLine} 30 80 660 2 ""
  Pop $0

  ${NSD_CreateLabel} 30 100 200 18 "项目目录"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $SectionFont 1
  SetCtlColors $0 0x374151 transparent

  ${NSD_CreateDirRequest} 30 120 528 32 "$LastDir"
  Pop $hDir
  ${NSD_CreateButton} 570 120 120 32 "浏览…"
  Pop $0
  ${NSD_OnClick} $0 DirBrowse

  ${NSD_CreateLabel} 30 176 200 18 "工作流"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $SectionFont 1
  SetCtlColors $0 0x374151 transparent
  ${NSD_CreateDropList} 30 196 360 160 ""
  Pop $hWorkflow
  ${NSD_CB_AddString} $hWorkflow "一般任务"
  ${NSD_CB_AddString} $hWorkflow "SDLC 开发流程"
  ${NSD_CB_AddString} $hWorkflow "REQDOC 需求书"
  ${If} $WorkflowType == "task"
    ${NSD_CB_SetSelectionIndex} $hWorkflow 0
  ${ElseIf} $WorkflowType == "reqdoc"
    ${NSD_CB_SetSelectionIndex} $hWorkflow 2
  ${Else}
    ${NSD_CB_SetSelectionIndex} $hWorkflow 1
  ${EndIf}
  ${NSD_OnChange} $hWorkflow OnWorkflowChange

  ${NSD_CreateLabel} 420 176 200 18 "终端类型"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $SectionFont 1
  SetCtlColors $0 0x374151 transparent
  ${NSD_CreateDropList} 420 196 270 160 ""
  Pop $hTerminal
  ${NSD_CB_AddString} $hTerminal "原生"
  ${NSD_CB_AddString} $hTerminal "专用"
  ${If} $TerminalMode == "dedicated"
    ${NSD_CB_SetSelectionIndex} $hTerminal 1
  ${Else}
    ${NSD_CB_SetSelectionIndex} $hTerminal 0
  ${EndIf}

  ${NSD_CreateGroupBox} 30 250 660 70 "插件"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $HintTitleFont 1
  ${NSD_CreateCheckBox} 46 274 140 18 "会话管理"
  Pop $hSm
  ${NSD_CreateCheckBox} 220 274 120 18 "Edge 调试"
  Pop $hEdge
  ${NSD_CreateCheckBox} 395 274 130 18 "服务器调试"
  Pop $hServer
  ${NSD_CreateLabel} 530 274 145 18 "默认仅启用会话管理"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $SubFont 1
  SetCtlColors $0 0x6B7280 transparent
  ${If} $PluginSm == "1"
    ${NSD_Check} $hSm
  ${Else}
    ${NSD_Uncheck} $hSm
  ${EndIf}
  ${If} $PluginEdge == "1"
    ${NSD_Check} $hEdge
  ${Else}
    ${NSD_Uncheck} $hEdge
  ${EndIf}
  ${If} $PluginServer == "1"
    ${NSD_Check} $hServer
  ${Else}
    ${NSD_Uncheck} $hServer
  ${EndIf}
  ${NSD_OnClick} $hSm OnSmToggle

  ${NSD_CreateGroupBox} 30 340 660 160 "工作流说明"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $HintTitleFont 1
  ${NSD_CreateLabel} 50 364 620 96 "$HintText"
  Pop $hHint
  SendMessage $hHint ${WM_SETFONT} $BodyFont 1
  SetCtlColors $hHint 0x374151 transparent
  Call RefreshWorkflowHint

  ${NSD_CreateCheckBox} 50 464 240 18 "继续上次会话"
  Pop $hResume
  ${NSD_Uncheck} $hResume
  ${NSD_CreateLabel} 300 464 370 18 ""
  Pop $hResumeHint
  SendMessage $hResumeHint ${WM_SETFONT} $SubFont 1
  SetCtlColors $hResumeHint 0x6B7280 transparent
  ${NSD_OnChange} $hDir OnDirChange
  Call UpdateResumeState

  ${NSD_CreateButton} 30 516 510 46 "打开 AI Assistant"
  Pop $2
  SendMessage $2 ${WM_SETFONT} $ButtonFont 1
  ${NSD_OnClick} $2 DoLaunch

  ${NSD_CreateButton} 552 516 138 46 "取消"
  Pop $3
  SendMessage $3 ${WM_SETFONT} $ButtonFont 1
  ${NSD_OnClick} $3 DoCancel

  ; 配置文件或身份不可用时, 只开放仍然安全的选项
  ${If} $ConfigOk != "1"
    EnableWindow $hSm 0
    EnableWindow $hEdge 0
    EnableWindow $hServer 0
  ${EndIf}
  ${If} $IdentityOk != "1"
    EnableWindow $hWorkflow 0
  ${ElseIf} $PluginSm != "1"
    EnableWindow $hWorkflow 0
  ${EndIf}

  ; 窗口居中（GetSystemMetrics 0/1 = 屏幕宽/高）
  System::Call 'user32::GetSystemMetrics(i 0) i .r0'
  System::Call 'user32::GetSystemMetrics(i 1) i .r1'
  IntOp $0 $0 - 760
  IntOp $0 $0 / 2
  IntOp $1 $1 - 660
  IntOp $1 $1 / 2
  System::Call 'user32::SetWindowPos(i $HWNDPARENT, i 0, i $0, i $1, i 760, i 660, i 0x0004)'

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
