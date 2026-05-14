#Requires -Version 5.1
# Claws — Windows PowerShell installer
# Usage: iwr https://raw.githubusercontent.com/neunaha/claws/v0.8-alpha/scripts/install.ps1 | iex
#
# Env overrides:
#   $env:CLAWS_BRANCH        — branch/tag to install (default: v0.8-alpha)
#   $env:CLAWS_VSCODE_CLI    — full path to Code.cmd (overrides auto-detection)

$ErrorActionPreference = 'Stop'

# Without SilentlyContinue, PS 5.1 redraws the progress bar every chunk (20-50x slower)
$ProgressPreference = 'SilentlyContinue'

# Branch override (PS 5.1: no ?? operator)
if ($env:CLAWS_BRANCH) { $BRANCH = $env:CLAWS_BRANCH } else { $BRANCH = 'v0.8-alpha' }

# Banner (ASCII-only — Unicode box chars render as ? in PS 5.1 / legacy consoles)
Write-Host ""
Write-Host "  +-------------------------------------------+" -ForegroundColor Cyan
Write-Host "  |                                           |" -ForegroundColor Cyan
Write-Host "  |   CLAWS -- Terminal Control Bridge        |" -ForegroundColor Cyan
Write-Host "  |   Project-local orchestration setup       |" -ForegroundColor Cyan
Write-Host "  |                                           |" -ForegroundColor Cyan
Write-Host "  +-------------------------------------------+" -ForegroundColor Cyan
Write-Host ""

# Preflight
Write-Host "Checking dependencies..." -ForegroundColor White

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "  ERROR: 'node' not found in PATH." -ForegroundColor Red
  Write-Host "  Install Node.js 18+ from: https://nodejs.org/" -ForegroundColor Yellow
  exit 1
}
$NodeVersionStr = (& node --version 2>&1).ToString().TrimStart('v')
$NodeMajor = [int]($NodeVersionStr.Split('.')[0])
if ($NodeMajor -lt 18) {
  Write-Host ("  ERROR: Node.js v" + $NodeVersionStr + " is too old -- Claws requires Node 18+.") -ForegroundColor Red
  Write-Host "  Upgrade from: https://nodejs.org/" -ForegroundColor Yellow
  exit 1
}
Write-Host ("  OK  node v" + $NodeVersionStr) -ForegroundColor Green

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host "  ERROR: 'git' not found in PATH." -ForegroundColor Red
  Write-Host "  Install Git from: https://git-scm.com/download/win" -ForegroundColor Yellow
  exit 1
}
$GitVersionStr = (& git --version 2>&1).ToString() -replace 'git version ', ''
Write-Host ("  OK  git " + $GitVersionStr) -ForegroundColor Green

# MSVC preflight — node-pty requires C++ build tools; warn-not-block if absent
$HasMSVC = (Get-Command 'cl.exe' -ErrorAction SilentlyContinue) -or
           (Get-Command 'msbuild.exe' -ErrorAction SilentlyContinue)
if (-not $HasMSVC) {
  Write-Host "  WARN: C++ build tools not found -- node-pty may not compile." -ForegroundColor Yellow
  Write-Host "        Install: winget install Microsoft.VisualStudio.BuildTools" -ForegroundColor DarkGray
}

Write-Host ("  Project: " + (Get-Location).Path) -ForegroundColor DarkGray
Write-Host ""

# Download + extract + delegate
$TempDir = $null
try {
  $TempDir = Join-Path $env:TEMP ("claws-install-" + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

  $TarballUrl  = "https://codeload.github.com/neunaha/claws/tar.gz/refs/heads/" + $BRANCH
  $TarballPath = Join-Path $TempDir "claws.tar.gz"
  $ExtractDir  = Join-Path $TempDir "extract"

  Write-Host ("Downloading branch '" + $BRANCH + "'...") -ForegroundColor White
  Invoke-WebRequest -Uri $TarballUrl -OutFile $TarballPath -UseBasicParsing

  Write-Host "Extracting..." -ForegroundColor White
  New-Item -ItemType Directory -Path $ExtractDir -Force | Out-Null
  & tar -xzf $TarballPath -C $ExtractDir
  if ($LASTEXITCODE -ne 0) { throw ("tar extraction failed (exit " + $LASTEXITCODE + ")") }

  # GitHub tarballs unpack to one top-level directory (e.g. neunaha-claws-<sha>)
  $RepoRoot = Get-ChildItem -Path $ExtractDir -Directory | Select-Object -First 1 -ExpandProperty FullName
  if (-not $RepoRoot) { throw ("No directory found in extracted archive at " + $ExtractDir) }

  $NodeCli = Join-Path $RepoRoot "bin\cli.js"
  if (-not (Test-Path $NodeCli)) { throw ("bin\cli.js not found at " + $NodeCli) }

  # Detect VS Code CLI: env override → LOCALAPPDATA → ProgramFiles → PATH
  $CodePath = ''
  if ($env:CLAWS_VSCODE_CLI) {
    $CodePath = $env:CLAWS_VSCODE_CLI
  } elseif (Test-Path "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\Code.cmd") {
    $CodePath = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\Code.cmd"
  } elseif (Test-Path "$env:ProgramFiles\Microsoft VS Code\bin\Code.cmd") {
    $CodePath = "$env:ProgramFiles\Microsoft VS Code\bin\Code.cmd"
  } elseif (Get-Command 'Code.cmd' -ErrorAction SilentlyContinue) {
    $CodePath = (Get-Command 'Code.cmd').Source
  }

  if (-not $CodePath) {
    Write-Host "  WARN: VS Code CLI not found -- extension install will be skipped." -ForegroundColor Yellow
    Write-Host "        After install: VS Code > 'Shell Command: Install code command in PATH'" -ForegroundColor DarkGray
  }

  # Delegate to Node installer; lib/install.js owns VSIX build, phases, and final output
  Write-Host "Running installer..." -ForegroundColor White
  $NodeArgs = @($NodeCli, 'install', '--vscode-cli', $CodePath) + $args
  & node @NodeArgs
  if ($LASTEXITCODE -ne 0) { throw ("node installer exited with code " + $LASTEXITCODE) }

  Remove-Item -Recurse -Force -Path $TempDir -ErrorAction SilentlyContinue
  $TempDir = $null
} catch {
  Write-Host ""
  Write-Host ("  INSTALL FAILED: " + $_) -ForegroundColor Red
  if ($TempDir -and (Test-Path $TempDir)) {
    Write-Host ("  Extract dir left for debugging: " + $TempDir) -ForegroundColor Yellow
  }
  Write-Host ""
  exit 1
}
