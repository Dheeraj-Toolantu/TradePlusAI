# Contract: AI Monitoring API

This contract describes the server-side interface used by the algo-trading page. The API is advisory and orchestration-oriented; order submission remains behind the existing execution boundary.

## `GET /api/ai-monitoring`

Returns the current monitoring read model for the authenticated user.

### Query parameters

- `sessionId` (optional): monitoring session to inspect.
- `symbol` (optional): filter current state by NIFTY, BANKNIFTY, or SENSEX instrument.
- `limit` (optional): log page size, default 50, maximum 200.
- `cursor` (optional): opaque pagination cursor.
- `direction` (optional): `BULLISH`, `BEARISH`, `NEUTRAL`, `NO_TRADE`, `WAITING`, `UNAVAILABLE`.
- `outcome` (optional): `ADVISORY`, `WAITING`, `CONFIRMED`, `BLOCKED`, `INVALIDATED`, `EXPIRED`.
- `from` / `to` (optional): ISO 8601 UTC date bounds.

### Response `200`

```json
{
  "monitoring": {
    "sessionId": "ms_123",
    "state": "ACTIVE",
    "monitoringEnabled": true,
    "automationEnabled": false,
    "mode": "PAPER",
    "scope": { "symbols": ["NIFTY"], "timeframes": ["5m"] },
    "startedAt": "2026-09-20T09:15:00.000Z",
    "lastEvaluationAt": "2026-09-20T09:20:00.000Z"
  },
  "health": {
    "dataFreshness": "FRESH",
    "provider": "READY",
    "safeMode": false,
    "killSwitch": false,
    "broker": "CONNECTED",
    "blockers": []
  },
  "latest": {
    "suggestionId": "sg_123",
    "direction": "BULLISH",
    "status": "ADVISORY",
    "confidence": 78,
    "reasonSummary": ["..."],
    "invalidation": "...",
    "createdAt": "2026-09-20T09:20:00.000Z"
  },
  "log": { "items": [], "nextCursor": null, "total": 1 }
}
```

The response MUST omit secrets, raw provider prompts, raw provider responses, and credentials.

## `POST /api/ai-monitoring`

Creates or changes monitoring state, or requests one evaluation. The server revalidates authorization, configuration, context freshness, and mode policy.

### Enable monitoring

```json
{
  "action": "ENABLE_MONITORING",
  "symbols": ["NIFTY"],
  "timeframes": ["5m"],
  "mode": "PAPER",
  "strategyVersion": "v5-paper",
  "confidenceThreshold": 70,
  "automationEnabled": false,
  "riskAcknowledged": true
}
```

### Disable or stop

```json
{
  "action": "DISABLE_MONITORING",
  "sessionId": "ms_123",
  "reason": "User stopped monitoring"
}
```

### Change automation setting

```json
{
  "action": "SET_AUTOMATION",
  "sessionId": "ms_123",
  "enabled": true,
  "mode": "PAPER"
}
```

### Request a deterministic evaluation cycle

```json
{
  "action": "EVALUATE",
  "sessionId": "ms_123",
  "symbol": "NIFTY",
  "timeframe": "5m"
}
```

### Response `202`

```json
{
  "sessionId": "ms_123",
  "evaluationId": "ev_123",
  "state": "REQUESTED",
  "correlationId": "corr_123"
}
```

The server may complete an evaluation synchronously for the first implementation, but the response and lifecycle model must support asynchronous completion.

### Response `200` for a completed safe-state change

```json
{
  "sessionId": "ms_123",
  "state": "STOPPED",
  "reason": "User stopped monitoring",
  "occurredAt": "2026-09-20T09:25:00.000Z"
}
```

### Errors

- `400 INVALID_REQUEST`: unsupported symbol/timeframe, invalid configuration, malformed action, or missing required fields.
- `401 UNAUTHORIZED`: no valid authenticated user.
- `403 FORBIDDEN`: role or risk acknowledgement does not permit the action.
- `409 STATE_CONFLICT`: stale session, configuration/mode changed, duplicate idempotency key, or expired suggestion.
- `422 UNSAFE_CONTEXT`: data quality, session, contract, liquidity, or risk precondition fails; response includes `blockers`.
- `503 AI_UNAVAILABLE`: provider timeout, misconfiguration, or unavailable model; deterministic analysis remains usable where possible.

## `GET /api/ai-monitoring/log/:id`

Returns the immutable details for one suggestion or evaluation, including context references, deterministic analysis summary, model metadata, gate results, automation decision, and linked order/outcome events. It MUST redact secrets and MUST NOT mutate the record.

## Contract Invariants

- Monitoring is independent from automation and execution mode.
- An AI direction never directly becomes an order.
- `PAPER` decisions cannot reach a live broker destination.
- `ASSISTED` decisions require the existing user confirmation boundary.
- `ALGO_LIVE` activation remains subject to existing release policy and is rejected while readiness is incomplete.
- Every completed or failed evaluation produces an immutable log record.
- Repeated `EVALUATE` requests with the same session, context identity, strategy version, and evaluation window are idempotent.
