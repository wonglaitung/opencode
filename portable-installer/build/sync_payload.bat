@echo off
setlocal
rem ============================================================
rem sync_payload.bat - 从源目录同步载荷到 payload\OpenCode
rem 注意: echo 语句中不要包含重定向符号
rem ============================================================
if not defined SRC_NODE     set "SRC_NODE=D:\Tools\node-v22.23.2-win-x64"
if not defined SRC_PY       set "SRC_PY=D:\Tools\Python312"
if not defined SRC_TERMINAL set "SRC_TERMINAL=D:\Tools\terminal-1.23.20211.0"
set "DST=%~dp0..\payload\OpenCode"

if not exist "%SRC_NODE%\"     (echo [ERR] 源 Node 目录不存在: %SRC_NODE% & exit /b 1)
if not exist "%SRC_PY%\"       (echo [ERR] 源 Python 目录不存在: %SRC_PY% & exit /b 1)
if not exist "%SRC_TERMINAL%\" (echo [ERR] 源终端目录不存在: %SRC_TERMINAL% & exit /b 1)

echo [1/7] 同步 Node 工具链
robocopy "%SRC_NODE%" "%DST%\runtime" /E /PURGE /SL /XF "opencode.exe.bak-*" /R:0 /W:0 /NFL /NDL /NJH /NJS

echo [2/7] 同步 Python 环境
robocopy "%SRC_PY%" "%DST%\python" /E /PURGE /SL /R:0 /W:0 /NFL /NDL /NJH /NJS

echo [3/7] 同步 Windows Terminal
robocopy "%SRC_TERMINAL%" "%DST%\terminal" /E /PURGE /R:0 /W:0 /NFL /NDL /NJH /NJS

echo [4/7] 补 python3.exe 别名
if not exist "%DST%\python\python3.exe" copy /Y "%DST%\python\python.exe" "%DST%\python\python3.exe" >nul

echo [5/7] 剔除 torch，单文件 dnnl.lib 超 2GB 且技能不需要
if exist "%DST%\python\Lib\site-packages\torch" rmdir /s /q "%DST%\python\Lib\site-packages\torch"

echo [6/7] 剔除 opencode 重复平台包，运行时只用 opencode-ai\bin\opencode.exe
if exist "%DST%\runtime\node_modules\opencode-windows-x64" rmdir /s /q "%DST%\runtime\node_modules\opencode-windows-x64"
if exist "%DST%\runtime\node_modules\opencode-windows-x64-baseline" rmdir /s /q "%DST%\runtime\node_modules\opencode-windows-x64-baseline"
if exist "%DST%\runtime\node_modules\opencode-ai\node_modules\opencode-windows-x64" rmdir /s /q "%DST%\runtime\node_modules\opencode-ai\node_modules\opencode-windows-x64"
if exist "%DST%\runtime\node_modules\opencode-ai\node_modules\opencode-windows-x64-baseline" rmdir /s /q "%DST%\runtime\node_modules\opencode-ai\node_modules\opencode-windows-x64-baseline"
rem 删除 opencode 自动升级留下的旧版备份，避免载荷逼近 2 GiB
if exist "%DST%\runtime\node_modules\opencode-ai\bin\opencode.exe.bak-*" del /f /q "%DST%\runtime\node_modules\opencode-ai\bin\opencode.exe.bak-*"

echo [7/7] 剔除各 bundle 的 npm .bin 符号链接，NSIS 无法打包
powershell -NoProfile -Command "Get-ChildItem '%DST%\runtime' -Recurse -Force -Directory -Filter '.bin' | Remove-Item -Recurse -Force"

echo 载荷同步完成: %DST%
endlocal
