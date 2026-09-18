# Risk Gate Contract

The risk gate is the final deterministic decision before assisted or live order submission and is
also used by paper and backtest evaluation.

## Input

- Signal and strategy version
- Entry, stop, target, quantity candidate, and calculated R:R
- Account capital, realized/unrealized P&L, margin, open positions, and trade count
- Risk configuration version
- Instrument lot size, liquidity, expiry, and market-data quality
- Current regime, event risk, blackout state, broker health, protection readiness, and mode
- Kill-switch and promotion-gate state

## Output

```text
decision: ALLOW | BLOCK | REQUIRE_CONFIRMATION
checks: [{ name, observed, threshold, result, reason }]
normalized_quantity: integer | null
max_loss: decimal | null
expected_reward: decimal | null
minimum_rr: decimal
configuration_version: string
correlation_id: string
```

## Invariants

- `BLOCK` produces no order side effect.
- `ALLOW` requires valid data, valid lot size, minimum R:R, all hard limits, and healthy required dependencies.
- A live `ALLOW` expires when the relevant market, risk, broker, or protection state changes.
- Every result is persisted as a RiskDecision and linked to the signal and eventual order.