---

# Tasks: Platform Requirements Convergence

**Input**: [spec.md](spec.md), [plan.md](plan.md), and the implementation audit of `001-trading-intelligence-platform`.

**Execution rule**: Do not enable live execution. Every task must preserve PAPER/ASSISTED/ALGO LIVE separation and add or update focused tests.

## Tasks

The implementation tasks are grouped by dependency phase and user story below.

## Implementation Tasks

## Phase 1: Baseline and contracts

- [ ] T001 Record current focused test/build baselines and list false-complete tasks from `specs/001-trading-intelligence-platform/tasks.md` in `docs/release-validation.md`.
- [ ] T002 [P] Define versioned indicator, price-action, OI-analysis, analytics, data-quality, notification-outbox, and square-off result types in `packages/domain-contracts/src/`.
- [ ] T003 [P] Add convergence fixtures for insufficient data, crossed quotes, outliers, OI changes, costs, R multiples, regimes, and end-of-day positions in `tests/fixtures/`.

## Phase 2: Analytics completeness

- [x] T004 [P] [US1] Implement RSI, MACD, Supertrend, Bollinger Bands, CPR, and pivot calculations with explicit insufficient-data status in `services/options-analytics/src/market-indicators.ts`.
- [x] T005 [P] [US1] Implement HH/HL, LH/LL, breakout, breakdown, retest, rejection, and trade-marker observations in `services/options-analytics/src/price-action.ts`.
- [x] T005a [US1] Add deterministic trade-setup validation for resistance proximity, 5-minute breakout close, breakout-retest hold, rejection, structural stop/target derivation, and minimum R:R blocking in `services/options-analytics/src/trade-setup-validator.ts`; cover the 23,567.85 / 23,571.05 / 23,470.85 / 23,602.83 regression fixture.
- [x] T006 [US1] Implement OI build-up, unwinding, long-build-up, and short-build-up classification with missing-data handling in `services/options-analytics/src/options-chain-service.ts`.
- [x] T007 [P] [US1] Add indicator, price-action, trade-setup validation, and OI classification unit/contract tests in `tests/unit/market-indicators.test.ts`, `tests/unit/trade-setup-validator.test.ts`, and `tests/unit/options-chain-analysis.test.ts`.
- [x] T008 [P] [US2] Extend Python analytics with profit factor, average/median R, costs, slippage, exposure, and regime breakdown in `quant/src/tradepulse_quant/analytics/metrics.py`.
- [x] T009 [US2] Extend TypeScript analytics/report mapping with mode labels, no-trade/no-loss representations, and calculation version in `services/audit/src/analytics-service.ts` and `services/backtest/src/backtest-service.ts`.
- [x] T010 [US2] Add fixture-based metric tests for all required fields and edge cases in `quant/tests/test_metrics.py` and `tests/unit/analytics-completeness.test.ts`.

## Phase 3: Data quality and paper operations

- [ ] T011 [P] [US3] Add crossed-quote, invalid-OHLC, non-finite, outlier, duplicate-timestamp, continuity-gap, and stale checks in `services/market-data/src/market-feed.ts`.
- [ ] T012 [US3] Connect data-quality decisions to entry blocking while preserving existing-position management in `services/risk/src/data-quality-gate.ts` and `services/risk/src/risk-gate.ts`.
- [ ] T013 [US3] Add configurable end-of-day square-off policy and auditable paper-only orchestration in `services/paper-trading/src/square-off-service.ts`.
- [x] T014 [US3] Add provider-neutral notification outbox, delivery state, retry metadata, and deterministic local provider in `services/notifications/src/notification-outbox.ts`.
- [ ] T015 [P] [US3] Add unsafe-data, square-off, notification retry, and paper/live isolation tests in `tests/integration/data-quality-boundary.test.ts`, `tests/integration/paper-square-off.test.ts`, and `tests/integration/notification-outbox.test.ts`.

## Phase 4: Operational readiness

- [ ] T016 [P] [US4] Add load-test execution and evidence for market-session updates and risk-state availability in `tests/load/market-session.js` and `docs/release-validation.md`.
- [ ] T017 [P] [US4] Add accessibility and narrow-screen checks for mode, freshness, blocker, kill-switch, and position controls in `tests/e2e/dashboard-responsive.spec.ts`.
- [x] T018 [US4] Document consent, suitability, broker/exchange review, privacy, operational ownership, incident response, and unresolved blockers in `docs/compliance/live-readiness.md` and `docs/operations/incident-response.md`.
- [x] T019 [US4] Add release-evidence checklist and enforce that missing evidence keeps live activation blocked in `services/execution/src/live-release-policy.ts` and `tests/security/live-readiness-evidence.test.ts`.
- [ ] T020 [US4] Update validation UI and copy to distinguish historical, paper, assisted, and live results and show unresolved release blockers in `apps/web/app/validation/page.tsx` and `apps/web/app/execution/page.tsx`.

## Phase 5: Final verification

- [x] T021 Run focused indicator, options, analytics, data-quality, paper, notification, security, and Groww tests and record results in `docs/release-validation.md`.
- [x] T022 Run the full Vitest suite, Python quantitative tests, and the production web build; fix only convergence-related failures and record warnings in `docs/release-validation.md`.
- [x] T023 Verify `.env` files are excluded from commits, credentials are absent from client bundles/logs, and `LIVE_EXECUTION_ENABLED=false` remains the default in `tests/security/credential-boundary.test.ts` and `docs/compliance/live-readiness.md`.

## Dependencies and execution order

- Phase 1 blocks all later phases.
- T004-T010 can proceed in parallel after T002-T003.
- T011-T015 depend on the existing risk and paper-mode contracts; T013-T015 may proceed in parallel with analytics work.
- T016-T020 depend on the completed safety behavior and provide release evidence only; they do not authorize live execution.
- T021-T023 are final gates and must complete before any live-release review.

## Independent test criteria

- **US1**: Deterministic indicator and options fixtures produce correct values, evidence, and explicit insufficient-data states.
- **US2**: Metric fixtures produce correct profit factor, R statistics, costs, exposure, and regime breakdown with mode labels.
- **US3**: Unsafe data blocks entries, paper square-off never reaches a live adapter, and notification failures remain retryable/auditable.
- **US4**: Release evidence is reviewable, missing approvals block live activation, and accessibility/load checks produce artifacts.

## MVP recommendation

The existing paper-trading MVP may continue for local validation. For this convergence feature, complete Phase 1, Phase 2, and Phase 3 before treating analytics or automated paper results as release evidence. Phase 4 is mandatory before any live activation discussion.
