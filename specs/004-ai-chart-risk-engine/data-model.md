# Data Model: AI Trading Chart and Risk/Reward Engine

## Design Rules

- All timestamps are ISO timestamps with an explicit timezone.
- All prices, volumes, scores, and ratios are finite numbers when status is valid.
- Every calculated result carries `strategyVersion` and `calculationVersion`.
- Invalid or insufficient values use an explicit status and reason; they are never represented as valid zeroes.
- Analysis objects are immutable snapshots. Lifecycle changes append events and create a new current state.

## Entities

### OHLCVSeries

Represents validated time-ordered candles for one instrument and timeframe.

Fields:

- `instrumentId`, `symbol`, `timeframe`
- `candles[]`: timestamp, open, high, low, close, volume
- `quality`: VALID, INSUFFICIENT_DATA, INVALID, STALE, DISCONTINUOUS
- `qualityReasons[]`, `observedAt`, `latestTimestamp`
- `dataVersion`

Validation: finite OHLCV values; high >= max(open, close, low); low <= min(open, close, high); volume >= 0; strictly increasing timestamps; required interval continuity; freshness within configured limit.

### IndicatorSet

Contains configured indicator outputs for an OHLCV snapshot.

Fields:

- `ema9`, `ema20`, `ema50`, `ema200`
- `rsi`, `macd` (line, signal, histogram), `adx`, `vwap`, `atr`
- `volumeSma`, `relativeVolume`
- `periods`, `sourceRange`, `status`, `reasons[]`

Validation: each value is finite only when its required lookback exists; period and buffer configuration must be positive.

### MarketStructure

Represents deterministic swing and regime observations.

Fields:

- `swingHighs[]`, `swingLows[]`: timestamp, price, strength, source index
- `relationships[]`: HH, HL, LH, LL with prior/current references
- `regime`: STRONG_UPTREND, UPTREND, BULLISH_REVERSAL, SIDEWAYS, BEARISH_REVERSAL, DOWNTREND, STRONG_DOWNTREND
- `trendDirection`, `confidenceContribution`, `status`, `reasons[]`

Validation: no relationship may reference a missing swing; unconfirmed trailing swings must be marked as provisional and cannot silently act as confirmed levels.

### PriceZone

Represents merged support or resistance evidence.

Fields:

- `type`: SUPPORT or RESISTANCE
- `min`, `max`, `midpoint`
- `sources[]`: swing, touch, rejection, consolidation, previous-day, previous-week, previous-close, VWAP, EMA, psychological
- `touchCount`, `timeframes[]`, `strength`, `validUntil`, `status`

Validation: min <= midpoint <= max; zones merge only within configured proximity; source evidence is retained.

### CandlestickPattern and ChartPattern

`CandlestickPattern` contains type, direction, candle timestamps, state, score contribution, and evidence. Supported minimum types are defined by FR-008.

`ChartPattern` contains type, direction, boundary points, confidence, evidence, breakout/breakdown status, and invalidation.

Validation: patterns require their minimum source candles and cannot alone produce a confirmed `TradeSetup`.

### ConfirmationScore

Fields:

- `components`: candlestick, marketStructure, trend, supportResistance, volume, momentum, chartPattern, multiTimeframe
- `weights`, `total` from 0 to 100
- `quality`: NO_TRADE, WEAK, POTENTIAL, CONFIRMED, STRONG
- `blockers[]`, `strategyVersion`, `calculationVersion`

Default weights: 20, 20, 15, 15, 10, 10, 5, 5. R:R does not contribute materially to confidence.

### TradeSetup

Fields:

- `id`, `symbol`, `instrumentId`, `direction`, `timeframe`, `status`
- `entry`: min, max, method, trigger
- `stopLoss`: price, reference, volatilityBuffer
- `targets[]`: label, price, technicalReference, rMultiple, available
- `riskReward[]`: targetLabel, risk, reward, ratio
- `confidence`, `quality`, `pattern`, `trend`
- `reasons[]`, `risks[]`, `invalidation`, `blockers[]`
- `strategyVersion`, `calculationVersion`, `createdAt`, `sourceDataVersion`

Validation: long targets above entry and stop below entry; short targets below entry and stop above entry; risk > 0; entry is a zone; target references are market-structure-based; no confirmed status without required confirmations and minimum configured R:R.

### OptionAlignment

Fields:

- `underlyingSetupId`, `optionInstrumentId`, `underlyingTrend`, `optionTrend`
- `alignment`: ALIGNED, CONFLICTING, INSUFFICIENT
- `confidenceAdjustment`, `conflicts[]`, `evidence[]`

Validation: an options setup cannot be confirmed when either input is insufficient or alignment is conflicting under a requiring-alignment configuration.

### ChartAnnotation

Fields:

- `id`, `setupId`, `annotationType`, `timeframe`
- `priceMin`, `priceMax`, `timestampStart`, `timestampEnd`
- `label`, `visualRole`, `sourceEvidenceId`, `lifecycleState`

Annotation types include ENTRY_ZONE, STOP_LOSS, TARGET, RISK_ZONE, REWARD_ZONE, SUPPORT_ZONE, RESISTANCE_ZONE, SWING, PATTERN, BREAKOUT, and TREND_LINE. Annotations are a projection of setup and evidence state.

### SetupStateEvent

Fields: `setupId`, `from`, `to`, `trigger`, `reason`, `actor`, `occurredAt`, `calculationVersion`.

Allowed path: WATCHING -> PATTERN_DETECTED -> WAITING_CONFIRMATION -> CONFIRMED -> ENTRY_TRIGGERED -> ACTIVE -> TARGET_1 -> TARGET_2 -> TARGET_3 -> COMPLETED; any eligible active/pre-confirmation state may transition to INVALIDATED according to its invalidation rule.

### StrategyConfiguration

Fields:

- `strategyId`, `version`, `minimumRr`, `minimumConfidence`
- `indicatorPeriods`, `confirmationWeights`, `atrBufferMultiplier`, `volumeConfirmationRequired`
- `supportConfirmationRequired`, `mtfConfirmationRequired`
- `timeframeRoles`: trend, setup, entry
- `swingRules`, `zoneProximityRules`, `freshnessLimits`
- `immutable`, `createdAt`

A configuration used in a backtest or live/paper analysis is immutable and included in output hashes or audit metadata.

### BacktestResult

Fields: `runId`, inputs, `strategyVersion`, `calculationVersion`, trade records, wins, losses, winRate, averageRr, profitFactor, maxDrawdown, averageWin, averageLoss, expectancy, costs, slippage, exposure, regimeBreakdown, mode, reproducibilityKey.

Validation: empty and all-loss runs use defined metric states; historical results are labeled as simulation and cannot be presented as guaranteed performance.

## Relationships

- One `OHLCVSeries` produces one `IndicatorSet`, one `MarketStructure`, zero or more patterns, and zero or more `PriceZone` snapshots.
- A `ConfirmationScore` references the evidence snapshots and one `StrategyConfiguration`.
- A `TradeSetup` references one confirmation score and may reference one `OptionAlignment`.
- A `TradeSetup` produces chart annotations and append-only state events.
- A `BacktestResult` contains many setup/trade snapshots and references the exact strategy and calculation versions used.
- Audit events reference every setup snapshot, state transition, blocked decision, and explanation request.
