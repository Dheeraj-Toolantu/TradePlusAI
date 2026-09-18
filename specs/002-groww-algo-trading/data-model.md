# Data Model: Groww Algo Trading and Explainable Flow Gates

## AlgoFlowEvaluation

- `id`, `candidate_id`, `correlation_id`, `mode`, `broker`, `current_stage`, `final_decision`,
  `started_at`, `completed_at`
- Contains ordered `GateResult` records; no stage may be skipped.

## GateResult

- `stage`, `observed_value`, `threshold`, `passed`, `evidence`, `reason`, `evaluated_at`
- Stages: `NEWS`, `REGIME`, `TECHNICAL`, `OPTIONS`, `LIQUIDITY`, `RR`, `RISK`, `EXECUTION`.
- A failed result prevents downstream side effects.

## BrokerConnection

- `id`, `user_id`, `broker`, `credential_reference`, `api_version`, `permissions`, `health`,
  `authenticated`, `last_checked_at`, `compliance_approval`, `status`
- Credential values never enter this entity or API response; only protected references are stored.

## BrokerOrder

- `id`, `mode`, `broker`, `instrument`, `side`, `quantity`, `price`, `trigger_price`, `order_type`,
  `internal_reference`, `provider_order_id`, `status`, `filled_quantity`, `remaining_quantity`,
  `average_fill_price`, `retry_count`, `created_at`, `updated_at`
- `internal_reference` is unique and provider-compatible.

## ProtectionPlan

- `id`, `position_id`, `type`, `quantity`, `target_leg`, `stop_loss_leg`, `provider_reference`, `status`
- Quantity cannot exceed absolute net position. Partial fills update the quantity.

## PaperAccount

- `id`, `owner_id`, `capital`, `balance`, `margin`, `cost_config`, `slippage_config`, `orders`, `fills`,
  `positions`, `realized_pnl`, `unrealized_pnl`
- All order destinations are internal simulator operations.

## NewsOutcome

- `event_id`, `prediction_id`, `predicted_direction`, `predicted_impact`, `confidence`, `horizon`,
  `realized_move`, `accuracy`, `evaluated_at`, `calibration_state`
- Original prediction is immutable; calibration is an additional review record.

## PromotionEvidence

- `strategy_version`, `out_of_sample`, `walk_forward`, `paper_validated`, `assisted_approved`,
  `capped_live`, `consent`, `compliance_approved`, `reviewed_at`

## State transitions

### Flow

`NOT_STARTED -> NEWS -> REGIME -> TECHNICAL -> OPTIONS -> LIQUIDITY -> RR -> RISK -> EXECUTION -> COMPLETED`

Any stage can terminate as `BLOCKED`, `SAFE_STATE`, or `KILL_SWITCH`.

### Broker order

`CREATED -> SUBMITTED -> OPEN -> PARTIALLY_FILLED -> FILLED -> PROTECTED -> CLOSED`

Failure states: `REJECTED`, `UNKNOWN`, `RECONCILIATION_REQUIRED`, `CANCELLED`, `PROTECTION_FAILED`.

### Promotion

`DRAFT -> BACKTESTED -> WALK_FORWARD_VALIDATED -> PAPER_VALIDATED -> ASSISTED_APPROVED -> ALGO_LIVE_CAPPED`.