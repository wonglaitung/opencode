@echo off
chcp 65001 >nul
setlocal EnableExtensions
rem setup.cmd - offline deployment: prefill @opencode-ai/plugin dependency seed.
rem Messages are pure ASCII on purpose: Windows cmd parses batch files using the
rem active console codepage (GBK/CP936 on Chinese systems); UTF-8 Chinese text in
rem rem/echo lines gets mis-split and executed as bogus commands.
rem
rem Why: after plugins are configured, opencode runs a dependency install per
rem config dir at startup; on an offline machine (no network) it hangs ~1-2 min.
rem The bundled seed/ makes that install a no-op (node_modules present + lock
rem lists @opencode-ai/plugin). Each project's .opencode is independent, so run
rem once per project.
rem
rem Usage:
rem   setup.cmd seed <projectDir>   seeds global config dir (+ ~/.opencode if it
rem                                 exists) and <projectDir>\.opencode; idempotent
rem
rem Verify: opencode should start fast; log should no longer show
rem "background dependency install failed".

set "HERE=%~dp0"
set "SEED=%HERE%seed"

if not exist "%SEED%\node_modules\@opencode-ai\plugin" (
  echo ERROR: bundle is missing seed\node_modules\@opencode-ai\plugin - incomplete package.
  exit /b 1
)

rem ---- setup.cmd seed <projectDir>: seed global + the project's .opencode ----
if /i "%~1"=="seed" (
  if "%~2"=="" (
    echo Usage: setup.cmd seed ^<projectDir^>
    exit /b 1
  )
  call :seed_target "%USERPROFILE%\.config\opencode"
  if exist "%USERPROFILE%\.opencode" call :seed_target "%USERPROFILE%\.opencode"
  call :seed_target "%~2\.opencode"
  echo Seeded global config + %~2\.opencode
  exit /b 0
)

echo Usage: setup.cmd seed ^<projectDir^>
echo Note: run once per project that uses the plugin; global config is seeded automatically.
exit /b 1

:seed_target
rem Copy seed/ into %1 (a config dir); idempotent; creates the dir if missing.
set "T=%~1"
if not exist "%T%" mkdir "%T%"
if not exist "%T%\node_modules" mkdir "%T%\node_modules"
if not exist "%T%\node_modules\@opencode-ai" mkdir "%T%\node_modules\@opencode-ai"
xcopy /E /I /Y /Q "%SEED%\node_modules\@opencode-ai\plugin" "%T%\node_modules\@opencode-ai\plugin" >nul 2>&1
copy /Y "%SEED%\package.json" "%T%\package.json" >nul 2>&1
copy /Y "%SEED%\package-lock.json" "%T%\package-lock.json" >nul 2>&1
exit /b 0
