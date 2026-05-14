#Requires -Version 5.1
# Claws — Windows PowerShell installer
# Usage: iwr https://raw.githubusercontent.com/neunaha/claws/v0.8-alpha/scripts/install.ps1 | iex
#
# Env overrides:
#   $env:CLAWS_BRANCH        — branch/tag to install (default: v0.8-alpha)
#   $env:CLAWS_VSCODE_CLI    — full path to Code.cmd (overrides auto-detection)

$ErrorActionPreference = 'Stop'

# ─── PowerShell 5.1 IWR slowness fix ──────────────────────────────────────────
# Without SilentlyContinue, Invoke-WebRequest in PS 5.1 redraws the progress bar
# every chunk and runs 20-50x slower than expected. This single line turns a
# 5-minute download into a 5-second one.
$ProgressPreference = 'SilentlyContinue'

# ─── Branch override (PS 5.1: no ?? operator) ─────────────────────────────────
if ($env:CLAWS_BRANCH) {
  $BRANCH = $env:CLAWS_BRANCH
} else {
  $BRANCH = 'v0.8-alpha'
}

# ─── Banner ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ╔═══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║                                           ║" -ForegroundColor Cyan
Write-Host "  ║   CLAWS — Terminal Control Bridge         ║" -ForegroundColor Cyan
Write-Host "  ║   Windows installer (v0.8-alpha)          ║" -ForegroundColor Cyan
Write-Host "  ║                                           ║" -ForegroundColor Cyan
Write-Host "  ╚═══════════════════════════════════════════╝" -ForegroundColor Cyan
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

  # ─── VSIX build + VS Code extension install ────────────────────────────────
  Write-Host ""
  Write-Host "Building VS Code extension..." -ForegroundColor White
  $ExtDir    = Join-Path $RepoRoot "extension"
  $ExtPkgFile = Join-Path $ExtDir "package.json"
  $VsixPath  = $null
  $VsixBuilt = $false

  if (Test-Path $ExtPkgFile) {
    $buildOk  = $false
    $buildErr = $null
    Push-Location $ExtDir
    try {
      $ExtVersion = (Get-Content $ExtPkgFile -Raw | ConvertFrom-Json).version
      $VsixPath   = Join-Path $RepoRoot ("claws-code-" + $ExtVersion + ".vsix")

      Write-Host "  npm install..." -ForegroundColor DarkGray
      & npm install --no-fund --no-audit --omit=optional
      if ($LASTEXITCODE -ne 0) { throw ("npm install failed (exit " + $LASTEXITCODE + ")") }

      Write-Host "  npm run build..." -ForegroundColor DarkGray
      & npm run build
      if ($LASTEXITCODE -ne 0) { throw ("npm run build failed (exit " + $LASTEXITCODE + ")") }

      Write-Host "  Packaging VSIX..." -ForegroundColor DarkGray
      & npx vsce package --no-dependencies -o $VsixPath
      if ($LASTEXITCODE -ne 0) { throw ("vsce package failed (exit " + $LASTEXITCODE + ")") }

      $buildOk = $true
    } catch {
      $buildErr = $_
    } finally {
      Pop-Location
    }

    if ($buildOk) {
      Write-Host ("  OK  VSIX packaged: " + $VsixPath) -ForegroundColor Green
      $VsixBuilt = $true

      # Locate the VS Code CLI: env override first, then well-known Windows paths, then PATH
      $CodePath = $null
      if ($env:CLAWS_VSCODE_CLI) {
        $CodePath = $env:CLAWS_VSCODE_CLI
      } elseif (Test-Path "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\Code.cmd") {
        $CodePath = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\Code.cmd"
      } elseif (Test-Path "$env:ProgramFiles\Microsoft VS Code\bin\Code.cmd") {
        $CodePath = "$env:ProgramFiles\Microsoft VS Code\bin\Code.cmd"
      } elseif (Get-Command 'Code.cmd' -ErrorAction SilentlyContinue) {
        $CodePath = (Get-Command 'Code.cmd').Source
      }

      if ($CodePath) {
        Write-Host ("  Installing extension via: " + $CodePath) -ForegroundColor DarkGray
        & $CodePath --install-extension $VsixPath --force
        if ($LASTEXITCODE -eq 0) {
          Write-Host "  OK  neunaha.claws installed" -ForegroundColor Green
          $ExtList = (& $CodePath --list-extensions 2>&1) -join "`n"
          if ($ExtList -match 'neunaha\.claws') {
            Write-Host "  OK  verified: neunaha.claws in extension list" -ForegroundColor Green
          }
        } else {
          Write-Host ("  WARN: --install-extension failed (exit " + $LASTEXITCODE + ")") -ForegroundColor Yellow
          Write-Host ("        VSIX: " + $VsixPath) -ForegroundColor DarkGray
          Write-Host "        Fix:  code --install-extension <vsix-path> --force" -ForegroundColor DarkGray
        }
      } else {
        Write-Host "  WARN: VS Code CLI not found — skipping extension install." -ForegroundColor Yellow
        Write-Host ("        VSIX built at: " + $VsixPath) -ForegroundColor DarkGray
        Write-Host "        Fix:  code --install-extension <vsix-path> --force" -ForegroundColor DarkGray
      }
    } else {
      Write-Host ("  WARN: extension build failed — " + $buildErr) -ForegroundColor Yellow
      Write-Host "        CLI tools are installed. Retry manually:" -ForegroundColor DarkGray
      Write-Host ("        cd " + $ExtDir + " && npm install && npm run build") -ForegroundColor DarkGray
    }
  } else {
    Write-Host "  WARN: extension/package.json not found in archive — skipping build." -ForegroundColor Yellow
  }

  # Cleanup on success only
  Remove-Item -Recurse -Force -Path $TempDir -ErrorAction SilentlyContinue
  $TempDir = $null

  Write-Host ""
  Write-Host "  ✓ Claws installed." -ForegroundColor Green
  Write-Host ""
  Write-Host "  ── Next steps ──────────────────────────────────────────────" -ForegroundColor White
  Write-Host ""
  Write-Host "  1. Reload VS Code:" -ForegroundColor White
  Write-Host "       Ctrl+Shift+P > Developer: Reload Window" -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "  2. If you don't have Claude Code installed yet:" -ForegroundColor White
  Write-Host "       code --install-extension anthropic.claude-code" -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "  3. In a Claude Code session, run:" -ForegroundColor White
  Write-Host "       /claws-help" -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "  ────────────────────────────────────────────────────────────" -ForegroundColor DarkGray
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
