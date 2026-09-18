---

description: "Executable implementation tasks for the AI Trading Chart and Risk/Reward Engine"
---

# Tasks: AI Trading Chart and Risk/Reward Engine

**Input**: Design documents from `/specs/004-ai-chart-risk-engine/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/analysis-api.md, quickstart.md

**Tests**: Included because the specification requires deterministic fixture validation, risk-critical contract coverage, reproducibility, and chart acceptance scenarios.

**Organization**: Tasks are grouped by user story. Every story has an independent test criterion and can be validated at its checkpoint.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish shared fixtures, version identifiers, and test locations without changing runtime behavior.

- [ ] T001 Create shared deterministic OHLCV, multi-timeframe, option-alignment, and setup fixtures in `quant/tests/fixtures/ai_chart_risk_fixtures.py`
- [X] T002 [P] Add analysis calculation and contract version constants in `quant/src/tradepulse_quant/signals/version.py` and `packages/domain-contracts/src/analysis-version.ts`
- [ ] T003 [P] Add feature test fixture exports and path conventions in `tests/fixtures/ai-chart-risk-engine.ts`
- [ ] T004 [P] Add the feature's test commands and validation notes to `specs/004-ai-chart-risk-engine/quickstart.md`

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Build the shared data-quality, configuration, domain-contract, and audit primitives required by every story.

**Checkpoint**: No user story work begins until validated inputs, versioned contracts, and safe no-trade primitives are available.

- [X] T005 Implement validated OHLCV series, timeframe, freshness, continuity, and explicit quality statuses in `quant/src/tradepulse_quant/signals/ohlcv.py`
- [X] T006 [P] Implement immutable strategy configuration parsing, defaults, validation, and version identity in `quant/src/tradepulse_quant/signals/configuration.py`
- [X] T007 [P] Add shared Python result types for indicator, evidence, blocker, and analysis status values in `quant/src/tradepulse_quant/signals/models.py`
- [X] T008 [P] Add TypeScript analysis request, quality, evidence, no-trade, setup, annotation, and versioned response types in `packages/domain-contracts/src/analysis.ts`
- [X] T009 Add analysis setup, state-event, and audit envelope types to `packages/event-schemas/src/events.ts`
- [X] T010 Add fixture-based validation tests for invalid OHLCV, stale data, duplicate timestamps, discontinuities, insufficient history, and deterministic configuration hashing in `quant/tests/test_ohlcv_validation.py`
- [ ] T011 [P] Add domain contract shape tests for valid and no-trade analysis responses in `tests/contract/ai-chart-risk-contract.test.ts`
- [X] T012 Add an analysis snapshot and append-only state-event persistence adapter using existing audit boundaries in `services/audit/src/analysis-audit.ts`
- [X] T013 Add a shared analysis error and no-trade response mapper in `services/market-data/src/analysis-quality.ts`

## Phase 3: User Story 1 - Inspect Deterministic Market Analysis (Priority: P1) 🎯 MVP

**Goal**: Produce validated indicators, market structure, patterns, and support/resistance evidence for chart inspection.

**Independent Test**: Given fixed candles, the analysis result contains expected indicator values, swings, HH/HL/LH/LL labels, trend regime, zones, and pattern evidence; invalid fixtures return blockers and no fabricated values.

### Tests for User Story 1

- [ ] T014 [P] [US1] Add indicator fixture tests for EMA 9/20/50/200, RSI, MACD, ADX, VWAP, ATR, volume SMA, and relative volume in `quant/tests/test_indicators.py`
- [ ] T015 [P] [US1] Add swing, HH/HL/LH/LL, and regime classification tests in `quant/tests/test_market_structure.py`
- [ ] T016 [P] [US1] Add bullish, bearish, neutral candlestick and chart-pattern fixture tests in `quant/tests/test_patterns.py`
- [ ] T017 [P] [US1] Add support/resistance source, touch, rejection, consolidation, merging, and psychological-level tests in `quant/tests/test_price_zones.py`
- [ ] T018 [P] [US1] Add analysis quality and evidence contract tests in `tests/contract/market-analysis-contract.test.ts`

### Implementation for User Story 1

- [X] T019 [P] [US1] Implement configurable EMA, RSI, MACD, ADX, VWAP, ATR, volume SMA, and relative-volume calculations in `quant/src/tradepulse_quant/signals/indicators.py`
- [X] T020 [P] [US1] Implement deterministic swing detection, HH/HL/LH/LL relationships, and seven-regime classification in `quant/src/tradepulse_quant/signals/market_structure.py`
- [X] T021 [P] [US1] Implement required candlestick pattern detection and pattern-state classification in `quant/src/tradepulse_quant/signals/patterns.py`
- [X] T022 [P] [US1] Implement chart-pattern detection and confidence evidence for formations, breakouts, and breakdowns in `quant/src/tradepulse_quant/signals/chart_patterns.py`
- [X] T023 [P] [US1] Implement support/resistance extraction and nearby-level zone merging in `quant/src/tradepulse_quant/signals/price_zones.py`
- [X] T024 [US1] Compose validated OHLCV, indicators, structure, patterns, and zones into an immutable market-analysis snapshot in `quant/src/tradepulse_quant/signals/analysis.py`
- [ ] T025 [US1] Add a TypeScript adapter for market-analysis snapshots and quality blockers in `services/market-data/src/analysis-adapter.ts`
- [ ] T026 [US1] Add the initial deterministic analysis route response for candles, evidence, zones, and no-trade quality states in `apps/web/app/api/analysis/evaluate/route.ts`
- [ ] T027 [US1] Render candles, configured indicators, swings, structure labels, patterns, and support/resistance zones in `apps/web/components/analysis-chart.tsx`
- [ ] T028 [US1] Integrate selected timeframe, data-quality state, and analysis evidence into `apps/web/app/page.tsx`

**Checkpoint**: US1 is independently demonstrable with fixed candles and no trade execution path.

## Phase 4: User Story 2 - Evaluate a Confirmed Setup (Priority: P1)

**Goal**: Convert evidence into a deterministic confirmation score and complete trade setup with entry, stop, targets, R:R, reasons, risks, and invalidation.

**Independent Test**: Given fixed evidence and a strategy configuration, repeated evaluation produces the same setup object; pattern-only, weak-volume, invalid-risk, and below-minimum-R:R cases produce explicit no-trade decisions.

### Tests for User Story 2

- [ ] T029 [P] [US2] Add weighted confirmation-score tests for default weights, quality bands, blockers, and R:R independence in `quant/tests/test_confirmation.py`
- [ ] T030 [P] [US2] Add long and short entry-zone, ATR-buffered stop, technical-target, and per-target R:R tests in `quant/tests/test_setup_levels.py`
- [ ] T031 [P] [US2] Add pattern-only, low-volume, invalid-risk, unsupported-target, and below-minimum-R:R no-trade tests in `quant/tests/test_no_trade_engine.py`
- [ ] T032 [P] [US2] Add setup response contract tests for all required fields and no-trade statuses in `tests/contract/trade-setup-contract.test.ts`
- [ ] T033 [US2] Add deterministic repeated-evaluation integration tests in `tests/integration/analysis-determinism.test.ts`

### Implementation for User Story 2

- [X] T034 [US2] Implement configurable weighted confirmation scoring, quality bands, evidence components, and blockers in `quant/src/tradepulse_quant/signals/confirmation.py`
- [X] T035 [US2] Implement breakout, pullback, and reversal entry-zone derivation in `quant/src/tradepulse_quant/signals/entry_engine.py`
- [X] T036 [US2] Implement long/short ATR-buffered stop placement that avoids obvious support/resistance in `quant/src/tradepulse_quant/signals/stop_engine.py`
- [X] T037 [US2] Implement technical-level and R-multiple target selection plus long/short R:R calculations in `quant/src/tradepulse_quant/signals/target_engine.py`
- [X] T038 [US2] Implement complete TradeSetup assembly, confidence thresholds, minimum-R:R gating, invalidation, reasons, risks, and explicit no-trade statuses in `quant/src/tradepulse_quant/signals/setup_engine.py`
- [ ] T039 [US2] Wire the setup engine into the analysis composition path without changing source evidence snapshots in `quant/src/tradepulse_quant/signals/analysis.py`
- [ ] T040 [US2] Extend `/api/analysis/evaluate` to return versioned setup, confirmation, levels, R:R, blockers, reasons, risks, and invalidation in `apps/web/app/api/analysis/evaluate/route.ts`
- [ ] T041 [US2] Add a setup evidence panel showing direction, entry zone, stop, targets, R:R, confidence quality, reasons, risks, and no-trade status in `apps/web/components/trade-setup-card.tsx`

**Checkpoint**: US2 is independently testable from a fixed analysis request and has no broker side effect.

## Phase 5: User Story 3 - See Risk and Reward on the Chart (Priority: P1)

**Goal**: Project deterministic setup levels and structure into clear long/short chart annotations.

**Independent Test**: Given a long and short setup, the chart shows correctly ordered entry, stop, targets, risk/reward zones, structural annotations, and lifecycle status.

### Tests for User Story 3

- [ ] T042 [P] [US3] Add long/short annotation projection tests for price ordering, risk/reward zones, labels, and lifecycle state in `tests/unit/chart-annotation-projector.test.ts`
- [ ] T043 [P] [US3] Add annotation API contract tests proving client-supplied levels are rejected and source setup versions are preserved in `tests/contract/analysis-annotations-contract.test.ts`
- [ ] T044 [US3] Add Playwright chart acceptance tests for long, short, invalidated, and completed setup rendering in `tests/e2e/ai-chart-risk-engine.spec.ts`

### Implementation for User Story 3

- [ ] T045 [US3] Implement setup-to-annotation projection for entry, stop, targets, risk/reward zones, zones, swings, patterns, breakouts, and trend lines in `services/signal/src/chart-annotation-projector.ts`
- [ ] T046 [US3] Add derived annotation retrieval at `/api/analysis/[analysisId]/annotations/route.ts` without recalculating or accepting client levels
- [ ] T047 [US3] Render entry zone, stop line, T1/T2/T3, risk/reward zones, labels, and structural overlays in `apps/web/components/analysis-chart.tsx`
- [ ] T048 [US3] Add visible chart states for no-trade, insufficient data, invalidated, and completed setups in `apps/web/components/trade-setup-card.tsx`
- [ ] T049 [US3] Verify responsive chart sizing and non-overlapping risk/reward labels in `apps/web/app/globals.css` and `tests/e2e/dashboard-responsive.spec.ts`

**Checkpoint**: US3 is independently demonstrable from a stored deterministic setup snapshot and has no calculation or broker side effect in the browser.

## Phase 6: User Story 4 - Analyze Options With Underlying Alignment (Priority: P1)

**Goal**: Analyze underlying and option evidence separately, then expose alignment and confidence adjustment.

**Independent Test**: Aligned, conflicting, and insufficient underlying/option fixtures return separate trends, setup evidence, alignment state, and the configured confidence or waiting behavior.

### Tests for User Story 4

- [ ] T050 [P] [US4] Add aligned, conflicting, and insufficient option/underlying fixture tests in `quant/tests/test_option_alignment.py`
- [ ] T051 [P] [US4] Add options analysis contract tests for underlying trend, option trend, alignment, conflicts, and adjustment in `tests/contract/option-alignment-contract.test.ts`
- [ ] T052 [US4] Add options workflow integration tests proving conflicting underlying/option evidence cannot produce an unqualified confirmed setup in `tests/integration/option-analysis.test.ts`

### Implementation for User Story 4

- [ ] T053 [US4] Implement underlying and option analysis composition with explicit OptionAlignment evidence in `quant/src/tradepulse_quant/signals/option_alignment.py`
- [ ] T054 [US4] Integrate existing option-engine and option-chain inputs with the versioned analysis request in `services/options-analytics/src/analysis-option-adapter.ts`
- [ ] T055 [US4] Extend the analysis response with underlying analysis, option analysis, alignment, conflicts, and confidence adjustment in `apps/web/app/api/analysis/evaluate/route.ts`
- [ ] T056 [US4] Add underlying trend, option trend, alignment, and conflict evidence to `apps/web/components/trade-setup-card.tsx`
- [ ] T057 [US4] Add option/underlying chart mode and separate annotations to `apps/web/components/analysis-chart.tsx`

**Checkpoint**: US4 is independently testable with deterministic paired fixtures and remains broker-neutral.

## Phase 7: User Story 5 - Monitor Setup Lifecycle and No-Trade States (Priority: P1)

**Goal**: Make setup transitions, blockers, invalidation, and explicit waiting/no-trade results visible and auditable.

**Independent Test**: A candidate can be driven through detection, confirmation, active targets, completion, and invalidation while every transition records a reason and no broker call occurs.

### Tests for User Story 5

- [ ] T058 [P] [US5] Add lifecycle transition and invalid-transition tests for all required setup states in `tests/unit/setup-state-machine.test.ts`
- [ ] T059 [P] [US5] Add no-trade reason and blocker persistence tests in `tests/integration/setup-no-trade-state.test.ts`
- [ ] T060 [US5] Add audit completeness tests for analysis snapshots, lifecycle events, explanation requests, and invalidation in `tests/integration/analysis-audit.test.ts`
- [ ] T061 [US5] Add end-to-end safe-state tests proving no-trade and invalidated setups create zero broker calls in `tests/e2e/ai-chart-safe-state.spec.ts`

### Implementation for User Story 5

- [ ] T062 [US5] Extend `services/signal/src/signal-state-machine.ts` with the feature's pattern-detected, waiting-confirmation, target-3, and completed transitions while preserving existing execution states
- [ ] T063 [US5] Add setup state event creation, append-only persistence, and transition reason validation in `services/signal/src/setup-state-events.ts`
- [ ] T064 [US5] Add no-trade decision persistence and current-versus-prior snapshot handling in `services/audit/src/analysis-audit.ts`
- [ ] T065 [US5] Add lifecycle status and blocker rendering to `apps/web/components/trade-setup-card.tsx` and `apps/web/app/page.tsx`
- [ ] T066 [US5] Add the `analysis.setup-state.v1` event mapping and audit correlation fields in `packages/event-schemas/src/events.ts`

**Checkpoint**: US5 is independently testable with state fixtures and confirms the feature cannot authorize broker execution.

## Phase 8: User Story 6 - Validate the Same Rules Historically (Priority: P2)

**Goal**: Run the same versioned deterministic signal engine over historical data and return reproducible metrics.

**Independent Test**: Running the same backtest inputs twice produces identical trade records, setup levels, state outcomes, metrics, and reproducibility key, labeled as historical simulation.

### Tests for User Story 6

- [ ] T067 [P] [US6] Add backtest signal-engine parity tests comparing historical and analysis evaluation outputs in `quant/tests/test_signal_engine_parity.py`
- [ ] T068 [P] [US6] Add empty-run, all-loss, target, drawdown, R:R, cost, slippage, exposure, and regime metric tests in `quant/tests/test_backtest_metrics.py`
- [ ] T069 [P] [US6] Add backtest request/response contract tests for version and simulation labeling in `tests/contract/backtest-analysis-contract.test.ts`
- [ ] T070 [US6] Add repeated-run reproducibility integration tests in `tests/integration/analysis-backtest-reproducibility.test.ts`

### Implementation for User Story 6

- [ ] T071 [US6] Extract the shared versioned analysis evaluator interface used by live/review and historical paths in `quant/src/tradepulse_quant/signals/analysis.py`
- [ ] T072 [US6] Add setup-level trade simulation and strategy/calculation version capture to `services/backtest/src/backtest-service.ts`
- [ ] T073 [US6] Extend backtest metric output with required R:R, profit factor, drawdown, average win/loss, expectancy, cost, slippage, exposure, and regime fields in `quant/src/tradepulse_quant/analytics/metrics.py`
- [ ] T074 [US6] Add `POST /api/backtests` request validation, simulation labeling, and reproducibility-key response in `apps/web/app/api/backtests/route.ts`
- [ ] T075 [US6] Add a backtest results view with trade evidence, metrics, strategy version, and simulation label in `apps/web/components/backtest-results.tsx`

**Checkpoint**: US6 is independently repeatable and does not change live execution behavior.

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Complete documentation, safety review, performance checks, and full validation across all stories.

- [ ] T076 [P] Add feature contract and data-model references to `specs/004-ai-chart-risk-engine/quickstart.md`
- [ ] T077 [P] Add explicit no-guarantee and explanation-only copy review to `apps/web/components/trade-setup-card.tsx` and `apps/web/components/backtest-results.tsx`
- [ ] T078 [P] Add analysis failure observability and correlation logging in `services/audit/src/analysis-audit.ts` and `services/market-data/src/analysis-quality.ts`
- [ ] T079 Run `pnpm test` and repair feature-scoped contract/integration regressions without altering unrelated tests
- [ ] T080 Run `python -m pytest quant/tests` and verify deterministic numeric and safety fixtures
- [ ] T081 Run the feature scenarios in `specs/004-ai-chart-risk-engine/quickstart.md`, including chart, no-trade, lifecycle, options, and repeated-backtest checks
- [ ] T082 [P] Review `specs/004-ai-chart-risk-engine/spec.md`, `plan.md`, `data-model.md`, `contracts/analysis-api.md`, and `tasks.md` for traceability and update assumptions if implementation decisions changed

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies; T001-T004 can run in parallel except where a shared fixture path is required.
- **Foundational (Phase 2)**: Depends on Setup; T005-T013 block all user stories.
- **User Story 1 (Phase 3)**: Depends on Phase 2 and is the MVP foundation for analysis evidence.
- **User Story 2 (Phase 4)**: Depends on US1 evidence composition; it adds confirmation and setup levels.
- **User Story 3 (Phase 5)**: Depends on US2 setup output; it projects levels and lifecycle status.
- **User Story 4 (Phase 6)**: Depends on US1 and US2 contracts/evaluator; it can run in parallel with US3 after US2.
- **User Story 5 (Phase 7)**: Depends on US2 setup states and can run in parallel with US4; chart state integration uses US3 when available.
- **User Story 6 (Phase 8)**: Depends on US2 shared evaluator and existing backtest service; it can run in parallel with US3-US5 after US2.
- **Polish (Phase 9)**: Depends on all desired stories and their checkpoints.

### User Story Dependencies

- **US1 (P1)**: Foundational only; MVP entry point.
- **US2 (P1)**: Depends on US1's validated evidence and analysis snapshot.
- **US3 (P1)**: Depends on US2's immutable TradeSetup and annotation source data.
- **US4 (P1)**: Depends on US1 analysis primitives and US2 confirmation/setup contracts.
- **US5 (P1)**: Depends on US2 setup decisions; can proceed without US3 rendering, with UI completion after US3.
- **US6 (P2)**: Depends on US2's shared evaluator and strategy configuration; independent of option-specific rendering.

### Parallel Opportunities

- Phase 1 tasks T001-T004 can be split across fixture, versioning, and documentation work.
- Phase 2 tasks T006-T009, T011-T013 can proceed in parallel after the shared fixture conventions are agreed.
- Within US1, indicator, structure, pattern, zone, and contract tests/implementations are separate files and can run in parallel before composition T024.
- Within US2, confirmation, entry, stop, target, and contract tests can run in parallel before setup assembly T038-T040.
- After US2, US3, US4, US5, and US6 can be assigned to separate owners with their stated dependencies.
- Polish documentation, copy review, observability, and traceability tasks can run in parallel before the final test commands.

## Parallel Execution Examples

### User Story 1

```text
Task T014: indicator fixtures in quant/tests/test_indicators.py
Task T015: structure fixtures in quant/tests/test_market_structure.py
Task T016: pattern fixtures in quant/tests/test_patterns.py
Task T017: zone fixtures in quant/tests/test_price_zones.py
Task T019: indicator implementation in quant/src/tradepulse_quant/signals/indicators.py
Task T020: structure implementation in quant/src/tradepulse_quant/signals/market_structure.py
Task T021: candlestick implementation in quant/src/tradepulse_quant/signals/patterns.py
Task T022: chart-pattern implementation in quant/src/tradepulse_quant/signals/chart_patterns.py
Task T023: zone implementation in quant/src/tradepulse_quant/signals/price_zones.py
```

### User Story 2

```text
Task T029: confirmation tests in quant/tests/test_confirmation.py
Task T030: setup-level tests in quant/tests/test_setup_levels.py
Task T031: no-trade tests in quant/tests/test_no_trade_engine.py
Task T034: confirmation implementation in quant/src/tradepulse_quant/signals/confirmation.py
Task T035: entry implementation in quant/src/tradepulse_quant/signals/entry_engine.py
Task T036: stop implementation in quant/src/tradepulse_quant/signals/stop_engine.py
Task T037: target implementation in quant/src/tradepulse_quant/signals/target_engine.py
```

### Post-US2 Story Parallelism

```text
User Story 3: chart annotation projection and rendering
User Story 4: options alignment and paired analysis
User Story 5: lifecycle events and no-trade audit
User Story 6: backtest parity and reproducibility
```

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Setup and Foundational phases.
2. Complete US1 deterministic market analysis and chart evidence.
3. Validate fixed-candle indicators, structure, patterns, zones, and unsafe-data behavior.
4. Stop before setup confirmation or broker integration; demonstrate evidence inspection independently.

### Incremental Delivery

1. Add US2 to produce explainable trade setups and explicit no-trade outcomes.
2. Add US3 to visualize risk/reward and structural annotations.
3. Add US4 for options/underlying alignment.
4. Add US5 for lifecycle, audit, and visible safe states.
5. Add US6 for shared backtest/live rules and reproducibility.
6. Complete polish and full quickstart validation.

### Parallel Team Strategy

1. Complete Setup and Foundational together.
2. Assign US1 analysis to the quant/API owner.
3. After US2 contracts stabilize, assign chart annotations, options alignment, lifecycle/audit, and backtest parity to separate owners.
4. Integrate at each checkpoint and run story-specific tests before proceeding.

## Notes

- `[P]` tasks touch different files and have no dependency on incomplete work in the same phase.
- `[US1]` through `[US6]` map directly to the six user stories in `spec.md`.
- Every task includes an exact repository-relative file path and an executable outcome.
- No task creates a live broker call path; all analysis and backtest work remains deterministic and broker-neutral.
