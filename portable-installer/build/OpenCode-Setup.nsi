; OpenCode 一键图形化安装包
; 构建: makensis OpenCode-Setup.nsi  (需安装 NSIS 3.x; PATH 维护用自带的 StrFunc/WordFunc, 无需 EnvVarUpdate.nsh)
; 载荷: 本脚本使用相对路径 ..\payload\OpenCode, 构建前请确保已放置 runtime/ 与 python/

Unicode true                    ; 生成 Unicode 安装包, 正确显示中文
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "StrFunc.nsh"
!include "WordFunc.nsh"
${Using:StrFunc} StrStr

;---------------- 基本信息 ----------------
Name "智能研发助手"
OutFile "OpenCode-Setup.exe"
InstallDir "$PROFILE\OpenCode"
Icon "icon.ico"
!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
RequestExecutionLevel user          ; 装到用户目录, 无需管理员
SetCompressor /SOLID lzma           ; 固实压缩, 减小体积
ManifestSupportedOS "all"

; 打包方可改的默认值
!define DEFAULT_BASEURL "http://<内网模型地址>:<端口>/v1"
!define DEFAULT_COLLECTOR "http://<内网看板收集器地址>:<端口>"
!define DEFAULT_WORKFLOW "sdlc"
!define DEFAULT_MODEL "athlon-coder"
!define DEFAULT_CONTEXT "1000000"
!define DEFAULT_OUTPUT "65536"
!define DEFAULT_TERMINAL "原生终端"

;---------------- 变量 ----------------
Var BaseURL
Var ApiKey
Var Collector
Var Workflow
Var Dialog
Var hBaseURL
Var hApiKey
Var hCollector
Var hWorkflow
Var ContextLimit
Var OutputLimit
Var hContext
Var hOutput
Var TerminalMode
Var hTerminal
Var ModelName
Var hModel
Var ApiKeyEsc
Var BaseURLEsc
Var CollectorEsc
Var ModelNameEsc

;---------------- MUI 页面 ----------------
!insertmacro MUI_PAGE_WELCOME
Page custom ConfigPage1 ConfigPage1Leave
Page custom ConfigPage2 ConfigPage2Leave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_LANGUAGE "SimpChinese"

;---------------- 安装段 ----------------
Section "Install"
  SetOverwrite on

  ; 1. 复制载荷到 %USERPROFILE%\OpenCode
  SetOutPath "$PROFILE"
  File /r "..\payload\OpenCode"

  ; 2. 补 python3.exe 别名
  CopyFiles "$PROFILE\OpenCode\python\python.exe" "$PROFILE\OpenCode\python\python3.exe"

  ; 3. 写配置
  Call WriteConfigs

  ; 3.1 验证配置中的路径已正确展开
  Call VerifyConfigs

  ; 4. 加入当前用户 PATH
  Push "$PROFILE\OpenCode\runtime"
  Call AddToPath
  Push "$PROFILE\OpenCode\python"
  Call AddToPath

  ; 5. 部署启动器与清空历史会话工具
  SetOutPath "$PROFILE\OpenCode"
  File "OpenCode-launch.exe"
  File "OpenCode-Reset.exe"

  ; 6. 快捷方式 (指向启动器, 由启动器弹目录选择)
  CreateDirectory "$SMPROGRAMS\智能研发助手"
  CreateShortCut "$SMPROGRAMS\智能研发助手\智能研发助手.lnk" "$PROFILE\OpenCode\OpenCode-launch.exe" "" "$PROFILE\OpenCode\OpenCode-launch.exe" 0 SW_SHOWNORMAL
  CreateShortCut "$SMPROGRAMS\智能研发助手\清空历史会话.lnk" "$PROFILE\OpenCode\OpenCode-Reset.exe" "" "$PROFILE\OpenCode\OpenCode-Reset.exe" 0 SW_SHOWNORMAL
  CreateShortCut "$DESKTOP\智能研发助手.lnk" "$PROFILE\OpenCode\OpenCode-launch.exe" "" "$PROFILE\OpenCode\OpenCode-launch.exe" 0 SW_SHOWNORMAL

  ; 7. 卸载程序
  WriteUninstaller "$PROFILE\OpenCode\Uninstall.exe"
SectionEnd

;---------------- JSON 字符串转义 ----------------
; 将 ApiKey 中的特殊字符转义, 防止破坏 JSON 结构
; 顺序: 反斜杠 → 双引号 → 控制字符 (必须先转义反斜杠)
Function EscJsonStr
  Exch $0      ; 输入字符串
  Push $1      ; 结果
  Push $2      ; 当前字符
  Push $3      ; 暂存

  StrCpy $1 '"' ; 开头双引号

  EscJsonStr_Loop:
  ${If} $0 == ""
    Goto EscJsonStr_Done
  ${EndIf}

  StrCpy $2 $0 1 0 ; 取首个字符
  StrCpy $0 $0 "" 1 ; 去掉首个字符

  ${If} $2 == '\'
    StrCpy $1 '$1\\'
  ${ElseIf} $2 == '"'
    StrCpy $1 '$1\"'
  ${ElseIf} $2 == '$\t'
    StrCpy $1 '$1\t'
  ${ElseIf} $2 == '$\r'
    StrCpy $1 '$1\r'
  ${ElseIf} $2 == '$\n'
    StrCpy $1 '$1\n'
  ${Else}
    StrCpy $1 '$1$2'
  ${EndIf}

  Goto EscJsonStr_Loop

  EscJsonStr_Done:
  StrCpy $1 '$1"' ; 结尾双引号
  StrCpy $0 $1
  Pop $3
  Pop $2
  Pop $1
  Exch $0
FunctionEnd

;---------------- 写三份配置 ----------------
Function WriteConfigs
  ; 展开 $PROFILE 为实际路径 (如 C:/Users/wongl)
  StrCpy $0 "$PROFILE"
  ; 将反斜杠替换为正斜杠 (JSON 路径规范)
  ${WordReplace} "$0" "\" "/" "+" $0

  ; 转义 ApiKey 中的特殊字符
  Push $ApiKey
  Call EscJsonStr
  Pop $ApiKeyEsc

  ; 转义 BaseURL 中的特殊字符
  Push $BaseURL
  Call EscJsonStr
  Pop $BaseURLEsc

  ; 转义 Collector 中的特殊字符
  Push $Collector
  Call EscJsonStr
  Pop $CollectorEsc

  ; 转义 ModelName 中的特殊字符
  Push $ModelName
  Call EscJsonStr
  Pop $ModelNameEsc

  ; opencode.jsonc
  CreateDirectory "$PROFILE\.config\opencode"
  FileOpen $1 "$PROFILE\.config\opencode\opencode.jsonc" w
  FileWrite $1 "{$\n"
  FileWrite $1 "  $\"$$schema$\": $\"https://opencode.ai/config.json$\",$\n"
  FileWrite $1 "  $\"shell$\": $\"cmd.exe$\",$\n"
  FileWrite $1 "  $\"plugin$\": [$\n"
  FileWrite $1 "    $\"$0/OpenCode/runtime/opencode-sm-bundle/packages/plugin$\",$\n"
  FileWrite $1 "    $\"$0/OpenCode/runtime/opencode-edge-debug-bundle$\",$\n"
  FileWrite $1 "    $\"$0/OpenCode/runtime/opencode-server-debug-bundle$\"$\n"
  FileWrite $1 "  ],$\n"
  FileWrite $1 "  $\"provider$\": {$\n"
  FileWrite $1 "    $\"athlon-coding$\": {$\n"
  FileWrite $1 "      $\"npm$\": $\"@ai-sdk/openai-compatible$\",$\n"
  FileWrite $1 "      $\"name$\": $\"athlon$\",$\n"
  FileWrite $1 "      $\"options$\": {$\n"
  FileWrite $1 "        $\"baseURL$\": $BaseURLEsc,$\n"
  FileWrite $1 "        $\"apiKey$\": $ApiKeyEsc,$\n"
  FileWrite $1 "        $\"temperature$\": 0.1,$\n"
  FileWrite $1 "        $\"maxTokens$\": 16384,$\n"
  FileWrite $1 "        $\"topP$\": 0.9,$\n"
  FileWrite $1 "        $\"thinking$\": { $\"type$\": $\"disabled$\" }$\n"
  FileWrite $1 "      },$\n"
  FileWrite $1 "      $\"models$\": {$\n"
  FileWrite $1 "        $ModelNameEsc: {$\n"
  FileWrite $1 "          $\"name$\": $ModelNameEsc,$\n"
  FileWrite $1 "          $\"modalities$\": { $\"input$\": [$\"text$\", $\"image$\"], $\"output$\": [$\"text$\"] },$\n"
  FileWrite $1 "          $\"limit$\": { $\"context$\": $ContextLimit, $\"output$\": $OutputLimit }$\n"
  FileWrite $1 "        }$\n"
  FileWrite $1 "      }$\n"
  FileWrite $1 "    }$\n"
  FileWrite $1 "  },$\n"
  FileWrite $1 "  $\"permission$\": {$\n"
  FileWrite $1 "    $\"read$\": $\"allow$\",$\n"
  FileWrite $1 "    $\"edit$\": $\"allow$\",$\n"
  FileWrite $1 "    $\"bash$\": $\"ask$\",$\n"
  FileWrite $1 "    $\"webfetch$\": $\"allow$\"$\n"
  FileWrite $1 "  }$\n"
  FileWrite $1 "}$\n"
  FileClose $1

  ; .npmrc
  FileOpen $1 "$PROFILE\.npmrc" w
  FileWrite $1 "offline=true$\n"
  FileClose $1

  ; identity.json
  CreateDirectory "$PROFILE\.config\opencode\session-mgmt"
  FileOpen $1 "$PROFILE\.config\opencode\session-mgmt\identity.json" w
  FileWrite $1 "{$\n"
  FileWrite $1 "  $\"apiKey$\": $ApiKeyEsc,$\n"
  FileWrite $1 "  $\"collector_url$\": $CollectorEsc,$\n"
  FileWrite $1 "  $\"workflowType$\": $\"$Workflow$\"$\n"
  FileWrite $1 "}$\n"
  FileClose $1

  ; terminal_mode.ini
  ${If} $TerminalMode == "专用终端(OpenConsole)"
    StrCpy $0 "dedicated"
  ${Else}
    StrCpy $0 "native"
  ${EndIf}
  FileOpen $1 "$PROFILE\.config\opencode\terminal_mode.ini" w
  FileWrite $1 "$0$\n"
  FileWrite $1 "; mode: native | dedicated (edit this file to switch terminal)$\n"
  FileClose $1
FunctionEnd

;---------------- 验证配置 ----------------
Function VerifyConfigs
  ; 验证 opencode.jsonc 中不包含 %USERPROFILE% 字面量
  FileOpen $0 "$PROFILE\.config\opencode\opencode.jsonc" r
  ${If} $0 != ""
    FileRead $0 $1
    ${While} $1 != ""
      ${StrStr} $2 $1 "%USERPROFILE%"
      ${If} $2 != ""
        MessageBox MB_OK|MB_ICONEXCLAMATION "警告: 配置文件中发现未展开的 %USERPROFILE% 变量，请运行 fix_config.bat 修复"
        FileClose $0
        Return
      ${EndIf}
      FileRead $0 $1
    ${EndWhile}
    FileClose $0
  ${EndIf}
FunctionEnd

;---------------- 配置弹窗 ----------------
Function ConfigPage1
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 12u "模型服务地址 (baseURL):"
  ${NSD_CreateText} 0 12u 100% 12u "${DEFAULT_BASEURL}"
  Pop $hBaseURL

  ${NSD_CreateLabel} 0 24u 100% 12u "API 密钥:"
  ${NSD_CreatePassword} 0 36u 100% 12u ""
  Pop $hApiKey

  ${NSD_CreateLabel} 0 48u 100% 12u "默认模型名称 (model):"
  ${NSD_CreateText} 0 60u 100% 12u "${DEFAULT_MODEL}"
  Pop $hModel

  ${NSD_CreateLabel} 0 72u 100% 12u "收集服务地址 (collector_url):"
  ${NSD_CreateText} 0 84u 100% 12u "${DEFAULT_COLLECTOR}"
  Pop $hCollector

  nsDialogs::Show
FunctionEnd

Function ConfigPage1Leave
  ${NSD_GetText} $hBaseURL $BaseURL
  ${NSD_GetText} $hApiKey $ApiKey
  ${NSD_GetText} $hCollector $Collector
  ${NSD_GetText} $hModel $ModelName
FunctionEnd

Function ConfigPage2
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 12u "上下文长度上限 (context):"
  ${NSD_CreateText} 0 12u 100% 12u "${DEFAULT_CONTEXT}"
  Pop $hContext

  ${NSD_CreateLabel} 0 24u 100% 12u "输出长度上限 (output):"
  ${NSD_CreateText} 0 36u 100% 12u "${DEFAULT_OUTPUT}"
  Pop $hOutput

  ${NSD_CreateLabel} 0 48u 100% 12u "工作流类型:"
  ${NSD_CreateDropList} 0 60u 100% 12u ""
  Pop $hWorkflow
  ${NSD_CB_AddString} $hWorkflow "sdlc"
  ${NSD_CB_AddString} $hWorkflow "reqdoc"
  ${NSD_CB_SelectString} $hWorkflow "${DEFAULT_WORKFLOW}"

  ${NSD_CreateLabel} 0 72u 100% 12u "终端类型:"
  ${NSD_CreateDropList} 0 84u 100% 12u ""
  Pop $hTerminal
  ${NSD_CB_AddString} $hTerminal "原生终端"
  ${NSD_CB_AddString} $hTerminal "专用终端(OpenConsole)"
  ${NSD_CB_SelectString} $hTerminal "${DEFAULT_TERMINAL}"

  nsDialogs::Show
FunctionEnd

Function ConfigPage2Leave
  ${NSD_GetText} $hContext $ContextLimit
  ${NSD_GetText} $hOutput $OutputLimit
  ${NSD_GetText} $hTerminal $TerminalMode
  ${NSD_GetText} $hWorkflow $Workflow
FunctionEnd

;---------------- 卸载段 ----------------
Section "Uninstall"
  ; 移除 PATH
  Push "$PROFILE\OpenCode\runtime"
  Call un.RemoveFromPath
  Push "$PROFILE\OpenCode\python"
  Call un.RemoveFromPath

  ; 删除快捷方式
  Delete "$SMPROGRAMS\智能研发助手\智能研发助手.lnk"
  Delete "$SMPROGRAMS\智能研发助手\清空历史会话.lnk"
  RMDir "$SMPROGRAMS\智能研发助手"
  Delete "$DESKTOP\智能研发助手.lnk"

  ; 删除安装目录与配置
  RMDir /r "$PROFILE\OpenCode"
  RMDir /r "$PROFILE\.config\opencode"
SectionEnd

;---------------- PATH 维护 (HKCU) ----------------
Function AddToPath
  Exch $0
  Push $1
  Push $2
  ReadRegStr $1 HKCU "Environment" "Path"
  ${If} $1 == ""
    WriteRegExpandStr HKCU "Environment" "Path" "$0"
    Goto A2P_Done
  ${EndIf}
  ${StrStr} $2 $1 "$0"
  ${If} $2 == ""
    WriteRegExpandStr HKCU "Environment" "Path" "$1;$0"
  ${EndIf}
A2P_Done:
  SendMessage 0xFFFF 0x1A 0 "STR:Environment" /TIMEOUT=5000
  Pop $2
  Pop $1
  Exch $0
FunctionEnd

Function un.RemoveFromPath
  Exch $0
  Push $1
  ReadRegStr $1 HKCU "Environment" "Path"
  ${If} $1 == ""
    Goto R2P_Done
  ${EndIf}
  ${WordReplace} $1 "$0;" "" "+" $1
  ${WordReplace} $1 ";$0" "" "+" $1
  ${WordReplace} $1 "$0" "" "+" $1
  WriteRegExpandStr HKCU "Environment" "Path" "$1"
R2P_Done:
  SendMessage 0xFFFF 0x1A 0 "STR:Environment" /TIMEOUT=5000
  Pop $1
  Exch $0
FunctionEnd
