$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
& corepack pnpm dev
exit $LASTEXITCODE
