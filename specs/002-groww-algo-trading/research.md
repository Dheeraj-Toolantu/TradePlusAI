# Research: Groww Algo Trading and Explainable Flow Gates

**Date**: 2026-09-08
**Feature**: [spec.md](spec.md)

## Decision 1: Implement the image flow as a deterministic first-failure pipeline

**Decision**: Evaluate `NEWS -> REGIME -> TECHNICAL -> OPTIONS/OI -> LIQUIDITY -> R:R -> RISK -> EXECUTION`.
Each stage returns pass/fail, observed values, threshold, evidence, timestamp, and correlation ID.
The pipeline stops at the first failure.

**Rationale**: The supplied flow chart explicitly orders context, confirmation, risk, and execution.
First-failure behavior makes blocked trades explainable, prevents wasted downstream work, and gives
tests a precise no-side-effect boundary.

**Alternatives considered**: Running all checks and choosing the strongest result was rejected because
it could allow a later positive score to obscure a hard earlier blocker. Letting news call execution
directly was rejected by the constitution and the supplied architecture.

## Decision 2: Keep Paper Broker and Groww Broker behind one adapter contract

**Decision**: Strategy and risk code depend only on the broker-neutral contract. Paper execution uses
an internal simulator. Groww execution uses a server-side HTTP adapter with normalized quotes, health,
orders, status, cancellations, positions, and reconciliation.

**Rationale**: The images explicitly show one execution engine branching to Paper Broker or Groww Broker.
This preserves strategy portability and makes Paper mode technically incapable of reaching Groww.

**Alternatives considered**: Calling Groww directly from the strategy was rejected because it creates
provider lock-in and makes paper/live isolation difficult to prove. Separate strategy implementations
were rejected because promotion would require rewriting and revalidating the strategy.

## Decision 3: Use server-side authenticated Groww HTTP transport

**Decision**: Configure `GROWW_ACCESS_TOKEN`, base URL, and API version only on the server. The adapter
adds authorization and API-version headers, maps provider payloads into broker-neutral types, and turns
provider/network failures into retryable or safe-state domain errors.

**Rationale**: Groww's documented order and Smart Order APIs use bearer authorization, provider API
version headers, reference IDs, order status endpoints, and OCO/GTT endpoints. Server-side transport
prevents browser credential exposure and supports testing with a transport stub.

**Alternatives considered**: Browser-side calls were rejected because secrets and order authority would
be exposed. A direct SDK dependency was rejected because the existing contract and documented HTTP API
are easier to stub and keep broker-neutral.

## Decision 4: Reconcile unknown state before retrying

**Decision**: A successful submission with unknown local response, timeout, or ambiguous provider state
enters `UNKNOWN`; the execution service must query by provider order ID or reference before retrying.
Duplicate references return the existing normalized order state.

**Rationale**: Network uncertainty must not create duplicate financial orders. This follows Groww's
reference-ID behavior and the project constitution's idempotency requirement.

## Decision 5: Treat OCO as a protection plan, not a generic order

**Decision**: Model target and stop legs as one ProtectionPlan tied to a position. Validate quantity
against absolute net position, update quantity after partial fills, and enter emergency protection when
creation or reconciliation fails.

**Rationale**: OCO has coupled lifecycle semantics: one leg executing cancels the other. A dedicated
protection model makes partial fills and emergency workflows explicit.

## Decision 6: Store predictions and outcomes immutably

**Decision**: Store the original news event, AI interpretation, market reaction, and each horizon result.
Calibration reports may expose bias and future weighting recommendations but never mutate the original
prediction or outcome.

**Rationale**: This supports the requested learn-from-mistakes behavior without retrospective rewriting
of evidence.

## Decision 7: Live enablement is a compound release gate

**Decision**: Live submission requires all flow gates, healthy broker/session/reconciliation state,
`LIVE_EXECUTION_ENABLED=true`, `LIVE_COMPLIANCE_APPROVED=true`, explicit activation, and promotion evidence.

**Rationale**: Technical approval alone is not regulatory or operational approval. Keeping the flags
server-side and false by default makes local and test environments safe.

## External references

- [Groww Orders API](https://groww.in/trade-api/docs/curl/orders)
- [Groww Smart Orders](https://groww.in/trade-api/docs/curl/smart-orders)
- [SEBI retail algorithmic trading circular](https://www.sebi.gov.in/legal/circulars/feb-2025/safer-participation-of-retail-investors-in-algorithmic-trading_91614.html)
- [SEBI implementation timeline update](https://www.sebi.gov.in/legal/circulars/sep-2025/extension-of-timeline-for-implementation-of-sebi-circular-dated-february-04-2025-on-safer-participation-of-retail-investors-in-algorithmic-trading-_96979.html)