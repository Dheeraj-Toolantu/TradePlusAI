# Research: AI Trading Chart and Risk/Reward Engine

## Decision 1: Use the existing Python quant engine as the calculation authority

**Decision**: Extend `quant/src/tradepulse_quant/signals/` with validated OHLCV, indicator, structure, confirmation, setup-level, and options-alignment calculations. Keep the calculation path broker-agnostic and deterministic.

**Rationale**: The repository already has Python signal calculations, candle validation, ATR/EMA/VWAP helpers, option context, and quant metric tests. One calculation authority prevents live and backtest drift and keeps AI outside level calculation.

**Alternatives considered**: Reimplementing calculations in the web application was rejected because it would duplicate rules and make reproducibility across live and backtest paths harder. Calling an LLM for levels was rejected by the feature requirement and safety constitution.

## Decision 2: Adapt results through versioned TypeScript contracts

**Decision**: Add broker-neutral/domain-neutral analysis contracts for analysis requests, evidence, trade setups, chart annotations, no-trade decisions, and backtest results. Expose the analysis through the existing API/service boundary and preserve a strategy configuration version in every result.

**Rationale**: Existing domain contracts already model instruments, candles, signals, risk decisions, and audit events. Versioned contracts let the frontend consume stable output while the quant implementation evolves.

**Alternatives considered**: Returning untyped provider payloads was rejected because it would hide validation state and make chart behavior depend on provider details. Persisting calculation-specific fields only in UI state was rejected because audit and backtest reproducibility require durable result metadata.

## Decision 3: Keep chart annotations derived and session-oriented

**Decision**: Generate chart annotations from the deterministic `TradeSetup`, structure, zones, and state events. Store the source setup and calculation version for audit, while allowing the visual annotation projection to be regenerated for a selected chart session.

**Rationale**: The chart must never become a second source of trading truth. Regenerating annotations from setup output avoids stale drawings and keeps invalidation and lifecycle changes consistent.

**Alternatives considered**: Treating manually drawn chart shapes as trade decisions was rejected because it is not reproducible or auditable. Persisting every visual pixel coordinate was rejected because visual layout is presentation state rather than analysis evidence.

## Decision 4: Use explicit fail-closed quality and no-trade outcomes

**Decision**: Invalid, stale, discontinuous, insufficient, conflicting, or below-threshold inputs return explicit quality blockers and no-trade statuses. They do not emit placeholder levels or zero-valued indicators that could be mistaken for valid evidence.

**Rationale**: This matches the constitution's safety gate and existing `blocked_by`/reason patterns in quant and risk services.

**Alternatives considered**: Silently omitting unavailable evidence was rejected because a trader needs to know why a setup is absent and an auditor needs to distinguish no signal from calculation failure.

## Decision 5: Preserve current strategy and execution boundaries

**Decision**: Reuse the signal state-machine and risk-gate patterns, but keep this feature limited to analysis, charting, paper/review workflows, and backtest evaluation. No new broker call path is introduced.

**Rationale**: Existing signal, risk, paper-trading, audit, and broker-neutral services already provide the correct boundaries. The feature's specification explicitly excludes independent live authorization.

**Alternatives considered**: Connecting chart setup confirmation directly to Groww or another broker was rejected because it would violate mode isolation and bypass existing risk/execution gates.

## Decision 6: Multi-timeframe and option alignment are explicit evidence objects

**Decision**: Represent higher-timeframe, setup-timeframe, and entry-timeframe observations separately, and represent underlying/option alignment as its own result with conflicts and confidence adjustment.

**Rationale**: A combined score without its component evidence would hide counter-trend and premium/underlying conflicts. Explicit objects support explanations, tests, and UI inspection.

**Alternatives considered**: A single opaque confidence value was rejected because it cannot explain why confidence changed or distinguish missing evidence from disagreement.

## Decision 7: Use existing repository validation patterns

**Decision**: Add Python unit fixtures for calculations and TypeScript contract/integration tests for adaptation, state transitions, risk gates, and chart projection. Use existing Vitest and quant test conventions, with targeted end-to-end coverage for chart and no-trade rendering.

**Rationale**: Existing tests already cover stale data, no-trade signals, risk gates, state transitions, chart workflows, options, and backtest metrics.

**Alternatives considered**: Relying only on browser screenshots was rejected because numeric correctness and safety gates require executable deterministic tests.
