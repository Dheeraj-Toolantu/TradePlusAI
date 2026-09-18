# Implementation Plan: NIFTY Options Strategy V5 Compliance Remediation

## Technical Context

- Python quant package: `quant/src/tradepulse_quant`.
- Canonical algo-page package: `quant/src/tradepulse_quant/algo_engine`.
- Web execution page: `apps/web/app/execution/page.tsx`.
- Web API boundary: `apps/web/app/api/algo-trading/route.ts`.
- Existing tests: `quant/tests` and TypeScript/Vitest tests under `tests`.
- Live broker adapter: Groww integration under `adapters/groww` and `services/execution`.
- Validation commands: Python `pytest`, web TypeScript check, and Next.js production build.
- Live mode: explicitly disabled during this plan.

## Architecture

The page consumes a read-only analysis response from the Python pipeline. The pipeline does not place orders. Any paper order request must pass a server-side validation boundary. Live execution is unavailable until a separate readiness checker proves all V5 controls.

```text
market history + option evidence
        -> DataQualityGate
        -> SessionGate
        -> Gap/Regime/Strategy gates
        -> Score/ORS/OI-PCR/VIX/Liquidity gates
        -> NoTradeEngine
        -> Contract/RR/Risk readiness
        -> explainable PipelineDecision
        -> paper-only API validation
```

## Design Principles

1. Fail closed when a required module or input is unavailable.
2. Keep signal generation, risk planning, option selection, and execution separate.
3. Do not use a page-level manual override as a trading control.
4. Preserve existing import compatibility while `algo_engine` remains canonical.
5. Do not mark tasks complete without implementation, tests, docs, and evidence.
6. Do not connect live capital during this remediation.

## Phase 1: Artifacts and Traceability

- Create this `spec.md` and `plan.md`.
- Update architecture, gap, and traceability documents to reflect verified foundation status and remaining gaps.
- Keep all incomplete tasks unchecked.

## Phase 2: Central Fail-Closed Pipeline

- Add typed pipeline inputs, gate results, and decisions in `quant/src/tradepulse_quant/algo_engine/pipeline.py`.
- Add `NoTradeEngine` in `quant/src/tradepulse_quant/algo_engine/no_trade_engine.py`.
- Require explicit evidence for every V5 gate; missing evidence blocks.
- Keep output deterministic and serializable.

## Phase 3: Execution Lockdown

- Disable `ALGO_LIVE` at the API boundary with a deterministic `LIVE_EXECUTION_DISABLED` response.
- Keep paper validation strict and independent of UI state.
- Add tests for direct API route behavior where the existing test harness permits.

## Phase 4: Deterministic Verification

- Add unit tests for no-trade reason aggregation, ordering, score/RR/liquidity/risk gates, and missing-input behavior.
- Add end-to-end scenario tests A-N as decision fixtures. Scenarios requiring unimplemented execution infrastructure must assert `NO_TRADE` or `SAFE_MODE`, not fabricate success.
- Run Python regression, TypeScript, and web build validation.

## Phase 5: Deferred V5 Work

The following remain blocked until their own implementation and tests exist: true ATR/ADX/VWAP, gap-day state machine, regime hysteresis, independent 15m trend, ORB/retest state machine, ORS, OI/PCR, VIX, liquidity, contract master, option risk sizing, expiry protocol, daily risk, position management, execution state machine, reconciliation, forced exits, SAFE_MODE lifecycle, realistic backtesting, theta accounting, robustness validation, observability, and production readiness.

## Risks and Mitigations

- Missing market evidence: return `NO_TRADE`.
- Direct API invocation: enforce gates server-side and disable live route.
- Stale documentation: update traceability in the same change.
- False confidence from passing tests: keep task checklist unchecked until full acceptance evidence exists.

## Validation

```text
$env:PYTHONPATH = 'D:\TestData\TradePlusAI\quant\src'
D:\TestData\TradePlusAI\.venv\Scripts\python.exe -m pytest -q quant/tests
corepack pnpm --filter @tradepulse/web exec tsc --noEmit
corepack pnpm --filter @tradepulse/web build
```

## Release Gate

The result of this plan is not controlled-live approval. Controlled live remains blocked until production-readiness evidence proves contract metadata, risk manager, reconciliation, SAFE_MODE, kill switch, broker state handling, realistic backtesting, and paper/live parity.
