# V5 Gap Analysis

## Closed or Reduced Gaps

- Missing feature artifacts: `spec.md` and `plan.md` now exist.
- Stale audit documents: refreshed with current statuses.
- No central fail-closed decision object: added under `algo_engine/no_trade_engine.py`.
- Missing deterministic A-N gate scenarios: added under `quant/tests/test_end_to_end_scenarios.py`.
- Unsafe live API availability: live branch now returns `LIVE_EXECUTION_DISABLED` before broker calls.
- The algo-trading API route previously invoked the Python pipeline without forwarding known server-side evidence (broker health, SAFE_MODE, kill switch), so every reason beyond the candle-derived gates was silently `MISSING_*` even when the true state was known. The Node boundary now merges observed broker health and explicit `ALGO_SAFE_MODE` / `ALGO_KILL_SWITCH` environment state into the pipeline evidence (`services/execution/src/safe-mode.ts`), and `analyze_payload` merges caller-supplied evidence without allowing it to override candle-observed fields (data quality, session, breakout, retest, risk/reward).
- The Algo Trading page previously rendered only a single joined `reason` string and never exposed the full ordered gate list or the complete `NO_TRADE` reason set required by the V5 feedback ("show every active blocking reason, not just the first failure"). The page now renders a header status bar (instrument, session state, IST clock, execution mode, SAFE_MODE, KILL_SWITCH, data-feed health, reconciliation placeholder), a full "V5 Decision Pipeline" panel driven by `analysis.pipeline.gates`, and a "No-Trade Engine" panel driven by `analysis.pipeline.reasons`. All of this is read-only and sourced entirely from the backend response; the UI performs no strategy calculation.
- Market data and paper order placement on the Algo Trading page are now hard-restricted to the Groww provider at the API boundary (`GET`/`POST /api/algo-trading` reject any other `provider` value with 400). The prior Yahoo/fallback data-source selector has been removed from the page.

## Remaining Functional Gaps

- ATR/ADX/EMA/VWAP are not reference-correct V5 implementations.
- Gap-day and regime-hysteresis engines are absent.
- ORB/retest remains a prototype rather than the required state machine.
- Correlation-aware score, ORS, OI/PCR, VIX, and liquidity engines are absent.
- Contract master, deterministic option selection, structural target engine, option-based risk sizing, and expiry-day protocol are absent.
- Daily risk, position lifecycle, trailing, execution state machine, timeout/reprice, freeze orders, reconciliation, forced exits, risk supervisor, SAFE_MODE, and kill switch are absent.
- Full signal-to-trade-plan orchestration is not yet populated with real V5 evidence providers.
- Trade journal, realistic historical option-chain backtest, theta accounting, walk-forward validation, edge-decay metrics, observability, and readiness checker are absent.

## Remaining Safety Risks

- Direct live execution is blocked, but paper order/API contract tests should still be added.
- Existing prototype modules can produce incomplete analysis fields and must not be treated as V5 confirmation without pipeline evidence.
- The ORB stop/target calculation is still the prototype `entry ± 2R` heuristic (labeled `target_method: "PROTOTYPE_2R_ATR_HEURISTIC"` in the API response) and is not the structural retest-based stop/target engine required by V5 (task T038). It must not be presented as a verified structural calculation.
- `SAFE_MODE`/`KILL_SWITCH` are now plumbed end-to-end from environment flags through the pipeline to the UI, but there is still no operator control surface, persistence, or automatic trigger logic (e.g. broker-forced-exit or reconciliation failure do not yet set these flags automatically).
- The feature task list remains intentionally unchecked except for the original audit tasks.

## Required Next Implementation Order

1. Implement true indicators, gap, regime, trend, ORB, and retest engines.
2. Implement option evidence, contract metadata, liquidity, structural risk, expiry, and sizing.
3. Implement daily risk, position supervision, execution states, reconciliation, SAFE_MODE, and kill switch.
4. Implement realistic backtesting, paper parity, journal, metrics, observability, and readiness.
5. Add acceptance evidence and only then check individual tasks.
