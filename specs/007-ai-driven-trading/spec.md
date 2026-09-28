# Feature Specification: AI-Driven Trading Monitor and Gated Automation

**Feature Branch**: `007-ai-driven-trading`

**Created**: 2026-09-20

**Status**: Draft

**Input**: User description: "Create a specification where the algo trading page is handled through an AI model using LiteLLM. When a user enables AI-driven trading, the model continuously monitors real-time charts and Indian market trends, behaves as an expert NIFTY, BANKNIFTY, and SENSEX options trader, and when it predicts bearish or bullish confirmation, it enables auto trading on the algo trading page. Provide a log where the user can see suggestions provided by the model."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Enable AI Market Monitoring (Priority: P1)

As an algo-trading user, I want to explicitly enable AI-driven monitoring for selected Indian-market instruments and timeframes so that I can receive ongoing analysis without accidentally activating automation.

**Why this priority**: Monitoring is the foundation of the feature, and explicit activation protects users from unexpected model activity or order behavior.

**Independent Test**: Select an eligible instrument, timeframe, and paper or assisted mode, enable AI monitoring, and verify that monitoring starts with a visible status, configuration, and safe-state controls.

**Acceptance Scenarios**:

1. **Given** the user has selected a supported NIFTY, BANKNIFTY, or SENSEX underlying or option and a supported timeframe, **When** the user enables AI monitoring, **Then** the page shows monitoring as active, displays the selected scope, and records who enabled it and when.
2. **Given** the user has not explicitly enabled AI monitoring, **When** market data arrives, **Then** the system may continue ordinary chart analysis but must not request AI-driven automation or submit an order.
3. **Given** monitoring is active, **When** the user disables it or the kill switch is activated, **Then** new AI suggestions and automation actions stop and the page shows the stopped reason.

---

### User Story 2 - Receive Explainable Bullish or Bearish Suggestions (Priority: P1)

As a trader, I want the AI to continuously assess current charts and relevant Indian-market trends and explain bullish, bearish, neutral, or no-trade suggestions so that I can evaluate the model's reasoning before relying on it.

**Why this priority**: The user needs evidence and context, not an opaque direction label, especially when options and fast-moving markets are involved.

**Independent Test**: Replay deterministic market snapshots while monitoring is active and verify that each completed evaluation produces a suggestion, evidence summary, confidence, invalidation, freshness, and model status without modifying deterministic risk outputs.

**Acceptance Scenarios**:

1. **Given** fresh, valid chart and market context, **When** an evaluation completes, **Then** the page displays the model direction, confidence, evidence used, suggested instrument or setup, entry conditions, invalidation, and timestamp.
2. **Given** the model predicts a bullish or bearish direction but deterministic strategy or risk gates do not confirm an actionable setup, **When** the evaluation completes, **Then** the system shows the suggestion as advisory or waiting and does not enable automation.
3. **Given** the model has insufficient context, conflicting timeframes, stale data, or an unavailable provider, **When** evaluation runs, **Then** it returns an explicit neutral, no-trade, or unavailable state with the blocking reason.

---

### User Story 3 - Review the AI Suggestion Log (Priority: P1)

As a trader or reviewer, I want a searchable chronological log of AI suggestions and outcomes so that I can understand what the model recommended and compare suggestions with later market and order results.

**Why this priority**: A durable audit trail is necessary for trust, troubleshooting, strategy review, and responsible automation.

**Independent Test**: Generate suggestions across multiple instruments and outcomes, open the log, filter it, and verify that each record preserves the original evidence, model status, user configuration, automation decision, and outcome without being overwritten by later updates.

**Acceptance Scenarios**:

1. **Given** one or more completed evaluations, **When** the user opens the AI log, **Then** records appear newest first with instrument, timeframe, direction, confidence, recommendation, decision, timestamp, and status.
2. **Given** a logged bullish or bearish suggestion, **When** the user opens its details, **Then** the system shows the market snapshot references, deterministic analysis, model explanation, risk checks, automation decision, and any rejection reason.
3. **Given** the user filters by instrument, direction, date range, confidence, or outcome, **When** the filter is applied, **Then** only matching immutable records are shown and the total result count is visible.

---

### User Story 4 - Approve Gated Auto Trading (Priority: P1)

As a trader, I want an explicit automation mode that can act only after AI confirmation and all existing strategy, risk, market-data, session, contract, and broker-readiness gates pass so that model output cannot bypass trading safeguards.

**Why this priority**: Automation has financial consequences and must remain subordinate to deterministic controls and the selected execution mode.

**Independent Test**: Replay confirmed and rejected scenarios in paper mode and verify that only a fully qualified decision produces an automation request, while every failure remains visible and produces no order side effect.

**Acceptance Scenarios**:

1. **Given** AI monitoring is enabled, a current bullish or bearish suggestion is confirmed, and all deterministic gates pass, **When** automation mode is enabled, **Then** the system creates an auditable automation decision for the permitted mode and shows its protective levels and quantity.
2. **Given** any required data, session, strategy, liquidity, risk, contract, broker-health, reconciliation, kill-switch, or readiness gate fails, **When** the AI produces a direction, **Then** automation remains disabled for that evaluation and the user sees the failed gate.
3. **Given** the selected mode is PAPER, **When** an automated decision is approved, **Then** it can affect paper trading only and cannot call a live broker order destination.
4. **Given** the selected mode is ASSISTED, **When** an automated decision is approved, **Then** the system prepares the permitted assisted-trading action and requires the existing user confirmation before order submission.
5. **Given** ALGO LIVE is unavailable or not formally approved, **When** the user attempts to enable it, **Then** the system refuses activation and displays the readiness requirements.

---

### User Story 5 - Stop, Recover, and Investigate AI Trading (Priority: P2)

As a trader or risk owner, I want monitoring, automation, and model failures to fail closed and be recoverable so that an outage or unexpected suggestion cannot create uncontrolled activity.

**Why this priority**: Continuous monitoring depends on live data and model availability; safe recovery is essential for a feature that may operate unattended.

**Independent Test**: Interrupt market data, the model provider, chart processing, and broker status independently, then verify that new automation stops, the reason is logged, existing positions remain governed by existing risk controls, and monitoring can resume only after recovery checks pass.

**Acceptance Scenarios**:

1. **Given** chart data becomes stale, missing, invalid, or discontinuous, **When** the next evaluation is due, **Then** the system marks monitoring unsafe, produces no new automation decision, and records the data-quality reason.
2. **Given** the AI provider times out, returns malformed output, or becomes unavailable, **When** evaluation is due, **Then** deterministic analysis remains available, no new automation is enabled, and the failure is logged without fabricated model output.
3. **Given** a previously confirmed suggestion becomes invalid before execution, **When** the next evaluation runs, **Then** the automation decision is cancelled or blocked and the original suggestion remains preserved in the log.

### Edge Cases

- A bullish or bearish model prediction with no aligned option contract, invalid expiry, unavailable lot size, or insufficient liquidity remains non-actionable.
- Underlying and option directions conflict; the conflict is shown and blocks or reduces confirmation according to the configured deterministic policy.
- Multiple evaluations arrive close together; only one current decision may create an automation request for the same instrument and setup identity.
- Repeated equivalent suggestions are grouped for display but each evaluation remains traceable and cannot overwrite the original record.
- Market session is closed, outside the configured entry window, or halted; monitoring may summarize context but cannot create a new automation request.
- A user changes mode, risk limits, instruments, or timeframes while monitoring is active; the current evaluation is invalidated and the change is logged.
- Model confidence is high but required evidence is missing; confidence does not override data-quality or risk gates.
- AI explanations must not claim guaranteed profit, certainty, or risk-free performance.
- A provider response contains unsupported instructions or attempts to alter risk limits; the response is rejected and logged as unsafe.
- The user loses permission, session validity, or broker connectivity while automation is enabled; new actions stop until authorization and health are re-established.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide an explicit, user-controlled AI monitoring setting that is separate from the execution-mode setting.
- **FR-002**: The system MUST support AI monitoring for configured NIFTY, BANKNIFTY, and SENSEX underlyings and their eligible options, subject to existing instrument and market-data availability.
- **FR-003**: The system MUST continuously evaluate fresh chart data and configured Indian-market context while monitoring is active, using the user's selected instruments, timeframes, and strategy configuration.
- **FR-004**: The system MUST represent every completed model evaluation as bullish, bearish, neutral, no-trade, waiting, or unavailable, with timestamp, freshness, confidence, and evaluation status.
- **FR-005**: The system MUST provide the model with bounded, relevant market context and MUST reject evaluations when required context is stale, invalid, incomplete, or outside the configured scope.
- **FR-006**: The system MUST display the evidence supporting each bullish or bearish suggestion, including relevant trend, structure, momentum, volume, support/resistance, option alignment, timeframe alignment, and risk conditions when available.
- **FR-007**: The system MUST keep AI-generated direction, explanation, or confidence separate from deterministic prices, stops, targets, position size, risk limits, and gate results.
- **FR-008**: The system MUST NOT allow an AI response to change strategy configuration, risk limits, quantity limits, kill-switch state, execution mode, or readiness state.
- **FR-009**: The system MUST require a current bullish or bearish AI suggestion, applicable deterministic confirmation, valid market data, open session, eligible instrument, valid option contract, acceptable liquidity, minimum risk/reward, daily risk capacity, and all existing safety gates before creating an automation decision.
- **FR-010**: The system MUST treat AI confirmation as an additional gate and MUST never use it to bypass or weaken an existing fail-closed gate.
- **FR-011**: The system MUST keep PAPER, ASSISTED, and ALGO LIVE modes visibly distinct and enforce the permissions of each mode.
- **FR-012**: Automated decisions in PAPER mode MUST be technically unable to submit live broker orders; ASSISTED mode MUST preserve the existing user confirmation boundary; ALGO LIVE MUST remain unavailable until existing production-readiness and compliance approvals are complete.
- **FR-013**: The system MUST show the current monitoring state, model health, data freshness, execution mode, automation state, active risk limits, and blocking reason on the algo-trading page.
- **FR-014**: The system MUST provide a chronological AI suggestion log containing immutable evaluation records, including instrument, underlying, option contract when applicable, timeframe, direction, confidence, evidence, model explanation, deterministic decision, risk decision, automation decision, user configuration, and timestamps.
- **FR-015**: Users MUST be able to filter and inspect log records by instrument, direction, date range, confidence, monitoring session, and automation outcome.
- **FR-016**: The system MUST record who enabled, disabled, approved, or stopped monitoring and automation, including the reason and effective time.
- **FR-017**: The system MUST record all automation requests, blocked attempts, cancellations, rejections, order identifiers, fills, and exits using the existing append-only audit boundaries.
- **FR-018**: The system MUST fail closed for stale or invalid data, model timeout, malformed model output, provider unavailability, authorization failure, broker-health failure, reconciliation failure, kill-switch activation, and uncertain order state.
- **FR-019**: When AI services are unavailable, the system MUST keep deterministic chart and risk analysis available where possible and MUST clearly mark AI output unavailable without fabricating a suggestion.
- **FR-020**: The system MUST prevent duplicate automation requests for the same current instrument, setup identity, direction, and evaluation window.
- **FR-021**: The system MUST preserve the original model input references, output, decision, and gate results for later review even when a suggestion is invalidated, superseded, or grouped in the user interface.
- **FR-022**: The system MUST expose user-friendly reasons when a suggestion cannot enable automation, including the failed gate and the observed condition where available.
- **FR-023**: The system MUST protect credentials, provider configuration, and sensitive market or account information from browser bundles and ordinary user-visible logs.
- **FR-024**: The system MUST support configured model-provider routing through the platform's approved model gateway, including LiteLLM-compatible routing, without making the model provider part of the trading decision contract.
- **FR-025**: AI-generated text MUST avoid claims of guaranteed profit, guaranteed accuracy, certainty, or risk-free returns and MUST identify that market outcomes remain uncertain.
- **FR-026**: Historical and paper evaluations MUST be distinguishable from live outcomes, and AI suggestions MUST be attributable to the model configuration and version used at evaluation time.

### Key Entities

- **AITradingConfiguration**: User-controlled monitoring scope, instruments, timeframes, context sources, confidence threshold, execution mode, automation setting, and risk acknowledgements.
- **AIEvaluation**: One model evaluation with bounded input references, timestamp, freshness, direction, confidence, evidence, explanation, model status, and configuration version.
- **AISuggestion**: A user-facing bullish, bearish, neutral, waiting, no-trade, or unavailable recommendation linked to an evaluation and deterministic setup.
- **AutomationDecision**: The decision to permit, prepare, block, cancel, or submit an action, including all safety gates, mode, quantity, protective levels, and reason.
- **AISuggestionLogEntry**: Immutable audit-oriented record of an evaluation, suggestion, user action, automation decision, and later outcome.
- **ModelProviderStatus**: Availability, latency, validation status, routing configuration, and error state for the approved AI model gateway.
- **MonitoringSession**: Start, stop, scope changes, health events, and terminal state for a user's AI monitoring period.
- **MarketContextSnapshot**: Time-bounded chart, trend, option, session, liquidity, and risk evidence supplied to an evaluation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In 100% of tests, AI monitoring remains inactive until the user explicitly enables it, and disabling monitoring prevents new AI automation decisions.
- **SC-002**: At least 95% of valid scheduled evaluations display a current status, direction or non-actionable state, confidence, timestamp, freshness, evidence summary, and blocking or invalidation reason within 10 seconds of the evaluation completing.
- **SC-003**: 100% of evaluations with stale, invalid, incomplete, or conflicting required context produce no new automation decision and preserve the blocking reason.
- **SC-004**: 100% of automation fixtures with any failed deterministic safety gate produce no order side effect, while the failed gate is visible in the page and suggestion log.
- **SC-005**: 100% of PAPER-mode automation fixtures are prevented from reaching a live broker order destination, and 100% of ASSISTED-mode fixtures require the existing user confirmation boundary.
- **SC-006**: 100% of completed evaluations create an immutable suggestion-log record that can be opened later with its original evidence, model configuration, deterministic decision, and automation outcome.
- **SC-007**: At least 90% of usability-test participants can identify the current AI state, execution mode, latest suggestion, confidence, and reason automation is blocked or enabled within 60 seconds.
- **SC-008**: Replaying identical market context, strategy configuration, model configuration, and evaluation time produces the same validated suggestion category and deterministic automation outcome in 100 out of 100 repeated paper evaluations, apart from permitted timestamps and provider metadata.
- **SC-009**: 100% of model timeout, malformed-output, provider-unavailable, authorization, broker-health, reconciliation, and kill-switch fixtures fail closed and leave deterministic analysis available when its own inputs are valid.
- **SC-010**: No user-visible AI output, log entry, or automation explanation claims guaranteed profit, guaranteed accuracy, certainty, or risk-free performance.
- **SC-011**: Users can find a suggestion's evidence, invalidation condition, failed gates, and resulting automation outcome from the log without consulting source code or raw infrastructure logs.

## Assumptions

- The first release operates within the existing PAPER and ASSISTED boundaries; ALGO LIVE remains blocked until the platform's existing readiness, compliance, and risk approvals are complete.
- The deterministic V5 pipeline, no-trade engine, risk controls, contract metadata, session gates, audit records, reconciliation, and kill switch remain authoritative for execution.
- AI is used to monitor, summarize, classify, and propose; it does not calculate authoritative trade levels or independently submit live orders.
- LiteLLM-compatible provider routing is available through an approved server-side model gateway, while provider credentials remain server-side.
- Monitoring cadence, supported timeframes, context sources, retention, and confidence thresholds use existing platform configuration unless a later product decision changes them.
- Suggestions, model configurations, and outcomes are retained according to existing audit and data-retention policies.
- Users understand that AI suggestions are probabilistic analysis and not financial guarantees or personalized regulatory advice.
