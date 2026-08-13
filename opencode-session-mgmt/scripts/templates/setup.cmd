@echo off
chcp 65001 >nul
setlocal EnableExtensions
rem setup.cmd —— 内网离线部署：预填 @opencode-ai/plugin 依赖种子（纯 cmd，无需 PowerShell、无需网络）。
rem
rem 背景：opencode 配置插件后，启动会对各 config 目录执行依赖安装，内网机无法联网而卡约 2 分钟。
rem 本脚本把 bundle 内 seed/ 铺进 全局 + 指定项目的 .opencode，让安装判定变为 no-op。
rem 项目 .opencode 目录各自独立，需对每个要用插件的项目各跑一次。
rem
rem 用法：
rem   setup.cmd seed <项目目录>   种全局 config（+ ~/.opencode 若存在）+ 该项目 .opencode；幂等
rem
rem 验证：打开 opencode 应秒开；日志不应再出现 "background dependency install failed"。

set "HERE=%~dp0"
set "SEED=%HERE%seed"

if not exist "%SEED%\node_modules\@opencode-ai\plugin" (
  echo 错误：bundle 内缺少 seed\node_modules\@opencode-ai\plugin，包可能不完整。
  exit /b 1
)

rem ---- setup.cmd seed <项目目录>：种全局 + 指定项目的 .opencode（每个项目跑一次即可） ----
if /i "%~1"=="seed" (
  if "%~2"=="" (
    echo 用法：setup.cmd seed ^<项目目录^>
    exit /b 1
  )
  call :seed_target "%USERPROFILE%\.config\opencode"
  if exist "%USERPROFILE%\.opencode" call :seed_target "%USERPROFILE%\.opencode"
  call :seed_target "%~2\.opencode"
  echo 已种：全局 config + %~2\.opencode
  exit /b 0
)

echo 用法：setup.cmd seed ^<项目目录^>
echo 说明：对每个要用插件的项目各跑一次，会自动一并种全局 config 目录。
exit /b 1

:seed_target
rem 把 seed 铺进 %1（目标 config 目录），幂等；目录不存在则创建。
set "T=%~1"
if not exist "%T%" mkdir "%T%"
if not exist "%T%\node_modules" mkdir "%T%\node_modules"
if not exist "%T%\node_modules\@opencode-ai" mkdir "%T%\node_modules\@opencode-ai"
xcopy /E /I /Y /Q "%SEED%\node_modules\@opencode-ai\plugin" "%T%\node_modules\@opencode-ai\plugin" >nul 2>&1
copy /Y "%SEED%\package.json" "%T%\package.json" >nul 2>&1
copy /Y "%SEED%\package-lock.json" "%T%\package-lock.json" >nul 2>&1
exit /b 0
