# Algo Flow Contract

## Input

```text
candidate_id
news_impact
minimum_news_impact
regime_allowed
technical_confirmed
options_confirmed
liquidity_confirmed
risk_context
mode
broker
correlation_id
```

## Output

```text
allowed: boolean
stage: NEWS | REGIME | TECHNICAL | OPTIONS | LIQUIDITY | RR | RISK | EXECUTION
reason: string | null
gate_results: [{ stage, observed, threshold, passed, evidence, evaluated_at }]
risk_decision: RiskDecision | null
execution_request: ExecutionRequest | null
```

## Invariants

- Gate order is fixed and versioned.
- A failed stage returns no execution request.
- News has no order capability.
- Execution request exists only after R:R and risk pass.
- Kill switch, stale data, failed health, unexpected position, or failed compliance invalidates execution.