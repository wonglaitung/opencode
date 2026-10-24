@echo off
setlocal
set BUILD=%~dp0
set PAYLOAD=%BUILD%..\payload\OpenCode

:: 定位 makensis (按优先级: ProgramFiles(x86) -> ProgramFiles -> PATH)
set "MAKENSIS="
if exist "%ProgramFiles(x86)%\NSIS\makensis.exe" set "MAKENSIS=%ProgramFiles(x86)%\NSIS\makensis.exe"
if not defined MAKENSIS if exist "%ProgramFiles%\NSIS\makensis.exe" set "MAKENSIS=%ProgramFiles%\NSIS\makensis.exe"
if not defined MAKENSIS for %%i in (makensis.exe) do @if "%%~$PATH:i" neq "" set "MAKENSIS=%%~$PATH:i"
if not defined MAKENSIS (echo [ERR] 未找到 makensis, 请先安装 NSIS 3.x & exit /b 1)

:: 检查载荷目录存在
if not exist "%PAYLOAD%\" (echo [ERR] 载荷目录不存在: %PAYLOAD% & echo 请先运行 sync_payload.bat & exit /b 1)

:: 检查载荷大小 (32位 NSIS + LZMA 不能处理超 2GB 的载荷)
for /f %%a in ('powershell -NoProfile -Command "(Get-ChildItem '%PAYLOAD%' -Recurse -File | Measure-Object -Property Length -Sum).Sum"') do set SIZE=%%a
if not defined SIZE goto :size_ok
if %SIZE% LEQ 2147483648 goto :size_ok
echo [WARN] 载荷超过 2GB (%SIZE% bytes), 32位 NSIS 可能无法构建
echo        建议清理源目录中不必要的包后重新 sync_payload.bat
:size_ok

echo [1/3] 构建清空历史会话工具 OpenCode-Reset.exe ...
"%MAKENSIS%" "%BUILD%OpenCode-Reset.nsi"
if errorlevel 1 (echo [FAIL] 清空历史会话工具构建失败 & exit /b 1)

echo [2/3] 构建启动器 OpenCode-launch.exe ...
"%MAKENSIS%" "%BUILD%OpenCode-launch.nsi"
if errorlevel 1 (echo [FAIL] 启动器构建失败 & exit /b 1)

echo [3/3] 构建主安装包 OpenCode-Setup.exe ...
"%MAKENSIS%" "%BUILD%OpenCode-Setup.nsi"
if errorlevel 1 (echo [FAIL] 主包构建失败 & exit /b 1)

echo 完成: %BUILD%OpenCode-Setup.exe
endlocal
