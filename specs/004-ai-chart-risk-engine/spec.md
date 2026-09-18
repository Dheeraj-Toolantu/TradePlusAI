# Feature Specification: AI Trading Chart and Risk/Reward Engine

**Feature Branch**: `004-ai-chart-risk-engine`

**Created**: 2026-09-10

**Status**: Draft

**Input**: User description: "AI TRADING CHART & RISK/REWARD ENGINE - COPILOT SPEC"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Inspect Deterministic Market Analysis (Priority: P1)

As a trader, I want to inspect OHLCV data, indicators, market structure, and detected patterns on a chart so that I can understand the evidence before considering a trade.

**Why this priority**: Reliable, inspectable market evidence is the foundation for every setup and prevents a single indicator or opaque model from driving a decision.

**Independent Test**: Supply fixed candles for a supported instrument and timeframe, then verify the chart and analysis output contain validated data, configured indicators, swing points, structure labels, support/resistance zones, and detected patterns with evidence.

**Acceptance Scenarios**:

1. **Given** valid OHLCV data for a supported Indian-market instrument, **When** the trader selects a supported timeframe, **Then** the chart displays candles, configured indicators, swing highs/lows, and relevant support/resistance zones.
2. **Given** candles that form higher highs and higher lows, **When** structure analysis completes, **Then** the result labels those relationships and classifies the market with the applicable trend regime.
3. **Given** missing, invalid, duplicated, stale, or discontinuous data, **When** analysis runs, **Then** affected outputs are marked unsafe or insufficient and no fabricated indicator or setup value is shown.

---

### User Story 2 - Evaluate a Confirmed Setup (Priority: P1)

As a trader, I want a qualified setup to include an entry zone, stop loss, technical targets, risk/reward values, confidence, reasons, risks, and invalidation so that I can make a controlled decision.

**Why this priority**: The product's central value is converting observable market evidence into a bounded and explainable trade plan.

**Independent Test**: Run fixed candles through the analysis engine with a strategy configuration and verify that the same inputs produce the same setup object, levels, score, and state.

**Acceptance Scenarios**:

1. **Given** a setup with sufficient structure, trend, momentum, volume, support/resistance, and timeframe evidence, **When** confirmation completes, **Then** the result includes direction, entry zone, stop loss, T1/T2/T3, risk/reward for each target, confidence, reasons, risks, and invalidation.
2. **Given** a candlestick pattern without sufficient confirmation, **When** the candidate is evaluated, **Then** it cannot become a confirmed trade and the result is `NO TRADE`, `WAIT FOR CONFIRMATION`, or another applicable non-entry state.
3. **Given** a technically valid setup with risk/reward below the configured minimum, **When** the candidate is evaluated, **Then** the result is a no-trade decision with the failed threshold and observed values visible.

---

### User Story 3 - See Risk and Reward on the Chart (Priority: P1)

As a trader, I want the calculated trade plan drawn directly on the chart so that I can compare risk, reward, and nearby market levels at a glance.

**Why this priority**: Visualizing the plan reduces ambiguity between the numeric setup and the price action that invalidates or supports it.

**Independent Test**: Provide a deterministic long and short setup and verify that each chart contains the entry zone, stop loss, three targets, risk/reward zones, support/resistance, swings, annotations, and applicable breakout or trend lines.

**Acceptance Scenarios**:

1. **Given** a long setup, **When** chart annotations are rendered, **Then** the entry zone, stop loss below the relevant structure, targets above entry, risk zone, and reward zone are distinguishable and correctly ordered.
2. **Given** a short setup, **When** chart annotations are rendered, **Then** the entry zone, stop loss above the relevant structure, targets below entry, risk zone, and reward zone are distinguishable and correctly ordered.
3. **Given** the setup is invalidated or completed, **When** its state changes, **Then** annotations and setup status reflect the current state without changing the original calculated evidence.

---

### User Story 4 - Analyze Options With Underlying Alignment (Priority: P1)

As an options trader, I want the underlying and option charts analyzed together so that premium behavior is not mistaken for an independent signal.

**Why this priority**: Option-specific volatility and premium behavior can conflict with the underlying, creating material risk if the two views are not compared.

**Independent Test**: Supply synchronized underlying and option candles with aligned and conflicting signals, then verify both analyses, their alignment state, and confidence adjustment.

**Acceptance Scenarios**:

1. **Given** an option instrument, **When** analysis runs, **Then** the result separately shows underlying trend, underlying structure and levels, option trend, option setup levels, and their alignment.
2. **Given** an underlying bullish setup and a conflicting option trend, **When** confirmation completes, **Then** confidence is reduced or the result waits for confirmation according to configuration.
3. **Given** insufficient option or underlying data, **When** an options setup is requested, **Then** the system refuses to represent the setup as confirmed and states the missing evidence.

---

### User Story 5 - Monitor Setup Lifecycle and No-Trade States (Priority: P1)

As a trader, I want setup states and explicit no-trade decisions to be visible so that absence of a signal is treated as a valid, explainable outcome.

**Why this priority**: A high-quality system must prefer fewer explainable setups and must make waiting and invalidation actionable rather than silently showing weak ideas.

**Independent Test**: Feed candidates through pattern detection, confirmation, trigger, targets, and failure conditions, then verify the state transitions and reasons without creating an execution side effect.

**Acceptance Scenarios**:

1. **Given** a candidate pattern, **When** analysis progresses, **Then** it follows `WATCHING`, `PATTERN_DETECTED`, `WAITING_CONFIRMATION`, `CONFIRMED`, `ENTRY_TRIGGERED`, `ACTIVE`, target states, and `COMPLETED` as applicable.
2. **Given** a setup violates its invalidation condition, **When** the next evaluation runs, **Then** it transitions to `INVALIDATED` and identifies the condition that failed.
3. **Given** weak volume, conflicting higher-timeframe evidence, an unbroken level, or insufficient confirmation, **When** the trader views the result, **Then** the result explicitly states `NO TRADE`, `WAIT FOR CONFIRMATION`, or `WAIT FOR BREAKOUT` with reasons.

---

### User Story 6 - Validate the Same Rules Historically (Priority: P2)

As a strategy developer, I want historical analysis to use the same deterministic signal rules as live analysis so that backtest results are reproducible and meaningful.

**Why this priority**: A shared signal definition prevents a strategy from appearing valid in a backtest while behaving differently in live use.

**Independent Test**: Run a versioned strategy over a fixed historical range twice and compare trade records, levels, states, and aggregate metrics for exact reproducibility.

**Acceptance Scenarios**:

1. **Given** a symbol, timeframe, date range, strategy version, capital, and risk per trade, **When** a backtest runs, **Then** it reports trades, wins, losses, win rate, average R:R, profit factor, maximum drawdown, average win/loss, and expectancy.
2. **Given** identical inputs and a fixed strategy version, **When** the backtest is repeated, **Then** the trade sequence and metrics are identical.
3. **Given** a strategy version is used for validation, **When** its parameters are reviewed, **Then** the exact thresholds and configuration used for the result are available.

### Edge Cases

- Fewer candles than an indicator or pattern requires produce an explicit insufficient-data state rather than zero, null-as-success, or a trade.
- Non-finite prices, impossible OHLC relationships, negative volume, duplicate timestamps, gaps, out-of-order candles, and stale observations block dependent analysis.
- A doji, spinning top, or other neutral pattern may be annotated but cannot create a confirmed trade by itself.
- A setup near major support or resistance may have an attractive theoretical R:R but must use market-structure-based targets and may remain a no-trade if the path is obstructed.
- A stop loss cannot be placed directly on an obvious support or resistance level; the configured volatility buffer must be applied.
- Zero or negative calculated risk makes R:R invalid and prevents confirmation.
- A target that is already crossed or unavailable is excluded or marked unavailable rather than invented.
- Conflicting higher-timeframe direction lowers confidence or blocks confirmation according to configuration.
- Underlying and option prices can move in opposite directions; the conflict must be visible and must not be hidden by a combined score.
- A data refresh that removes a prior confirmation preserves the prior result for audit while marking the current setup state accurately.
- A strategy with no trades, all losses, or no profitable trades reports defined empty or zero metric states rather than misleading infinity or success values.
- AI explanation service failure leaves the deterministic setup available and does not change its levels, score, state, or decision.

## Requirements *(mandatory)*

### Functional Requirements

#### Market Data and Indicators

- **FR-001**: The system MUST accept OHLCV observations containing timestamp, open, high, low, close, and volume for supported indices, stocks, futures, and options in Indian markets.
- **FR-002**: The system MUST support 1m, 3m, 5m, 15m, 30m, 1h, 4h, daily, and weekly timeframes.
- **FR-003**: The system MUST validate missing, invalid, non-finite, stale, duplicated, out-of-order, and discontinuous observations before analysis and MUST expose the blocking reason.
- **FR-004**: The system MUST calculate configurable EMA 9/20/50/200, RSI, MACD, ADX, VWAP, ATR, volume SMA, and relative volume values when sufficient data exists.
- **FR-005**: The system MUST return an explicit insufficient-data status when an indicator, pattern, or analysis output lacks its required observations.

#### Market Structure and Patterns

- **FR-006**: The system MUST identify swing highs and swing lows using deterministic, configurable rules.
- **FR-007**: The system MUST classify higher high, higher low, lower high, and lower low relationships and use them to classify strong uptrend, uptrend, bullish reversal, sideways, bearish reversal, downtrend, or strong downtrend.
- **FR-008**: The system MUST detect bullish, bearish, and neutral candlestick patterns including the minimum patterns specified by the feature input, and MUST assign each a state of unconfirmed, weak, potential, confirmed, or strong.
- **FR-009**: A candlestick pattern alone MUST NOT create a confirmed trade or increase confidence beyond the configured confirmation rules.
- **FR-010**: The system MUST detect the specified chart patterns, including double tops/bottoms, head and shoulders, inverse head and shoulders, rounding formations, flags, pennants, rectangles, triangles, breakouts, and breakdowns, with a confidence score and supporting observations.

#### Support, Resistance, and Confirmation

- **FR-011**: The system MUST identify support and resistance from swing levels, touches, rejection zones, consolidation zones, previous day and week levels, previous close, VWAP, configured moving averages, and psychological levels when available.
- **FR-012**: The system MUST merge nearby levels into zones using configurable proximity rules and retain the evidence contributing to each zone.
- **FR-013**: The system MUST combine candlestick, market structure, trend, support/resistance, volume, momentum, chart-pattern, and multi-timeframe evidence into a configurable score from 0 to 100.
- **FR-014**: The default score weights MUST be candlestick 20, market structure 20, trend 15, support/resistance 15, volume 10, momentum 10, chart pattern 5, and multi-timeframe 5, unless the user changes the strategy configuration.
- **FR-015**: The system MUST classify scores as no trade from 0-39, weak from 40-59, potential from 60-74, confirmed from 75-84, and strong from 85-100, while ensuring high R:R alone does not materially increase confidence.
- **FR-016**: The system MUST support configurable higher-timeframe, setup-timeframe, and entry-timeframe roles, with defaults of 15m trend, 5m setup, and 1m entry.
- **FR-017**: Counter-trend or conflicting higher-timeframe evidence MUST reduce confidence or produce a waiting/no-trade decision according to configuration.

#### Trade Levels and Risk/Reward

- **FR-018**: The system MUST support breakout entries requiring a close beyond a level and volume confirmation, pullback entries requiring breakout, retest, and confirmation candle, and reversal entries requiring rejection, candle confirmation, and momentum confirmation.
- **FR-019**: Every actionable setup MUST return an entry zone with minimum and maximum values rather than only a single current-price value.
- **FR-020**: For long setups, the system MUST calculate stop loss below a relevant swing low or support with a configurable volatility buffer; for short setups, it MUST calculate stop loss above a relevant swing high or resistance with the buffer.
- **FR-021**: The system MUST prefer T1 as the nearest relevant opposing level, T2 as the next relevant level, and T3 as a major level, and MUST compare those levels with configurable 1.5R, 2R, 3R, and 4R reference targets.
- **FR-022**: The system MUST calculate long risk as entry minus stop loss and reward as target minus entry, and short risk as stop loss minus entry and reward as entry minus target.
- **FR-023**: The system MUST calculate a separate R:R for each available target and MUST enforce a configurable default minimum R:R of 1:2 without rejecting a technically strong setup solely because a distant theoretical target is unavailable.
- **FR-024**: The system MUST refuse confirmation when calculated risk is zero or negative, target direction is invalid, or a technical target cannot be supported by market structure.

#### Options and Setup Object

- **FR-025**: For options, the system MUST analyze both the underlying and option data, show underlying trend, option trend, and alignment, and reduce confidence or block confirmation when they conflict.
- **FR-026**: Every setup result MUST contain symbol, direction, timeframe, status, entry zone, stop loss, targets, risk/reward values, confidence, detected pattern, trend classification, invalidation condition, reasons, and risks.
- **FR-027**: The system MUST explicitly return `NO TRADE`, `WAIT FOR CONFIRMATION`, `WAIT FOR BREAKOUT`, or `INVALIDATED` when the applicable conditions are not satisfied.

#### Chart Visualization and Explanation

- **FR-028**: The chart MUST draw entry zone, stop-loss line, T1/T2/T3, risk zone, reward zone, support/resistance zones, swing highs/lows, pattern annotations, breakout markers, and applicable trend lines.
- **FR-029**: The chart MUST preserve clear visual ordering for long and short risk/reward plans and MUST distinguish risk from reward without requiring the user to inspect raw values.
- **FR-030**: The setup state machine MUST support `WATCHING`, `PATTERN_DETECTED`, `WAITING_CONFIRMATION`, `CONFIRMED`, `ENTRY_TRIGGERED`, `ACTIVE`, `TARGET_1`, `TARGET_2`, `TARGET_3`, `COMPLETED`, and `INVALIDATED` transitions.
- **FR-031**: The system MUST provide a "Why this setup?" explanation containing the actual detected pattern, structure confirmation, trend confirmation, support/resistance confirmation, volume and momentum confirmation, multi-timeframe alignment, and calculated R:R.
- **FR-032**: AI-generated explanations MUST use only the deterministic engine outputs, MUST not calculate or alter trade levels, and MUST never claim guaranteed profit, accuracy, or returns.
- **FR-033**: Failure or unavailability of the AI explanation service MUST leave the deterministic setup, chart levels, confidence, and decision usable and unchanged.

#### Backtesting and Reproducibility

- **FR-034**: The system MUST use the same deterministic signal rules for historical backtesting and live analysis.
- **FR-035**: Backtesting MUST accept symbol, timeframe, date range, strategy version, capital, and risk per trade, and MUST report trades, wins, losses, win rate, average R:R, profit factor, maximum drawdown, average win/loss, and expectancy.
- **FR-036**: Every strategy result MUST preserve the strategy version and parameters used so that identical inputs and versioned configuration reproduce identical outputs.
- **FR-037**: Backtest outputs MUST distinguish simulated historical results from live or paper performance and MUST not present performance as a guarantee.

### Key Entities

- **OHLCVSeries**: Validated time-ordered candle observations, instrument, timeframe, freshness, continuity, and quality status.
- **IndicatorSet**: Configured indicator values, periods, source observations, and insufficient-data state.
- **MarketStructure**: Swing points, HH/HL/LH/LL relationships, trend classification, and supporting observations.
- **CandlestickPattern**: Pattern type, direction, timestamp, state, confidence contribution, and source candles.
- **PriceZone**: Support or resistance zone, contributing levels, touch/rejection evidence, timeframe, and validity.
- **ChartPattern**: Pattern type, direction, boundaries, detection evidence, confidence, and invalidation.
- **ConfirmationScore**: Weighted evidence components, total score, quality classification, configuration version, and blockers.
- **TradeSetup**: Direction, timeframe, status, entry zone, stop loss, targets, R:R values, confidence, reasons, risks, and invalidation.
- **OptionAlignment**: Underlying setup, option setup, alignment state, conflicts, and confidence adjustment.
- **ChartAnnotation**: Annotation type, price or zone, timeframe, source setup, visual role, and lifecycle state.
- **StrategyConfiguration**: Indicator periods, confirmation weights, timeframe roles, risk buffer, minimum R:R, confidence threshold, and version.
- **BacktestResult**: Strategy version, inputs, trade records, aggregate metrics, drawdown, and reproducibility metadata.
- **SetupStateEvent**: Prior state, next state, timestamp, triggering observation, and reason.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of deterministic fixture cases with known swing relationships return the expected swing highs/lows and HH/HL/LH/LL labels.
- **SC-002**: 100% of supported candlestick-pattern fixture cases return the expected pattern and state, while every pattern-only fixture produces no confirmed trade.
- **SC-003**: 100% of invalid, stale, discontinuous, or insufficient-data fixtures block dependent trade confirmation and expose an actionable reason.
- **SC-004**: 100% of confirmed setup fixtures contain entry zone, stop loss, T1/T2/T3 where technically available, per-target R:R, confidence, reasons, risks, and invalidation.
- **SC-005**: Long and short risk/reward calculations match independently verified reference calculations for all valid fixture setups, including at least 99% numerical agreement at displayed precision.
- **SC-006**: 100% of chart-rendering acceptance fixtures display the required entry, stop, targets, risk/reward zones, and applicable structural annotations in the correct price order.
- **SC-007**: At least 95% of usability test participants can identify a setup's direction, entry zone, stop loss, nearest target, confidence quality, and no-trade reason within 60 seconds.
- **SC-008**: Repeating a backtest with identical data, strategy version, and parameters produces identical trade records and aggregate metrics in 100 out of 100 repeated runs.
- **SC-009**: 100% of option fixtures expose underlying trend, option trend, alignment, and any confidence reduction caused by conflict.
- **SC-010**: AI explanation failure changes none of the deterministic levels, scores, statuses, or decisions in automated tests.
- **SC-011**: No product copy, setup explanation, or backtest report claims guaranteed profit, 100% accuracy, or risk-free performance.
- **SC-012**: Users can find the evidence and invalidation condition for every confirmed setup without consulting raw logs or source code.

## Assumptions

- The initial release supports analysis and paper or review workflows; it does not independently authorize or submit live broker orders.
- Existing market-data, strategy, paper-trading, audit, and risk boundaries remain the integration points for this feature.
- Deterministic calculation behavior, configuration versions, and setup state changes are auditable and retained according to existing platform governance.
- Indicator periods, score weights, timeframe roles, volatility buffer, minimum confidence, and minimum R:R use the specified defaults unless a strategy configuration overrides them.
- Market structure and target selection use available historical candles and do not invent levels when evidence is insufficient.
- Indian-market instruments may include indices, equities, futures, and options; instrument-specific tick sizes, lot sizes, and trading sessions are supplied by existing instrument metadata.
- AI is an explanation and summarization layer only; it is never the source of calculated prices, risk, confidence, or trade decisions.
- Backtest results are historical simulations and require costs, slippage, and other existing validation controls before any promotion decision.
