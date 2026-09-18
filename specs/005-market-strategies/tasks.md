# Tasks: NIFTY Options Strategy V5

**Input**: Master implementation prompt pack in `NIFTY_Options_Strategy_V5_Master_AI_Implementation_Prompts.txt`

**Prerequisites**: Repository audit, signal/ORB prototype review, and V5 requirements traceability.

**Tests**: The V5 prompt explicitly requires automated tests for all acceptance criteria. This task list includes the required test tasks as implementation gates.

**Organization**: Tasks are grouped by implementation phase so each phase can be built and validated independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Story labels are assigned only for user-story-style phases; this backlog is treated as a sequential platform implementation with explicit dependency checkpoints
- Include exact file paths in each task description

---

## Phase 1: Setup, Audit, and Traceability

**Purpose**: Establish the implementation baseline, review the repository, and produce a traceability map before code changes.

- [X] T001 Analyze the current repository and compare it with every V5 requirement in `quant/src/`, `services/`, `apps/`, and `tests/` to produce the required architecture and gap analysis
- [X] T002 [P] Create `docs/requirements-traceability.md` mapping each V5 section to IMPLEMENTED / PARTIAL / MISSING / INCORRECT
- [X] T003 [P] Create `docs/architecture-review.md` documenting the current module dependency map and architecture review
- [X] T004 [P] Create `docs/gap-analysis.md` listing missing functionality, incorrect calculations, risk deficiencies, and migration plan

**Checkpoint**: The codebase is reviewed, risks are identified, and no destructive change is made before the foundation is defined.

---

## Phase 2: Core Configuration and Market Data Foundations

**Purpose**: Build the configuration and fail-closed rules that all future strategy components depend on.

- [ ] T005 Create strongly typed strategy configuration and startup validation in `quant/src/tradepulse_quant/configuration.py`
- [ ] T006 [P] Define immutable domain models for `Candle`, `MarketSnapshot`, `OptionQuote`, `OptionChainSnapshot`, `ContractMetadata`, `Signal`, `TradePlan`, `Position`, `OrderPlan`, `OrderState`, `RiskState`, and `TradeRecord` in `quant/src/tradepulse_quant/models/`
- [ ] T007 Implement fail-closed data quality validation in `quant/src/tradepulse_quant/data_quality_gate.py` with rejection reasons and reconnect synchronization rules
- [ ] T008 [P] Add unit tests for every data-quality gate failure condition and recovery path under `quant/tests/test_data_quality_gate.py`
- [ ] T009 Implement Asia/Kolkata timestamp normalization and session scheduling helpers in `quant/src/tradepulse_quant/session_engine.py`
- [ ] T010 [P] Add exact-boundary session tests for 09:14:59, 09:15:00, 09:29:59, 09:30:00, 09:34:59, 09:35:00, 14:44:59, 14:45:00, 15:14:59, and 15:15:00 in `quant/tests/test_session_engine.py`

**Checkpoint**: Config-driven validation, stale-data rejection, and time-window rules are in place before strategy logic is implemented.

---

## Phase 3: Indicator Correctness and Regime Logic

**Purpose**: Replace the incorrect prototype calculations with deterministic, reference-tested indicator and regime engines.

- [ ] T011 Replace the incorrect ATR, ADX, EMA, and VWAP implementations in `quant/src/tradepulse_quant/indicators/`
- [ ] T012 [P] Add reference-value tests for ATR, ADX, EMA, and VWAP in `quant/tests/test_indicators_reference.py`
- [ ] T013 Document the calculation methodology and parameter assumptions in `quant/src/tradepulse_quant/indicators/README.md`
- [ ] T014 Implement the gap-day engine and explicit states (`NORMAL_DAY`, `GAP_UP_UNRESOLVED`, `GAP_DOWN_UNRESOLVED`, `GAP_HOLD_CONFIRMED`, `GAP_FILL_CONFIRMED`, `GAP_INVALIDATED`) in `quant/src/tradepulse_quant/gap_engine.py`
- [ ] T015 [P] Add gap-day tests covering up/down, hold, fill, ambiguity, and recovery in `quant/tests/test_gap_engine.py`
- [ ] T016 Implement regime classification and hysteresis (`UNKNOWN`, `TRENDING_BULL`, `TRENDING_BEAR`, `RANGE`, `CHOP`) in `quant/src/tradepulse_quant/regime_engine.py`
- [ ] T017 [P] Add regime transition tests including unknown-to-trending, trending stay-in, range, chop, conflicting timeframe, and gap-day override in `quant/tests/test_regime_engine.py`
- [ ] T018 Implement the independent 15-minute trend engine in `quant/src/tradepulse_quant/trend_engine_15m.py` without copying the 5-minute state
- [ ] T019 [P] Add 5m vs 15m independence tests in `quant/tests/test_trend_engine_15m.py`

**Checkpoint**: Indicator calculations are correct, regime transitions are deterministic, and gap-day handling is fail-closed.

---

## Phase 4: ORB, Retest, and Signal Structure

**Purpose**: Rebuild the breakout and retest logic and ensure a structured signal pipeline before option selection and risk sizing.

- [ ] T020 Rebuild the 15-minute ORB engine with ORH/ORL, breakout validation, extension guard, and explicit status/reason output in `quant/src/tradepulse_quant/orb_engine.py`
- [ ] T021 [P] Add ORB tests for both directions, boundary conditions, and extension rejection in `quant/tests/test_orb_engine.py`
- [ ] T022 Implement the 5-minute retest engine with states `WAITING`, `RETESTING`, `CONFIRMED`, `FAILED`, `TIMED_OUT`, and `INVALIDATED` in `quant/src/tradepulse_quant/retest_engine.py`
- [ ] T023 [P] Add retest tests for success, VWAP-loss failure, close-through-without-VWAP-loss, timeout, multiple attempts, and no duplicate re-entry in `quant/tests/test_retest_engine.py`
- [ ] T024 Implement correlation-aware signal scoring with transparent cluster breakdown and a hard 0–10 cap in `quant/src/tradepulse_quant/signal_scoring.py`
- [ ] T025 [P] Add score tests for maximum value, minimum trade score, and compliant achievement conditions in `quant/tests/test_signal_scoring.py`
- [ ] T026 Implement the Option Premium Relative Strength (ORS) engine with safe near-zero denominator handling in `quant/src/tradepulse_quant/ors_engine.py`
- [ ] T027 [P] Add ORS tests for normal participation, strong participation, underperformance, stale prints, zero denominator, and abnormal spread in `quant/tests/test_ors_engine.py`
- [ ] T028 Implement the OI/PCR structure engine with evidence breakdown and configurable thresholds in `quant/src/tradepulse_quant/oipcr_engine.py`
- [ ] T029 [P] Add OI/PCR tests confirming no single PCR cutoff independently generates a trade in `quant/tests/test_oipcr_engine.py`
- [ ] T030 Implement the India VIX / IV regime engine with level + percentile/change gating in `quant/src/tradepulse_quant/vix_engine.py`
- [ ] T031 [P] Add VIX regime tests for low, normal, high, and extreme states in `quant/tests/test_vix_engine.py`
- [ ] T032 Implement 0–3 liquidity scoring with hard minimum score enforcement in `quant/src/tradepulse_quant/liquidity_engine.py`
- [ ] T033 [P] Add liquidity scoring and abnormal-market rejection tests in `quant/tests/test_liquidity_engine.py`

**Checkpoint**: Trend, ORB, retest, score, ORS, OI/PCR, VIX, and liquidity are all independently validated before option selection.

---

## Phase 5: Option Selection, Contract Metadata, and Structural Risk

**Purpose**: Convert valid directional signals into valid trade candidates and realistic risk plans.

- [ ] T034 Create the option selection engine in `quant/src/tradepulse_quant/option_selection.py` with contract filtering, ranking, and deterministic reasoning
- [ ] T035 [P] Add option-selection tests covering ATM/ITM preferences, spread filters, liquidity fails, and invalid contract rejection in `quant/tests/test_option_selection.py`
- [ ] T036 Implement contract metadata provider and cache/refresh logic in `quant/src/tradepulse_quant/contract_master.py` so expiry, strike, lot size, tick size, freeze quantity, and expiry calendar are resolved from live metadata instead of hard-coded values
- [ ] T037 [P] Add contract master tests for metadata refresh and exchange-spec change resilience in `quant/tests/test_contract_master.py`
- [ ] T038 Implement the structural stop and target engine with configurable ATR buffer and RR validation in `quant/src/tradepulse_quant/stop_target_engine.py`
- [ ] T039 [P] Add stop/target deterministic tests and RR gating in `quant/tests/test_stop_target_engine.py`
- [ ] T040 Implement option-based risk sizing and position sizing only after option selection in `quant/src/tradepulse_quant/risk_sizing.py`
- [ ] T041 [P] Add position sizing and risk budget tests for normal, high-VIX, expiry-day, poor-liquidity, and freeze-quantity scenarios in `quant/tests/test_risk_sizing.py`
- [ ] T042 Implement expiry-day gamma protocol with configurable risk adjustments and stricter entry gating in `quant/src/tradepulse_quant/expiry_day_engine.py`
- [ ] T043 [P] Add expiry-day restriction tests in `quant/tests/test_expiry_day_engine.py`

**Checkpoint**: Valid signals turn into deterministic, risk-calibrated option trades without hard-coded contract or market assumptions.

---

## Phase 6: Daily Risk, Position Management, and Order Execution

**Purpose**: Enforce risk controls, execution state machines, and disciplined position lifecycle.

- [ ] T044 Implement the persistent daily risk manager in `quant/src/tradepulse_quant/daily_risk_manager.py` covering daily loss cap, max trades, consecutive losses, cooldown, and profit protection
- [ ] T045 [P] Add daily-loss and cooldown tests in `quant/tests/test_daily_risk_manager.py`
- [ ] T046 Implement the position manager lifecycle in `quant/src/tradepulse_quant/position_manager.py` covering FLAT, ENTRY_PENDING, OPEN, EXIT_PENDING, CLOSED, BROKER_FORCED_EXIT, and RECONCILIATION_REQUIRED
- [ ] T047 [P] Add position lifecycle tests and reversal restrictions in `quant/tests/test_position_manager.py`
- [ ] T048 Implement BE, trailing, and partial-exit logic in `quant/src/tradepulse_quant/trailing_policy.py`
- [ ] T049 [P] Add BE/trailing/partial-exit tests in `quant/tests/test_trailing_policy.py`
- [ ] T050 Implement the order execution state machine in `quant/src/tradepulse_quant/order_state_machine.py`
- [ ] T051 [P] Add order state transition and marketable-limit validation tests in `quant/tests/test_order_state_machine.py`
- [ ] T052 Implement order timeout, cancel, repricing, and bounded retry logic in `quant/src/tradepulse_quant/order_timeout_manager.py`
- [ ] T053 [P] Add timeout/cancel/reprice tests in `quant/tests/test_order_timeout_manager.py`
- [ ] T054 Implement freeze-quantity child-order logic and aggregate reconciliation in `quant/src/tradepulse_quant/freeze_quantity_orders.py`
- [ ] T055 [P] Add freeze-quantity child-order tests in `quant/tests/test_freeze_quantity_orders.py`
- [ ] T056 Implement broker reconciliation and active-position checks in `quant/src/tradepulse_quant/broker_reconciliation.py`
- [ ] T057 [P] Add reconciliation mismatch and reconnect sync tests in `quant/tests/test_broker_reconciliation.py`
- [ ] T058 Implement broker-forced-exit detection and session halt logic in `quant/src/tradepulse_quant/broker_forced_exit.py`
- [ ] T059 [P] Add broker-forced-exit tests in `quant/tests/test_broker_forced_exit.py`
- [ ] T060 Implement the emergency risk supervisor independent of the signal engine in `quant/src/tradepulse_quant/risk_supervisor.py`
- [ ] T061 [P] Add emergency supervision tests in `quant/tests/test_risk_supervisor.py`
- [ ] T062 Implement kill-switch and SAFE_MODE flow in `quant/src/tradepulse_quant/safe_mode.py`
- [ ] T063 [P] Add kill-switch path tests in `quant/tests/test_safe_mode.py`

**Checkpoint**: Risk controls, position management, and order execution are fail-closed and cannot bypass the configured safety rules.

---

## Phase 7: Secondary Strategy Gates and Pipeline Orchestration

**Purpose**: Add the no-trade guardrails, optional strategy variants, and the central deterministic orchestration pipeline.

- [ ] T064 Implement the range strategy safety gate and `NO_TRADE` fallback behavior in `quant/src/tradepulse_quant/range_strategy.py`
- [ ] T065 [P] Add range-strategy tests for no-trade, range gating, and volatility override in `quant/tests/test_range_strategy.py`
- [ ] T066 Implement optional VWAP reversal logic behind explicit enablement checks in `quant/src/tradepulse_quant/vwap_reversal.py`
- [ ] T067 [P] Add optional reversal tests in `quant/tests/test_vwap_reversal.py`
- [ ] T068 Create the central no-trade engine in `quant/src/tradepulse_quant/no_trade_engine.py` that rejects any invalid path deterministically
- [ ] T069 [P] Add no-trade invariant tests in `quant/tests/test_no_trade_engine.py`
- [ ] T070 Build the central signal-to-trade-plan orchestration pipeline in `quant/src/tradepulse_quant/trade_plan_pipeline.py`
- [ ] T071 [P] Add end-to-end pipeline tests for bullish and bearish scenarios in `quant/tests/test_trade_plan_pipeline.py`
- [ ] T072 Implement complete trade journal / audit trail persistence in `quant/src/tradepulse_quant/trade_journal.py`
- [ ] T073 [P] Add journal/audit tests for decision trace and configuration versioning in `quant/tests/test_trade_journal.py`

**Checkpoint**: Every valid trade decision is governed by a single no-trade gate and a single explainable orchestration pipeline.

---

## Phase 8: Backtesting, Metrics, Validation, and Production Readiness

**Purpose**: Prove the strategy is robust under historical, walk-forward, and production-readiness checks.

- [ ] T074 Build a realistic historical backtest engine using actual option-contract data and no look-ahead bias in `quant/src/tradepulse_quant/backtest/engine.py`
- [ ] T075 [P] Add backtest validation tests covering historical option-chain data and execution costs in `quant/tests/test_backtest_metrics.py`
- [ ] T076 Implement theta-realistic P&L accounting and expectancy decomposition in `quant/src/tradepulse_quant/theta_accounting.py`
- [ ] T077 [P] Add theta vs spot-implied expectancy tests in `quant/tests/test_theta_accounting.py`
- [ ] T078 Implement walk-forward, robustness, parameter sensitivity, and overfit checks in `quant/src/tradepulse_quant/validation/robustness.py`
- [ ] T079 [P] Add robustness/overfit validation tests in `quant/tests/test_robustness.py`
- [ ] T080 Implement performance metrics and edge-decay dashboard logic in `quant/src/tradepulse_quant/metrics/dashboard.py`
- [ ] T081 [P] Add dashboard/edge-decay tests in `quant/tests/test_metrics_dashboard.py`
- [ ] T082 Create the complete automated test suite covering all V5 required acceptance criteria under `quant/tests/`
- [ ] T083 [P] Add invariant/property tests for score bounds, risk caps, stale-data blocks, RR, freeze quantity, SAFE_MODE, and mandatory square-off in `quant/tests/test_invariants.py`
- [ ] T084 Implement structured observability and alerting in `quant/src/tradepulse_quant/observability.py`
- [ ] T085 [P] Add observability and alerting tests in `quant/tests/test_observability.py`
- [ ] T086 Implement paper-trading mode with latencies, slippage, partial fill, and rejection simulation in `services/paper-trading/src/`
- [ ] T087 [P] Add paper-trading tests in `quant/tests/test_paper_trading.py`
- [ ] T088 Create broker adapter abstraction and live broker implementation isolated behind a `Broker` interface in `services/` and `adapters/`
- [ ] T089 [P] Add adapter contract tests in `tests/contract/groww-*.test.ts` and equivalent broker tests
- [ ] T090 Implement configuration/environment safety and explicit mode gating (`BACKTEST`, `PAPER`, `LIVE_DISABLED`, `LIVE`) in `quant/src/tradepulse_quant/env_safety.py`
- [ ] T091 [P] Add startup safety tests in `quant/tests/test_env_safety.py`
- [ ] T092 Implement automated production-readiness checker in `quant/src/tradepulse_quant/prod_readiness.py`
- [ ] T093 [P] Add production readiness gate tests in `quant/tests/test_prod_readiness.py`
- [ ] T094 Perform final V5 traceability and code audit with PASS/PARTIAL/FAIL/NOT_APPLICABLE evidence in `docs/final-v5-traceability.md`
- [ ] T095 [P] Create deterministic end-to-end scenario tests for Scenarios A–D in `quant/tests/test_end_to_end_scenarios.py`
- [ ] T096 Execute the full regression suite and confirm the project meets the hard acceptance rule before any controlled-live approval

**Checkpoint**: The strategy is production-ready only when code exists, tests exist, tests pass, edge cases are covered, and traceability remains explicit.

---

## Phase 9: Final Polish and Cross-Cutting Validation

**Purpose**: Final documentation, auditability, and release-signoff checks.

- [ ] T097 Update all implementation notes and operational docs for the V5 strategy in `docs/` and `specs/005-market-strategies/`
- [ ] T098 [P] Review and align configuration, terminology, and code comments to ensure no hidden manual override remains
- [ ] T099 [P] Validate that all tasks follow the required checklist format and execution order
- [ ] T100 Perform final sign-off confirming no V5 requirement is silently weakened and that the strategy remains fail-closed

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1**: No dependencies; establishes baseline
- **Phase 2**: Depends on Phase 1; blocks all subsequent strategy logic
- **Phase 3**: Depends on Phase 2; foundation required before indicators and regimes
- **Phase 4**: Depends on Phase 3; breakout and scoring logic
- **Phase 5**: Depends on Phase 4; selection and risk planning
- **Phase 6**: Depends on Phase 5; execution and risk controls
- **Phase 7**: Depends on Phase 6; no-trade gate and pipeline finalization
- **Phase 8**: Depends on Phase 7; full validation and readiness
- **Phase 9**: Depends on Phases 1–8; final review and sign-off

### Recommended Execution Strategy

- Implement in dependency order, not by generic backlog order alone.
- Treat Phase 2 and 3 as the critical technical foundation.
- Validate each phase with focused tests before moving forward.
- Keep all trade decisions deterministic and explainable.

### Parallel Opportunities

- Tasks marked [P] are good candidates for parallel work once their prerequisites are complete.
- Data-model, tests, and documentation tasks are especially parallelizable.
- The backtest, metrics, and readiness verification tasks can be run in parallel after the core risk pipeline is stable.

---

## Implementation Strategy

### MVP First

1. Complete Phase 1: audit and traceability.
2. Complete Phase 2: configuration + fail-closed data gate.
3. Complete Phase 3: indicator correctness and regime logic.
4. Validate the foundational signal engine before any execution logic.

### Incremental Delivery

1. Add signal generation and no-trade gate.
2. Add option selection and risk sizing.
3. Add execution and broker safety controls.
4. Add backtesting, metrics, and production-readiness checks.
5. Finalize release evidence and sign-off.

### Parallel Team Strategy

- Developer A: Phase 2 foundation and data-quality gate
- Developer B: Phase 3 indicators and regime logic
- Developer C: Phase 4 ORB/retest/scoring
- Developer D: Phase 5 option selection and risk sizing
- Developer E: Phase 6 execution and risk manager
- Developer F: Phase 8 validation and production readiness

---

## Notes

- This task breakdown is derived directly from the V5 prompt pack and the required acceptance gates in that document.
- No task should be marked complete without implementation, tests, passing evidence, deterministic behavior, and documentation.
- The prompt explicitly forbids silently weakening V5 requirements to satisfy a passing test run.
