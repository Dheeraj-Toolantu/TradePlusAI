---

description: "Executable task list for Groww Algo Trading and Explainable Flow Gates"
---

# Tasks: Groww Algo Trading and Explainable Flow Gates

**Input**: Design documents from `specs/002-groww-algo-trading/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts](contracts/), and [quickstart.md](quickstart.md)

**Tests**: Included because the constitution and feature specification require contract, security,
flow-gate, reconciliation, paper-isolation, and outcome validation.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish safe Groww configuration and feature-specific database/event foundations.

- [x] T001 Add server-only Groww configuration validation for `GROWW_API_BASE_URL`, `GROWW_API_VERSION`, `GROWW_ACCESS_TOKEN`, `LIVE_EXECUTION_ENABLED`, and `LIVE_COMPLIANCE_APPROVED` in `services/execution/src/groww-config.ts`.
- [x] T002 [P] Add the Groww configuration template and secret-handling notes in `.env.groww.example` and `docs/compliance/live-readiness.md`.
- [x] T003 [P] Add database migration tables for flow evaluations, gate results, broker connections, protection plans, news outcomes, and promotion evidence in `infra/database/migrations/003-groww-algo.sql`.
- [x] T004 [P] Add feature-scoped fixture candidates for pass, news-blocked, R:R-blocked, risk-blocked, stale-data, and Groww failure cases in `tests/fixtures/groww-algo-flow.json`.

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish shared flow, broker, execution-mode, audit, and safe-state contracts before stories.

- [x] T005 Define AlgoFlowEvaluation and GateResult types with ordered stage literals in `packages/domain-contracts/src/algo-flow.ts`.
- [x] T006 [P] Define BrokerConnection, BrokerOrder, ProtectionPlan, PaperAccount, NewsOutcome, and PromotionEvidence types in `packages/domain-contracts/src/groww-algo-entities.ts`.
- [x] T007 [P] Extend the broker-neutral interface with quotes, positions, order lifecycle, reconciliation, and protection operations in `packages/broker-contracts/src/broker-adapter.ts`.
- [x] T008 [P] Define Paper/Groww execution-mode capabilities and live-release preconditions in `packages/domain-contracts/src/execution-modes.ts`.
- [x] T009 [P] Add append-only flow and provider-event audit persistence helpers in `services/audit/src/groww-audit.ts`.
- [x] T010 [P] Add realtime events for `algo.gate_updated`, `broker.health_changed`, `order.updated`, `protection.updated`, `reconciliation.required`, and `news.outcome_recorded` in `packages/event-schemas/src/groww-events.ts`.
- [x] T011 Add foundational contract tests for stage ordering, mode isolation, secret redaction, and live-release preconditions in `tests/contract/groww-foundation.test.ts`.

## Phase 3: User Story 1 - Evaluate a Setup Through Ordered Gates (Priority: P1) 🎯 MVP

**Goal**: Evaluate every candidate through the supplied flow-chart sequence, stop at the first failed gate, and produce no broker side effect before full approval.

**Independent Test**: Run one candidate through each failed gate and one all-pass candidate; assert stage, reason, persisted trace, and zero provider calls for every blocked result.

### Tests for User Story 1

- [x] T012 [P] [US1] Add first-failure tests for NEWS, REGIME, TECHNICAL, OPTIONS, LIQUIDITY, R:R, and RISK in `tests/unit/algo-flow-gate.test.ts`.
- [x] T013 [P] [US1] Add no-side-effect integration tests proving blocked flow results do not call `ExecutionService` in `tests/integration/algo-flow-side-effects.test.ts`.
- [x] T014 [P] [US1] Add persistence/event tests for ordered GateResult records and current-stage updates in `tests/integration/algo-flow-audit.test.ts`.

### Implementation for User Story 1

- [x] T015 [US1] Implement ordered gate evaluation and first-failure results in `services/strategy/src/algo-flow-gate.ts`.
- [x] T016 [US1] Implement gate-result persistence and correlation IDs in `services/strategy/src/algo-flow-service.ts`.
- [x] T017 [US1] Integrate existing deterministic R:R/risk evaluation into the flow at `services/risk/src/risk-gate.ts` and `services/strategy/src/algo-flow-service.ts`.
- [x] T018 [US1] Add execution boundary enforcement so only an `EXECUTION` flow result can create an execution request in `services/execution/src/flow-execution-boundary.ts`.
- [x] T019 [US1] Add authenticated flow-status and failed-gate routes in `apps/api/src/routes/algo-flow.ts`.
- [x] T020 [US1] Add the active-gate, evidence, reason, broker, mode, freshness, and kill-switch presentation to `apps/web/app/execution/page.tsx`.

## Phase 4: User Story 2 - Connect Groww Through a Dedicated Adapter (Priority: P1)

**Goal**: Provide a real server-side Groww adapter with normalized responses, safe errors, idempotency, status reconciliation, positions, and protection.

**Independent Test**: Run transport-stub tests through health, quotes, order, status, cancel, position, reconciliation, missing token, provider failure, and OCO paths.

### Tests for User Story 2

- [x] T021 [P] [US2] Add missing/invalid/expired credential and secret-redaction tests in `tests/security/groww-credentials.test.ts`.
- [x] T022 [P] [US2] Add Groww HTTP request/header and response-normalization tests in `tests/contract/groww-http-adapter.test.ts`.
- [x] T023 [P] [US2] Add order timeout, unknown status, reference lookup, duplicate prevention, and cancellation tests in `tests/integration/groww-order-lifecycle.test.ts`.
- [x] T024 [P] [US2] Add partial-fill, OCO quantity, protection failure, and unexpected-position tests in `tests/integration/groww-protection-reconciliation.test.ts`.

### Implementation for User Story 2

- [x] T025 [P] [US2] Implement server-only Groww environment validation and transport creation in `services/execution/src/groww-config.ts` and `adapters/groww/src/groww-adapter.ts`.
- [x] T026 [US2] Implement normalized Groww health and quote operations in `adapters/groww/src/groww-adapter.ts`.
- [x] T027 [US2] Implement normalized Groww order placement, status-by-reference, cancellation, positions, and structured errors in `adapters/groww/src/groww-adapter.ts`.
- [x] T028 [US2] Implement reference-ID retry/reconciliation orchestration in `services/execution/src/execution-service.ts`.
- [x] T029 [US2] Implement Groww OCO/SL/target request mapping and capability validation in `adapters/groww/src/groww-smart-orders.ts`.
- [x] T030 [US2] Implement partial-fill protection updates and emergency-protection transitions in `services/execution/src/protection-service.ts`.
- [x] T031 [US2] Implement broker position reconciliation and automation-blocking discrepancy records in `services/reconciliation/src/reconciliation-service.ts`.
- [x] T032 [US2] Add authenticated Groww connection, health, reconciliation, and execution routes in `apps/api/src/routes/execution.ts`.

## Phase 5: User Story 3 - Use One Strategy With Paper or Groww Execution (Priority: P1)

**Goal**: Promote one immutable strategy from Paper Broker to Groww Broker without changing strategy logic.

**Independent Test**: Run identical strategy/risk inputs through Paper and Groww transport stubs; verify different destinations, identical inputs, and live preconditions.

### Tests for User Story 3

- [x] T033 [P] [US3] Add 100-order Paper Broker isolation tests with zero Groww transport calls in `tests/security/paper-groww-isolation.test.ts`.
- [x] T034 [P] [US3] Add execution-mode parity tests for identical strategy/risk input and different destinations in `tests/integration/execution-mode-parity.test.ts`.
- [x] T035 [P] [US3] Add promotion, consent, compliance, immutable-version, and kill-switch tests in `tests/security/groww-live-activation.test.ts`.

### Implementation for User Story 3

- [x] T036 [US3] Implement Paper Broker adapter using the shared broker contract in `services/paper-trading/src/paper-broker-adapter.ts`.
- [x] T037 [US3] Implement execution target selection and mode isolation in `services/execution/src/execution-target.ts`.
- [x] T038 [US3] Integrate promotion evidence and immutable strategy references into Groww activation in `services/strategy/src/promotion-gates.ts` and `services/strategy/src/strategy-version-service.ts`.
- [x] T039 [US3] Implement live-release checks for all flow gates, broker health, reconciliation, explicit activation, compliance, and flags in `services/execution/src/live-release-policy.ts`.
- [x] T040 [US3] Add Paper/Groww broker selection, promotion state, session health, and blocked-reason UI to `apps/web/app/execution/page.tsx` and `apps/web/app/validation/page.tsx`.

## Phase 6: User Story 4 - Learn From News Outcomes (Priority: P2)

**Goal**: Store immutable news predictions and evaluate realized market reactions across six horizons for calibration.

**Independent Test**: Ingest one event, persist its prediction, record all six horizon outcomes, and verify accuracy/calibration records without mutating the original prediction.

### Tests for User Story 4

- [x] T041 [P] [US4] Add immutable event/prediction persistence tests in `tests/unit/news-outcome-model.test.ts`.
- [x] T042 [P] [US4] Add six-horizon outcome evaluation and accuracy tests in `tests/integration/news-outcome-horizons.test.ts`.
- [x] T043 [P] [US4] Add calibration-bias report tests proving historical predictions remain unchanged in `tests/integration/news-calibration.test.ts`.

### Implementation for User Story 4

- [x] T044 [P] [US4] Implement NewsOutcome persistence and immutable prediction records in `services/news-intelligence/src/news-outcome-repository.ts`.
- [x] T045 [US4] Implement 1m/5m/15m/30m/1h/1d market-reaction evaluation in `services/news-intelligence/src/outcome-evaluator.ts`.
- [x] T046 [US4] Implement accuracy and calibration-bias reporting without retroactive mutation in `services/news-intelligence/src/calibration-service.ts`.
- [x] T047 [US4] Add news outcome, horizon, accuracy, and calibration routes in `apps/api/src/routes/intelligence.ts`.
- [x] T048 [US4] Add news outcome history and calibration-bias presentation to `apps/web/app/intelligence/page.tsx`.

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Harden the Groww feature, validate release behavior, and preserve the live safety posture.

- [x] T049 [P] Add Groww/flow observability dashboards and alerts for gate latency, provider errors, unknown orders, protection failures, and reconciliation in `infra/observability/dashboards/groww-algo-alerts.json`.
- [x] T050 [P] Add live-order secret scanning, server-only environment checks, and dependency security checks in `.github/workflows/security.yml`.
- [x] T051 [P] Add end-to-end flow-to-paper validation in `tests/e2e/groww-algo-paper-flow.spec.ts`.
- [x] T052 [P] Add end-to-end fail-closed validation for missing token, stale data, provider outage, kill switch, and unexpected position in `tests/e2e/groww-safe-state.spec.ts`.
- [x] T053 Review UI labels for active gate, broker, mode, data freshness, compliance status, and kill switch in `apps/web/components/`.
- [x] T054 Run the complete Groww quickstart and record evidence in `docs/release-validation.md`.
- [x] T055 Revalidate current Groww API capabilities, permissions, rate limits, exchange requirements, SEBI obligations, consent, and disclosures in `docs/compliance/live-readiness.md`.
- [x] T056 Keep `LIVE_EXECUTION_ENABLED=false` and `LIVE_COMPLIANCE_APPROVED=false` in local/test environments and verify the release guard in `services/execution/src/live-release-policy.ts`.

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**: No dependencies; T001-T004 can proceed in parallel.
- **Phase 2 Foundational**: Depends on setup; blocks all user stories.
- **US1**: Depends on foundational contracts; recommended MVP and no broker side effects.
- **US2**: Depends on broker contracts and US1 execution boundary; can use transport stubs.
- **US3**: Depends on US1 and US2; Paper/Groww parity and live-release evidence.
- **US4**: Depends on existing news intelligence and event contracts; can proceed in parallel with US2/US3.
- **Polish**: Depends on the stories included in the release candidate; must complete before live review.

### User Story Dependencies

- **US1 (P1)**: Starts after Phase 2; no broker dependency; recommended MVP.
- **US2 (P1)**: Starts after Phase 2; integrates with the US1 execution boundary.
- **US3 (P1)**: Depends on US1 flow approval and US2 broker adapter.
- **US4 (P2)**: Can proceed after Phase 2 and existing news event contracts.

### Parallel Opportunities

- T001-T004 can run in parallel.
- T005-T010 can run in parallel by contract/service ownership.
- US1 gate tests and audit tests can run in parallel before gate integration.
- US2 transport, credential, lifecycle, and protection tests can run in parallel.
- US3 Paper Broker, promotion, and UI work can run in parallel after adapter contracts.
- US4 repository, horizon evaluator, calibration, and UI work can run in parallel.
- Polish observability, security, e2e, compliance, and UI review tasks can run in parallel.

## Parallel Example: User Story 1

```text
T012 flow gate unit tests
T013 no-side-effect integration tests
T014 ordered audit tests
T015 algo-flow-gate implementation
```

## Parallel Example: User Story 2

```text
T021 credential security tests
T022 HTTP adapter contract tests
T023 order lifecycle tests
T024 protection/reconciliation tests
T025 Groww transport configuration
```

## Implementation Strategy

### MVP First

1. Complete Phase 1 Setup and Phase 2 Foundational.
2. Complete US1 ordered flow gates and first-failure audit.
3. Validate the flow entirely in Paper mode.
4. Stop before enabling any Groww order submission.

### Incremental Delivery

1. Add US2 Groww adapter against transport stubs.
2. Add US3 Paper/Groww parity and promotion/live-release checks.
3. Add US4 immutable news outcomes and calibration reports.
4. Complete polish, security, operational, compliance, and release evidence.
5. Enable live execution only after explicit authorized review changes both live flags.

### Format Validation

Every task uses `- [ ] T###`, includes `[P]` only when independently parallelizable,
includes `[US#]` in story phases, and names an exact repository path. IDs are sequential T001-T056.
