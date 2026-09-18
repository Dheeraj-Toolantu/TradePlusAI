---

description: "Executable task list for TradePulse AI Trading Intelligence Platform"
---

# Tasks: TradePulse AI Trading Intelligence Platform

**Input**: Design documents from `specs/001-trading-intelligence-platform/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts](contracts/), and [quickstart.md](quickstart.md)

**Tests**: Included because the constitution requires verification of risk, mode isolation,
broker contracts, reconciliation, auditability, and failure-closed behavior.

**Organization**: Tasks are grouped by user story so each story can be implemented and validated
as an independently demonstrable increment.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Initialize the modular monorepo and local development foundation.

- [x] T001 Create the monorepo directory structure from [plan.md](plan.md) under `apps/`, `services/`, `quant/`, `packages/`, `adapters/`, `infra/`, and `tests/`.
- [x] T002 Create the root workspace manifest and package-manager configuration in `package.json`, `pnpm-workspace.yaml`, and `tsconfig.base.json`.
- [x] T003 [P] Create the web application shell and development scripts in `apps/web/package.json` and `apps/web/next.config.ts`.
- [x] T004 [P] Create the API service shell and development scripts in `apps/api/package.json` and `apps/api/src/server.ts`.
- [x] T005 [P] Create the Python quantitative service environment in `quant/pyproject.toml` and `quant/src/tradepulse_quant/__init__.py`.
- [x] T006 [P] Configure shared linting, formatting, type checking, and import boundaries in `eslint.config.js`, `prettier.config.js`, and `tsconfig.base.json`.
- [x] T007 [P] Add local PostgreSQL/TimescaleDB, Redis, and observability dependencies in `infra/local/docker-compose.yml`.
- [x] T008 [P] Add safe environment templates and startup documentation in `.env.example` and `README.md`.
- [x] T009 [P] Add deterministic market, options, news, broker, and failure fixtures in `tests/fixtures/trading-session.json`.

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Build the shared boundaries and safety infrastructure required by every story.

**Checkpoint**: No user-story implementation starts until identity, contracts, persistence,
events, observability, and mode policy are available.

- [x] T010 Define shared domain identifiers, timestamps, money, quantity, mode, status, and error types in `packages/domain-contracts/src/primitives.ts`.
- [x] T011 Define the versioned realtime envelope and event names from `contracts/events.md` in `packages/event-schemas/src/events.ts`.
- [x] T012 [P] Define shared User, Instrument, MarketCandle, OptionSnapshot, Strategy, Signal, Order, Position, and AuditEvent schemas in `packages/domain-contracts/src/entities.ts`.
- [x] T013 [P] Define broker-neutral operations and normalized responses from `contracts/broker-adapter.md` in `packages/broker-contracts/src/broker-adapter.ts`.
- [x] T014 [P] Define RiskGate input/output types and check-result semantics from `contracts/risk-gate.md` in `packages/domain-contracts/src/risk-gate.ts`.
- [x] T015 Create PostgreSQL migrations for users, broker connections, instruments, strategies, orders, positions, risk decisions, execution events, notifications, and audit events in `infra/database/migrations/001_core.sql`.
- [x] T016 Create time-series migrations for candles, option snapshots, market events, and news outcome observations in `infra/database/migrations/002_market_timeseries.sql`.
- [x] T017 [P] Implement database connection, transaction, migration, and append-only audit helpers in `packages/domain-contracts/src/persistence.ts`.
- [x] T018 [P] Implement authentication/session validation and role-based authorization middleware in `apps/api/src/middleware/auth.ts`.
- [x] T019 [P] Implement mode policy enforcement so PAPER, ASSISTED, and ALGO_LIVE have distinct capabilities in `services/execution/src/mode-policy.ts`.
- [x] T020 [P] Implement secret-redaction, protected credential references, and security-event logging in `services/audit/src/security-logging.ts`.
- [x] T021 [P] Implement structured logging, metrics, traces, correlation IDs, and alert hooks in `packages/domain-contracts/src/observability.ts`.
- [x] T022 Implement realtime publish/subscribe infrastructure and stale-event precedence in `services/market-data/src/realtime-events.ts`.
- [x] T023 Implement the shared safe-state and kill-switch policy in `services/risk/src/safe-state.ts`.
- [x] T024 [P] Add contract tests for event envelopes, mode policy, secret redaction, and append-only audit behavior in `tests/contract/foundation-contracts.test.ts`.
- [x] T025 Add local health checks, migration scripts, and fixture-loading commands in `infra/local/health-check.ps1` and `package.json`.

## Phase 3: User Story 1 - Understand the Market Before Acting (Priority: P1) 🎯 MVP

**Goal**: Deliver a safe dashboard that shows market context, data quality, active signals,
exposure, mode, broker health, and blockers in one desktop-first workspace.

**Independent Test**: Load deterministic market fixtures and confirm the dashboard updates without
a full-page refresh, exposes required context and freshness, opens a signal explanation, and blocks
new live entries when data becomes stale or invalid.

### Tests for User Story 1

- [x] T026 [P] [US1] Add market fixture contract tests for index quotes, candles, options summaries, freshness, and invalid data in `tests/contract/market-data-contract.test.ts`.
- [x] T027 [P] [US1] Add dashboard integration tests for market cards, regime, signal explanation, exposure, mode, broker health, and blockers in `tests/integration/dashboard.test.ts`.
- [x] T028 [P] [US1] Add responsive UI tests for desktop and narrow-screen safety indicators in `tests/e2e/dashboard-responsive.spec.ts`.

### Implementation for User Story 1

- [x] T029 [P] [US1] Implement Instrument, MarketCandle, OptionSnapshot, and market-quality persistence in `services/market-data/src/market-repository.ts`.
- [x] T030 [P] [US1] Implement normalized market-feed ingestion and stale/crossed/missing data detection in `services/market-data/src/market-feed.ts`.
- [x] T031 [US1] Implement candle aggregation, index quote snapshots, and freshness events in `services/market-data/src/market-data-service.ts`.
- [x] T032 [P] [US1] Implement technical indicators, key levels, and basic price-action observations in `services/options-analytics/src/market-indicators.ts`.
- [x] T033 [P] [US1] Implement options-chain summary, PCR, OI change, IV, and support/resistance observations in `services/options-analytics/src/options-chain-service.ts`.
- [x] T034 [US1] Implement market dashboard read models and authenticated routes in `apps/api/src/routes/dashboard.ts`.
- [x] T035 [US1] Implement the persistent navigation, mode/health/risk header, market cards, chart region, options summary, and blocker panel in `apps/web/app/page.tsx`.
- [x] T036 [P] [US1] Implement chart, indicator, trade-marker, and freshness presentation components in `apps/web/app/page.tsx` and `apps/web/app/globals.css`.
- [x] T037 [US1] Implement dashboard realtime subscriptions and stale-state rendering in `apps/web/lib/dashboard-events.ts`.
- [x] T038 [US1] Implement signal explanation drawer with evidence, rationale, strategy version, and risk state in `apps/web/components/signal-explanation.tsx`.
- [x] T039 [US1] Implement safe-state transitions that block live entry when data quality is unsafe in `services/risk/src/data-quality-gate.ts`.
- [x] T040 [US1] Run the independent dashboard test suite and record the MVP evidence in `specs/001-trading-intelligence-platform/quickstart.md`.

**Checkpoint**: User Story 1 is independently demonstrable as the MVP; stop and validate before
adding execution or live broker capability.

## Phase 4: User Story 2 - Evaluate and Manage a Qualified Signal (Priority: P1)

**Goal**: Produce explainable signal states, risk/reward validation, position sizing, and safe
signal/position lifecycle behavior.

**Independent Test**: Evaluate valid, invalidated, risk-breaching, and event-blocked signals and
confirm correct state, reason, quantity, protection, notification, and audit outcomes.

### Tests for User Story 2

- [x] T041 [P] [US2] Add property and boundary tests for R:R, risk-per-trade, lot-size rounding, quantity limits, and daily-loss calculations in `tests/unit/risk-gate.test.ts`.
- [x] T042 [P] [US2] Add signal state-machine tests for confirmation, invalidation, target, trailing, risk breach, and emergency stop in `tests/unit/signal-state-machine.test.ts`.
- [x] T043 [P] [US2] Add integration tests proving blocked risk decisions produce no order side effect in `tests/integration/risk-order-boundary.test.ts`.

### Implementation for User Story 2

- [x] T044 [P] [US2] Implement Signal, RiskDecision, Position, and protection persistence in `services/signal/src/signal-repository.ts`.
- [x] T045 [US2] Implement deterministic quantity, lot-size, max-loss, expected-reward, and minimum-R:R calculations in `services/risk/src/risk-calculator.ts`.
- [x] T046 [US2] Implement configurable hard-limit evaluation for daily loss, open positions, trade count, quantity, liquidity, event risk, and exposure in `services/risk/src/risk-gate.ts`.
- [x] T047 [US2] Implement signal state transitions and transition audit events in `services/signal/src/signal-state-machine.ts`.
- [x] T048 [P] [US2] Implement fixed, percentage, ATR, swing, previous-candle, VWAP, and fixed-distance trailing policies in `services/risk/src/trailing-policy.ts`.
- [x] T049 [US2] Implement signal evaluation and rationale assembly from market, options, strategy, news, and risk evidence in `services/signal/src/signal-service.ts`.
- [x] T050 [US2] Implement signal list, detail, risk decision, and lifecycle routes in `apps/api/src/routes/signals.ts`.
- [x] T051 [US2] Implement live-signal list, entry plan, risk checks, status lifecycle, and blocker presentation in `apps/web/app/signals/page.tsx`.
- [x] T052 [P] [US2] Implement trade-detail chart, options context, risk plan, and order-lifecycle components in `apps/web/components/trade-detail.tsx`.
- [x] T053 [US2] Publish signal, risk, position, and protection events through `services/signal/src/signal-events.ts`.

## Phase 5: User Story 3 - Build a Rule-Based Strategy (Priority: P1)

**Goal**: Let users compose, validate, explain, save, version, and reuse strategies without
broker-specific commands.

**Independent Test**: Build nested rules with indicator, price-action, options, news, entry, risk,
target, trailing, and exit conditions; save a version; then evaluate it in backtest and paper mode.

### Tests for User Story 3

- [x] T054 [P] [US3] Add strategy schema and nested AND/OR/NOT validation tests in `tests/unit/strategy-schema.test.ts`.
- [x] T055 [P] [US3] Add immutable-live-version tests in `tests/integration/strategy-versioning.test.ts`.
- [x] T056 [P] [US3] Add strategy evaluation contract tests proving news conditions cannot submit live orders in `tests/contract/strategy-evaluation.test.ts`.

### Implementation for User Story 3

- [x] T057 [P] [US3] Implement Strategy, strategy-version, rule-node, risk-config, and promotion-state persistence in `services/strategy/src/strategy-repository.ts`.
- [x] T058 [US3] Implement validated strategy rule schema for instruments, timeframes, indicators, price action, options, news, logical groups, entries, exits, and trailing in `services/strategy/src/strategy-schema.ts`.
- [x] T059 [US3] Implement strategy version creation, publication, immutability, and promotion evidence in `services/strategy/src/strategy-version-service.ts`.
- [x] T060 [US3] Implement broker-neutral strategy evaluation that emits conditions and evidence but has no broker side effects in `services/strategy/src/strategy-evaluator.ts`.
- [x] T061 [US3] Implement strategy CRUD, version, validation, and promotion routes in `apps/api/src/routes/strategies.ts`.
- [x] T062 [US3] Implement visual IF/AND/OR/NOT builder, readable rule summary, risk/exit configuration, and version controls in `apps/web/app/strategies/builder/page.tsx`.
- [x] T063 [P] [US3] Implement strategy condition/action palette and nested rule-group components in `apps/web/components/strategy-builder/`.
- [x] T064 [US3] Connect saved strategy versions to signal, backtest, and paper-mode selectors in `packages/domain-contracts/src/strategy-references.ts`.

## Phase 6: User Story 4 - Validate Through Backtest and Paper Trading (Priority: P1)

**Goal**: Provide evidence-based historical and virtual validation using shared strategy and risk
semantics while guaranteeing paper/live isolation.

**Independent Test**: Run a backtest, inspect all required metrics, run the same version in a paper
account, and assert that the live adapter receives zero order calls.

### Tests for User Story 4

- [x] T065 [P] [US4] Add backtest metric and deterministic fill tests in `quant/tests/test_backtest_metrics.py`.
- [x] T066 [P] [US4] Add paper order simulation tests for market, limit, SL, SL-M, fees, slippage, expiry, margin, partial fills, and P&L in `tests/integration/paper-trading.test.ts`.
- [x] T067 [P] [US4] Add hard isolation tests proving paper mode cannot invoke the broker adapter in `tests/security/paper-live-isolation.test.ts`.
- [x] T068 [P] [US4] Add promotion-gate tests for out-of-sample, walk-forward, paper, consent, and capped-live evidence in `tests/integration/promotion-gates.test.ts`.

### Implementation for User Story 4

- [x] T069 [P] [US4] Implement quantitative candle replay, indicator evaluation, fills, costs, slippage, and expiry handling in `quant/src/tradepulse_quant/backtest/engine.py`.
- [x] T070 [P] [US4] Implement required performance metrics and regime breakdown in `quant/src/tradepulse_quant/analytics/metrics.py`.
- [x] T071 [US4] Implement backtest run persistence and report generation in `services/backtest/src/backtest-service.ts`.
- [x] T072 [P] [US4] Implement PaperAccount, simulated order, simulated fill, and virtual position persistence in `services/paper-trading/src/paper-repository.ts`.
- [x] T073 [US4] Implement paper execution simulator with mode-enforced internal destination in `services/paper-trading/src/paper-engine.ts`.
- [x] T074 [US4] Implement promotion evidence and gate evaluation in `services/strategy/src/promotion-gates.ts`.
- [x] T075 [US4] Implement backtest, paper account, paper order, and promotion routes in `apps/api/src/routes/validation.ts`.
- [x] T076 [US4] Implement backtesting equity curve, trade list, metrics, paper portfolio, orders, and promotion screens in `apps/web/app/validation/`.
- [x] T077 [US4] Add explicit paper-mode destination assertions to execution policy in `services/execution/src/paper-mode-assertions.ts`.

## Phase 7: User Story 5 - Execute With a Broker Safely (Priority: P1)

**Goal**: Deliver broker-neutral assisted execution, Groww order lifecycle support, protection,
partial-fill handling, reconciliation, and fail-closed live activation.

**Independent Test**: Run the fake adapter through authentication, health, quote, order, modify,
cancel, fill, partial fill, protection, timeout, duplicate, disconnect, and reconciliation cases.

### Tests for User Story 5

- [x] T078 [P] [US5] Add broker adapter contract tests for normalized auth, health, order, trade, position, and reconciliation responses in `tests/contract/broker-adapter.test.ts`.
- [x] T079 [P] [US5] Add Groww request/response mapping tests for order reference IDs, status lookup, partial fills, and OCO in `tests/contract/groww-adapter.test.ts`.
- [x] T080 [P] [US5] Add idempotency, unknown-status, retry, and duplicate-signal integration tests in `tests/integration/execution-idempotency.test.ts`.
- [x] T081 [P] [US5] Add partial-fill, OCO failure, unexpected-position, and reconciliation tests in `tests/integration/reconciliation.test.ts`.
- [x] T082 [P] [US5] Add live-activation security tests for permission, consent, risk-limit, credential, and kill-switch gates in `tests/security/live-activation.test.ts`.

### Implementation for User Story 5

- [x] T083 [P] [US5] Implement normalized broker adapter types and execution command persistence in `services/execution/src/execution-repository.ts`.
- [x] T084 [US5] Implement adapter orchestration, idempotency keys, unknown-status reconciliation, and safe retry policy in `services/execution/src/execution-service.ts`.
- [x] T085 [US5] Implement Groww authentication, health, quotes, order lifecycle, trades, positions, and capability mapping in `adapters/groww/src/groww-adapter.ts`.
- [x] T086 [US5] Implement Groww reference-ID validation and API error normalization in `adapters/groww/src/groww-request-policy.ts`.
- [x] T087 [US5] Implement Groww OCO create, modify, cancel, quantity validation, and protection fallback in `adapters/groww/src/groww-smart-orders.ts`.
- [x] T088 [US5] Implement broker position/order reconciliation and discrepancy states in `services/reconciliation/src/reconciliation-service.ts`.
- [x] T089 [US5] Implement partial-fill protection recalculation and emergency-protection workflow in `services/execution/src/protection-service.ts`.
- [x] T090 [US5] Implement live activation, assisted confirmation, order, cancel, modify, and health routes in `apps/api/src/routes/execution.ts`.
- [x] T091 [US5] Implement broker connection, assisted order confirmation, algo activation, exposure, health, and emergency controls in `apps/web/app/execution/`.
- [x] T092 [US5] Add live execution feature flag and compliance-release guard in `services/execution/src/live-release-policy.ts`.

## Phase 8: User Story 6 - Understand News and Market Regime (Priority: P2)

**Goal**: Add contextual global/Indian news intelligence, source quality, event impact, regime
classification, blackout windows, and outcome evaluation without autonomous trading.

**Independent Test**: Ingest duplicate and high-severity fixture articles, verify clustering and
scoring, apply a blackout window, and record outcome evaluation without any order side effect.

### Tests for User Story 6

- [x] T093 [P] [US6] Add news normalization, source-tier, deduplication, entity, sentiment, impact, and corroboration tests in `tests/unit/news-intelligence.test.ts`.
- [x] T094 [P] [US6] Add market-regime score, calibration, blackout, and event-risk gating tests in `tests/integration/market-regime.test.ts`.
- [x] T095 [P] [US6] Add outcome-horizon evaluation tests for 1m, 5m, 15m, 30m, 1h, and 1d in `tests/integration/news-outcomes.test.ts`.
- [x] T096 [P] [US6] Add no-live-order side-effect tests for news processing in `tests/security/news-order-isolation.test.ts`.

### Implementation for User Story 6

- [x] T097 [P] [US6] Implement NewsEvent, source registry, cluster, outcome, and blackout persistence in `services/news-intelligence/src/news-repository.ts`.
- [x] T098 [US6] Implement approved-source ingestion, normalization, deduplication, and clustering in `services/news-intelligence/src/news-ingestion.ts`.
- [x] T099 [US6] Implement structured event extraction, sentiment, impact, confidence, horizon, and corroboration policy in `services/news-intelligence/src/news-analysis.ts`.
- [x] T100 [US6] Implement configurable composite market-regime scoring and calibration state in `services/market-regime/src/regime-service.ts`.
- [x] T101 [US6] Implement scheduled-event blackout and news-risk policy in `services/market-regime/src/event-risk-policy.ts`.
- [x] T102 [US6] Implement horizon-based event outcome evaluation in `services/news-intelligence/src/outcome-evaluator.ts`.
- [x] T103 [US6] Implement news, regime, impact-map, blackout, and outcome routes in `apps/api/src/routes/intelligence.ts`.
- [x] T104 [US6] Implement AI Market Brain, global sentiment, impact score, regime, confidence, blockers, and source views in `apps/web/app/intelligence/`.
- [x] T105 [US6] Add explicit strategy/risk boundary checks proving news analysis only emits context and gating inputs in `services/news-intelligence/src/live-boundary.ts`.

## Phase 9: User Story 7 - Operate and Review the System (Priority: P2)

**Goal**: Deliver notifications, trade journal, analytics, settings, audit review, health, and
emergency operations while preserving safety context.

**Independent Test**: Generate every required notification and operational failure, trigger the
kill switch, and inspect the journal, analytics, audit history, and restored safe state.

### Tests for User Story 7

- [x] T106 [P] [US7] Add notification routing and delivery-state tests for all FR-044 categories in `tests/integration/notifications.test.ts`.
- [x] T107 [P] [US7] Add journal completeness and audit trace tests in `tests/integration/audit-journal.test.ts`.
- [x] T108 [P] [US7] Add analytics metric aggregation and simulation/live labeling tests in `tests/unit/analytics.test.ts`.
- [x] T109 [P] [US7] Add kill-switch immediate-block and recovery tests in `tests/security/kill-switch.test.ts`.
- [x] T110 [P] [US7] Add role, permission, failed-authentication, and security-event tests in `tests/security/operations-access.test.ts`.

### Implementation for User Story 7

- [x] T111 [P] [US7] Implement Notification persistence, severity, channels, delivery state, and retry policy in `services/notifications/src/notification-service.ts`.
- [x] T112 [P] [US7] Implement trade journal projections across signals, risk decisions, orders, fills, positions, and exits in `services/audit/src/trade-journal.ts`.
- [x] T113 [P] [US7] Implement performance analytics aggregation and mode labeling in `services/audit/src/analytics-service.ts`.
- [x] T114 [US7] Implement append-only audit query, export, and correlation views in `services/audit/src/audit-service.ts`.
- [x] T115 [US7] Implement notification, journal, analytics, audit, settings, and operational-health routes in `apps/api/src/routes/operations.ts`.
- [x] T116 [US7] Implement notification center, trade journal, analytics, settings, security, and system-health views in `apps/web/app/operations/`.
- [x] T117 [US7] Implement protected kill-switch controls and safe-state recovery workflow in `services/risk/src/kill-switch-service.ts`.
- [x] T118 [US7] Implement daily summary and end-of-day square-off notifications in `services/notifications/src/end-of-day.ts`.

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Harden the complete system, validate the full quickstart, and prepare a controlled
release without enabling live execution by default.

- [x] T119 [P] Add end-to-end workflow coverage for dashboard -> signal -> risk -> paper -> journal in `tests/e2e/trading-workflow.spec.ts`.
- [x] T120 [P] Add end-to-end failure-closed coverage for stale data, broker disconnect, risk outage, unknown order, and protection failure in `tests/e2e/safe-state.spec.ts`.
- [x] T121 [P] Add load tests for market-session event delivery and risk decisions in `tests/load/market-session.js`.
- [x] T122 [P] Add security scanning, dependency policy, secret detection, and client-bundle credential checks in `.github/workflows/security.yml`.
- [x] T123 [P] Add observability dashboards and alerts for execution, reconciliation, data quality, risk, latency, and availability in `infra/observability/dashboards/`.
- [x] T124 Review narrow-screen layouts and accessibility labels for all safety-critical indicators in `apps/web/components/`.
- [x] T125 Verify all mode labels, simulation/live labels, no-profit-guarantee wording, consent, and disclosure copy in `apps/web/src/content/trading-safety.ts`.
- [x] T126 Run the complete validation procedure in `specs/001-trading-intelligence-platform/quickstart.md` and record evidence in `docs/release-validation.md`.
- [x] T127 Perform current Groww, exchange, SEBI, privacy, security, consent, and disclosure review and record the decision in `docs/compliance/live-readiness.md`.
- [x] T128 Keep live execution disabled by default and document the controlled feature-flag approval in `services/execution/src/live-release-policy.ts`.

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**: No dependencies; T003-T009 can proceed in parallel after T001-T002 define the workspace.
- **Phase 2 Foundational**: Depends on T001-T002; T012-T024 can proceed in parallel where shared types do not conflict; this phase blocks all stories.
- **Phase 3 US1**: Depends on Phase 2; this is the recommended MVP and validates the first safe market-intelligence slice.
- **Phase 4 US2**: Depends on shared contracts from Phase 2; it can begin after Phase 2, but integrates most cleanly after US1 signal views exist.
- **Phase 5 US3**: Depends on Phase 2; it can proceed in parallel with US1/US2 because strategy evaluation has no broker side effects.
- **Phase 6 US4**: Depends on US3 strategy contracts and Phase 2; paper isolation must pass before any live execution work.
- **Phase 7 US5**: Depends on US2 risk contracts, US4 promotion evidence, and Phase 2; live remains feature-flagged.
- **Phase 8 US6**: Depends on market and signal contracts from US1/US2; it can proceed in parallel with US3/US4.
- **Phase 9 US7**: Depends on execution, audit, and event contracts; selected notification work can start after Phase 2.
- **Phase 10 Polish**: Depends on the stories included in the release candidate and must complete before live-readiness review.

### User Story Dependencies

- **US1 (P1)**: Can start after Phase 2; no story dependency; MVP.
- **US2 (P1)**: Can start after Phase 2; uses US1 market data but remains independently testable with fixtures.
- **US3 (P1)**: Can start after Phase 2; can run independently with deterministic rule fixtures.
- **US4 (P1)**: Depends on US3 strategy contracts and Phase 2; must complete before promotion or live execution.
- **US5 (P1)**: Depends on US2 risk contracts and US4 promotion gates; Groww work is isolated behind adapter contracts.
- **US6 (P2)**: Depends on market/event contracts; it cannot authorize orders and can proceed independently.
- **US7 (P2)**: Depends on shared events and audit; journal/analytics become richer as execution stories land.

### Parallel Opportunities

- Setup T003-T009 can run in parallel after workspace files exist.
- Foundational T012-T014 and T017-T024 can run in parallel by package/service ownership.
- Within US1, market ingestion, indicator calculations, options analytics, and UI component work can run in parallel after contracts.
- Within US2, risk tests, state-machine tests, persistence, and trailing policy can run in parallel.
- US3 and US6 can be developed in parallel with US1/US2 after the foundational contracts are stable.
- US4 quantitative work can run in parallel with paper persistence and promotion-gate UI work.
- US5 adapter mapping, execution policy tests, and reconciliation tests can run in parallel before integration.
- US7 notification, journal, analytics, and access-control work can run in parallel by service ownership.
- Final security, load, accessibility, and compliance evidence tasks can run in parallel before release review.

## Parallel Example: User Story 1

```text
T026 market-data contract tests
T029 market repository
T030 feed quality detection
T032 indicator calculations
T033 options-chain summary
T036 chart and market-card components
```

These tasks touch separate files and can proceed in parallel once the shared domain contracts from
Phase 2 are available. T031, T034, T035, T037, T038, and T039 then compose the independently testable dashboard.

## Parallel Example: User Story 5

```text
T078 broker contract tests
T079 Groww mapping tests
T080 idempotency tests
T081 reconciliation tests
T083 execution repository
T085 Groww adapter
T087 Groww smart-order adapter
```

The implementation and tests converge at T084, T088, T089, and the execution route/UI tasks.

## Implementation Strategy

### MVP First

1. Complete Phase 1 Setup.
2. Complete Phase 2 Foundational and verify all safety/mode/audit contracts.
3. Complete Phase 3 User Story 1.
4. Run the independent dashboard and safe-data tests; demo the market-intelligence MVP.
5. Do not enable assisted or live order paths at the MVP checkpoint.

### Incremental Delivery

1. Add US2 for deterministic signal and risk decisions.
2. Add US3 for reusable, versioned strategies.
3. Add US4 for backtest and paper validation; require paper isolation evidence.
4. Add US5 for broker-connected assisted execution behind a disabled live flag.
5. Add US6 for contextual news and regime intelligence.
6. Add US7 for operational review, notifications, analytics, and audit.
7. Run Phase 10 and require compliance approval before any capped live activation.

### Format Validation

Every task uses the required `- [ ] T###` checklist prefix, includes `[P]` only for parallel work,
includes `[US#]` for user-story phases, and names at least one concrete repository path. Task IDs
are sequential from T001 through T128.