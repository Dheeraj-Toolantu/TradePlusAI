# Feature Specification: Platform Requirements Convergence

**Feature Branch**: `003-platform-requirements-convergence`

**Created**: 2026-09-08

**Status**: Draft

**Input**: Gap audit against `TradePulse_AI_Business_Analysis_and_Product_Specification.docx` and `specs/001-trading-intelligence-platform/spec.md`.

## Problem Statement

TradePulse AI has a usable paper-trading and Groww integration foundation, but several requirements are only partial or represented by contracts and in-memory stubs. This feature closes the highest-value gaps without enabling live execution. It makes analytics, data quality, options evidence, notifications, and operational readiness honest and testable.

## Overview

This is a completion feature for the existing TradePulse AI platform, not a replacement for the broad product specification in feature `001`.

## Scope

In scope:

- RSI, MACD, Supertrend, Bollinger Bands, CPR, pivot levels, and explicit price-action/trade-marker observations.
- Options OI build-up and unwinding classification with evidence and invalid-data handling.
- Complete backtest and analytics metrics: profit factor, average/median R, costs, slippage, exposure, and regime breakdown.
- Crossed-quote, outlier, continuity, and freshness data-quality gates.
- Paper-mode end-of-day square-off policy and audit event.
- Notification delivery abstraction with a durable outbox contract and a deterministic local adapter.
- Load, accessibility, and failure-closed validation evidence.
- Compliance, consent, suitability, incident ownership, and operational runbook documentation needed before live activation.

Out of scope:

- Enabling live order submission.
- Claiming signal accuracy, profitability, or future performance.
- High-frequency/co-located execution.
- Unverified social-media news as a trading trigger.
- Replacing the existing business specification or deleting existing feature artifacts.

## User Scenarios & Testing

## User Stories

### User Story 1 - Interpret Complete Technical and Options Evidence (Priority: P1)

As a paper trader, I want the indicators and options evidence used by a signal to be explicit so that I can understand and challenge the setup.

**Independent Test**: Given deterministic candles and option snapshots, the system returns all configured indicators, price-action markers, OI build-up/unwinding evidence, and invalid-data blockers.

### User Story 2 - Trust Validation Metrics (Priority: P1)

As a strategy developer, I want complete cost-aware and regime-aware backtest metrics so that promotion decisions are based on evidence rather than a partial report.

**Independent Test**: Given deterministic trade returns, R multiples, costs, slippage, and regimes, the report calculates profit factor, average R, median R, exposure, and regime breakdown with correct paper/live labels.

### User Story 3 - Operate Paper Trading Safely (Priority: P1)

As an operator, I want stale or unsafe market data, end-of-day rules, and notification failures to fail closed and remain auditable.

**Independent Test**: Inject crossed, outlier, stale, and discontinuous data; trigger square-off and notification events; verify no live endpoint is called and each decision is recorded.

### User Story 4 - Prepare for Controlled Release (Priority: P2)

As a risk manager, I want compliance, ownership, consent, incident response, load, and accessibility evidence documented before any live activation request.

**Independent Test**: The release checklist remains blocked when required evidence is missing and becomes reviewable only when every required artifact is present.

## Functional Requirements

## Non-Functional Requirements

- Safety behavior MUST fail closed and remain observable.
- Paper/live isolation MUST remain enforced in code and tests.
- Calculation versions and audit correlation IDs MUST be retained for reproducibility.

- **FR-001**: The indicator service MUST calculate RSI, MACD, Supertrend, Bollinger Bands, CPR, and pivot levels with deterministic edge-case behavior.
- **FR-002**: The market-intelligence output MUST identify HH/HL, LH/LL, breakout, breakdown, retest, rejection, and trade-marker observations when sufficient data exists.
- **FR-003**: Options analytics MUST classify call/put OI build-up, unwinding, long build-up, and short build-up using OI change, price change, and volume evidence; insufficient data MUST be marked unknown.
- **FR-004**: Backtest and analytics reports MUST include profit factor, average R, median R, costs, slippage, exposure, and regime-wise performance in addition to existing metrics.
- **FR-005**: Metrics MUST distinguish PAPER, ASSISTED, and ALGO_LIVE results and MUST NOT describe uncalibrated scores as probabilities or results as guarantees.
- **FR-006**: Market-data quality MUST reject or flag crossed quotes, invalid OHLC, non-finite values, implausible outliers, timestamp gaps, and stale observations.
- **FR-007**: A blocked data-quality decision MUST prevent new assisted or live entries while preserving visibility and existing-position management.
- **FR-008**: Paper trading MUST support a configurable end-of-day square-off policy, record the reason, and never submit the square-off to a live adapter.
- **FR-009**: Notification events MUST be routed through a provider-neutral outbox contract with delivery state, retry metadata, mode, severity, instrument, and correlation ID.
- **FR-010**: A deterministic local notification adapter MUST support testing without external delivery credentials.
- **FR-011**: Load and accessibility validation MUST produce reproducible evidence for market-session updates, risk-state availability, keyboard access, and narrow-screen safety indicators.
- **FR-012**: Live activation documentation MUST identify current broker/exchange/regulatory review, consent and suitability requirements, operational owners, incident procedures, and unresolved blockers; live flags MUST remain disabled until review is approved.

## Edge Cases

- Fewer than the minimum indicator periods returns `INSUFFICIENT_DATA`, not zero-valued indicators.
- Zero or negative volume, crossed bid/ask, impossible OHLC, duplicate timestamps, and large timestamp gaps block dependent analysis.
- A missing previous OI or missing option price produces `UNKNOWN` OI classification.
- All-loss trades produce a defined zero profit factor; no-loss trades are represented explicitly rather than as infinity in UI output.
- No valid R multiple or no trades produces a defined empty metric state.
- End-of-day square-off does not close positions when the policy is disabled, and it records the policy decision either way.
- Notification provider failure creates a retryable outbox state and does not authorize an order.
- Missing compliance evidence blocks live activation regardless of technical test results.

## Key Entities

- `IndicatorObservation`: indicator name, timeframe, value, status, inputs, calculation version.
- `PriceActionMarker`: marker type, timestamp, price, confidence context, source candles.
- `OIAnalysis`: strike, option type, price change, OI change, volume, classification, evidence, status.
- `AnalyticsReport`: mode, trades, returns, R multiples, costs, slippage, exposure, regime metrics, calculation version.
- `DataQualityDecision`: freshness, continuity, crossed/outlier/invalid checks, decision, blocked reasons.
- `NotificationOutboxEvent`: event, mode, severity, destination, delivery state, attempts, retry time, correlation ID.
- `SquareOffDecision`: account, policy, timestamp, positions, action, reason, result, audit reference.
- `ReleaseEvidence`: requirement, owner, artifact, status, reviewed-at, blocker.

## Success Criteria

- **SC-001**: Deterministic tests cover every newly required indicator and return no false numeric values for insufficient data.
- **SC-002**: Every analytics report includes the required metric fields and passes fixture-based calculations for profit factor, median R, costs, exposure, and regime breakdown.
- **SC-003**: 100% of unsafe data fixtures block new assisted/live entries and preserve an actionable reason.
- **SC-004**: 100% of paper square-off tests prove zero live-adapter order calls.
- **SC-005**: 100% of notification events have an outbox state and correlation ID, including provider failure and retry cases.
- **SC-006**: A release review can identify every unresolved compliance or operational blocker without relying on source-code inspection.
- **SC-007**: Live execution remains disabled in automated tests and local defaults throughout this feature.

## Assumptions

- Existing `001-trading-intelligence-platform` remains the source of broad product scope and safety principles.
- Existing Groww adapter and paper mode remain the integration boundaries.
- Production notification providers and regulatory decisions require deployment-specific configuration and approval.
- This feature improves implementation completeness; it does not make a trading strategy accurate or profitable by itself.
