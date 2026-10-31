# TradePulse AI

TradePulse AI is a risk-controlled trading intelligence workspace for Indian markets. The current
repository contains the Spec Kit artifacts and the initial runnable monorepo foundation.

## Local setup

1. Install Node.js 20+, pnpm, Python 3.11+, and Docker Desktop.
2. Copy `.env.example` to `.env` and keep `LIVE_EXECUTION_ENABLED=false`.
3. Start local dependencies with `docker compose -f infra/local/docker-compose.yml up -d`.
4. Install JavaScript dependencies with `pnpm install`.
5. Start the dashboard with `pnpm dev`.

## Claude Code day-trader skills

The MIT-licensed skills from
[day-trader-skill](https://github.com/Jakeschincariol/day-trader-skill) are vendored in
`.claude/skills/` and adapted to Indian markets: NSE, IST, rupees, NSE charges and Groww. They are
`/trader-market`, `/trader-scanner`, `/trader-news`, `/trader-entry`, `/trader-exit`,
`/trader-timemachine`, `/trader-budget`, `/trader-risk`, `/trader-broker`, `/trader-alerts`,
`/trader-analyst`, `/trader-deals` and the US-only `/trader-pelosi`; `--market US` restores the
original behaviour. They never place a live order and are separate from the TradePulse execution
gates. See [docs/day-trader-skill/README.md](docs/day-trader-skill/README.md). Run their offline
tests with `npm run test:trader-skills`.

Live execution is intentionally disabled until the risk, paper-trading, broker, security, and
regulatory release gates are implemented and verified.