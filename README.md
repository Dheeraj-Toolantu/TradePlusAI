# TradePulse AI

TradePulse AI is a risk-controlled trading intelligence workspace for Indian markets. The current
repository contains the Spec Kit artifacts and the initial runnable monorepo foundation.

## Local setup

1. Install Node.js 20+, pnpm, Python 3.11+, and Docker Desktop.
2. Copy `.env.example` to `.env` and keep `LIVE_EXECUTION_ENABLED=false`.
3. Start local dependencies with `docker compose -f infra/local/docker-compose.yml up -d`.
4. Install JavaScript dependencies with `pnpm install`.
5. Start the dashboard with `pnpm dev`.

Live execution is intentionally disabled until the risk, paper-trading, broker, security, and
regulatory release gates are implemented and verified.