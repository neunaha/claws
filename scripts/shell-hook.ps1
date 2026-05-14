# CLAWS terminal hook (auto-generated — do not edit)
# Sourced from $PROFILE on PowerShell startup.
# Only shows banner when running inside a Claws-wrapped terminal.
# CLAWS_WRAPPED is set by the VS Code extension (claws-pty.ts) when a real
# pty session is active; it is never set in ordinary PowerShell sessions.

if ($env:CLAWS_WRAPPED -ne '1') { return }
if ($env:CLAWS_BANNER_SHOWN -eq '1') { return }
$env:CLAWS_BANNER_SHOWN = '1'

# ASCII-only banner — Unicode box chars render as ? in PS 5.1 / legacy CP437 consoles.
# Matches install.ps1 format.
Write-Host ""
Write-Host "  +-------------------------------------------+" -ForegroundColor DarkYellow
Write-Host "  |                                           |" -ForegroundColor DarkYellow
Write-Host "  |   CLAWS  Terminal Control Bridge          |" -ForegroundColor DarkYellow
Write-Host "  |                                           |" -ForegroundColor DarkYellow
Write-Host "  +-------------------------------------------+" -ForegroundColor DarkYellow
Write-Host ""

# Wrap / pipe-mode state
$_wrapState = if ($env:CLAWS_PIPE_MODE -eq '1') {
    "pipe-mode (degraded)"
} else {
    "wrapped (pty logged)"
}
Write-Host ("  This term  " + $_wrapState)
if ($env:CLAWS_TERMINAL_ID) {
    Write-Host ("  Term ID    " + $env:CLAWS_TERMINAL_ID) -ForegroundColor DarkGray
}
Write-Host ""

Remove-Variable -Name '_wrapState' -ErrorAction SilentlyContinue
