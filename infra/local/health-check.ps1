$ErrorActionPreference = "Stop"
Write-Output "TradePulse local dependencies"
docker compose -f "$PSScriptRoot\docker-compose.yml" ps