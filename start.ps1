# Chat & Games starten
# Zeigt die lokale IP an und startet den Server fuer das gesamte Netzwerk.

$config = Get-Content "$PSScriptRoot\config.json" | ConvertFrom-Json
$port = $config.port

$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
    $_.InterfaceAlias -notmatch "Loopback" -and $_.IPAddress -notmatch "^169\."
} | Select-Object -First 1 -ExpandProperty IPAddress)

Write-Host ""
Write-Host "Chat & Games startet..." -ForegroundColor Cyan
Write-Host "Deine Freunde erreichen den Chat im WLAN unter:" -ForegroundColor Green
Write-Host "  http://$ip`:$port" -ForegroundColor Yellow
Write-Host ""

python -m uvicorn backend.main:app --host 0.0.0.0 --port $port
