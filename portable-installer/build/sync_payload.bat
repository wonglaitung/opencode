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

echo [1/9] 同步 Node 工具链
robocopy "%SRC_NODE%" "%DST%\runtime" /E /PURGE /SL /XF "opencode.exe.bak-*" /R:0 /W:0 /NFL /NDL /NJH /NJS

echo [2/9] 同步 Python 环境
robocopy "%SRC_PY%" "%DST%\python" /E /PURGE /SL /R:0 /W:0 /NFL /NDL /NJH /NJS

echo [3/9] 同步 Windows Terminal
robocopy "%SRC_TERMINAL%" "%DST%\terminal" /E /PURGE /R:0 /W:0 /NFL /NDL /NJH /NJS

echo [4/9] 补 python3.exe 别名
if not exist "%DST%\python\python3.exe" copy /Y "%DST%\python\python.exe" "%DST%\python\python3.exe" >nul

echo [5/9] 剔除 torch，单文件 dnnl.lib 超 2GB 且技能不需要
if exist "%DST%\python\Lib\site-packages\torch" rmdir /s /q "%DST%\python\Lib\site-packages\torch"

echo [6/9] 剔除 opencode 重复平台包，运行时只用 opencode-ai\bin\opencode.exe
if exist "%DST%\runtime\node_modules\opencode-windows-x64" rmdir /s /q "%DST%\runtime\node_modules\opencode-windows-x64"
if exist "%DST%\runtime\node_modules\opencode-windows-x64-baseline" rmdir /s /q "%DST%\runtime\node_modules\opencode-windows-x64-baseline"
if exist "%DST%\runtime\node_modules\opencode-ai\node_modules\opencode-windows-x64" rmdir /s /q "%DST%\runtime\node_modules\opencode-ai\node_modules\opencode-windows-x64"
if exist "%DST%\runtime\node_modules\opencode-ai\node_modules\opencode-windows-x64-baseline" rmdir /s /q "%DST%\runtime\node_modules\opencode-ai\node_modules\opencode-windows-x64-baseline"
rem 删除 opencode 自动升级留下的旧版备份，避免载荷逼近 2 GiB
if exist "%DST%\runtime\node_modules\opencode-ai\bin\opencode.exe.bak-*" del /f /q "%DST%\runtime\node_modules\opencode-ai\bin\opencode.exe.bak-*"

echo [7/9] 剔除 Python 文档、测试和开发残留
if exist "%DST%\python\Doc" rmdir /s /q "%DST%\python\Doc"
if exist "%DST%\python\Lib\test" rmdir /s /q "%DST%\python\Lib\test"
if exist "%DST%\python\tcl" rmdir /s /q "%DST%\python\tcl"
if exist "%DST%\python\Lib\idlelib" rmdir /s /q "%DST%\python\Lib\idlelib"
if exist "%DST%\python\Lib\ensurepip" rmdir /s /q "%DST%\python\Lib\ensurepip"
if exist "%DST%\python\Lib\venv" rmdir /s /q "%DST%\python\Lib\venv"
if exist "%DST%\python\include" rmdir /s /q "%DST%\python\include"
if exist "%DST%\python\libs" rmdir /s /q "%DST%\python\libs"
if exist "%DST%\python\Lib\site-packages\PyInstaller" rmdir /s /q "%DST%\python\Lib\site-packages\PyInstaller"
if exist "%DST%\python\Lib\site-packages\_pytest" rmdir /s /q "%DST%\python\Lib\site-packages\_pytest"
if exist "%DST%\python\Lib\site-packages\pytest" rmdir /s /q "%DST%\python\Lib\site-packages\pytest"
if exist "%DST%\python\Lib\site-packages\torchvision" rmdir /s /q "%DST%\python\Lib\site-packages\torchvision"
if exist "%DST%\python\Lib\site-packages\torchaudio" rmdir /s /q "%DST%\python\Lib\site-packages\torchaudio"
if exist "%DST%\python\Lib\site-packages\torchgen" rmdir /s /q "%DST%\python\Lib\site-packages\torchgen"
if exist "%DST%\python\Lib\site-packages\torch-2.8.0+cpu.dist-info" rmdir /s /q "%DST%\python\Lib\site-packages\torch-2.8.0+cpu.dist-info"

echo [8/9] 剔除 Mermaid 相关依赖
rem sm-plugin 已使用 beautiful-mermaid 和 resvg，不依赖 mermaid-cli
if exist "%DST%\runtime\node_modules\@mermaid-js" rmdir /s /q "%DST%\runtime\node_modules\@mermaid-js"
if exist "%DST%\runtime\node_modules\mermaid" rmdir /s /q "%DST%\runtime\node_modules\mermaid"
if exist "%DST%\runtime\node_modules\@fortawesome" rmdir /s /q "%DST%\runtime\node_modules\@fortawesome"
if exist "%DST%\runtime\node_modules\@zenuml" rmdir /s /q "%DST%\runtime\node_modules\@zenuml"
if exist "%DST%\runtime\node_modules\puppeteer-core" rmdir /s /q "%DST%\runtime\node_modules\puppeteer-core"
if exist "%DST%\runtime\node_modules\chromium-bidi" rmdir /s /q "%DST%\runtime\node_modules\chromium-bidi"
if exist "%DST%\runtime\node_modules\devtools-protocol" rmdir /s /q "%DST%\runtime\node_modules\devtools-protocol"

echo [9/9] 剔除各 bundle 的 npm .bin 符号链接，NSIS 无法打包
powershell -NoProfile -Command "Get-ChildItem '%DST%\runtime' -Recurse -Force -Directory -Filter '.bin' | Remove-Item -Recurse -Force"

echo 载荷同步完成: %DST%
endlocal
