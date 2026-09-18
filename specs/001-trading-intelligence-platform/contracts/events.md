# Realtime Event Contract

All dashboard and notification updates use a versioned envelope so the UI can show freshness,
mode, and safe-state transitions consistently.

```text
event_id: string
event_type: string
schema_version: string
occurred_at: ISO-8601 timestamp
received_at: ISO-8601 timestamp
mode: PAPER | ASSISTED | ALGO_LIVE | SYSTEM
subject_type: string
subject_id: string
correlation_id: string | null
freshness: FRESH | STALE | UNKNOWN | NOT_APPLICABLE
severity: INFO | WARNING | HIGH | CRITICAL
payload: object
```

## Event types

`quote.updated`, `candle.updated`, `options.updated`, `regime.updated`, `signal.updated`,
`risk.decisioned`, `order.updated`, `fill.recorded`, `protection.updated`, `position.updated`,
`broker.health_changed`, `data.quality_changed`, `safe_state.entered`, `kill_switch.changed`,
`notification.created`, and `audit.recorded`.

## Safety rules

- `STALE`, `UNKNOWN`, and `safe_state.entered` events override older optimistic UI state.
- A critical event must remain visible until acknowledged or superseded by a recorded recovery.
- Events are traceable to the decision or execution correlation ID.