# NIFTY Options Strategy V5 Compliance Remediation

## Overview

This feature makes the NIFTY options algo-trading page fail closed against the V5 master prompt. It establishes a single Python decision pipeline for paper analysis, blocks live execution until production-readiness controls exist, and records explicit evidence for every completed requirement. It does not claim profitability or authorize live capital.

## Goals

- Ensure every paper trade decision passes deterministic data, session, strategy, liquidity, risk, and execution gates.
- Ensure incomplete or unavailable V5 inputs produce `NO_TRADE` with machine-readable reasons.
- Keep live broker execution disabled until risk management, reconciliation, SAFE_MODE, contract metadata, and readiness checks are implemented and tested.
- Provide deterministic end-to-end scenarios A-N from the master prompt.
- Keep task status honest: a task is checked only when code, tests, documentation, and acceptance evidence exist.

## User Scenarios & Testing

### User Story 1: Safe paper analysis
As an algo-trading user, I want the execution page to receive one explainable decision from the V5 pipeline so stale, incomplete, ambiguous, or unsafe market states cannot become a trade plan.

Acceptance scenarios:
- Valid data and all required gates produce an explainable candidate or confirmed plan.
- Stale, missing, invalid, unresolved-gap, CHOP, low-liquidity, extreme-VIX, insufficient-RR, or risk-locked inputs produce `NO_TRADE`.
- Identical inputs produce identical output and rejection ordering.

### User Story 2: Protected execution boundary
As a risk owner, I want all order routes to remain paper-only until readiness evidence exists, so a UI or direct API caller cannot bypass V5 controls.

Acceptance scenarios:
- Any live order request returns a deterministic blocked response.
- Paper orders require a confirmed plan, valid contract metadata, valid quantity, structural stop, target, and minimum 2.0R.
- SAFE_MODE, kill-switch, reconciliation failure, missing metadata, or unavailable risk approval blocks entries.

### User Story 3: Auditable requirement verification
As a production reviewer, I want each V5 task mapped to code, tests, and evidence so release status is independently verifiable.

Acceptance scenarios:
- `spec.md`, `plan.md`, traceability, and gap documents agree on status.
- Scenarios A-N are represented by deterministic tests.
- No incomplete task is marked checked.

## Functional Requirements

- FR-001: The system MUST expose one central fail-closed Python pipeline for algo-page analysis.
- FR-002: The pipeline MUST evaluate data quality, session, gap, regime, strategy, score, option, liquidity, RR, daily risk, SAFE_MODE, and execution readiness gates in a deterministic order.
- FR-003: Every failed gate MUST return machine-readable rejection codes and preserve all applicable reasons.
- FR-004: Missing required V5 engines or unavailable required data MUST result in `NO_TRADE`, never an inferred positive signal.
- FR-005: The pipeline MUST not place broker orders or embed broker calls in signal calculation.
- FR-006: The live API route MUST remain disabled until risk manager, reconciliation, contract master, SAFE_MODE, execution state machine, and production-readiness checks are implemented and evidenced.
- FR-007: Paper order validation MUST enforce confirmed analysis, live contract metadata, valid lot/freeze constraints, directional structural risk, and RR >= 2.0.
- FR-008: The implementation MUST preserve deterministic behavior for identical serialized inputs.
- FR-009: Tests MUST cover the V5 failure paths and deterministic scenarios A-N.
- FR-010: Documentation MUST distinguish implemented, partial, missing, blocked, and verified requirements.

## Non-Functional Requirements

- NFR-001: No live execution is enabled by default or by a UI confirmation alone.
- NFR-002: Rejection reasons and decisions are auditable and serializable.
- NFR-003: The pipeline is isolated from broker adapters and can run in unit tests without network access.
- NFR-004: The full regression suite must pass before a task can be marked complete.

## Key Entities

- `PipelineInput`: serialized market, option, session, risk, broker, and readiness evidence.
- `GateResult`: deterministic pass/fail result with code, message, observed value, and threshold.
- `PipelineDecision`: `CONFIRMED`, `WAITING`, or `NO_TRADE`, with ordered gates, reasons, and optional trade plan.
- `ReadinessState`: explicit evidence for live execution prerequisites.

## Scope Boundaries

This remediation does not declare the complete V5 strategy implemented. Indicator correctness, gap/regime engines, option analytics, contract master, risk manager, execution state machine, reconciliation, backtesting, and production readiness remain separate tasks until their acceptance evidence exists.

## Success Criteria

- SC-001: All required V5 gate tests and scenarios A-N pass deterministically.
- SC-002: Direct live order requests are blocked 100% of the time while readiness is incomplete.
- SC-003: Every `NO_TRADE` result contains at least one machine-readable reason.
- SC-004: Repeated pipeline evaluation with identical input yields byte-equivalent decision data after volatile timestamps are excluded from input.
- SC-005: Full Python regression and web type/build checks pass.
- SC-006: Traceability reports contain no unchecked task marked as complete and no unexplained PASS status.

## Assumptions

- Historical option-chain data, contract metadata, and production broker evidence are not fabricated when unavailable.
- Paper mode is the only permitted execution mode during this remediation.
- The existing V5 master prompt and merged strategy document remain the normative trading requirements.
