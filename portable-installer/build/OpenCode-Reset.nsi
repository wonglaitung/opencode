; 清空历史会话
; 独立小工具，由 build.bat 编译为 OpenCode-Reset.exe。
; 只删全局会话库与关联快照，不动 .config\opencode、模型设置和项目工作流库。

Unicode true
Name "清空历史会话"
OutFile "OpenCode-Reset.exe"
Icon "icon.ico"
RequestExecutionLevel user
SilentInstall silent
SetCompressor /SOLID lzma
ManifestSupportedOS "all"

!include "LogicLib.nsh"
!include "StrFunc.nsh"
${Using:StrFunc} StrStr

!define SHARE "$PROFILE\.local\share\opencode"
!define STATE "$PROFILE\.local\state\opencode"

Var running
Var out
Var code

Section "Reset"
  ; 没有任何会话数据时直接退出
  IfFileExists "${SHARE}\opencode.db" reset_has_data
  IfFileExists "${SHARE}\opencode.db-wal" reset_has_data
  IfFileExists "${SHARE}\opencode.db-shm" reset_has_data
  IfFileExists "${SHARE}\opencode.db-journal" reset_has_data
  IfFileExists "${SHARE}\snapshot\*.*" reset_has_data
  IfFileExists "${SHARE}\tool-output\*.*" reset_has_data
  IfFileExists "${SHARE}\repos\*.*" reset_has_data
  IfFileExists "${STATE}\prompt-history.jsonl" reset_has_data
  MessageBox MB_OK|MB_ICONINFORMATION "未发现历史会话，无需清理。"
  Quit

reset_has_data:
  ; 有进程占用时拒绝删除，避免留下半删状态
  StrCpy $running ""
  Call CheckProcess
  ${If} $running != ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "检测到智能研发助手仍在运行（$running）。$\r$\n请先完全退出所有窗口，再执行本工具。"
    Quit
  ${EndIf}

  ; 默认按钮为“否”，防止误触
  MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "将删除所有项目的历史会话、快照和工具输出，删除后不可恢复。$\r$\n$\r$\n配置、模型设置和项目工作流记录不会删除。$\r$\n$\r$\n确认继续？" IDNO reset_cancel

  SetFileAttributes "${SHARE}\opencode.db" NORMAL
  SetFileAttributes "${SHARE}\opencode.db-wal" NORMAL
  SetFileAttributes "${SHARE}\opencode.db-shm" NORMAL
  SetFileAttributes "${SHARE}\opencode.db-journal" NORMAL

  Delete "${SHARE}\opencode.db"
  Delete "${SHARE}\opencode.db-wal"
  Delete "${SHARE}\opencode.db-shm"
  Delete "${SHARE}\opencode.db-journal"
  RMDir /r "${SHARE}\snapshot"
  RMDir /r "${SHARE}\tool-output"
  RMDir /r "${SHARE}\repos"
  Delete "${STATE}\prompt-history.jsonl"

  IfFileExists "${SHARE}\opencode.db" reset_failed
  MessageBox MB_OK|MB_ICONINFORMATION "历史会话已清空。$\r$\n配置、模型设置和项目工作流记录未改动。"
  Quit

reset_failed:
  MessageBox MB_OK|MB_ICONSTOP "未能删除会话库：$\r$\n${SHARE}\opencode.db$\r$\n$\r$\n请关闭所有智能研发助手窗口后重试。"
  Quit

reset_cancel:
  Quit
SectionEnd

Function CheckProcess
  nsExec::ExecToStack '"$SYSDIR\tasklist.exe" /FI "IMAGENAME eq opencode.exe" /NH'
  Pop $code
  Pop $out
  ${StrStr} $9 $out "opencode.exe"
  ${If} $9 != ""
    StrCpy $running "opencode.exe"
    Return
  ${EndIf}

  nsExec::ExecToStack '"$SYSDIR\tasklist.exe" /FI "IMAGENAME eq opencode-sm.exe" /NH'
  Pop $code
  Pop $out
  ${StrStr} $9 $out "opencode-sm.exe"
  ${If} $9 != ""
    StrCpy $running "opencode-sm.exe"
  ${EndIf}
FunctionEnd
