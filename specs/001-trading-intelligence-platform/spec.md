# Feature Specification: TradePulse AI Trading Intelligence Platform

**Feature Branch**: `001-trading-intelligence-platform`

**Created**: 2026-09-08

**Status**: Draft

**Input**: Business requirements from `TradePulse_AI_Business_Analysis_and_Product_Specification.docx` and the supplied TradePulse AI desktop dashboard reference image.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Understand the Market Before Acting (Priority: P1)

As a retail trader, I want one desktop workspace that combines live NIFTY, BANK NIFTY,
SENSEX, volatility, price action, technical indicators, options-chain intelligence,
global news context, active signals, exposure, and risk state so that I can understand
why a setup exists before deciding whether to act.

**Why this priority**: Market context and safe visibility are the foundation of every later
workflow and are the product's primary user value.

**Independent Test**: Load the dashboard with a valid market-data feed and confirm that the
user can identify the current market regime, selected index state, active signal rationale,
data freshness, mode, risk status, and broker/session health without opening another screen.

**Acceptance Scenarios**:

1. **Given** live data is available, **When** the user opens the dashboard, **Then** the
   workspace shows current index prices and changes, trend regime, volatility where available,
   key levels, active signals, open positions, P&L, and visible data freshness.
2. **Given** a signal is displayed, **When** the user opens its explanation, **Then** the system
   shows the contributing price, technical, options, volume, volatility, liquidity, and news
   context plus the applicable strategy and risk state.
3. **Given** market data is stale, missing, crossed, or invalid, **When** the dashboard refreshes,
   **Then** the affected data is marked unsafe and new live entries are blocked.

### User Story 2 - Evaluate and Manage a Qualified Signal (Priority: P1)

As a trader, I want qualified signals to include entry range, stop loss, targets, quantity,
minimum risk/reward, confidence context, and a complete status lifecycle so that I can make
an informed paper, assisted, or live decision.

**Why this priority**: This is the controlled path from intelligence to an actionable decision.

**Independent Test**: Feed a deterministic signal through valid, invalid, risk-breaching, and
event-blocked conditions and verify that the system shows the correct state and decision reason.

**Acceptance Scenarios**:

1. **Given** all confirmation rules pass and minimum R:R is met, **When** a setup is qualified,
   **Then** it progresses from Watching to Pre-entry to Entry Confirmed with entry, SL, targets,
   quantity, lot-size adjustment, rationale, and risk decision visible.
2. **Given** minimum R:R, daily loss, position, trade-count, quantity, liquidity, or event-risk
   limits fail, **When** the user attempts an assisted or live entry, **Then** the order is rejected
   before submission with the failed rule and current values shown.
3. **Given** a signal is invalidated, stopped, targeted, trailed, or exited, **When** the state
   changes, **Then** the signal, position, protection, notification, and audit record agree.

### User Story 3 - Build a Rule-Based Strategy (Priority: P1)

As a strategy builder, I want to compose instrument, timeframe, indicator, price-action,
options, news, logical, entry, risk, target, trailing, and exit rules visually so that I can
create an explainable strategy without writing broker-specific commands.

**Why this priority**: Reusable rule-based strategies connect market intelligence to repeatable
validation and execution while keeping decisions explainable.

**Independent Test**: Create, save, version, inspect, and evaluate a strategy containing nested
AND/OR/NOT conditions, risk rules, and exit rules, then confirm the same strategy can be selected
in backtest and paper modes.

**Acceptance Scenarios**:

1. **Given** the strategy builder is open, **When** the user selects conditions and actions,
   **Then** the system validates incomplete or contradictory rules and presents the resulting
   strategy in readable form.
2. **Given** a strategy version has started a live run, **When** the user attempts to edit it,
   **Then** the system preserves the live version and requires a new version for changes.
3. **Given** a strategy uses a news condition, **When** the condition is evaluated, **Then** it
   can influence regime or gating but cannot independently submit a live order.

### User Story 4 - Validate Through Backtest and Paper Trading (Priority: P1)

As an algo user, I want to backtest and paper trade a strategy with realistic costs, slippage,
lot sizes, expiry behavior, fills, and risk controls so that promotion decisions are evidence-based.

**Why this priority**: Validation prevents premature live automation and is a core safety promise.

**Independent Test**: Run a strategy over historical data, inspect trade-level and aggregate
metrics, then run the same version in a virtual account and verify that no live endpoint is called.

**Acceptance Scenarios**:

1. **Given** a strategy and historical period, **When** the user runs a backtest, **Then** the
   system reports equity curve, trades, win rate, profit factor, expectancy, maximum drawdown,
   Sharpe, average and median R, slippage, costs, exposure, and regime-wise performance.
2. **Given** a paper account, **When** a strategy produces an order, **Then** the simulator applies
   configured capital, brokerage, taxes or fees, slippage, lot sizes, expiry, fills, margin, and
   realized/unrealized P&L without sending the order to a broker.
3. **Given** configurable promotion gates are not met, **When** the user requests promotion,
   **Then** the request is blocked and the unmet evidence is shown; no performance is presented
   as a guarantee of future results.

### User Story 5 - Execute With a Broker Safely (Priority: P1)

As an assisted or algo trader, I want a broker-neutral execution workflow initially connected to
Groww so that approved orders, Smart Orders, fills, positions, and protection can be managed while
uncertain states fail closed.

**Why this priority**: Broker execution creates financial risk and must be controlled, reconcilable,
and auditable before it is useful.

**Independent Test**: Exercise authentication, health, quote, order, modify, cancel, fill,
partial-fill, protective-order, timeout, disconnect, duplicate, and reconciliation scenarios
against a broker test or controlled mock adapter.

**Acceptance Scenarios**:

1. **Given** live mode is selected, **When** the user activates it, **Then** the system shows broker
   connection, session health, permissions, current exposure, risk limits, and explicit confirmation
   before allowing automation.
2. **Given** an approved order is submitted, **When** the broker returns success, rejection, timeout,
   or unknown status, **Then** the system records a unique internal idempotency reference and
   reconciles unknown state before retrying.
3. **Given** an entry partially fills, **When** the fill is recorded, **Then** the remaining
   protection quantity is recalculated and the position and audit trail are updated.
4. **Given** a broker disconnect, unexpected position, risk-service outage, or failed OCO creation,
   **When** the condition is detected, **Then** new entries stop, the user is notified, and the
   configured emergency protection or reconciliation workflow begins.

### User Story 6 - Understand News and Market Regime (Priority: P2)

As a trader, I want global and Indian business news summarized, deduplicated, scored for sentiment
and impact, mapped to affected assets and sectors, and combined with market evidence so that news
adds context without becoming an unsafe black-box trade trigger.

**Why this priority**: Context improves interpretation of volatility and event risk but must remain
subordinate to deterministic strategy and risk controls.

**Independent Test**: Provide articles from multiple sources and scheduled events, then verify source
tiers, clustering, extracted entities, sentiment, impact, horizon, regime classification, blackout
windows, and outcome evaluation.

**Acceptance Scenarios**:

1. **Given** related syndicated articles arrive, **When** ingestion completes, **Then** the system
   deduplicates or clusters them and retains source reliability and timestamps.
2. **Given** a high-severity event is detected, **When** corroboration is insufficient, **Then** the
   system marks it uncertain and does not allow it to authorize a live trade.
3. **Given** a configured scheduled event window is active, **When** a strategy evaluates an entry,
   **Then** the system blocks, downgrades, or requires confirmation according to the user's rule.
4. **Given** an event's forecast horizon has elapsed, **When** the outcome evaluator runs, **Then**
   the system records realized movement and calibration results for the configured horizons.

### User Story 7 - Operate and Review the System (Priority: P2)

As an advanced user or operator, I want notifications, trade journal, analytics, settings,
permissions, health, and emergency controls in one coherent workspace so that I can monitor and
review the platform without losing safety context.

**Why this priority**: Operations, review, and rapid intervention are necessary for trustworthy use.

**Independent Test**: Generate each supported notification and operational failure, trigger the kill
switch, then inspect the journal, analytics, audit history, and restored safe state.

**Acceptance Scenarios**:

1. **Given** an entry, fill, target, stop, trailing change, news shock, risk limit, broker error,
   disconnect, pause, or end-of-day event, **When** it occurs, **Then** the configured notification
   is delivered with mode, instrument, severity, and action state.
2. **Given** the kill switch is activated, **When** a new signal or order is produced, **Then** no
   new order is submitted immediately and the system shows the switch state and configured position
   handling.
3. **Given** a live trade is complete, **When** the user opens the journal, **Then** the complete
   decision, order, fill, exit, rationale, risk, and outcome history is available.

### Edge Cases

- Stale, missing, crossed, or malformed quotes and candles mark affected signals invalid and block
  new live entries.
- A market-data disconnect enters a safe state; existing positions remain visible for management,
  but new entries are blocked until health recovers.
- Broker authentication failure disables live execution and notifies the user without exposing the
  failed credential or token.
- An order timeout or unknown status triggers reconciliation before any retry; duplicate signals
  cannot create duplicate broker orders.
- A partial fill recalculates remaining SL, target, and OCO quantities.
- A failed protective-order or OCO creation starts an emergency protection workflow and escalates it.
- An unexpected broker position blocks automation and creates a reconciliation alert.
- Missing option expiry, lot size, liquidity, IV, or OI data prevents dependent calculations from
  being represented as valid.
- A high or extreme news event can pause, downgrade, or require confirmation for affected strategies.
- A user cannot activate live mode without healthy broker state, explicit consent, and valid risk limits.
- End-of-day rules handle open positions according to the configured square-off policy and record the
  decision.

## Requirements *(mandatory)*

### Functional Requirements

#### Market Intelligence and Signals

- **FR-001**: The system MUST support NIFTY, BANK NIFTY, SENSEX, and configured liquid F&O instruments.
- **FR-002**: The system MUST display live price, change, trend regime, volatility where available,
  key levels, market breadth where available, and active signals for supported indices.
- **FR-003**: The system MUST provide candle views for 1m, 3m, 5m, 15m, 30m, 1h, and daily periods.
- **FR-004**: The system MUST support EMA/SMA, VWAP, RSI, MACD, ATR, Supertrend, Bollinger Bands,
  volume, CPR, pivots, trade markers, support/resistance, and price-action analysis.
- **FR-005**: The system MUST identify HH/HL, LH/LL, breakouts, breakdowns, retests, rejections,
  and key levels when sufficient data exists.
- **FR-006**: The system MUST display options strikes, CE/PE LTP, OI, OI change, volume, IV, bid,
  ask, PCR, premium movement, strike distance, and derived support/resistance where available.
- **FR-007**: The system MUST identify OI build-up and unwinding and show the evidence used.
- **FR-008**: The system MUST represent signal states as No Setup, Watching, Pre-entry, Entry
  Confirmed, Order Pending, Filled, Target, Trailing, Exit, Invalidated, Risk Breach, and Emergency Stop.
- **FR-009**: The system MUST explain every qualified signal using its contributing market, technical,
  derivatives, news, volatility, liquidity, strategy, and risk inputs.
- **FR-010**: The system MUST classify market regime as Bull Trend, Bear Trend, Range, High Volatility,
  or Event Risk, with configurable evidence weights and versioned scoring.
- **FR-011**: The system MUST NOT label an uncalibrated composite score as a probability.

#### News and AI Market Brain

- **FR-012**: The system MUST ingest approved global and Indian macroeconomic, central-bank,
  geopolitical, commodity, currency, global-index, company, and business news sources.
- **FR-013**: The system MUST assign configurable source reliability tiers and retain source and time.
- **FR-014**: The system MUST deduplicate syndicated stories and cluster related events.
- **FR-015**: The system MUST extract countries, companies, sectors, indices, commodities, currencies,
  central banks, policies, event type, severity, sentiment, confidence, direction, magnitude,
  persistence, and time horizon.
- **FR-016**: The system MUST score sentiment separately from market impact and map impact to affected
  indices, assets, sectors, commodities, currencies, and rates.
- **FR-017**: The system MUST cross-check high-severity events against multiple sources before they
  influence live trading.
- **FR-018**: The system MUST support configurable blackout windows around scheduled major events.
- **FR-019**: News MUST remain contextual input; the news engine MUST never independently submit a live order.
- **FR-020**: The system MUST evaluate event outcomes across 1m, 5m, 15m, 30m, 1h, and 1d horizons.

#### Strategy, Risk, and Position Management

- **FR-021**: The strategy builder MUST support instruments, timeframes, indicators, price action,
  options, news, nested AND/OR/NOT groups, entry selection, risk, targets, trailing, invalidation,
  time exit, news-shock exit, and end-of-day square-off rules.
- **FR-022**: The system MUST support CE, PE, ATM, ITM, OTM, and underlying selection rules where the
  selected instrument and broker support them.
- **FR-023**: The risk engine MUST calculate quantity from capital, risk percentage, entry, stop distance,
  and valid lot size, rounding down or rejecting when no valid quantity exists.
- **FR-024**: The risk engine MUST reject a trade below configured minimum R:R before assisted or live submission.
- **FR-025**: The risk engine MUST enforce maximum risk per trade, daily loss, open positions, trades per day,
  quantity, liquidity, event risk, and user-configured exposure controls.
- **FR-026**: All risk defaults MUST be configurable and MUST be presented as controls, not profit guarantees.
- **FR-027**: The system MUST support fixed, percentage, ATR, swing, previous-candle, VWAP, and fixed-distance
  trailing methods where data permits.
- **FR-028**: Strategy versions MUST be immutable after a live run starts and every signal MUST reference a version.

#### Paper, Assisted, and Live Execution

- **FR-029**: The system MUST provide explicit PAPER, ASSISTED, and ALGO LIVE modes and show the active mode
  persistently in the UI.
- **FR-030**: Paper mode MUST use a virtual account with configurable capital, realistic market/limit/SL/SL-M
  behavior, fees, taxes, slippage, margin, expiry, fills, P&L, drawdown, and R-multiples.
- **FR-031**: Paper mode MUST be technically unable to call live broker order endpoints.
- **FR-032**: Assisted mode MUST require user confirmation after all risk gates pass and before broker submission.
- **FR-033**: Algo Live mode MUST require explicit activation, healthy broker/session state, permissions,
  risk-limit confirmation, and configurable promotion gates.
- **FR-034**: Live orders MUST use a unique internal idempotency reference and safe retry behavior.
- **FR-035**: The execution layer MUST support authentication, quotes, historical candles, funds, positions,
  orders, order status, place, modify, cancel, protective orders, and health checks through a broker-neutral contract.
- **FR-036**: The initial broker integration MUST support Groww capabilities currently permitted for authentication,
  data, market/limit/SL orders, order lifecycle, trades, positions, and Smart Orders including OCO where applicable.
- **FR-037**: Strategy logic MUST NOT call broker-specific endpoints directly.
- **FR-038**: Unknown order status MUST be reconciled before retry; partial fills MUST update remaining protection.
- **FR-039**: The system MUST reconcile platform positions with broker positions and block automation on unexpected positions.
- **FR-040**: A kill switch MUST immediately prevent new orders and show configured handling for existing positions.

#### Operations, Security, and Audit

- **FR-041**: The system MUST provide Dashboard, Markets, Options Chain, Live Signals, Trade Detail, Strategy
  Builder, Backtesting, Paper Trading, Algo Control, Broker Connection, AI Market Brain, Trade Journal,
  Analytics, and Settings views.
- **FR-042**: The desktop-first UI MUST follow the supplied reference direction: dense but scannable multi-panel
  workspace, persistent left navigation, dark navy/teal surfaces, restrained borders, compact market cards,
  green/red state colors, chart-led analysis, and clear mode and connection badges. The UI MUST remain usable
  on narrower screens without hiding safety state or causing overlapping content.
- **FR-043**: Critical risk, data freshness, mode, broker health, exposure, kill-switch, and trade blockers MUST
  be visible without deep navigation.
- **FR-044**: The system MUST notify users for pre-entry, entry, order acceptance or rejection, partial fill,
  target, stop, trailing change, news shock, risk limit, broker disconnect, automatic pause, and end-of-day events.
- **FR-045**: The system MUST maintain a trade journal containing every signal, order, fill, exit, rationale, risk
  decision, strategy version, and outcome.
- **FR-046**: The system MUST provide analytics for win rate, profit factor, expectancy, maximum drawdown, Sharpe,
  average R, median R, slippage, costs, exposure, and regime-wise performance.
- **FR-047**: Credentials MUST be encrypted in transit and at rest, held through protected credential references,
  separated from user identity, and excluded from browser logs, client bundles, and ordinary application logs.
- **FR-048**: The system MUST enforce strong authentication, least privilege, role-based administrative access,
  protected kill-switch controls, security-event logging, and failed-authentication logging.
- **FR-049**: The system MUST provide structured operational metrics, logs, traces, and alerts for execution,
  reconciliation, data-quality, risk, and availability failures.
- **FR-050**: The system MUST preserve an append-only audit history and support review of all live decision and
  execution events.
- **FR-051**: The product MUST distinguish historical simulation, paper results, assisted results, and live results.
- **FR-052**: The product MUST support graceful degradation and fail closed for unavailable market data, risk
  service, authentication, broker state, or protection state.
- **FR-053**: The product MUST not claim or imply guaranteed profit, accuracy, or future performance.
- **FR-054**: The production live workflow MUST be gated on verification of current broker, exchange, and applicable
  regulatory requirements, with suitability, disclosures, consent, and permissions appropriate to the offering.

### Key Entities

- **User**: Person with role, status, preferences, permissions, and authenticated identity.
- **Broker Connection**: User-scoped broker relationship with protected credential reference, broker name, health,
  permissions, and last check.
- **Instrument**: Exchange symbol with expiry, strike, option type, lot size, and tradability metadata.
- **Market Candle**: Instrument/timeframe OHLCV observation with timestamp and data-quality state.
- **Option Snapshot**: Strike observation containing LTP, OI, OI change, IV, volume, bid, ask, and timestamp.
- **News Event**: Sourced article or clustered event with entities, source tier, timestamp, severity, sentiment,
  impact, confidence, horizon, corroboration, and outcome.
- **Strategy**: Versioned rule set with instrument scope, conditions, actions, risk configuration, and lifecycle state.
- **Backtest Run**: Strategy version, period, data assumptions, trades, equity curve, and performance metrics.
- **Paper Account**: Virtual capital, balance, margin, positions, simulated orders, P&L, and drawdown.
- **Signal**: Strategy evaluation with state, score, rationale, evidence, timestamp, and risk decision.
- **Risk Decision**: Evaluated limits, decision, failed or passed rules, and reason linked to a signal or order.
- **Order**: Internal order identity, mode, side, quantity, price, protection, idempotency reference, broker identity,
  and status.
- **Position**: Instrument quantity, average price, stop, targets, trailing state, exposure, and P&L.
- **Execution Event**: Order lifecycle, fill, protection, reconciliation, or failure event with timestamp and payload.
- **Audit Event**: Actor, action, object, before/after context, decision rationale, and immutable timestamp.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: During supported trading sessions, the dashboard updates live market state without a full-page refresh
  and shows a visible data-freshness state for every critical feed.
- **SC-002**: 100% of assisted and live order attempts are evaluated by the deterministic risk gate before submission;
  zero orders bypass minimum R:R or configured hard limits in acceptance testing.
- **SC-003**: 100% of paper-mode order attempts are prevented from reaching live broker order endpoints in isolation tests.
- **SC-004**: 100% of live orders have a unique internal idempotency reference, complete decision trace, and reconciled
  final status before being considered complete.
- **SC-005**: In controlled failure tests, stale data, risk-service outage, authentication failure, broker disconnect,
  unknown order status, unexpected position, and failed protection creation result in no new live entry until resolved.
- **SC-006**: A user can move from dashboard context to a qualified signal explanation and risk decision in no more than
  three deliberate interactions, while mode, broker health, and blockers remain visible.
- **SC-007**: A strategy can be represented in the builder, saved as a version, backtested, and selected in paper mode
  without rewriting its rules or broker-specific behavior.
- **SC-008**: Backtest and paper reports include all required trade and strategy metrics and clearly distinguish simulated
  results from assisted and live performance.
- **SC-009**: Every critical notification category in FR-044 is generated with the correct instrument, mode, severity,
  and action state in operational acceptance tests.
- **SC-010**: At least 90% of representative users can identify the active mode, current risk status, data health, and
  the reason a sample trade is allowed or blocked on their first dashboard attempt.
- **SC-011**: During a controlled market-session load test, critical dashboard and risk-state updates remain available
  with graceful degradation and execution failures produce structured alerts and audit events.
- **SC-012**: Before live launch, a documented review confirms current broker, exchange, security, privacy, and
  applicable regulatory obligations, with unresolved obligations blocking live activation.

## Assumptions

- The first release targets desktop-first use by Indian retail traders, strategy builders, algo users, and operators;
  mobile optimization is secondary to preserving desktop safety visibility.
- Supported instruments and live capabilities depend on current exchange and Groww permissions; unsupported instruments
  or fields are shown as unavailable rather than inferred.
- Market data, historical candles, options data, and approved news sources are available through licensed or authorized
  providers and may have latency or coverage limitations.
- All risk defaults are examples and are configurable by the authorized user or operator.
- The promotion path is backtest, paper, performance validation, assisted, then controlled algo live; promotion is not
  a guarantee of performance.
- Existing market, broker, and regulatory documentation may change; live enablement requires a current verification.
- The attached image is a visual reference for information hierarchy and styling, not a pixel-perfect contract.
- Multi-broker adapters, advanced portfolio analytics, and broader instruments follow after the initial Groww workflow.
- Quantitative backtesting requires historical data quality, corporate-action handling, expiry metadata, and documented
  assumptions about fills, fees, slippage, and liquidity.