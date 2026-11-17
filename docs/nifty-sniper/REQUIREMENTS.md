# NIFTY SNIPER AI

## AI-Ready Product Requirements, Strategy Specification & Engineering Build Guide

**Document version:** 1.1\
**Prepared:** 17 November 2026\
**Product:** NIFTY Sniper AI\
**Initial instrument:** NSE NIFTY 50 index options (long calls and long
puts)\
**Trading style:** Intraday options buying\
**Primary objective:** Identify selective, high-momentum directional
setups and manage trades toward a 2.0x option-premium target while
enforcing strict capital protection.

------------------------------------------------------------------------

# 0. Instructions to the AI Software Engineering Agent

You are the lead quantitative developer, trading-systems architect,
Python engineer, QA engineer and technical product owner for this
project.

Build the system described in this document. Treat this file as the
product and strategy baseline. Do not silently omit requirements, invent
market-data capabilities, assume broker API behavior, or claim that a
strategy is profitable without test evidence.

## Mandatory engineering principles

1.  **Do not jump directly to live trading.** Build in stages: data
    validation, deterministic strategy, historical backtest, paper
    trading, broker integration, controlled live release.
2.  **Do not fabricate data.** Clearly distinguish live data, delayed
    data, historical data, simulated data and unavailable fields.
3.  **No look-ahead bias.** A signal may only use information available
    at the signal timestamp. A candle-close condition is not confirmed
    until that candle has closed.
4.  **No repainting.** Swing points, BOS, MSS, FVG and liquidity events
    must have explicit confirmation rules and timestamps. A later candle
    must not retroactively create an earlier executable signal.
5.  **No guaranteed-return language.** A 2x target is an objective,
    never a promise. The model must be allowed to reject every trade.
6.  **Risk controls take precedence over signal scores.** A high score
    must never override a risk lock, stale feed, invalid contract,
    market halt or broker safety condition.
7.  **Use actual option prices for option backtests.** Do not backtest
    option returns using index candles or delta-only approximations as
    if they were actual fills.
8.  **Model realistic execution costs.** Include bid/ask spread,
    slippage, brokerage, exchange charges, taxes and applicable fees.
    Make cost assumptions configurable and document them.
9.  **Avoid overfitting.** Use chronological train/validation/test
    splits, walk-forward evaluation and untouched out-of-sample periods.
10. **Make every decision explainable.** Persist the features, rule
    outcomes, score components, data timestamps, model version, order
    lifecycle and exit reason for every signal/trade.
11. **Use safe defaults.** The initial mode must be `BACKTEST` or
    `PAPER`; live order placement must be disabled until explicitly
    configured and confirmed by an authorized operator.
12. **Never store broker secrets in source code.** Use environment
    variables or a secrets manager. Redact credentials from logs.
13. **Fail safely.** If market data or broker state is uncertain, do not
    open a new position. Reconcile actual broker positions before
    retrying orders.
14. **Do not bypass broker, exchange, regulatory or data-provider
    terms.** Use supported APIs and permitted market-data sources.

## Required working method

Before implementation: - Inspect the existing repository and report its
current structure and technology choices. - Identify missing information
and external dependencies. - Produce an implementation plan and a
requirements traceability matrix. - Propose interfaces for market data,
broker execution and option-chain providers. - Record all assumptions in
`docs/ASSUMPTIONS.md`. - Do not invent endpoints, authentication flows,
fields, rate limits or broker capabilities.

Then implement in small, testable milestones. At the end of each
milestone: - Run automated tests. - Report completed requirements and
remaining gaps. - Provide commands to run the module. - Update
documentation and the traceability matrix.

If a requirement cannot be implemented with available data or APIs,
explain the limitation and provide a clearly labelled alternative. Do
not simulate a capability and present it as real.

------------------------------------------------------------------------

# 1. Product Vision and Goals

NIFTY Sniper AI is an explainable, rules-first intraday options-buying
engine. It monitors NIFTY spot/futures and the option chain, identifies
liquidity events and directional market structure, checks momentum and
derivatives context, selects a suitable CE or PE contract, estimates the
feasibility of a 2x premium target, and manages the position under
strict risk limits.

The system should prefer **few high-quality trades over frequent
low-quality trades**. It must be comfortable returning `NO_TRADE`.

## 1.1 Business objectives

-   Identify bullish setups suitable for buying NIFTY CE options.
-   Identify bearish setups suitable for buying NIFTY PE options.
-   Detect liquidity sweeps and distinguish reversals from genuine
    breakouts.
-   Confirm directional movement through market structure and
    displacement.
-   Use OI and option-chain information as supporting evidence, not as
    standalone signals.
-   Estimate whether the selected option has a plausible path to 1.5x
    and 2.0x.
-   Select liquid option contracts with acceptable spread and Greeks.
-   Support manual approval, paper trading and controlled automatic
    execution.
-   Protect capital through position sizing, daily loss limits and
    emergency controls.
-   Provide historical backtesting, audit logs and performance
    analytics.

## 1.2 Non-goals for initial release

-   No promise of a fixed win rate or guaranteed 2x return.
-   No averaging down or martingale.
-   No naked option selling.
-   No multi-leg spreads in version 1.
-   No simultaneous multi-instrument trading in version 1.
-   No autonomous strategy self-modification in production.
-   No use of unverified social-media/news sentiment as a trade trigger.
-   No live deployment before historical and paper-trading acceptance
    gates pass.

------------------------------------------------------------------------

# 2. Scope and Release Plan

## Version 1 --- NIFTY only

Included: - NIFTY spot and, where available, futures data. - NIFTY CE/PE
option contracts. - 15-minute context, 5-minute setup, 1-minute
execution monitoring. - Liquidity, SMC and market-structure features. -
OI and option-chain analytics. - Sniper score and trade rejection
logic. - Option selection and 2x feasibility model. - Backtesting and
paper trading. - Risk engine and broker adapter. - React dashboard and
trade journal.

## Future versions

-   BANK NIFTY and SENSEX.
-   Additional brokers.
-   Advanced ML models.
-   News/event risk filters.
-   Multi-strategy portfolio allocation.
-   Advanced order-flow features, only if reliable data is available.

## Release gates

  -----------------------------------------------------------------------
  Gate                    Required evidence       Permission
  ----------------------- ----------------------- -----------------------
  G0: Data readiness      Validated schemas,      Research only
                          timestamps, gaps and    
                          data lineage            

  G1: Strategy            Unit tests and          Backtest
  implementation          deterministic signal    
                          tests                   

  G2: Historical          Chronological           Paper trading
  validation              out-of-sample results   
                          with costs              

  G3: Paper validation    Stable order simulation Broker sandbox /
                          and risk controls       controlled testing

  G4: Live readiness      Reconciliation, kill    Limited live trading
                          switch, operational     
                          checklist and explicit  
                          approval                
  -----------------------------------------------------------------------

------------------------------------------------------------------------

# 3. Users and Operating Modes

## 3.1 User roles

-   **Administrator:** Configures data providers, broker connection,
    risk limits and system settings.
-   **Trader:** Monitors signals, approves or rejects manual-entry
    suggestions, reviews positions and analytics.
-   **Researcher:** Runs backtests, compares strategy versions and
    reviews model performance.

## 3.2 Operating modes

Implement an explicit mode setting:

-   `BACKTEST`: historical simulation only; no broker orders.
-   `PAPER`: simulated orders using live or replayed market data; no
    real orders.
-   `MANUAL`: generate signals and proposed orders; user confirms each
    trade.
-   `LIVE`: real broker orders, disabled by default and protected by
    explicit configuration.

The UI must always display the current mode prominently. Mode changes
must be audited. A restart must not silently enable LIVE mode.

------------------------------------------------------------------------

# 4. System Architecture

Use modular architecture with clear interfaces. The suggested stack is:

  Layer                     Suggested technology
  ------------------------- --------------------------------------------------------
  Core engine               Python
  API                       FastAPI
  Data processing           Pandas, NumPy
  Indicators                Custom tested calculations; TA-Lib optional
  Database                  PostgreSQL
  Cache / transient state   Redis, optional
  Frontend                  React
  Charts                    TradingView Lightweight Charts or equivalent
  Background jobs           Celery / APScheduler, as appropriate
  ML                        Scikit-learn / XGBoost, only after baseline validation
  Deployment                AWS or another documented environment
  Testing                   Pytest, integration tests, replay tests

## 4.1 Logical architecture

``` text
Market Data Providers
   |-- NIFTY spot / futures OHLC and ticks
   |-- Option chain / contract master
   |-- Option OHLC / bid / ask / volume / OI
   v
Data Adapters -> Validation -> Timestamp Normalization
   v
Market Data Store + Live Event Stream
   v
Feature Engine
   |-- Multi-timeframe candles and indicators
   |-- Liquidity / swing structure
   |-- SMC events (BOS, MSS, FVG, order blocks)
   |-- OI and derivatives features
   |-- Volatility and market regime
   v
Signal Engine
   |-- Reversal setup
   |-- Breakout expansion setup
   |-- Trend continuation setup
   |-- Directional score and hard filters
   v
Option Selector
   v
2x Feasibility / Probability Model
   v
Risk Manager -> Trade Decision
   |-- REJECT
   |-- WATCH
   |-- ALERT
   |-- PAPER ORDER
   |-- MANUAL APPROVAL
   |-- LIVE ORDER (only in LIVE mode)
   v
Execution Adapter -> Position Monitor -> Exit Manager
   v
Audit Log / Trade Journal / Analytics / Alerts
```

## 4.2 Required module boundaries

Create independent modules with documented interfaces:

-   `data/`: provider adapters, schemas, validation, candle builder.
-   `features/`: indicators, market regime, volatility, OI features.
-   `smc/`: swing detection, liquidity, BOS/MSS, FVG, order blocks.
-   `strategy/`: setup detectors, scoring, signal lifecycle.
-   `options/`: contract selection, Greeks, premium modelling.
-   `prediction/`: 1.5x/2x probability estimation and calibration.
-   `risk/`: sizing, limits, pre-trade and post-trade checks.
-   `execution/`: broker interface, order state machine, reconciliation.
-   `backtest/`: event-driven replay, fills, costs and reports.
-   `api/`: REST/WebSocket endpoints.
-   `frontend/`: dashboard and charts.
-   `persistence/`: repositories, migrations and audit records.
-   `monitoring/`: health checks, alerts and structured logs.
-   `tests/`: unit, integration, replay, regression and safety tests.

Do not put all trading logic in one large Python file. Keep strategy
calculations independent from broker execution.

------------------------------------------------------------------------

# 5. Market Data Requirements

## 5.1 Required data

### Underlying data

-   Instrument identifier and exchange.
-   Exchange timestamp.
-   Open, high, low, close.
-   Volume.
-   Last traded price, if tick feed is available.
-   Bid/ask, if available.
-   Futures price and volume, if provider supplies them.

### Option data

-   Contract identifier.
-   Underlying.
-   Expiry.
-   Strike.
-   CE/PE type.
-   Exchange timestamp.
-   Last traded price.
-   OHLC.
-   Volume.
-   Open interest.
-   Change in OI.
-   Bid and ask prices and quantities, if available.
-   IV and Greeks, if provided or safely calculable from valid inputs.

### Reference data

-   Contract master and lot size.
-   Tick size.
-   Expiry calendar.
-   Trading sessions and holidays.
-   Instrument status.

## 5.2 Data quality rules

-   Store timestamps in UTC and retain exchange-local time
    (`Asia/Kolkata`) for display and session logic.
-   Reject or quarantine malformed records.
-   Detect duplicate, out-of-order and stale events.
-   Track missing intervals and feed disconnects.
-   Do not forward-fill option prices across material gaps for
    executable backtests.
-   Do not assume OI or Greeks update at the same frequency as price.
-   Store source and received timestamps separately.
-   Every feature must retain the latest source timestamp used to
    calculate it.
-   If mandatory data is stale or missing, set signal status to
    `DATA_INVALID` and block new entries.

## 5.3 Candle construction

Build 1-minute, 5-minute and 15-minute candles from timestamped source
data using exchange session boundaries. Document whether candle
intervals are left-closed/right-open or another convention. A completed
candle must only become available after its end time.

Do not use a partially formed 5-minute or 15-minute candle as a
completed confirmation. If intrabar monitoring is used, label it
separately and define its rules.

------------------------------------------------------------------------

# 6. Strategy Specification

The strategy has three setup families. They share the same risk, option
selection and execution modules.

1.  Liquidity Reversal.
2.  Breakout Expansion.
3.  Trend Continuation.

Each setup must have its own identifier, score breakdown and performance
reporting.

## 6.1 Timeframe responsibilities

  -----------------------------------------------------------------------
  Timeframe                           Purpose
  ----------------------------------- -----------------------------------
  15-minute                           Market regime, broader trend and
                                      major levels

  5-minute                            Setup formation, liquidity event,
                                      structure shift and displacement

  1-minute                            Entry trigger, spread check and
                                      execution timing
  -----------------------------------------------------------------------

Use completed candles for confirmed structure. The 1-minute timeframe
may monitor a retest or entry trigger, but it must not contradict the
higher-timeframe invalidation rules.

## 6.2 Important reference levels

Calculate and store: - Previous day high (PDH). - Previous day low
(PDL). - Previous day close (PDC). - Current session high and low. -
Confirmed intraday swing highs and lows. - Equal highs and equal lows. -
Opening range levels, if configured. - VWAP. - Major OI concentration
strikes, if data quality permits.

Each level must include source timeframe, creation timestamp, validity
status and invalidation rules.

## 6.3 Swing high / swing low

Implement a configurable pivot/fractal method.

A swing high is a high greater than the highs of a configured number of
candles to its left and right. A swing low is the inverse.

Important: - A pivot is not confirmed until the required right-side
candles have closed. - Its confirmation timestamp is later than its
pivot candle timestamp. - Never use a pivot before it was confirmed. -
Keep pivot parameters configurable and test sensitivity.

## 6.4 Liquidity sweep detection

### Bullish sweep candidate

1.  Identify a previously confirmed low or liquidity level.
2.  Price trades below that level by a configurable buffer.
3.  Price closes back above the level within a configured number of
    candles.
4.  Record sweep depth, reclaim distance, duration and volume.
5.  Wait for bullish displacement and confirmed bullish MSS/BOS before
    treating it as an actionable reversal setup.

### Bearish sweep candidate

1.  Identify a previously confirmed high or liquidity level.
2.  Price trades above that level by a configurable buffer.
3.  Price closes back below the level within a configured number of
    candles.
4.  Record sweep depth, reclaim distance, duration and volume.
5.  Wait for bearish displacement and confirmed bearish MSS/BOS before
    treating it as an actionable reversal setup.

A wick beyond a level alone is not sufficient. A sweep candidate without
structure confirmation remains `WATCH`, not `ENTRY`.

### Sweep configuration

Expose: - `sweep_buffer_points` or volatility-normalized buffer. -
`reclaim_window_bars`. - `minimum_reclaim_close`. -
`minimum_sweep_depth`. - `level_age_limit`. -
`volume_confirmation_threshold`.

Avoid hardcoding values before backtesting. Defaults must be documented
and versioned.

## 6.5 Market structure shift (MSS), BOS and CHOCH

Define objective rules using confirmed swing points.

-   Bullish MSS: after bearish or neutral structure, price closes above
    the relevant confirmed lower high / protected swing level.
-   Bearish MSS: after bullish or neutral structure, price closes below
    the relevant confirmed higher low / protected swing level.
-   BOS: close beyond a relevant structure level in the direction of the
    current trend.
-   CHOCH: initial break against the established structure; treat as an
    early warning unless confirmed by the strategy's MSS rules.

The implementation must specify which swing is the protected level and
how it is selected. Avoid discretionary labels.

## 6.6 Displacement candle

Calculate: - Candle body size. - Total range. - Body-to-range ratio. -
Close location within range. - Range relative to ATR. - Volume relative
to rolling baseline.

A bullish displacement candidate should have a large bullish body, close
near its high and range/body strength above configurable thresholds. A
bearish candidate is the inverse.

Do not use one fixed point threshold across all volatility regimes. Use
ATR-normalized thresholds and validate them historically.

## 6.7 Fair Value Gap (FVG)

Using three completed candles:

-   Bullish FVG when the first candle's high is below the third candle's
    low.
-   Bearish FVG when the first candle's low is above the third candle's
    high.

Persist upper/lower boundaries, direction, formation time, timeframe,
gap size, mitigation status and invalidation status.

FVG must be associated with a meaningful displacement event to receive
full score. Define mitigation consistently (for example, first touch,
midpoint fill or full fill) and make the chosen convention configurable.

## 6.8 Order block

Candidate bullish order block: the last bearish candle before a
qualifying bullish displacement that breaks structure.

Candidate bearish order block: the last bullish candle before a
qualifying bearish displacement that breaks structure.

Persist zone boundaries, source candle, formation time, direction,
displacement link, mitigation and invalidation status. Do not describe
an algorithmic order block as verified institutional activity.

------------------------------------------------------------------------

# 7. OI and Derivatives Analysis

## 7.1 Price/OI interpretation

Use the following conventional interpretations as contextual features:

  Underlying/futures price   OI change   Interpretation
  -------------------------- ----------- --------------------------
  Rising                     Rising      Potential long buildup
  Falling                    Rising      Potential short buildup
  Rising                     Falling     Potential short covering
  Falling                    Falling     Potential long unwinding

These are probabilistic interpretations, not proof of buyer/seller
intent.

## 7.2 Required OI features

-   Strike-wise Call OI and Put OI.
-   Change in Call OI and Put OI.
-   OI concentration and concentration changes.
-   PCR, with clearly defined calculation (OI PCR or volume PCR).
-   Put writing / Call writing candidates.
-   Put unwinding / Call unwinding candidates.
-   Futures price and OI interpretation, where reliable.
-   OI change over configurable intervals.
-   Distance of relevant strikes from spot.
-   Data timestamp and freshness.

Do not label an increase in option OI as call writing or put writing
without considering price/premium behavior and other evidence. If only
snapshots are available, label the interpretation as tentative.

## 7.3 OI scoring

OI contributes supporting evidence to the directional score. It must not
independently trigger an entry. If OI is unavailable or stale, the
system must either: - reduce the score / mark the feature unavailable,
or - reject the setup if the selected strategy configuration requires
OI.

Never treat missing OI as a bullish or bearish value.

------------------------------------------------------------------------

# 8. Momentum and Market Regime

Calculate: - VWAP. - EMA 9. - EMA 20. - ATR. - Relative volume. - Candle
body/range ratio. - Trend slope or another documented trend-strength
feature. - Volatility regime.

Possible market regimes: - `TREND_UP` - `TREND_DOWN` - `RANGE` -
`HIGH_VOLATILITY` - `LOW_VOLATILITY` - `UNCLASSIFIED`

Use explicit, testable regime rules. In a range, prioritize confirmed
sweep reversals or reject low-quality setups. In strong trends, allow
continuation setups. Avoid trading during abnormal or unreliable data
conditions.

VWAP and EMA alignment are supporting confirmations, not mandatory
universal rules if backtesting shows they exclude valid reversal
entries. Each setup family must define its own conditions.

------------------------------------------------------------------------

# 9. Setup Definitions and Signal Lifecycle

## 9.1 Setup A --- Liquidity Reversal

### Bullish CALL candidate

1.  Price sweeps a confirmed liquidity low.
2.  Price reclaims the swept level.
3.  Bullish displacement appears.
4.  Bullish MSS is confirmed.
5.  A valid bullish FVG or order-block retest may provide entry
    location.
6.  OI and momentum are supportive or not materially contradictory.
7.  The option and 2x feasibility checks pass.

### Bearish PUT candidate

Apply the inverse conditions around a confirmed liquidity high.

## 9.2 Setup B --- Breakout Expansion

Bullish: 1. Price consolidates below a defined resistance / range
boundary. 2. Completed candle closes beyond the boundary with
displacement. 3. Relative volume confirms expansion. 4. Price
holds/retests the broken level or a defined continuation trigger occurs.
5. Higher timeframe is not materially contradictory. 6. Option and risk
filters pass.

Bearish: inverse conditions.

A breakout must not be misclassified as a liquidity sweep reversal. The
engine must record the setup family and evidence.

## 9.3 Setup C --- Trend Continuation

Bullish: 1. 15-minute regime is bullish. 2. 5-minute structure remains
bullish. 3. Price pulls back to a valid FVG, order block, VWAP or
configured dynamic support. 4. Pullback does not invalidate the
protected higher low. 5. Bullish continuation trigger appears on
1-minute or completed 5-minute data. 6. Option and risk filters pass.

Bearish: inverse conditions.

## 9.4 Signal lifecycle

Use explicit states:

`DETECTED -> WATCH -> CONFIRMED -> ELIGIBLE -> ORDER_PENDING -> OPEN -> EXIT_PENDING -> CLOSED`

Other terminal or exception states: - `REJECTED` - `EXPIRED` -
`INVALIDATED` - `CANCELLED` - `DATA_INVALID` - `EXECUTION_ERROR`

Every transition must have a timestamp and reason. A signal may not jump
directly to `OPEN` without an acknowledged fill.

------------------------------------------------------------------------

# 10. Sniper Scoring Engine

Initial score weights:

  Component                           Weight
  -------------------------------- ---------
  Liquidity event quality                 20
  MSS / BOS confirmation                  15
  Displacement and FVG                    15
  OI / derivatives context                15
  VWAP / EMA context                      10
  Volume confirmation                     10
  Option Greeks / IV suitability           5
  2x feasibility                          10
  **Total**                          **100**

## 10.1 Score bands

  Score     Classification     Default action
  --------- ------------------ -----------------------------
  0--64     Weak               Reject
  65--74    Watchlist          Monitor
  75--84    Strong             Alert / paper evaluation
  85--100   Sniper candidate   Eligible for further checks

A score of 85 is not an automatic order instruction. All hard filters
must pass.

## 10.2 Scoring requirements

-   Each component must return `score`, `max_score`, `status`, `reason`,
    `source_timestamp` and feature values.
-   Normalize the final score to 0--100.
-   Missing features must not be silently assigned a favorable score.
-   Avoid double-counting highly correlated features.
-   Store the scoring configuration version with each signal.
-   Make weights configurable and version controlled.
-   Report score performance by setup family and market regime.

## 10.3 Mandatory hard filters

Reject a trade if any applicable condition is true: - Data feed stale or
invalid. - Contract master unavailable or contract expired. - Bid/ask
spread above configured limit. - Insufficient liquidity. - Expected loss
exceeds permitted risk. - Daily loss lock active. - Consecutive-loss
lock active. - Position limit reached. - Existing order/position
conflicts with proposed order. - Signal expired or invalidated. - Market
closed, halted or in an unsupported state. - Broker state cannot be
reconciled. - 2x feasibility below configured minimum. - Manual/live
mode permissions not satisfied.

------------------------------------------------------------------------

# 11. Option Contract Selection

Select the CE for bullish signals and PE for bearish signals.

## 11.1 Candidate filters

Initial research ranges, to be validated: - Delta: approximately
0.45--0.65. - Acceptable bid/ask spread. - Adequate traded volume and
open interest. - Valid contract and expiry. - Sufficient time remaining
for the intended holding period. - Premium within configured capital
constraints. - No abnormal or missing quote.

These are configurable starting assumptions, not universal rules. The
engine must compare candidate contracts rather than select only by
nearest strike.

## 11.2 Greeks and volatility

Use provider Greeks only if source, timestamp and calculation
conventions are known. Otherwise calculate Greeks using a documented
model and validated inputs, including underlying price, strike, time to
expiry, risk-free rate and implied volatility.

Persist: - Delta. - Gamma. - Theta. - Vega. - IV. - Time to expiry. -
Model/source and timestamp.

Account for the fact that Greeks change as spot, time and IV change.

## 11.3 Contract ranking

Rank valid contracts using a configurable score based on: - Expected
premium response. - Delta suitability. - Gamma potential. - Theta
cost. - IV level and IV change. - Spread. - Volume and OI. - Estimated
slippage. - 2x feasibility.

Return the top candidate plus rejected candidates and reasons. Do not
choose a contract if none passes.

------------------------------------------------------------------------

# 12. 2x Premium Feasibility and Probability Model

This is a core differentiator and must be implemented carefully.

## 12.1 Definitions

For an actual filled entry premium `P0`: - 1.5x target = `1.5 * P0`. -
2.0x target = `2.0 * P0`. - A 25% stop example = `0.75 * P0`.

The target and stop must be calculated from the actual average fill
price, not the requested limit price.

## 12.2 Underlying movement approximation

A first-pass approximation may use:

`Estimated option price change ≈ Delta * underlying price change`

This is only a rough sensitivity estimate. It ignores changing delta,
gamma, theta, IV, skew and execution spread. It must not be used as the
final 2x decision.

## 12.3 Required premium model

Build a documented model that estimates option premium under plausible
future scenarios. At minimum consider: - Current premium and quote
quality. - Underlying price scenarios. - Delta and gamma. - Time
decay. - IV changes. - Time to expiry. - Bid/ask spread and slippage. -
Time horizon to target.

A pricing model may be used for scenario estimates, but empirical
historical option responses should be used to validate and calibrate it.
Do not imply theoretical option prices are executable market prices.

## 12.4 Probability prediction

Estimate: - `P(reach_1_5x_before_stop)` - `P(reach_2x_before_stop)` -
Expected time to 1.5x and 2x, where estimable. - Probability of stop
occurring first. - Expected net return after costs. - Prediction
uncertainty / calibration quality.

Train only on historical samples constructed without look-ahead. Use
chronological splits and walk-forward testing. Avoid leakage from future
high/low values, revised pivots, future option-chain snapshots or labels
that overlap the prediction timestamp.

The model must be calibrated (for example, reliability curve, Brier
score and calibration error) and evaluated on untouched data. If there
is insufficient data or poor calibration, mark probability as
`UNAVAILABLE` and do not pretend a heuristic score is a probability.

## 12.5 Feasibility gate

The system must reject a trade when: - Estimated target probability is
below configured threshold. - Expected move is insufficient after
costs. - Time to target is inconsistent with the intended holding
period. - IV or spread makes the trade unattractive. - Model confidence
is too low or the model is out of distribution.

Thresholds must be chosen from out-of-sample research, not invented as
proven values.

------------------------------------------------------------------------

# 13. Risk Management and Position Sizing

Risk controls are mandatory and independent of the signal engine.

## 13.1 Initial configurable risk profile

Example research configuration for ₹1,00,000 capital:

  Parameter                     Initial value
  ------------------------- -----------------
  Capital reference                 ₹1,00,000
  Risk budget per trade           1% (₹1,000)
  Daily loss lock                 2% (₹2,000)
  Maximum open positions                    1
  Maximum entries per day                   3
  Consecutive loss lock                     2
  Example premium stop        25% below entry
  Example premium target             2x entry

These are initial settings for simulation, not a recommendation to risk
these amounts in live markets. The operator must be able to lower them.

## 13.2 Position sizing

Calculate quantity from: - Available capital. - Permitted rupee risk. -
Entry price. - Stop price. - Lot size. - Estimated charges and
slippage. - Broker margin / funds requirements.

For long options, approximate planned premium risk:

`Risk per lot = (Entry premium - Stop premium) * Lot size + estimated costs`

`Lots = floor(per_trade_risk_budget / risk_per_lot)`

Then apply affordability and broker constraints. If the result is zero
lots, reject the trade. Never round quantity upward beyond the risk
budget.

## 13.3 Daily controls

-   Stop opening new positions after daily realized + unrealized loss
    reaches the configured loss limit.
-   Apply a configurable cooldown after consecutive losses.
-   Do not increase size to recover losses.
-   Do not average down.
-   Prevent overlapping duplicate orders.
-   Provide an operator kill switch.
-   Provide a maximum daily order count.
-   Define end-of-session exit policy; no overnight carry in version 1
    unless separately approved and specified.

## 13.4 Stop and target execution

A stop trigger is not a guarantee of fill price. Gap risk, liquidity and
exchange conditions can produce worse execution.

The execution module must: - Track actual average fill price. - Place or
monitor protective exits using broker-supported order types. - Verify
stop/target order status. - Handle partial fills. - Reconcile open
quantity. - Prevent both stop and target from independently closing more
quantity than is open. - Use a defined emergency exit procedure if
protective order placement fails.

Trailing-stop example is configurable: - Before 1.25x: initial stop. -
At 1.25x: consider moving stop toward breakeven after costs. - At 1.5x:
lock a configurable portion of profit. - At 1.75x: tighten trail. - At
2.0x: close remaining quantity.

Do not assume these stages are optimal. Compare fixed target, trailing
stop and partial-exit policies in backtests.

------------------------------------------------------------------------

# 14. Execution Engine and Broker Integration

## 14.1 Broker adapter interface

Define a broker-independent interface with methods conceptually
equivalent to: - authenticate / check session - get account funds - get
positions - get orders - submit order - modify order - cancel order -
subscribe to order updates - reconcile positions

Implement a specific broker adapter only after reviewing its current
official API documentation. Do not invent endpoints or claim unsupported
order types.

## 14.2 Order state machine

`CREATED -> SUBMITTED -> ACKNOWLEDGED -> PARTIALLY_FILLED -> FILLED`

Other states: `REJECTED`, `CANCEL_PENDING`, `CANCELLED`, `EXPIRED`,
`UNKNOWN`.

-   Every order needs a unique internal idempotency key.
-   A timeout must not cause blind resubmission.
-   Query broker order status before retrying.
-   Persist broker order ID and all status changes.
-   Reconcile internal position with broker position after every
    material order event.

## 14.3 Entry sequence

1.  Receive eligible signal.
2.  Recheck signal freshness and invalidation.
3.  Recheck market-data health.
4.  Select contract and validate quote.
5.  Run risk pre-trade checks.
6.  Check available funds and quantity.
7.  Confirm operating mode.
8.  In MANUAL mode, request user approval.
9.  In PAPER mode, create simulated order.
10. In LIVE mode, submit supported order.
11. Confirm actual fill.
12. Calculate stop/target from actual average fill.
13. Activate exit management.
14. Persist complete audit trail.

## 14.4 Failure handling

If broker state is unknown: - Block new entries. - Reconnect and query
orders/positions. - Reconcile before any retry. - Alert the operator.

If stop protection cannot be established: - Trigger configured emergency
handling. - Alert immediately. - Do not continue normal entry
processing.

------------------------------------------------------------------------

# 15. Backtesting Requirements

## 15.1 Data requirements

Prefer at least 1--2 years of quality historical data, subject to
availability: - NIFTY spot and/or futures intraday data. - Historical
option contract master. - Actual option OHLC or tick/quote data. -
Historical bid/ask where available. - Strike-wise OI and change in OI
snapshots. - IV and Greeks, if available. - Expiry and holiday
calendar. - Transaction cost assumptions.

If historical OI or quote data is unavailable, run clearly labelled
reduced-feature experiments. Do not claim the full OI strategy was
tested.

## 15.2 Backtest engine

Use event-driven chronological replay. At each timestamp: 1. Make only
then-available data visible. 2. Update completed candles and features.
3. Evaluate setup state. 4. Evaluate hard filters and score. 5. Select
an option using then-available chain data. 6. Simulate order submission
and fill using realistic quote assumptions. 7. Monitor stop/target using
data available after entry. 8. Apply costs and exit logic. 9. Record all
intermediate decisions.

Do not fill an order at a candle's close if the signal was only known
after that close unless the simulation models a subsequent executable
quote.

If both stop and target are touched in one OHLC bar and tick data is
unavailable, use a conservative assumption or mark the trade ambiguous.
Do not always assume the favorable level occurred first.

## 15.3 Validation methodology

-   Split chronologically into train, validation and test periods.
-   Use walk-forward testing.
-   Keep a final untouched holdout period.
-   Avoid random row splitting for time-series trading labels.
-   Include expiry days, high-volatility sessions and range-bound
    sessions.
-   Include brokerage, taxes, fees, spread and slippage.
-   Report performance by setup type, regime, time of day, expiry
    proximity and contract selection.
-   Perform parameter sensitivity analysis.
-   Compare against simple baselines.

## 15.4 Required metrics

-   Number of trades.
-   Win rate.
-   1.5x target hit rate.
-   2x target hit rate.
-   Stop-loss hit rate.
-   Average and median net return.
-   Average winner and loser.
-   Profit factor.
-   Expectancy per trade.
-   Maximum drawdown.
-   Consecutive losses.
-   Holding time.
-   Slippage and cost contribution.
-   MAE / MFE.
-   Performance by setup and market regime.
-   Calibration metrics for probability predictions.

## 15.5 Initial acceptance targets

These are proposed gates to evaluate, not promised performance: - At
least 300 trades across the research sample, if the strategy generates
enough valid opportunities. - At least three months of untouched
out-of-sample testing, preferably longer. - Positive net expectancy
after realistic costs. - Profit factor above 1.5 as an initial research
target. - Drawdown within an explicitly approved risk budget. - Stable
performance across multiple market regimes. - No critical order-state or
risk-control defects. - 2x target achievement rate reported honestly,
including the number of opportunities and average time to target.

Do not force the strategy to meet a trade-count target by weakening
filters. If there are too few trades, report insufficient evidence.

------------------------------------------------------------------------

# 16. Dashboard Requirements

## 16.1 Live overview

Display: - Operating mode. - Market session status. - NIFTY price and
change. - 15-minute market regime. - VWAP and EMA status. - Major
liquidity levels. - OI summary and data timestamp. - Feed health. - Open
positions and daily risk status.

## 16.2 Sniper signal panel

For each candidate: - Signal ID and setup family. - Direction: CALL /
PUT. - Signal lifecycle state. - Sniper score and component breakdown. -
Liquidity level and sweep evidence. - MSS/BOS evidence. - FVG / order
block details. - OI context. - Expected underlying move. - Candidate
contract. - Entry reference price and quote timestamp. - 1.5x / 2x
targets. - Estimated probabilities or `UNAVAILABLE`. - Stop reference. -
Rejection reasons.

## 16.3 Chart

Show: - 15-minute, 5-minute and 1-minute charts. - PDH, PDL, PDC and
session high/low. - Confirmed swing points. - Liquidity zones. - Sweep
markers. - BOS/MSS. - FVG zones. - Order-block zones. - VWAP and EMA. -
Proposed entry, actual fill, stop and target. - Trade exit marker.

Chart overlays must reflect only information known at the displayed
time. Clearly distinguish confirmed and developing structures.

## 16.4 Open trade panel

Display: - Instrument and contract. - Quantity and lot size. - Actual
average fill. - Current bid/ask and LTP. - Current P&L after estimated
costs. - Stop and target. - Broker order status. - Time in trade. - Exit
reason when closed.

## 16.5 Analytics

Display: - Daily / weekly / monthly P&L. - Win rate and expectancy. -
Profit factor and drawdown. - 1.5x / 2x achievement. - Performance by
setup family. - Performance by score band. - Performance by market
regime. - Costs and slippage. - Rejected-signal analysis. - Model
calibration and drift.

------------------------------------------------------------------------

# 17. Database Design

Create normalized PostgreSQL tables (or documented equivalent).
Suggested entities:

  Table                 Purpose
  --------------------- ------------------------------------------
  `instruments`         Instrument and contract master
  `market_candles`      OHLCV by timeframe
  `market_ticks`        Optional tick data
  `option_snapshots`    Option chain snapshots
  `option_quotes`       Bid/ask and option price data
  `feature_snapshots`   Calculated indicators and feature values
  `market_levels`       PDH/PDL, pivots and liquidity levels
  `smc_events`          Sweep, BOS, MSS, FVG and OB events
  `signals`             Signal lifecycle and direction
  `signal_scores`       Component score and explanation
  `model_predictions`   1.5x/2x predictions and model version
  `orders`              Internal and broker order lifecycle
  `fills`               Actual or simulated fills
  `positions`           Position state
  `trades`              Completed trade summary
  `risk_events`         Risk checks and lockouts
  `strategy_configs`    Versioned strategy parameters
  `audit_logs`          Immutable decision/action history
  `backtest_runs`       Backtest configuration and results

Use database migrations. Store monetary values and quantities with
appropriate decimal precision. Store timestamps consistently. Add
indexes for instrument, exchange timestamp, signal ID, order ID and
trade ID.

------------------------------------------------------------------------

# 18. API and Event Contracts

Design and document APIs before frontend integration. Suggested
endpoints:

-   `GET /api/health`
-   `GET /api/market/summary`
-   `GET /api/market/candles`
-   `GET /api/options/chain`
-   `GET /api/signals`
-   `GET /api/signals/{signal_id}`
-   `GET /api/positions`
-   `GET /api/orders`
-   `GET /api/trades`
-   `GET /api/analytics/summary`
-   `GET /api/analytics/by-setup`
-   `GET /api/config`
-   `PUT /api/config` (authorized and audited)
-   `POST /api/paper/start`
-   `POST /api/paper/stop`
-   `POST /api/trading/kill-switch`

Any live order endpoint must require authorization, explicit LIVE mode
and all risk checks. Never expose broker secrets to the browser.

Use WebSocket events for market summaries, signal updates, order status
and position updates. Define schemas and version them.

------------------------------------------------------------------------

# 19. Alerts and Monitoring

Support configurable alerts for: - New sniper candidate. - Signal
confirmed or invalidated. - Trade entered. - Stop loss or target
reached. - Order rejected or partially filled. - Broker disconnected. -
Market-data feed stale. - Daily loss lock activated. - Emergency
square-off. - Service failure.

Monitor: - Feed latency and gap rate. - Signal processing latency. -
Order acknowledgement and fill latency. - Broker reconciliation
differences. - Service health. - Database failures. - Prediction drift
and calibration. - Unexpected order counts.

All alerts must include timestamps and signal/order references, without
exposing secrets.

------------------------------------------------------------------------

# 20. Non-Functional Requirements

-   Reliability: recover safely after process restart.
-   Auditability: every signal, score, order and exit has a traceable
    record.
-   Security: secrets outside source code; least-privilege access.
-   Performance: configurable latency objectives measured under load; do
    not claim untested latency.
-   Maintainability: typed interfaces, modular code, linting and
    documentation.
-   Testability: deterministic replay and injectable data/broker
    adapters.
-   Observability: structured logs, metrics and health checks.
-   Data integrity: idempotent processing and database constraints.
-   Safety: default to no new trade when system state is uncertain.

------------------------------------------------------------------------

# 21. Testing and Acceptance Criteria

## 21.1 Unit tests

Test: - Candle aggregation boundaries. - Swing confirmation timing. -
Liquidity sweep rules. - MSS/BOS selection. - FVG calculations. -
Order-block creation/invalidation. - OI interpretation. - Score
normalization. - Option selection. - Greeks and premium scenario
calculations. - Position sizing. - Stop/target calculations. - Daily
loss and consecutive-loss locks. - Signal expiry and invalidation.

## 21.2 Integration tests

Test: - Data provider adapter and schema validation. - Data disconnect
and recovery. - Feature-to-signal pipeline. - Signal-to-option-selection
pipeline. - Risk engine to execution adapter. - Broker order updates and
reconciliation. - Database persistence. - Frontend live updates.

## 21.3 Replay and regression tests

Create fixed historical test cases with expected: - Market levels. -
Confirmed pivots. - Liquidity events. - MSS/BOS. - Signal state
transitions. - Score components. - Contract selection. - Entry/exit
decision.

A code change must not silently alter historical signals. Any intended
change requires a strategy version change and comparison report.

## 21.4 Safety acceptance tests

-   Stale feed blocks new entries.
-   Broker unknown state blocks new entries.
-   Daily loss limit blocks new entries.
-   Duplicate signal does not create duplicate order.
-   Timeout does not cause blind resubmission.
-   Partial fill is managed correctly.
-   Stop/target quantity never exceeds open quantity.
-   Restart reconciles broker positions before trading.
-   Kill switch blocks new entries and invokes the configured
    position-management procedure.
-   LIVE mode is disabled by default.

------------------------------------------------------------------------

# 22. Suggested Repository Structure

``` text
nifty-sniper-ai/
  README.md
  pyproject.toml
  .env.example
  docs/
    REQUIREMENTS.md
    ARCHITECTURE.md
    STRATEGY_RULES.md
    DATA_DICTIONARY.md
    API_SPEC.md
    ASSUMPTIONS.md
    TRACEABILITY_MATRIX.md
    BACKTEST_REPORT_TEMPLATE.md
    OPERATIONS_RUNBOOK.md
  src/
    app/
      config/
      data/
      features/
      smc/
      strategy/
      options/
      prediction/
      risk/
      execution/
      backtest/
      persistence/
      api/
      monitoring/
  frontend/
  migrations/
  scripts/
  tests/
    unit/
    integration/
    replay/
    safety/
    fixtures/
  reports/
```

Adapt this structure if the repository already has a sound architecture.
Do not overwrite existing work without inspecting it.

------------------------------------------------------------------------

# 23. Implementation Milestones

  -----------------------------------------------------------------------
  Milestone               Deliverable             Exit condition
  ----------------------- ----------------------- -----------------------
  M1                      Repository review,      Interfaces and data
                          architecture and        availability documented
                          assumptions             

  M2                      Data adapters and       Historical/live data
                          validation              checks pass

  M3                      Candles, indicators and Deterministic feature
                          market regime           tests pass

  M4                      SMC and liquidity       Replay tests pass
                          engine                  without repainting

  M5                      OI and derivatives      Snapshot interpretation
                          engine                  validated

  M6                      Setup and scoring       Signal traceability and
                          engine                  rejection reasons work

  M7                      Option selector and 2x  Option-level validation
                          model                   and calibration report

  M8                      Event-driven backtester Costs, fills and
                                                  out-of-sample reports
                                                  available

  M9                      Paper execution and     Safety tests pass
                          risk controls           

  M10                     Dashboard and alerts    End-to-end paper
                                                  workflow works

  M11                     Broker integration      Official API reviewed;
                                                  reconciliation tested

  M12                     Controlled production   Explicit approval and
                          readiness review        all release gates
                                                  passed
  -----------------------------------------------------------------------

Do not skip ahead because a module appears visually complete.

------------------------------------------------------------------------

# 24. Configuration Requirements

Keep strategy parameters in versioned configuration, not scattered
constants.

Example configuration shape (illustrative; values must be validated):

``` yaml
app:
  mode: PAPER
  timezone: Asia/Kolkata
  underlying: NIFTY

timeframes:
  context: 15m
  setup: 5m
  execution: 1m

strategy:
  enabled_setups:
    - LIQUIDITY_REVERSAL
    - BREAKOUT_EXPANSION
    - TREND_CONTINUATION
  minimum_sniper_score: 85
  signal_expiry_seconds: 180
  require_completed_setup_candle: true

scoring:
  liquidity: 20
  structure: 15
  displacement_fvg: 15
  oi: 15
  vwap_ema: 10
  volume: 10
  option_suitability: 5
  feasibility: 10

options:
  preferred_delta_min: 0.45
  preferred_delta_max: 0.65
  max_spread_percent: 2.0
  minimum_volume: configurable
  minimum_open_interest: configurable

risk:
  capital_reference: 100000
  risk_per_trade_percent: 1.0
  daily_loss_limit_percent: 2.0
  max_open_positions: 1
  max_entries_per_day: 3
  max_consecutive_losses: 2
  example_stop_percent: 25
  target_multiple: 2.0
  allow_averaging_down: false
  overnight_positions: false

execution:
  live_trading_enabled: false
  require_manual_approval: true
  max_order_retries: 0
  reconcile_before_retry: true
```

The sample spread and delta values are starting research parameters.
Validate them using actual NIFTY option data. Configuration parsing must
validate types, ranges and mutually inconsistent settings. Never allow
configuration to disable mandatory safety controls accidentally.

------------------------------------------------------------------------

# 25. Decisions and Assumptions to Confirm

The AI agent must create `docs/ASSUMPTIONS.md` and identify unresolved
decisions. Do not silently choose a broker or data source.

Initial working assumptions: - NIFTY only in version 1. - Long CE and
long PE only. - Intraday positions; no overnight holding. - 15m context,
5m setup, 1m execution. - Initial target multiple: 2.0x. - Example
initial stop: 25% premium loss. - Score threshold: 85 for sniper
eligibility. - One open position at a time. - Paper trading is the
default. - Broker and market-data APIs are provider adapters.

Questions requiring configuration or owner approval: 1. Which broker
will be integrated first? 2. Which licensed/authorized market-data
provider supplies historical option quotes and OI snapshots? 3. Which
order types are supported by the selected broker? 4. What are the
approved trading hours and entry cutoff? 5. What is the maximum
permitted daily risk? 6. Is manual confirmation required for the first
live release? 7. What probability threshold should the 2x model use
after calibration? 8. What is the end-of-day square-off time and
fallback procedure?

------------------------------------------------------------------------

# 26. Required AI Agent Deliverables

The engineering agent must produce all of the following:

1.  Repository assessment.
2.  Architecture document.
3.  Assumptions and unresolved decisions.
4.  Requirements traceability matrix mapping each requirement to code
    and tests.
5.  Data dictionary and provider capability matrix.
6.  Database schema and migrations.
7.  Deterministic SMC and signal engine.
8.  Configurable scoring engine.
9.  Option contract selector.
10. 2x feasibility model with limitations and calibration evidence.
11. Event-driven historical backtester.
12. Reproducible backtest reports.
13. Paper-trading engine.
14. Broker adapter behind a safe interface.
15. Risk controls and kill switch.
16. React dashboard.
17. Automated test suite.
18. Deployment and operations documentation.
19. Security and recovery checklist.
20. Production readiness report.

## Definition of done

A requirement is not complete merely because code exists. It is complete
only when: - Its behavior is documented. - Its implementation is linked
in the traceability matrix. - Relevant automated tests pass. - Failure
behavior is defined. - Logs/audit records exist where required. - Its
limitations are documented.

------------------------------------------------------------------------

# 27. Final Instruction to the AI Agent

Build NIFTY Sniper AI as a robust, explainable, testable trading
system---not as a collection of indicators or a demo dashboard.

Prioritize correctness of historical event timing, option-level
backtesting, capital protection, execution-state reconciliation and
honest performance reporting.

Start with repository inspection and a written implementation plan. Then
build the data layer and deterministic strategy engine. Validate every
strategy component with historical replay before implementing automated
live execution.

The system's most important decision is sometimes `NO_TRADE`.

Never claim that a 2x move is certain. The system's job is to identify
and measure opportunities, reject poor setups, execute only when all
controls pass, and manage risk when the market behaves unexpectedly.
