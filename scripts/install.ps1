# Claws — one-command installer for Windows
# Run: irm https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.ps1 | iex
# Or:  powershell -ExecutionPolicy Bypass -File install.ps1

$ErrorActionPreference = "Stop"

$REPO = "https://github.com/neunaha/claws.git"
$INSTALL_DIR = if ($env:CLAWS_DIR) { $env:CLAWS_DIR } else { "$env:USERPROFILE\.claws-src" }

# Detect editor extensions directory
function Get-ExtDir {
    $paths = @(
        "$env:USERPROFILE\.vscode\extensions",
        "$env:USERPROFILE\.vscode-insiders\extensions",
        "$env:USERPROFILE\.cursor\extensions",
        "$env:USERPROFILE\.windsurf\extensions"
    )
    foreach ($p in $paths) {
        if (Test-Path $p) { return $p }
    }
    # Default to VS Code
    $default = "$env:USERPROFILE\.vscode\extensions"
    New-Item -ItemType Directory -Force -Path $default | Out-Null
    return $default
}

$EXT_DIR = Get-ExtDir
$EXT_LINK = "$EXT_DIR\neunaha.claws-0.1.0"

Write-Host ""
Write-Host "  +=============================================+" -ForegroundColor Cyan
Write-Host "  |                                             |" -ForegroundColor Cyan
Write-Host "  |   CLAWS - Terminal Control Bridge           |" -ForegroundColor Cyan
Write-Host "  |   Your terminals are now programmable.      |" -ForegroundColor Cyan
Write-Host "  |                                             |" -ForegroundColor Cyan
Write-Host "  +=============================================+" -ForegroundColor Cyan
Write-Host ""

# Step 1: Clone or update
if (Test-Path $INSTALL_DIR) {
    Write-Host "[1/4] Updating existing install..."
    Push-Location $INSTALL_DIR
    git pull origin main --quiet 2>$null
    Pop-Location
} else {
    Write-Host "[1/4] Cloning..."
    git clone --quiet $REPO $INSTALL_DIR 2>$null
    if (-not $?) { git clone $REPO $INSTALL_DIR }
}

# Step 2: Create junction (Windows symlink equivalent)
Write-Host "[2/4] Installing extension to $EXT_DIR ..."
if (Test-Path $EXT_LINK) {
    Remove-Item $EXT_LINK -Force -Recurse 2>$null
}
try {
    # Try junction first (no admin needed)
    cmd /c mklink /J "$EXT_LINK" "$INSTALL_DIR\extension" 2>$null | Out-Null
    Write-Host "  OK Extension linked" -ForegroundColor Green
} catch {
    try {
        # Try symlink (needs admin)
        New-Item -ItemType SymbolicLink -Path $EXT_LINK -Target "$INSTALL_DIR\extension" -Force | Out-Null
        Write-Host "  OK Extension linked (admin)" -ForegroundColor Green
    } catch {
        # Fall back to copy
        Copy-Item -Recurse -Force "$INSTALL_DIR\extension" $EXT_LINK
        Write-Host "  OK Extension copied (no symlink support)" -ForegroundColor Yellow
    }
}

# Step 3: MCP auto-configure
Write-Host "[3/4] Configuring MCP server..."
$MCP_PATH = "$INSTALL_DIR\mcp_server.js"
$CLAUDE_SETTINGS = "$env:USERPROFILE\.claude\settings.json"

if (Test-Path $CLAUDE_SETTINGS) {
    $content = Get-Content $CLAUDE_SETTINGS -Raw
    if ($content -match '"claws"') {
        Write-Host "  OK MCP already registered" -ForegroundColor Green
    } else {
        try {
            $cfg = $content | ConvertFrom-Json
            if (-not $cfg.mcpServers) {
                $cfg | Add-Member -NotePropertyName "mcpServers" -NotePropertyValue @{} -Force
            }
            $cfg.mcpServers | Add-Member -NotePropertyName "claws" -NotePropertyValue @{
                command = "node"
                args = @($MCP_PATH.Replace('\', '/'))
                env = @{ CLAWS_SOCKET = ".claws/claws.sock" }
            } -Force
            $cfg | ConvertTo-Json -Depth 10 | Set-Content $CLAUDE_SETTINGS
            Write-Host "  OK MCP server registered globally" -ForegroundColor Green
        } catch {
            Write-Host "  ! Could not auto-register MCP - add manually" -ForegroundColor Yellow
        }
    }
} else {
    New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.claude" | Out-Null
    @{
        mcpServers = @{
            claws = @{
                command = "node"
                args = @($MCP_PATH.Replace('\', '/'))
                env = @{ CLAWS_SOCKET = ".claws/claws.sock" }
            }
        }
    } | ConvertTo-Json -Depth 10 | Set-Content $CLAUDE_SETTINGS
    Write-Host "  OK Created settings with MCP server" -ForegroundColor Green
}

# Step 4: Inject PowerShell profile hook
Write-Host "[4/5] Injecting shell hook..."
$profilePath = $PROFILE
if (-not $profilePath) { $profilePath = "$env:USERPROFILE\Documents\PowerShell\Microsoft.PowerShell_profile.ps1" }
$profileDir = Split-Path $profilePath -Parent
if (-not (Test-Path $profileDir)) { New-Item -ItemType Directory -Force -Path $profileDir | Out-Null }
if (-not (Test-Path $profilePath)) { New-Item -ItemType File -Force -Path $profilePath | Out-Null }
$hookMarker = "# CLAWS terminal hook"
$profileContent = Get-Content $profilePath -Raw -ErrorAction SilentlyContinue
if ($profileContent -and $profileContent.Contains("CLAWS terminal hook")) {
    Write-Host "  OK Shell hook already in profile" -ForegroundColor Green
} else {
    $hookCode = @"

# CLAWS terminal hook
Write-Host ""
Write-Host "  `e[38;2;200;90;62m+===============================================+`e[0m"
Write-Host "  `e[38;2;200;90;62m|`e[0m                                               `e[38;2;200;90;62m|`e[0m"
Write-Host "  `e[38;2;200;90;62m|`e[0m   `e[1;37mCLAWS`e[0m  Terminal Control Bridge             `e[38;2;200;90;62m|`e[0m"
Write-Host "  `e[38;2;200;90;62m|`e[0m   `e[90mPowered by Claude Opus`e[0m                     `e[38;2;200;90;62m|`e[0m"
Write-Host "  `e[38;2;200;90;62m|`e[0m   `e[90mv0.3.0 | Node.js only | Zero deps`e[0m         `e[38;2;200;90;62m|`e[0m"
Write-Host "  `e[38;2;200;90;62m|`e[0m                                               `e[38;2;200;90;62m|`e[0m"
Write-Host "  `e[38;2;200;90;62m+===============================================+`e[0m"
Write-Host ""
"@
    Add-Content -Path $profilePath -Value $hookCode
    Write-Host "  OK Shell hook added to PowerShell profile" -ForegroundColor Green
}

# Step 5: Verify
Write-Host "[5/5] Verifying..."
$checks = 0
if (Test-Path $EXT_LINK) { $checks++; Write-Host "  OK Extension installed" -ForegroundColor Green }
if (Test-Path $MCP_PATH) { $checks++; Write-Host "  OK MCP server exists" -ForegroundColor Green }
try {
    & node --version 2>$null
    if ($?) { $checks++; Write-Host "  OK Node.js available" -ForegroundColor Green }
} catch {}

Write-Host ""
Write-Host "  +=============================================+" -ForegroundColor Cyan
Write-Host "  |  CLAWS INSTALLED - $checks/3 checks passed           |" -ForegroundColor Cyan
Write-Host "  |                                             |" -ForegroundColor Cyan
Write-Host "  |  NEXT:                                      |" -ForegroundColor Cyan
Write-Host "  |  1. Reload VS Code (Ctrl+Shift+P > Reload) |" -ForegroundColor Cyan
Write-Host "  |  2. Open Claws terminal from dropdown       |" -ForegroundColor Cyan
Write-Host "  |  3. Claude Code now has terminal control    |" -ForegroundColor Cyan
Write-Host "  |                                             |" -ForegroundColor Cyan
Write-Host "  +=============================================+" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Docs:    https://github.com/neunaha/claws"
Write-Host "  Website: https://neunaha.github.io/claws/"
Write-Host ""
