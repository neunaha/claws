# Claws — Windows installer
# This script intentionally exits with an error.
#
# Windows native install is not supported in v0.7.10.
# Please use WSL2 with the Unix install.sh instead.
#
# See README.md for WSL2 setup instructions.

Write-Host ""
Write-Host "  +=============================================+" -ForegroundColor Red
Write-Host "  |                                             |" -ForegroundColor Red
Write-Host "  |   CLAWS — Windows Native: NOT SUPPORTED    |" -ForegroundColor Red
Write-Host "  |                                             |" -ForegroundColor Red
Write-Host "  +=============================================+" -ForegroundColor Red
Write-Host ""
Write-Host "  Windows native install is not supported in v0.7.10." -ForegroundColor Yellow
Write-Host "  Please use WSL2 with the Unix installer instead." -ForegroundColor Yellow
Write-Host ""
Write-Host "  Setup WSL2 then run:" -ForegroundColor Cyan
Write-Host ""
Write-Host "    bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)" -ForegroundColor White
Write-Host ""
Write-Host "  For full WSL2 setup instructions, see:" -ForegroundColor Cyan
Write-Host "    https://github.com/neunaha/claws#windows-wsl2" -ForegroundColor White
Write-Host ""

exit 1
