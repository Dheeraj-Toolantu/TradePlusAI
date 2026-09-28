# Data Model: AI-Driven Trading Monitor and Gated Automation

## Design Principles

- AI records are advisory evidence and never replace deterministic analysis, risk, mode, or execution contracts.
- Original evaluation evidence is immutable after creation. Later state changes are linked events or outcome records.
- All timestamps are ISO 8601 UTC; market-context timestamps retain the source timestamp and freshness classification.
- Credentials, access tokens, account secrets, raw prompts, and unredacted provider payloads are excluded from user-visible records.
- Every object participating in one evaluation shares a `correlationId`; every model invocation has a separate `providerRequestId`.

## Entities

### AITradingConfiguration

User-controlled monitoring and automation configuration.

| Field | Type | Rules |
|---|---|---|
| `id` | string | Unique identifier. |
| `ownerId` | string | Authenticated owner; access is role-scoped. |
| `monitoringEnabled` | boolean | Must be explicitly enabled before evaluations are requested. |
| `automationEnabled` | boolean | Independent from monitoring; enabling does not change execution mode. |
| `mode` | `PAPER \| ASSISTED \| ALGO_LIVE` | Must be visible and validated against mode policy. |
| `instruments` | string[] | Supported NIFTY, BANKNIFTY, SENSEX underlyings/options only. |
| `timeframes` | string[] | Existing supported timeframe values. |
| `strategyVersion` | string | Immutable reference to deterministic strategy configuration. |
| `confidenceThreshold` | number | Range 0-100; advisory filter only. |
| `contextPolicy` | object | Allowed data sources, freshness limits, and required evidence. |
| `riskAcknowledged` | boolean | Required for automation activation; does not bypass risk gates. |
| `version` | string | Incremented on any configuration change. |
| `createdAt`, `updatedAt` | timestamp | Audit timestamps. |

### MonitoringSession

A bounded period in which a user has enabled AI monitoring.

| Field | Type | Rules |
|---|---|---|
| `id` | string | Unique session identifier. |
| `ownerId` | string | Must match configuration owner. |
| `configurationId` | string | References configuration snapshot. |
| `state` | `DISABLED \| STARTING \| ACTIVE \| DEGRADED \| STOPPING \| STOPPED` | State transitions are audited. |
| `startedAt`, `stoppedAt` | timestamp? | Set at lifecycle transition. |
| `stopReason` | string? | Required for non-user stop or degraded terminal state. |
| `lastEvaluationAt` | timestamp? | Latest accepted evaluation. |
| `health` | object | Data freshness, provider status, broker health, safe mode, kill switch, and blockers. |
| `correlationId` | string | Session-level trace identifier. |

### MarketContextSnapshot

The bounded market evidence supplied to one model evaluation.

| Field | Type | Rules |
|---|---|---|
| `id` | string | Unique snapshot identifier. |
| `instrumentId`, `symbol`, `underlying` | string | Must resolve through instrument metadata. |
| `optionContract` | object? | Expiry, strike, option type, lot/tick/freeze metadata when applicable. |
| `timeframe` | string | Matches configuration. |
| `candleRange` | object | First/last timestamps and candle count. |
| `analysisId` | string? | Reference to deterministic analysis result. |
| `marketEvidence` | object | Trend, structure, momentum, volume, levels, option alignment, session, liquidity. |
| `freshness` | `FRESH \| STALE \| UNKNOWN` | Anything other than `FRESH` blocks automation. |
| `quality` | `VALID \| INSUFFICIENT_DATA \| INVALID \| STALE \| DISCONTINUOUS` | Derived from existing data-quality rules. |
| `capturedAt` | timestamp | Snapshot creation time. |

### AIEvaluation

One validated request/response cycle with the model gateway.

| Field | Type | Rules |
|---|---|---|
| `id` | string | Immutable evaluation identifier. |
| `sessionId`, `configurationId`, `contextSnapshotId` | string | Required references. |
| `correlationId`, `providerRequestId` | string | Trace identifiers; provider request ID must not contain secrets. |
| `state` | `REQUESTED \| COMPLETED \| TIMEOUT \| MALFORMED \| UNAVAILABLE \| REJECTED` | Terminal state is immutable. |
| `direction` | `BULLISH \| BEARISH \| NEUTRAL \| NO_TRADE \| WAITING \| UNAVAILABLE` | Validated model category. |
| `confidence` | number? | Range 0-100; absent for unavailable/rejected responses. |
| `evidence` | object | References and bounded claims tied to context/analysis. |
| `explanation` | string? | Validated, redacted, prohibited-claim checked. |
| `invalidation` | string? | Conditions that make the suggestion non-current. |
| `model` | object | Provider alias, model alias, version, prompt/schema version. |
| `latencyMs` | number? | Operational metric, not a trading input. |
| `failure` | object? | Code and safe user-facing reason for non-completed states. |
| `createdAt`, `completedAt` | timestamp | Immutable timestamps. |

### AISuggestion

User-facing projection of an evaluation and deterministic analysis.

| Field | Type | Rules |
|---|---|---|
| `id` | string | Unique suggestion identifier. |
| `evaluationId`, `analysisId` | string? | Links model and deterministic evidence. |
| `direction` | `BULLISH \| BEARISH \| NEUTRAL \| NO_TRADE \| WAITING \| UNAVAILABLE` | Never interpreted as an order side without deterministic mapping. |
| `status` | `ADVISORY \| WAITING \| CONFIRMED \| INVALIDATED \| EXPIRED \| BLOCKED` | Automation cannot proceed from advisory/waiting/blocked states. |
| `confidence` | number? | Displayed with model/version context. |
| `reasonSummary`, `risks`, `invalidation` | string[]/string | Must be grounded in bounded context and deterministic results. |
| `currentUntil` | timestamp? | Expiry or next-evaluation boundary. |
| `createdAt` | timestamp | Immutable creation time. |

### AutomationDecision

The authoritative result of evaluating an AI suggestion against all execution gates.

| Field | Type | Rules |
|---|---|---|
| `id` | string | Unique decision identifier. |
| `suggestionId`, `evaluationId`, `analysisId` | string | Required trace links. |
| `mode` | `PAPER \| ASSISTED \| ALGO_LIVE` | Captured at evaluation time; later mode changes invalidate the decision. |
| `decision` | `ALLOW_PAPER \| REQUIRE_CONFIRMATION \| BLOCK \| CANCEL` | Only `ALLOW_PAPER` can simulate; assisted requires existing confirmation. |
| `gates` | GateResult[] | Ordered deterministic and AI confirmation results. |
| `instrument`, `side`, `quantity` | object? | Derived by deterministic strategy/risk/contract services, never model output. |
| `protectiveLevels` | object? | Stop and targets from deterministic setup. |
| `idempotencyKey` | string | Unique for instrument, setup identity, direction, and evaluation window. |
| `reason` | string | Required for block/cancel/confirmation. |
| `createdAt` | timestamp | Immutable decision time. |

### AISuggestionLogEntry

Append-only read model for the user-facing log.

| Field | Type | Rules |
|---|---|---|
| `id` | string | Unique log record. |
| `eventType` | string | Evaluation, lifecycle, decision, cancellation, order, fill, or exit event. |
| `subjectId` | string | Suggestion/evaluation/session identifier. |
| `correlationId` | string | Joins all related records. |
| `summary` | object | Instrument, timeframe, direction, confidence, recommendation, decision, status, timestamp. |
| `detailRefs` | object | References to immutable context, analysis, gate, model, and order records. |
| `actor` | string | User, automation, system, or risk service. |
| `occurredAt` | timestamp | Event time. |

### ModelProviderStatus

Operational read model for the approved model gateway.

| Field | Type | Rules |
|---|---|---|
| `providerAlias`, `modelAlias`, `schemaVersion` | string | No credentials. |
| `state` | `READY \| DEGRADED \| UNAVAILABLE \| MISCONFIGURED` | `UNAVAILABLE` blocks new evaluations/automation. |
| `lastSuccessAt`, `lastFailureAt` | timestamp? | Health timestamps. |
| `latencyMs` | number? | Observability only. |
| `failureCode` | string? | Safe, non-secret code. |

## Relationships

```text
AITradingConfiguration 1 -> many MonitoringSession
MonitoringSession 1 -> many MarketContextSnapshot
MarketContextSnapshot 1 -> 1 AIEvaluation
AIEvaluation 1 -> 1 AISuggestion
AISuggestion 1 -> many AutomationDecision
AIEvaluation 1 -> many AISuggestionLogEntry
AutomationDecision 1 -> many AISuggestionLogEntry
AutomationDecision 0 -> 1 Order/Position lifecycle
```

## State Transitions

### MonitoringSession

- `DISABLED -> STARTING`: authenticated user enables monitoring and configuration validates.
- `STARTING -> ACTIVE`: first valid context and provider health checks pass.
- `STARTING -> STOPPED`: configuration, authorization, or initial health check fails.
- `ACTIVE -> DEGRADED`: data stale, provider unavailable, broker unhealthy, or safe state entered.
- `DEGRADED -> ACTIVE`: required health checks recover and a fresh context is accepted.
- `ACTIVE -> STOPPING`: user disables monitoring, kill switch activates, or configuration changes.
- `STOPPING -> STOPPED`: no further evaluation or automation work is accepted.

### AIEvaluation and AISuggestion

- `REQUESTED -> COMPLETED`: response validates and prohibited-claim/content checks pass.
- `REQUESTED -> TIMEOUT | UNAVAILABLE`: provider cannot respond within the configured bound.
- `REQUESTED -> MALFORMED | REJECTED`: response violates schema, scope, or safety validation.
- `COMPLETED -> ADVISORY`: direction exists but deterministic setup/gates are not confirmed.
- `COMPLETED -> CONFIRMED`: direction and deterministic confirmation are both valid for the current context.
- `ADVISORY -> WAITING | INVALIDATED | EXPIRED`: context changes or required confirmation remains absent.
- `CONFIRMED -> INVALIDATED | EXPIRED`: invalidation condition, freshness boundary, mode/configuration change, or timeout occurs.

### AutomationDecision

- `UNSEEN -> BLOCK`: any required gate fails, including AI unavailable or stale context.
- `UNSEEN -> REQUIRE_CONFIRMATION`: ASSISTED mode passes safety gates but needs user confirmation.
- `UNSEEN -> ALLOW_PAPER`: PAPER mode passes all gates and idempotency checks.
- `REQUIRE_CONFIRMATION -> ALLOW_ASSISTED`: user confirms before the decision expires and all gates are rechecked.
- `REQUIRE_CONFIRMATION -> CANCEL`: user declines, decision expires, or any gate becomes unsafe.
- `ALLOW_PAPER | ALLOW_ASSISTED -> CANCEL`: pre-submit recheck fails or duplicate/idempotency conflict occurs.

## Validation Rules

- AI direction and confidence never supply authoritative entry, stop, target, quantity, risk limit, or mode values.
- Any non-fresh or non-valid required context blocks new automation.
- Any provider timeout, malformed response, unsupported instruction, or missing model status is non-actionable.
- Existing risk, session, contract, liquidity, reconciliation, safe-mode, kill-switch, and live-release gates must pass in their existing order before an automation decision is allowed.
- A decision expires when the context freshness window, configuration version, strategy version, mode, or deterministic analysis identity changes.
- Idempotency keys prevent duplicate automation for the same current setup.
- Log records are append-only and may reference redacted snapshots; user-facing filters query the log read model without mutating source records.
