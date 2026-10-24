; OpenCode 启动器 (NSIS 编译, 零运行时依赖, 不用 PowerShell)
; 用途: 双击后弹原生目录选择框, 可改工作流/终端/插件开关, 选定项目目录后启动 opencode
; 构建: makensis OpenCode-launch.nsi  ->  OpenCode-launch.exe

Unicode true                    ; 生成 Unicode 安装包, 正确显示中文
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

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

Function .onInit
  ; 内嵌配置助手, 运行期释放到 $PLUGINSDIR
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "${__FILEDIR__}\launcher-config.js"

  ; 读取上次选择的目录
  ClearErrors
  FileOpen $0 "$PROFILE\.config\opencode\last_project.txt" r
  ${If} $0 != ""
    FileRead $0 $LastDir
    FileClose $0
    ${If} $LastDir == ""
      StrCpy $LastDir "$PROFILE"
    ${EndIf}
  ${Else}
    StrCpy $LastDir "$PROFILE"
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
    StrCpy $HintText "opencode.jsonc 缺失或无法解析, 插件开关不可用, 请重新运行安装包。"
  ${ElseIf} $IdentityOk != "1"
    StrCpy $HintText "身份文件缺失, 工作流不可选, 请先运行 opencode-sm init。"
  ${ElseIf} $PluginSm != "1"
    StrCpy $HintText "未启用会话管理，工作流选择不生效，也不记录工时。"
  ${ElseIf} $WorkflowType == "task"
    StrCpy $HintText "直接输入任务内容即开始（自动计时）$\r$\n预估请回「预估 xx 小时」；完成后请明确说「完成」$\r$\n本次启动生效；已有窗口请先退出"
  ${ElseIf} $WorkflowType == "reqdoc"
    StrCpy $HintText "输入「启动 REQDOC 工作流」进入$\r$\n目标阶段会问「预估 xx 小时」；定稿前业务逐条确认$\r$\n本次启动生效；已有窗口请先退出"
  ${Else}
    StrCpy $HintText "输入「启动 SDLC 工作流」进入$\r$\n需求阶段会问「预估 xx 小时」；提交前须过审查门禁$\r$\n本次启动生效；已有窗口请先退出"
  ${EndIf}
FunctionEnd

Function RefreshWorkflowHint
  Call SetWorkflowHint
  ${If} $hHint != ""
    ${NSD_SetText} $hHint "$HintText"
  ${EndIf}
FunctionEnd

Function DirBrowse
  nsDialogs::SelectFolderDialog "选择项目目录" "$LastDir"
  Pop $0
  ${If} $0 != "error"
  ${AndIf} $0 != "cancel"
  ${AndIf} $0 != ""
    ${NSD_SetText} $hDir $0
    StrCpy $LastDir $0
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

  ; 记忆上次目录
  CreateDirectory "$PROFILE\.config\opencode"
  FileOpen $3 "$PROFILE\.config\opencode\last_project.txt" w
  FileWrite $3 "$DirPath"
  FileClose $3

  ; 在该目录启动 opencode (cwd 即项目根)
  SetOutPath "$DirPath"
  ${If} $TerminalMode == "dedicated"
    Exec '"$PROFILE\OpenCode\terminal\OpenConsole.exe" cmd /c "title 智能研发助手 && $PROFILE\OpenCode\runtime\opencode.cmd -c"'
  ${Else}
    Exec '"$PROFILE\OpenCode\runtime\opencode.cmd" -c'
  ${EndIf}
  ; 关闭向导窗口, 让 nsDialogs 的消息循环退出
  SendMessage $HWNDPARENT ${WM_CLOSE} 0 0
FunctionEnd

Function LaunchPage
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 10u "请选择工作目录"
  ${NSD_CreateDirRequest} 0 12u 75% 12u "$LastDir"
  Pop $hDir
  ${NSD_CreateButton} 75% 12u 25% 12u "浏览"
  Pop $1
  ${NSD_OnClick} $1 DirBrowse

  ${NSD_CreateLabel} 0 32u 38u 10u "工作流"
  ${NSD_CreateDropList} 40u 30u 108u 50u
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

  ${NSD_CreateLabel} 158u 32u 40u 10u "终端类型"
  ${NSD_CreateDropList} 200u 30u 98u 50u
  Pop $hTerminal
  ${NSD_CB_AddString} $hTerminal "原生"
  ${NSD_CB_AddString} $hTerminal "专用"
  ${If} $TerminalMode == "dedicated"
    ${NSD_CB_SetSelectionIndex} $hTerminal 1
  ${Else}
    ${NSD_CB_SetSelectionIndex} $hTerminal 0
  ${EndIf}

  ${NSD_CreateLabel} 0 52u 38u 10u "插件"
  ${NSD_CreateCheckBox} 40u 52u 70u 10u "会话管理"
  Pop $hSm
  ${NSD_CreateCheckBox} 115u 52u 60u 10u "Edge 调试"
  Pop $hEdge
  ${NSD_CreateCheckBox} 180u 52u 85u 10u "服务器调试"
  Pop $hServer
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

  ${NSD_CreateLabel} 0 76u 100% 28u "$HintText"
  Pop $hHint
  SetCtlColors $hHint 666666 transparent
  Call RefreshWorkflowHint

  ${NSD_CreateButton} 0 108u 100% 16u "打开 AI Assistant"
  Pop $2
  ${NSD_OnClick} $2 DoLaunch

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

  ; 向导自带按钮改成中文, 不隐藏, 避免影响主窗口显示
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:关闭"
  GetDlgItem $0 $HWNDPARENT 2
  SendMessage $0 ${WM_SETTEXT} 0 "STR:取消"

  ShowWindow $HWNDPARENT ${SW_SHOW}
  nsDialogs::Show
FunctionEnd

Page custom LaunchPage

Section ""
  ; 空段, 实际启动逻辑在 LaunchPage 的按钮回调中
SectionEnd
