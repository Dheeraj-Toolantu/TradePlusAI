# Feature Specification: Groww Algo Trading and Explainable Flow Gates

**Feature Branch**: `002-groww-algo-trading`

**Created**: 2026-09-08

**Status**: Draft

**Input**: User request, supplied flow-chart images, existing TradePulse AI requirements, and
the current broker-neutral Groww adapter.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Evaluate a Setup Through Ordered Gates (Priority: P1)

As an algo user, I want every candidate setup to pass through an ordered, explainable decision
flow so that the system never jumps directly from a news event to an order.

**Independent Test**: Submit the same candidate with each gate failing in turn and verify that the
system stops at the first failed gate, records the reason, and produces no execution side effect.

**Acceptance Scenarios**:

1. **Given** news impact is below the configured threshold, **When** a candidate is evaluated,
   **Then** the result is `NEWS_BLOCKED` and no regime, signal, or execution action is taken.
2. **Given** news passes but regime, technical confirmation, options/OI confirmation, or liquidity
   fails, **When** the candidate is evaluated, **Then** the result identifies the first failed stage.
3. **Given** all context gates pass but R:R is below the configured minimum, **When** the candidate
   is evaluated, **Then** the result is `RR_BLOCKED` and no risk or broker order is invoked.
4. **Given** R:R passes but any hard risk limit fails, **When** the candidate is evaluated, **Then**
   the result is `RISK_BLOCKED` with failed checks and no broker order is invoked.
5. **Given** every gate passes, **When** the user is in Paper mode, **Then** the execution request
   is routed only to the Paper Broker.

### User Story 2 - Connect Groww Through a Dedicated Adapter (Priority: P1)

As an algo user, I want Groww authentication, market data, order lifecycle, positions, trades,
margin, and protective orders behind a dedicated broker adapter so that the strategy and execution
engine does not depend on Groww-specific endpoints.

**Independent Test**: Run adapter contract tests against a transport stub and verify request mapping,
response normalization, authentication failure, duplicate prevention, status lookup, cancellation,
positions, and reconciliation behavior.

**Acceptance Scenarios**:

1. **Given** no server-side Groww credential is configured, **When** health is checked, **Then** the
   adapter reports unauthenticated and the system blocks new live entries without exposing secrets.
2. **Given** valid server-side credentials, **When** the adapter requests health, quotes, positions,
   or order status, **Then** it maps provider responses to broker-neutral types.
3. **Given** a live order request, **When** the deterministic gates and explicit live-release guard
   pass, **Then** the adapter sends a unique provider-compatible reference ID and records the response.
4. **Given** an unknown or timed-out order result, **When** execution retries, **Then** status by
   reference is reconciled before another order is submitted.
5. **Given** an entry is partially filled, **When** protection is created or updated, **Then** the
   remaining target/stop quantity matches the filled position quantity.
6. **Given** an unexpected broker position is detected, **When** reconciliation runs, **Then** algo
   automation is blocked and the discrepancy is recorded.

### User Story 3 - Use One Strategy With Paper or Groww Execution (Priority: P1)

As a strategy builder, I want the same validated strategy and execution interface to run through a
Paper Broker first and a Groww Broker only after promotion gates, without rewriting strategy logic.

**Independent Test**: Execute one strategy in Paper mode and then evaluate it in Groww mode using a
transport stub; verify identical strategy/risk input and different order destinations.

**Acceptance Scenarios**:

1. **Given** Paper mode, **When** an execution request is allowed, **Then** it creates a virtual
   order/fill/P&L record and makes zero Groww transport calls.
2. **Given** Groww mode without compliance approval, **When** live activation is attempted, **Then**
   activation is rejected and the system remains in a safe state.
3. **Given** Groww mode with approval but unhealthy credentials, stale data, or failed reconciliation,
   **When** a candidate reaches execution, **Then** it is blocked before broker submission.
4. **Given** a strategy version has started a live run, **When** the user edits its rules, **Then**
   a new immutable version is created and the running version is unchanged.

### User Story 4 - Learn From News Outcomes (Priority: P2)

As a product operator, I want each news event, AI interpretation, market reaction, and horizon
outcome stored so that future regime and impact calibration can be reviewed rather than assumed.

**Independent Test**: Store an event and its prediction, record market movement at 1m, 5m, 15m,
30m, 1h, and 1d, then verify accuracy and calibration records are queryable.

**Acceptance Scenarios**:

1. **Given** a news event is ingested, **When** analysis completes, **Then** source, entities,
   sentiment, impact, confidence, predicted direction, and horizon are persisted.
2. **Given** a horizon elapses, **When** the evaluator runs, **Then** realized movement and prediction
   accuracy are recorded without changing the original prediction.
3. **Given** historical outcomes show systematic overestimation, **When** a calibration review is
   generated, **Then** the system exposes the bias and does not silently relabel the old score.

### Edge Cases

- Groww token missing, expired, revoked, or rejected by the provider.
- Provider rate limit, network timeout, malformed response, or API version mismatch.
- Broker returns success without an immediately queryable order status.
- Duplicate reference ID submitted after a client retry.
- Partial fills leave a residual quantity that cannot form a valid lot.
- OCO quantity exceeds the absolute net position or protective order creation fails.
- Market data is stale, unavailable, crossed, or outside the expected session.
- News is high severity but lacks corroboration.
- News impact passes while technical, options, liquidity, R:R, or risk gates fail.
- Kill switch activates between gate evaluation and broker submission.
- Compliance approval is removed while an algo session is active.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST evaluate candidate trades in this order: News Impact, Market Regime,
  Technical Signal, Options/OI, Liquidity, R:R, Risk Engine, and Execution.
- **FR-002**: The system MUST stop at the first failed gate and persist the stage, observed value,
  threshold, decision, and human-readable reason.
- **FR-003**: News MUST be contextual input and MUST NOT submit an order independently.
- **FR-004**: News impact MUST use a configurable threshold and distinguish sentiment from impact.
- **FR-005**: High and extreme events MUST require configurable corroboration before influencing live gates.
- **FR-006**: Market regime MUST be available as an explicit allow, block, or confirmation condition.
- **FR-007**: Technical, options/OI, and liquidity confirmation MUST be independently inspectable.
- **FR-008**: The R:R gate MUST reject candidates below the configured minimum before risk or execution.
- **FR-009**: The deterministic risk engine MUST enforce capital, risk percentage, daily loss,
  open-position, trade-count, quantity, lot-size, event-risk, liquidity, and kill-switch rules.
- **FR-010**: Execution MUST be reached only after all prior gates pass.
- **FR-011**: The system MUST expose Paper Broker and Groww Broker through the same broker-neutral execution contract.
- **FR-012**: Paper Broker MUST create virtual orders, fills, protection, margin, costs, and P&L without Groww calls.
- **FR-013**: Groww credentials MUST be server-side, encrypted or externally referenced, and excluded from client logs.
- **FR-014**: Groww adapter MUST support authenticated health, quotes, order placement, modification or cancellation,
  order status, positions, trades, and reconciliation through normalized responses.
- **FR-015**: Groww order requests MUST use unique provider-compatible reference IDs and safe retry semantics.
- **FR-016**: Unknown order status MUST be reconciled by provider order ID or reference before retry.
- **FR-017**: Groww protective execution MUST support OCO/SL/target behavior where the current provider capability allows it.
- **FR-018**: Partial fills MUST update remaining protection and position quantities.
- **FR-019**: Unexpected broker positions MUST block automation until reconciled.
- **FR-020**: Live execution MUST require explicit live enablement and current compliance approval in addition to all gates.
- **FR-021**: A kill switch MUST block new orders immediately, including between gate evaluation and submission.
- **FR-022**: Strategy versions used by live runs MUST be immutable.
- **FR-023**: The system MUST store each news event, AI prediction, market reaction, outcome horizon, and accuracy result.
- **FR-024**: Outcome horizons MUST include 1m, 5m, 15m, 30m, 1h, and 1d.
- **FR-025**: The system MUST preserve original predictions when later calibration identifies bias.
- **FR-026**: The UI MUST show the active broker, mode, gate currently being evaluated, failed gate reason,
  credential/session health, data freshness, and kill-switch state.

### Key Entities

- **AlgoFlowEvaluation**: Ordered gate results, current stage, final decision, correlation ID, and reasons.
- **GateResult**: Gate name, observed value, threshold, pass/fail, evidence, and timestamp.
- **BrokerConnection**: Broker, credential reference, health, permissions, API version, and approval state.
- **BrokerOrder**: Internal order, provider order ID, reference ID, status, fills, and retry history.
- **ProtectionPlan**: Target, stop, OCO/SL legs, filled quantity, remaining quantity, and state.
- **PaperAccount**: Virtual capital, orders, fills, positions, margin, costs, and P&L.
- **NewsOutcome**: Event, prediction, horizon, realized move, accuracy, and calibration review state.
- **PromotionEvidence**: Out-of-sample, walk-forward, paper, assisted, capped-live, consent, and compliance evidence.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of candidate evaluations produce an ordered gate trace with no skipped gate.
- **SC-002**: 100% of failed pre-execution gates produce zero broker order calls in automated tests.
- **SC-003**: Paper-mode evaluations produce zero Groww transport calls across 100 consecutive simulated orders.
- **SC-004**: Every Groww order has a unique reference ID and a reconciled final status before completion.
- **SC-005**: Missing credentials, failed health, stale data, unexpected position, or compliance failure block all live entries.
- **SC-006**: Partial-fill tests leave protection quantity equal to the filled position quantity.
- **SC-007**: A strategy can move from Paper Broker to Groww Broker by changing execution configuration only.
- **SC-008**: News outcome records are available for all six required horizons with preserved original predictions.
- **SC-009**: Users can identify the active gate, reason, broker, mode, freshness, and kill-switch state within three interactions.
- **SC-010**: Live execution remains disabled by default in local and test environments.

## Assumptions

- Groww API credentials are supplied by an authorized operator through environment or secret-manager configuration.
- The provider's current API documentation, permissions, rate limits, and retail-algo requirements are revalidated before launch.
- Market data may be delayed or unavailable; the system fails closed instead of fabricating live state.
- Paper Broker is the default execution target for development and validation.
- The supplied flow charts describe decision order and architecture, not a promise that any signal is profitable.
- Future Kite, Upstox, Angel One, or other adapters will implement the same broker-neutral contract.