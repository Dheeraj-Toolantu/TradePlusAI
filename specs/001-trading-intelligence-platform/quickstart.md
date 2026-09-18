# Quickstart Validation Guide

This guide validates the planned vertical slice without enabling live trading. No broker secret
or live credential is required. Live execution remains disabled until the compliance gate in the
feature specification passes.

## Prerequisites

- Node.js 20+ and a package manager selected during repository bootstrap.
- Python 3.11+.
- Docker Desktop for PostgreSQL/TimescaleDB and Redis.
- A deterministic fixture bundle for candles, options, news, broker responses, and failures.
- Test-only authentication and a fake broker adapter; never use production credentials.

## Planned local setup

```powershell
docker compose -f infra/local/docker-compose.yml up -d
pnpm install
pnpm db:migrate
pnpm fixtures:load --file tests/fixtures/trading-session.json
pnpm dev
```

The exact package scripts are implementation tasks. They must fail clearly if required services or
fixtures are missing and must never default to a live broker.

## Validation scenarios

1. **Dashboard health**: Load the dashboard fixture and verify index cards, chart, options summary,
   regime, signal explanation, mode badge, data freshness, risk state, and broker health update
   without a full-page refresh.
2. **Risk rejection**: Submit fixtures below minimum R:R, above daily loss, above max positions,
   with invalid lot size, stale data, and active extreme-event rules. Expect `BLOCK` with each failed
   check visible and no order side effect.
3. **Paper isolation**: Run a paper signal through fill, partial fill, target, stop, fees, slippage,
   and P&L. Assert the fake live adapter receives zero order calls.
4. **Strategy reuse**: Save a versioned nested strategy, run it in backtest, then select the same
   version in paper mode. Assert the rule representation and risk configuration are unchanged.
5. **Groww contract**: Against a fake adapter, test order reference idempotency, status-by-reference,
   partial fills, cancellation, OCO creation, OCO quantity validation, and broker reconciliation.
6. **Failure closed**: Simulate stale data, risk-service outage, broker authentication failure,
   disconnect, unknown order status, failed protection creation, and unexpected position. Expect no
   new live entry, a safe-state event, notification, and audit record.
7. **Kill switch**: Activate the kill switch while a signal is pending and assert immediate rejection
   of all new orders plus configured existing-position handling.
8. **Audit and journal**: Complete one paper and one fake-assisted lifecycle. Confirm that signal,
   rationale, strategy version, risk checks, order, fills, protection, exit, notification, and outcome
   are linked and secrets are absent.
9. **Promotion gate**: Attempt each promotion step without required evidence. Confirm the request is
   blocked until out-of-sample, walk-forward, paper, consent, and capped-live evidence is present.
10. **Responsive safety UI**: Exercise desktop and narrow-screen viewports and confirm mode, risk,
    broker health, exposure, freshness, blockers, and kill switch remain visible without overlap.

## Expected release evidence

- Contract and integration test reports for the risk, paper-mode, broker, reconciliation, and audit paths.
- Load results for realtime dashboard and risk evaluation targets in [plan.md](plan.md).
- Security evidence showing no credentials in client bundles or ordinary logs.
- Backtest and paper reports clearly labeled as simulation.
- Current Groww, exchange, SEBI, consent, and disclosure review signed before any live feature flag is enabled.

## Current local evidence

- JavaScript validation: 37 tests passing across contract, unit, integration, security, and e2e safety specs.
- Production UI build: passing with dashboard, signals, strategy builder, validation, execution, intelligence,
  trade detail, and operations routes.
- Python validation: quantitative fill and metrics unittest passing.
- Live execution remains disabled by default and requires explicit compliance approval.

## Related design artifacts

- Domain entities and transitions: [data-model.md](data-model.md)
- External and internal boundaries: [contracts](contracts/)
- Requirements and acceptance scenarios: [spec.md](spec.md)