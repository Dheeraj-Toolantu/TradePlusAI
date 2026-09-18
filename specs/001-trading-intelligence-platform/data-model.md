# Data Model: TradePulse AI Trading Intelligence Platform

## Identity and access

### User

- `id`, `role`, `status`, `preferences`, `created_at`, `updated_at`
- Roles include trader, strategy builder, algo user, risk manager, and operator/admin.
- Inactive users cannot activate assisted or live execution.

### BrokerConnection

- `id`, `user_id`, `broker`, `credential_reference`, `permissions`, `status`, `last_health_check`
- Credential values are never stored in domain records or returned to the UI.
- A connection must be healthy and authorized before live activation.

## Market and intelligence

### Instrument

- `id`, `exchange`, `symbol`, `segment`, `expiry`, `strike`, `option_type`, `lot_size`, `status`
- Option instruments require expiry, strike, option type, and a positive lot size.
- Unsupported or incomplete instruments are unavailable for dependent calculations.

### MarketCandle

- `instrument_id`, `timeframe`, `timestamp`, `open`, `high`, `low`, `close`, `volume`, `quality_state`
- OHLC values must be ordered and non-negative where the instrument permits; invalid or stale
  observations are retained with an unsafe quality state and cannot authorize new live entries.

### OptionSnapshot

- `instrument_id`, `timestamp`, `ltp`, `oi`, `oi_change`, `iv`, `volume`, `bid`, `ask`, `quality_state`
- OI/IV/volume may be unavailable; derived metrics must identify missing inputs rather than infer them.

### NewsEvent

- `id`, `source`, `source_tier`, `published_at`, `received_at`, `title`, `cluster_id`, `entities`,
  `event_type`, `severity`, `sentiment`, `impact`, `confidence`, `direction`, `magnitude`,
  `persistence`, `horizon`, `corroboration_state`, `outcomes`
- Sentiment and impact are distinct values. High-severity events require configurable corroboration.

### MarketRegime

- `id`, `scope`, `timestamp`, `regime`, `evidence_weights`, `component_scores`, `composite_score`,
  `calibration_state`, `version`
- The composite score cannot be displayed as a probability unless calibration is recorded.

## Strategy and validation

### Strategy

- `id`, `owner_id`, `name`, `version`, `rules`, `risk_config`, `promotion_state`, `created_at`, `published_at`
- Rules include nested conditions, entry selection, stop, targets, trailing, invalidation, time exit,
  news shock, and end-of-day policy.
- A version used by a live run is immutable; edits create a new version.

### BacktestRun

- `id`, `strategy_version`, `period`, `data_assumptions`, `cost_assumptions`, `status`, `metrics`, `trades`,
  `equity_curve`, `regime_breakdown`
- Results are explicitly labeled historical simulation and cannot be represented as live performance.

### PaperAccount

- `id`, `owner_id`, `starting_capital`, `balance`, `margin`, `realized_pnl`, `unrealized_pnl`, `drawdown`,
  `positions`, `orders`, `cost_config`, `slippage_config`
- Paper accounts route only to the simulator and share strategy/risk semantics with live evaluation.

## Decision and execution

### Signal

- `id`, `strategy_version`, `instrument_id`, `state`, `score`, `evidence`, `entry_range`, `stop`, `targets`,
  `quantity`, `r_multiple`, `rationale`, `mode_context`, `risk_decision_id`, `created_at`, `updated_at`
- State transitions are monotonic except for explicitly recorded invalidation or emergency paths.

### RiskDecision

- `id`, `signal_id`, `mode`, `evaluated_at`, `configuration_version`, `checks`, `decision`, `reason`, `correlation_id`
- `decision` is `ALLOW`, `BLOCK`, or `REQUIRE_CONFIRMATION`; every check records input, threshold, and result.
- A live `ALLOW` is invalid if market, broker, or protection health changes before submission.

### Order

- `id`, `mode`, `signal_id`, `instrument_id`, `side`, `quantity`, `price`, `trigger_price`, `order_type`,
  `validity`, `internal_reference`, `broker_order_id`, `status`, `filled_quantity`, `remaining_quantity`,
  `average_fill_price`, `created_at`, `updated_at`
- `internal_reference` is unique, conforms to broker limits, and is used for idempotency and reconciliation.

### Position

- `id`, `account_or_connection_id`, `instrument_id`, `quantity`, `average_price`, `stop`, `targets`,
  `trailing_state`, `exposure`, `realized_pnl`, `unrealized_pnl`, `state`
- Protection quantity must not exceed the current net position; unexpected broker quantity blocks automation.

### ProtectionOrder

- `id`, `position_id`, `type`, `quantity`, `target_leg`, `stop_loss_leg`, `broker_reference`, `status`, `updated_at`
- OCO legs are treated as one protection unit; execution of one leg must cancel or reconcile the other.

### ExecutionEvent

- `id`, `order_id`, `event_type`, `source`, `payload`, `occurred_at`, `received_at`, `correlation_id`
- Events are append-only and support duplicate detection, partial fills, unknown status, and reconciliation.

### Notification

- `id`, `user_id`, `category`, `severity`, `mode`, `subject_id`, `message`, `channels`, `delivery_state`, `created_at`
- Categories include pre-entry, entry, rejection, partial fill, target, stop, trailing, news shock, risk, broker,
  automatic pause, kill switch, and end-of-day.

### AuditEvent

- `id`, `actor`, `action`, `object_type`, `object_id`, `before`, `after`, `reason`, `correlation_id`, `occurred_at`
- Audit records are append-only and exclude secrets. A live decision must link to signal, risk, order, fill, and exit.

## State transitions

### Signal

`NO_SETUP -> WATCHING -> PRE_ENTRY -> ENTRY_CONFIRMED -> ORDER_PENDING -> FILLED -> TARGET_1/TARGET_2/TRAILING -> EXITED`

Any state may move to `INVALIDATED`, `RISK_BREACH`, or `EMERGENCY_STOP` when the corresponding event is recorded.

### Order

`CREATED -> RISK_CHECKED -> SUBMITTED -> OPEN -> PARTIALLY_FILLED -> FILLED -> CLOSED`

Failure paths include `BLOCKED`, `REJECTED`, `CANCEL_PENDING`, `CANCELLED`, `UNKNOWN`, and `RECONCILIATION_REQUIRED`.
`UNKNOWN` cannot transition to `SUBMITTED` again until broker status or reference lookup resolves it.

### Promotion

`DRAFT -> BACKTESTED -> WALK_FORWARD_VALIDATED -> PAPER_VALIDATED -> ASSISTED_APPROVED -> ALGO_LIVE_CAPPED`

Each transition records evidence and approval. A failed gate retains the prior state and exposes the reason.