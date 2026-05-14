#Requires -Version 5.1
# Claws — Windows PowerShell installer
# Usage: iwr https://raw.githubusercontent.com/neunaha/claws/v0.8-alpha/scripts/install.ps1 | iex
#
# Env overrides:
#   $env:CLAWS_BRANCH   — branch/tag to install (default: v0.8-alpha)

$ErrorActionPreference = 'Stop'

# ─── Branch override (PS 5.1: no ?? operator) ─────────────────────────────────
if ($env:CLAWS_BRANCH) {
  $BRANCH = $env:CLAWS_BRANCH
} else {
  $BRANCH = 'v0.8-alpha'
}

# ─── Banner ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  +=============================================+" -ForegroundColor Cyan
Write-Host "  |                                           |" -ForegroundColor Cyan
Write-Host "  |   CLAWS -- Terminal Control Bridge        |" -ForegroundColor Cyan
Write-Host "  |   Windows installer (v0.8-alpha)          |" -ForegroundColor Cyan
Write-Host "  |                                           |" -ForegroundColor Cyan
Write-Host "  +=============================================+" -ForegroundColor Cyan
Write-Host ""
Write-Host ("  Branch: " + $BRANCH) -ForegroundColor DarkGray
Write-Host ""

# ─── Preflight ────────────────────────────────────────────────────────────────
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

$ProjectDir = (Get-Location).Path
Write-Host ("  Project: " + $ProjectDir) -ForegroundColor DarkGray
Write-Host ""

# ─── Download + extract + install ─────────────────────────────────────────────
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
  if (-not (Test-Path $NodeCli)) { throw ("bin\cli.js not found in extracted archive at " + $RepoRoot) }

  # VS Code CLI is optional — warn and continue if absent
  if (-not (Get-Command code -ErrorAction SilentlyContinue)) {
    Write-Host "  WARN: 'code' CLI not in PATH — VS Code extension install will be best-effort." -ForegroundColor Yellow
    Write-Host "        After install: open VS Code > 'Shell Command: Install code command in PATH'" -ForegroundColor DarkGray
  }

  Write-Host "Running installer..." -ForegroundColor White
  $NodeArgs = @($NodeCli, 'install') + $args
  & node @NodeArgs
  if ($LASTEXITCODE -ne 0) { throw ("node installer exited with code " + $LASTEXITCODE) }

  # Cleanup on success only
  Remove-Item -Recurse -Force -Path $TempDir -ErrorAction SilentlyContinue
  $TempDir = $null

  Write-Host ""
  Write-Host "  Claws installed. Run /claws-help in your Claude Code session." -ForegroundColor Green
  Write-Host ""
} catch {
  Write-Host ""
  Write-Host ("  INSTALL FAILED: " + $_) -ForegroundColor Red
  if ($TempDir -and (Test-Path $TempDir)) {
    Write-Host ("  Extract dir left for debugging: " + $TempDir) -ForegroundColor Yellow
  }
  Write-Host ""
  exit 1
}
