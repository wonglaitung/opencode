# opencode-git-sync 安装脚本（Windows / PowerShell）
#
# 用途：在一台新机器上快速装好「跨机会话同步」插件。
#   .\install.ps1 -Generate            # 生成强随机口令（推荐）
#   .\install.ps1 -Passphrase "..."    # 指定口令
#   .\install.ps1 -Check               # 只体检
#   .\install.ps1 -Uninstall           # 卸载
#
[CmdletBinding()]
param(
  [string]$From,
  [string]$Target = "$env:USERPROFILE\.config\opencode\plugin",
  [string]$KeyFile = "$env:USERPROFILE\.config\opencode\git-sync.key",
  [string]$Passphrase,
  [string]$PassphraseFile,
  [switch]$Generate,
  [switch]$NoBuild,
  [switch]$Force,
  [switch]$Uninstall,
  [switch]$Check
)

$ErrorActionPreference = "Stop"
$PluginName = "git-sync.ts"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Err($m)  { Write-Host "  [X]  $m" -ForegroundColor Red }
function Die($m)  { Err $m; exit 1 }

# ---------------------------------------------------------------- 卸载
if ($Uninstall) {
  Write-Host "卸载 opencode-git-sync"
  $plugin = Join-Path $Target $PluginName
  if (Test-Path $plugin) { Remove-Item $plugin -Force; Ok "已移除 $plugin" }
  if (Test-Path $KeyFile) { Remove-Item $KeyFile -Force; Ok "已移除 $KeyFile" }
  Write-Host "远端分支不会自动删除，如需清理：git push <remote> --delete ocsync/<机器名>"
  exit 0
}

# ---------------------------------------------------------------- 体检
if ($Check) {
  Write-Host "体检"
  if (Get-Command git -ErrorAction SilentlyContinue) { Ok "git: $(git --version)" } else { Err "缺少 git" }
  if (Get-Command bun -ErrorAction SilentlyContinue) { Ok "bun: $(bun --version)" } else { Warn "没有 bun（仅重新构建时需要）" }
  if (Get-Command opencode -ErrorAction SilentlyContinue) { Ok "opencode: $(opencode --version)" } else { Warn "PATH 里没有 opencode" }
  $plugin = Join-Path $Target $PluginName
  if (Test-Path $plugin) { Ok "插件已安装: $plugin" } else { Warn "插件未安装: $plugin" }
  if (Test-Path $KeyFile) {
    $acl = Get-Acl $KeyFile
    $open = $acl.Access | Where-Object { $_.IdentityReference -match "Everyone|Users|BUILTIN" -and $_.FileSystemRights -match "Read" }
    if ($open) { Warn "口令文件权限过宽: $KeyFile" } else { Ok "口令文件权限可用: $KeyFile" }
  } else { Warn "口令文件不存在: $KeyFile" }
  if (git rev-parse --is-inside-work-tree 2>$null) {
    $remote = git remote get-url origin 2>$null
    if (-not $remote) { $remote = (git remote 2>$null | Select-Object -First 1) }
    if ($remote) { Ok "同步远端（项目 origin）: $remote" } else { Warn "当前目录没有远端" }
  } else { Warn "当前目录不是 git 仓库" }

  # 口令与远端一致性（需要 bun）
  if ((Get-Command bun -ErrorAction SilentlyContinue) -and (Test-Path "$ScriptDir\script\verify.ts")) {
    Write-Host ""
    Write-Host "口令 / 远端一致性校验"
    bun run "$ScriptDir\script\verify.ts" --key-file $KeyFile 2>&1 | ForEach-Object { Write-Host "  $_" }
  } else {
    Warn "跳过口令校验（需要 bun 才能验证口令是否与远端一致）"
  }
  exit 0
}

# ---------------------------------------------------------------- 取插件产物
Write-Host "安装 opencode-git-sync"
$source = $From
if (-not $source) {
  foreach ($c in @("$ScriptDir\dist\git-sync.ts", "$ScriptDir\..\dist\git-sync.ts", "$ScriptDir\git-sync.ts")) {
    if (Test-Path $c) { $source = $c; break }
  }
}
if (-not $source) { Die "找不到插件产物（dist/git-sync.ts），请先 bun run build 或用 -From 指定路径/URL" }
if ($source -match "^https?://") {
  $tmp = Join-Path $env:TEMP ([System.IO.Path]::GetRandomFileName())
  Invoke-WebRequest -Uri $source -OutFile $tmp -UseBasicParsing
  $source = $tmp
}
if (-not (Test-Path $source)) { Die "插件产物不存在: $source" }

if (-not $NoBuild -and (Test-Path "$ScriptDir\src\index.ts") -and (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Host "构建插件（bun build）"
  Push-Location $ScriptDir
  bun run build | Out-Null
  Pop-Location
  if (Test-Path "$ScriptDir\dist\git-sync.ts") { $source = "$ScriptDir\dist\git-sync.ts" }
}

# ---------------------------------------------------------------- 安装插件文件
New-Item -ItemType Directory -Force -Path $Target | Out-Null
$dest = Join-Path $Target $PluginName
if ((Test-Path $dest) -and (-not $Force)) {
  Warn "已存在 $dest（加 -Force 覆盖）"
} else {
  Copy-Item $source $dest -Force
  Ok "插件已安装: $dest"
}

# ---------------------------------------------------------------- 口令
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $KeyFile) | Out-Null
if ((Test-Path $KeyFile) -and (-not $Force) -and (-not $Passphrase) -and (-not $Generate)) {
  Ok "口令文件已存在，保持不变: $KeyFile"
} else {
  if ($Generate) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $Passphrase = [Convert]::ToBase64String($bytes).Replace("+", "").Replace("/", "").Replace("=", "").Substring(0, 40)
  } elseif ($PassphraseFile) {
    if (-not (Test-Path $PassphraseFile)) { Die "口令文件不存在: $PassphraseFile" }
    $Passphrase = (Get-Content $PassphraseFile -Raw).Trim()
    if (-not $Passphrase) { Die "口令文件为空: $PassphraseFile" }
    Ok "口令已从 $PassphraseFile 读取"
  } elseif (-not $Passphrase) {
    if (-not [Environment]::UserInteractive) { Die "非交互环境：请用 -Passphrase / -PassphraseFile / -Generate 指定口令" }
    Write-Host ""
    Write-Host "这台机器要加入已有的同步仓库吗？"
    Write-Host "  1) 使用现有口令（另一台机器正在用的那个）"
    Write-Host "  2) 生成新口令（仅当这台机器是第一台）"
    Write-Host "  3) 取消"
    $choice = Read-Host "选择 [1-3]"
    if ($choice -eq "2") {
      $bytes = New-Object byte[] 32
      [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
      $Passphrase = [Convert]::ToBase64String($bytes).Replace("+", "").Replace("/", "").Replace("=", "").Substring(0, 40)
    } elseif ($choice -eq "1") {
      $secure = Read-Host "请输入现有口令" -AsSecureString
      $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
      $Passphrase = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    } else {
      Die "已取消"
    }
  }
  if (-not $Passphrase) { Die "口令不能为空" }
  [System.IO.File]::WriteAllText($KeyFile, $Passphrase)
  Ok "口令已写入 $KeyFile"
  if ($Generate) {
    Write-Host ""
    Write-Host "请立刻抄下这个口令（只显示这一次），其他机器要用同一个：" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "    $Passphrase" -ForegroundColor Yellow
    Write-Host ""
  }
}

Write-Host ""
Write-Host "安装完成。下一步："
Write-Host "  1) 打开项目目录，确认远端：git remote get-url origin"
Write-Host "  2) 启动：opencode        （正常使用）"
Write-Host "  3) 跨机接力：opencode -c"
Write-Host "  4) 体检：.\install.ps1 -Check"
Write-Host ""
Write-Host "若这台机器是加入已有同步仓库：用「现有口令」或 -PassphraseFile（从另一台机器拷来的 git-sync.key）。"
