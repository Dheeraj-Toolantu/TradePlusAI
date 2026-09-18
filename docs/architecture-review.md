# Architecture Review: V5 Compliance Remediation

## Current Boundary

The algo page calls `apps/web/app/api/algo-trading/route.ts`. Analysis launches `tradepulse_quant.algo_engine.engine`. The canonical V5 safety foundation now lives under `quant/src/tradepulse_quant/algo_engine`.

```text
Web execution page
  -> /api/algo-trading
  -> Python algo_engine.engine
  -> algo_engine.pipeline
  -> algo_engine.no_trade_engine
  -> decision only
```

The pipeline does not place orders. The API is responsible for paper-order validation and currently hard-blocks the live branch.

## Implemented Boundaries

- Configuration and immutable domain models: `algo_engine/configuration.py`, `models.py`
- Data-quality and session helpers: `algo_engine/data_quality_gate.py`, `session_engine.py`
- Prototype ORB/retest and CLI entry point: `algo_engine/orb.py`, `engine.py`
- Central evidence gate: `algo_engine/no_trade_engine.py`
- Serializable orchestration wrapper: `algo_engine/pipeline.py`
- Compatibility imports remain at package root.

## Known Architectural Gaps

The following modules remain absent or non-compliant: gap, regime, independent 15m trend, reference indicators, ORS, OI/PCR, VIX, liquidity, contract master, option risk sizing, expiry protocol, daily risk manager, position manager, trailing policy, order state machine, timeout manager, freeze orders, reconciliation, forced-exit handling, independent risk supervisor, SAFE_MODE, journal, realistic backtesting, robustness validation, observability, and production readiness.

## Safety Decision

The live route is disabled until those prerequisites have code, tests, documentation, and evidence. A successful web build or passing prototype test is not a release authorization.
