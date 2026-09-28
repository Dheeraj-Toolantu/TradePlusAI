# Quickstart: Validate AI-Driven Trading Monitor and Gated Automation

This guide validates the feature with deterministic gateway stubs and existing paper-mode boundaries. It does not require live broker execution or external model credentials.

## Prerequisites

- Node.js version supported by the repository and pnpm 9.15.5.
- Python 3.11 or newer.
- Repository dependencies installed with `pnpm install`.
- Python test environment installed according to `quant/pyproject.toml`.
- `EXECUTION_MODE=PAPER` for all local validation.
- `LIVE_EXECUTION_ENABLED=false` and `LIVE_COMPLIANCE_APPROVED=false`.

## Targeted validation commands

Run from the repository root:

```powershell
pnpm exec vitest run tests/contract/algo-trading-route.test.ts tests/security/paper-live-isolation.test.ts tests/security/kill-switch.test.ts tests/integration/audit-journal.test.ts
python -m pytest quant/tests/test_no_trade_engine.py quant/tests/test_algo_engine_pipeline_integration.py quant/tests/test_end_to_end_scenarios.py
```

After implementation, add the feature-specific suites and run:

```powershell
pnpm exec vitest run tests/unit/ai-monitoring-service.test.ts tests/contract/ai-monitoring-route.test.ts tests/security/ai-model-output.test.ts tests/integration/ai-suggestion-audit.test.ts
```

## Validation scenarios

### 1. Explicit monitoring activation

1. Start with no monitoring session and call `POST /api/ai-monitoring` with `ENABLE_MONITORING`.
2. Verify the response creates a session in `STARTING` or `ACTIVE` and records the actor, scope, mode, and configuration version.
3. Submit market data while monitoring is disabled in a separate fixture.
4. Verify no model evaluation or automation decision is created.

Expected result: monitoring and automation are independent controls.

### 2. Valid bullish suggestion without automation

1. Use a fresh NIFTY candle/option fixture with deterministic bullish structure and a gateway stub returning `BULLISH` with confidence 78.
2. Keep `automationEnabled=false`.
3. Evaluate the session.
4. Verify a completed evaluation and `ADVISORY` or `WAITING` suggestion appears in the log with evidence, invalidation, model version, and timestamp.

Expected result: a suggestion is visible, but no order or automation request is created.

### 3. AI-confirmed paper automation

1. Use a fixture where deterministic analysis is confirmed, all risk/session/contract/liquidity gates pass, and the gateway returns a current matching direction.
2. Enable automation in `PAPER` mode.
3. Evaluate the session twice with the same setup identity and evaluation window.
4. Verify one `ALLOW_PAPER` decision and one simulator order at most; the second request is blocked as a duplicate.
5. Verify the suggestion log contains the evaluation, gate results, automation decision, and paper order outcome.

Expected result: paper automation can simulate only after every gate passes and is idempotent.

### 4. AI confirmation blocked by deterministic safety

1. Return a high-confidence bullish or bearish model response.
2. Make one deterministic gate fail, such as stale candles, insufficient R:R, invalid option metadata, active kill switch, reconciliation failure, or unavailable broker health.
3. Evaluate with automation enabled.
4. Verify the result is `BLOCK`, no order side effect occurs, and the exact failed gate is shown in both the page read model and immutable log.

Expected result: AI confidence never bypasses deterministic safety.

### 5. Provider failure and recovery

1. Configure the gateway stub to timeout, return malformed JSON, and return an unsupported instruction in separate runs.
2. Verify each evaluation becomes `TIMEOUT`, `MALFORMED`, or `REJECTED`, with no fabricated direction and no automation decision.
3. Verify deterministic chart/risk analysis remains available when its inputs are valid.
4. Restore the provider stub and fresh context; verify monitoring can return from `DEGRADED` to `ACTIVE`.

Expected result: provider failure fails closed and recovery is explicit.

### 6. Mode isolation and live block

1. Run a fully qualified evaluation in `PAPER` mode and inspect the simulator call boundary.
2. Verify no live broker endpoint is invoked.
3. Run the same fixture in `ASSISTED` mode and verify a user confirmation is required before submission.
4. Attempt `ALGO_LIVE` activation with live flags disabled or incomplete readiness evidence.
5. Verify the request is rejected and the readiness blockers are logged.

Expected result: mode capabilities remain distinct and live execution stays blocked until existing release gates pass.

### 7. Immutable log and filters

1. Create evaluations for NIFTY, BANKNIFTY, and SENSEX with bullish, bearish, blocked, and unavailable outcomes.
2. Query the log by symbol, direction, date range, confidence, session, and automation outcome.
3. Open one record detail and compare its stored evidence and model metadata with the original fixture.
4. Invalidate or supersede the suggestion and query it again.

Expected result: filters return only matching records, original evidence is unchanged, and later lifecycle events remain linked.

## Completion evidence

Capture:

- Test command output for all targeted suites.
- One valid suggestion log record and one blocked record with redacted payloads.
- Proof that PAPER mode invokes only the simulator boundary.
- Proof that ALGO LIVE remains rejected while readiness is incomplete.
- A UI screenshot or recorded manual check showing monitoring state, model health, execution mode, latest suggestion, and blocking reason together.
