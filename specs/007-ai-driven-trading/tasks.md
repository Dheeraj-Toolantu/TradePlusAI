---

description: "Executable task list for AI-driven trading monitor and gated automation"
---

# Tasks: AI-Driven Trading Monitor and Gated Automation

**Input**: Design documents from `specs/007-ai-driven-trading/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: Included because the specification and constitution require acceptance, security, audit, mode-isolation, and deterministic replay coverage.

**Organization**: Tasks are grouped by user story so each story can be implemented and validated as an independent increment after the foundational contracts are complete.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel with other tasks in the same phase when prerequisites are complete.
- **[Story]**: Maps the task to a user story from `spec.md`.
- Every task names the exact file or directory it changes.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish source directories, configuration boundaries, and deterministic fixtures without changing execution behavior.

- [X] T001 Create the AI monitoring service directory and module placeholders under `services/ai-monitoring/src/` according to `specs/007-ai-driven-trading/plan.md`.
- [X] T002 [P] Add server-side model-gateway configuration placeholders and secret-name documentation in `.env.example` and `.env.groww.example` without adding provider credentials.
- [X] T003 [P] Add shared AI monitoring fixture builders under `tests/fixtures/ai-monitoring.ts` for fresh, stale, malformed, unavailable, bullish, bearish, and blocked contexts.
- [X] T004 [P] Add the quant-side context contract fixture scaffold under `quant/tests/fixtures/ai_context.json` without changing the deterministic engine output contract.
- [X] T005 Document the feature-specific local test commands and required PAPER-mode environment in `specs/007-ai-driven-trading/quickstart.md`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Implement the shared contracts, bounded context, persistence boundaries, and safety evaluator required by every user story.

**CRITICAL**: No user story implementation may begin until this phase is complete and its contract tests pass.

- [X] T006 Define versioned AI trading domain types for configurations, monitoring sessions, context snapshots, evaluations, suggestions, automation decisions, provider status, and log entries in `packages/domain-contracts/src/ai-trading.ts`.
- [X] T007 Extend versioned event envelopes for monitoring, evaluation, suggestion, automation, safe-state, and lifecycle events in `packages/event-schemas/src/events.ts`.
- [X] T008 [P] Define append-only repository interfaces and test-database adapters for AI records in `services/ai-monitoring/src/suggestion-log-repository.ts`.
- [X] T009 [P] Define the provider-neutral model gateway interface, request/response schemas, and error categories in `services/ai-monitoring/src/model-gateway.ts`.
- [X] T010 Implement strict model response validation, prohibited-claim checks, secret redaction, bounded output checks, and unsupported-instruction rejection in `services/ai-monitoring/src/model-gateway-validator.ts`.
- [X] T011 Implement bounded market-context assembly from existing history, option-chain, instrument, freshness, session, and deterministic analysis outputs in `services/ai-monitoring/src/market-context-service.ts`.
- [X] T012 Implement the shared automation decision evaluator that consumes validated AI evidence and rechecks deterministic risk, session, contract, liquidity, broker, reconciliation, safe-mode, kill-switch, and live-release gates in `services/ai-monitoring/src/automation-decision-service.ts`.
- [X] T013 Implement the AI-specific append-only audit adapter with actor, correlation ID, configuration/model versions, gate results, and lifecycle outcome fields in `services/audit/src/ai-trading-audit.ts`.
- [X] T014 [P] Add repository and validator unit tests for immutability, redaction, schema rejection, confidence bounds, and provider failure mapping in `tests/unit/ai-monitoring-foundation.test.ts`.
- [X] T015 [P] Add automation decision unit tests for PAPER, ASSISTED, blocked ALGO_LIVE, stale context, kill switch, risk failure, and duplicate idempotency outcomes in `tests/unit/automation-decision.test.ts`.
- [X] T016 [P] Add shared contract fixture assertions for the AI domain and event schemas in `tests/contract/ai-trading-contracts.test.ts`.

**Checkpoint**: Shared AI records, bounded context, model validation, append-only audit, and fail-closed automation decisions are available for independent story work.

---

## Phase 3: User Story 1 - Enable AI Market Monitoring (Priority: P1) - MVP

**Goal**: Let an authenticated user explicitly start, inspect, and stop AI monitoring independently from automation and execution mode.

**Independent Test**: Enable monitoring for a supported instrument in PAPER mode, verify active scope and health, then disable it or activate the kill switch and verify no new AI evaluation or automation work is accepted.

### Tests for User Story 1

- [X] T017 [P] [US1] Add API contract tests for enable, disable, invalid scope, unauthorized access, and separate automation state in `tests/contract/ai-monitoring-route.test.ts`.
- [X] T018 [P] [US1] Add monitoring lifecycle integration tests for `STARTING`, `ACTIVE`, `STOPPING`, `STOPPED`, kill-switch stop, actor audit, and scope changes in `tests/integration/ai-monitoring-session.test.ts`.
- [X] T019 [P] [US1] Add security tests proving monitoring activation cannot select an unavailable live mode or change risk/kill-switch settings in `tests/security/ai-monitoring-controls.test.ts`.

### Implementation for User Story 1

- [X] T020 [US1] Implement configuration validation and versioned monitoring-session lifecycle in `services/ai-monitoring/src/monitoring-service.ts`.
- [X] T021 [US1] Implement monitoring status, health, safe-state blockers, and current scope read model in `services/ai-monitoring/src/monitoring-read-model.ts`.
- [X] T022 [US1] Implement `GET` and lifecycle `POST` handlers for `/api/ai-monitoring` in `apps/web/app/api/ai-monitoring/route.ts`.
- [X] T023 [US1] Add typed monitoring client request/response helpers in `apps/web/lib/ai-monitoring-client.ts`.
- [X] T024 [US1] Add explicit monitoring and automation controls, mode labels, provider/data health, and stop reasons to `apps/web/app/execution/page.tsx` without moving safety decisions into the browser.
- [X] T025 [US1] Record enable, disable, kill-switch, configuration-change, and safe-state events through `services/audit/src/ai-trading-audit.ts` and `services/ai-monitoring/src/monitoring-service.ts`.

**Checkpoint**: A user can independently enable/disable monitoring, see its state and blockers, and prove that monitoring does not implicitly activate automation.

---

## Phase 4: User Story 2 - Receive Explainable Bullish or Bearish Suggestions (Priority: P1)

**Goal**: Produce validated, explainable model suggestions from bounded fresh context while preserving deterministic analysis and risk values.

**Independent Test**: Replay fresh bullish, bearish, neutral, stale, conflicting, and provider-failure fixtures and verify suggestion state, evidence, confidence, invalidation, model health, and unchanged deterministic outputs.

### Tests for User Story 2

- [X] T026 [P] [US2] Add model-gateway unit tests for valid structured responses, timeout, cancellation, malformed payload, unsupported instruction, prohibited claim, and credential-redaction cases in `tests/unit/model-gateway.test.ts`.
- [X] T027 [P] [US2] Add evaluation integration tests for bullish, bearish, neutral, no-trade, waiting, unavailable, stale-context, and deterministic-blocked outcomes in `tests/integration/ai-evaluation.test.ts`.
- [X] T028 [P] [US2] Add deterministic replay tests proving identical context/configuration/model stub inputs produce the same validated suggestion category and deterministic decision in `tests/integration/ai-replay.test.ts`.
- [X] T029 [P] [US2] Add model-output security tests proving AI responses cannot alter entry, stop, targets, quantity, risk limits, mode, kill switch, or readiness in `tests/security/ai-model-output.test.ts`.

### Implementation for User Story 2

- [X] T030 [US2] Implement the configured LiteLLM-compatible server-side adapter behind `ModelGateway` in `services/ai-monitoring/src/litellm-gateway.ts` with timeout, cancellation, bounded request/response size, provider status, and safe failure mapping.
- [X] T031 [US2] Implement evaluation orchestration that creates context snapshots, invokes the gateway, validates output, creates `AIEvaluation` and `AISuggestion`, and leaves deterministic analysis unchanged in `services/ai-monitoring/src/monitoring-service.ts`.
- [X] T032 [US2] Add model/provider health and evaluation completion fields to the monitoring read model in `services/ai-monitoring/src/monitoring-read-model.ts`.
- [X] T033 [US2] Add `EVALUATE` handling and structured `202`, `422`, and `503` responses to `apps/web/app/api/ai-monitoring/route.ts`.
- [X] T034 [US2] Add latest direction, confidence, evidence, invalidation, model status, and deterministic-blocker presentation to `apps/web/app/execution/page.tsx`.
- [X] T035 [US2] Add redacted model metadata, evaluation outcomes, and suggestion events to the append-only audit path in `services/audit/src/ai-trading-audit.ts`.

**Checkpoint**: A monitoring session can produce a safe, explainable suggestion or explicit unavailable/no-trade result without changing authoritative levels or gates.

---

## Phase 5: User Story 3 - Review the AI Suggestion Log (Priority: P1)

**Goal**: Provide an immutable, chronological, searchable log of evaluations, suggestions, gate decisions, automation outcomes, and later lifecycle results.

**Independent Test**: Insert synthetic evaluations for multiple instruments and outcomes, filter the log, open one detail record, and verify original evidence remains unchanged after invalidation or supersession.

### Tests for User Story 3

- [X] T036 [P] [US3] Add log query contract tests for newest-first ordering, pagination, symbol/direction/date/confidence/outcome filters, and result totals in `tests/contract/ai-suggestion-log-route.test.ts`.
- [X] T037 [P] [US3] Add append-only integration tests proving evaluation evidence cannot be overwritten and later decision/order events remain linked in `tests/integration/ai-suggestion-audit.test.ts`.
- [X] T038 [P] [US3] Add authorization tests proving users cannot read another user's monitoring session or log details in `tests/security/ai-suggestion-log-access.test.ts`.

### Implementation for User Story 3

- [ ] T039 [US3] Implement durable server-side storage and append-only reads for AI evaluations, suggestions, decisions, and lifecycle events in `services/ai-monitoring/src/suggestion-log-repository.ts`.
- [X] T040 [US3] Implement paginated, filterable suggestion-log projection and detail assembly in `services/ai-monitoring/src/monitoring-read-model.ts`.
- [X] T041 [US3] Implement `GET /api/ai-monitoring` log query parameters and `GET /api/ai-monitoring/log/[id]` immutable detail route in `apps/web/app/api/ai-monitoring/route.ts` and `apps/web/app/api/ai-monitoring/log/[id]/route.ts`.
- [X] T042 [US3] Add typed log filters, pagination, detail loading, and evidence/gate/outcome display to `apps/web/lib/ai-monitoring-client.ts` and `apps/web/app/execution/page.tsx`.
- [X] T043 [US3] Add server-side redaction and authorization checks for log details in `services/ai-monitoring/src/suggestion-log-repository.ts` and `apps/web/app/api/ai-monitoring/log/[id]/route.ts`.

**Checkpoint**: Users can find and inspect immutable model suggestions and their outcomes without consulting raw infrastructure logs.

---

## Phase 6: User Story 4 - Approve Gated Auto Trading (Priority: P1)

**Goal**: Allow only fully qualified AI-confirmed paper decisions or existing assisted-confirmation flows to reach the permitted execution boundary.

**Independent Test**: Replay a fully qualified suggestion and one fixture for every major failed gate; verify only the permitted PAPER or ASSISTED path proceeds and ALGO LIVE remains blocked while readiness is incomplete.

### Tests for User Story 4

- [X] T044 [P] [US4] Add automation contract tests for AI confirmation, deterministic gate ordering, protective levels, quantity ownership, blockers, and idempotency in `tests/contract/ai-automation-decision.test.ts`.
- [X] T045 [P] [US4] Add PAPER isolation tests proving an AI-approved decision can invoke only the simulator and never a live broker endpoint in `tests/security/ai-paper-live-isolation.test.ts`.
- [X] T046 [P] [US4] Add ASSISTED and ALGO LIVE tests proving confirmation is required for assisted submission and incomplete readiness returns the existing live block in `tests/security/ai-execution-modes.test.ts`.
- [X] T047 [P] [US4] Add end-to-end paper automation tests for qualified, stale, low-RR, invalid-contract, kill-switch, reconciliation, and duplicate scenarios in `tests/e2e/ai-paper-automation.test.ts`.

### Implementation for User Story 4

- [ ] T048 [US4] Integrate `AutomationDecision` evaluation into the existing execution boundary without weakening manual-paper or live-block behavior in `apps/web/app/api/algo-trading/route.ts`.
- [ ] T049 [US4] Map approved PAPER decisions to the existing simulator and preserve order correlation, protective levels, and audit events in `services/paper-trading/src/paper-engine.ts` and `services/ai-monitoring/src/automation-decision-service.ts`.
- [ ] T050 [US4] Map approved ASSISTED decisions to the existing confirmation boundary and reject direct AI submission in `services/execution/src/mode-policy.ts` and `apps/web/app/api/algo-trading/route.ts`.
- [X] T051 [US4] Reuse existing live release policy and preserve `403`/`501` behavior for AI attempts to activate ALGO LIVE in `services/execution/src/live-release-policy.ts` and `apps/web/app/api/algo-trading/route.ts`.
- [ ] T052 [US4] Add automation decision state, protective levels, quantity, mode, and failed-gate details to `apps/web/app/execution/page.tsx`.
- [ ] T053 [US4] Append automation request, block, cancel, paper order, assisted confirmation, fill, and exit links to `services/audit/src/ai-trading-audit.ts`.

**Checkpoint**: AI can contribute confirmation but cannot bypass deterministic safety gates, mode policy, user confirmation, or live-readiness controls.

---

## Phase 7: User Story 5 - Stop, Recover, and Investigate AI Trading (Priority: P2)

**Goal**: Fail closed on market/model/broker failures, preserve deterministic analysis, record the reason, and resume only after health recovery.

**Independent Test**: Interrupt each dependency independently, verify no new automation occurs and the reason is logged, then restore health and verify monitoring resumes with a fresh context.

### Tests for User Story 5

- [X] T054 [P] [US5] Add failure-matrix tests for stale/discontinuous data, missing context, provider timeout, malformed output, authorization failure, broker failure, reconciliation uncertainty, safe mode, and kill switch in `tests/integration/ai-failure-matrix.test.ts`.
- [X] T055 [P] [US5] Add recovery tests for `DEGRADED -> ACTIVE`, fresh-context revalidation, expired suggestion cancellation, and preserved original log records in `tests/integration/ai-monitoring-recovery.test.ts`.
- [X] T056 [P] [US5] Add observability tests proving safe-state reasons and correlation IDs are present without secrets in `tests/security/ai-observability-redaction.test.ts`.

### Implementation for User Story 5

- [X] T057 [US5] Implement health aggregation and fail-closed transitions for market data, provider, broker, reconciliation, safe mode, kill switch, and authorization in `services/ai-monitoring/src/monitoring-service.ts`.
- [ ] T058 [US5] Implement evaluation expiry, configuration/mode/context invalidation, cancellation, and duplicate suppression in `services/ai-monitoring/src/automation-decision-service.ts`.
- [X] T059 [US5] Preserve deterministic analysis responses when the model gateway fails and expose safe unavailable state through `apps/web/app/api/ai-monitoring/route.ts`.
- [ ] T060 [US5] Add recovery controls, degraded/stopped reasons, provider health, and safe-state notifications to `apps/web/app/execution/page.tsx`.
- [X] T061 [US5] Add bounded structured logging and correlation-aware failure events without credentials or raw provider payloads in `services/ai-monitoring/src/monitoring-service.ts` and `services/audit/src/ai-trading-audit.ts`.

**Checkpoint**: Dependency failures stop new AI automation, preserve explainable records, keep valid deterministic analysis available, and recover only through fresh health checks.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Complete security, documentation, compatibility, performance, and release validation across all stories.

- [ ] T062 [P] Add server-side persistence authorization and least-privilege Firestore rules for AI records in `firestore.rules` and `services/ai-monitoring/src/suggestion-log-repository.ts`.
- [X] T063 [P] Add compatibility coverage for existing analysis, risk, execution-mode, audit, and event contracts in `tests/contract/foundation-contracts.test.ts`.
- [X] T064 [P] Add Python boundary/replay validation for unchanged deterministic engine inputs and outputs in `quant/tests/test_ai_context_contract.py`.
- [X] T065 [P] Add UI-safe-state and mode-visibility checks for the algo page in `tests/e2e/ai-monitoring-page.test.ts`.
- [X] T066 Run targeted Vitest, Python regression, security, contract, and integration commands from `specs/007-ai-driven-trading/quickstart.md` and record results in `docs/release-validation.md`.
- [ ] T067 Run `pnpm lint`, `pnpm format:check`, and `pnpm build`; resolve feature-caused errors without changing unrelated behavior in the affected source paths.
- [X] T068 Review the completed feature against `specs/007-ai-driven-trading/spec.md`, `plan.md`, and the checklist at `specs/007-ai-driven-trading/checklists/requirements.md`; document any remaining implementation gaps before release.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies; T001-T005 can be started immediately, with T002-T004 parallelizable.
- **Foundational (Phase 2)**: Depends on Setup completion; T006-T016 block all user-story work.
- **User Stories (Phases 3-7)**: Depend on the foundational checkpoint. Their domain contracts are independent, but production integration should follow the priority order below.
- **Polish (Phase 8)**: Depends on all selected user stories and their focused tests.

### User Story Completion Order

- **US1 (P1, MVP)**: First story after Foundation. Establishes explicit monitoring/session controls and the status read model.
- **US2 (P1)**: Can begin after Foundation with deterministic session fixtures; integrates the US1 monitoring lifecycle for production evaluation.
- **US3 (P1)**: Can begin after Foundation with synthetic log fixtures; production integration consumes US2 evaluation records.
- **US4 (P1)**: Depends on Foundation and the validated evaluation/decision contracts; production automation consumes US2 suggestions and existing execution boundaries.
- **US5 (P2)**: Depends on the lifecycle and evaluation paths from US1-US4 for full recovery and cancellation coverage, though failure fixtures can be developed in parallel.

### Within Each User Story

- Write the story tests before implementation and confirm they fail for the missing behavior.
- Implement or extend domain/service logic before API routes and UI integration.
- Keep safety decisions server-side; UI tasks render read models and never become gate authorities.
- Reach the story checkpoint only after its independent test criteria pass.

## Parallel Opportunities

- Setup: T002, T003, and T004 can run in parallel after T001 establishes directories.
- Foundation: T008, T009, T014, T015, and T016 can run in parallel after the domain/event contracts T006-T007; T011 and T012 can then proceed in parallel once their input contracts exist.
- US1: T017-T019 can run in parallel; T020-T021 can run in parallel before T022-T025.
- US2: T026-T029 can run in parallel; T030 and T032 can run in parallel after shared gateway contracts; T031 and T033 follow their dependencies.
- US3: T036-T038 can run in parallel; T039 and T040 can run in parallel only after repository interfaces; T041-T043 follow the read model.
- US4: T044-T047 can run in parallel; T049-T051 can run in parallel after T048 defines the integration point, while T052-T053 follow decision output.
- US5: T054-T056 can run in parallel; T057-T058 can run in parallel after lifecycle contracts; T059-T061 follow health/failure state definitions.
- Polish: T062-T065 can run in parallel before the final command tasks T066-T068.

## Parallel Example: User Story 1

```text
Task: "T017 [US1] Contract tests in tests/contract/ai-monitoring-route.test.ts"
Task: "T018 [US1] Lifecycle integration tests in tests/integration/ai-monitoring-session.test.ts"
Task: "T019 [US1] Security tests in tests/security/ai-monitoring-controls.test.ts"

After the tests are established:

Task: "T020 [US1] Monitoring lifecycle in services/ai-monitoring/src/monitoring-service.ts"
Task: "T021 [US1] Status read model in services/ai-monitoring/src/monitoring-read-model.ts"
```

## Parallel Example: User Story 2

```text
Task: "T026 [US2] Model gateway tests in tests/unit/model-gateway.test.ts"
Task: "T027 [US2] Evaluation integration tests in tests/integration/ai-evaluation.test.ts"
Task: "T028 [US2] Replay tests in tests/integration/ai-replay.test.ts"
Task: "T029 [US2] Model-output security tests in tests/security/ai-model-output.test.ts"
```

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 setup.
2. Complete Phase 2 foundational contracts, bounded context, audit, and fail-closed decision evaluator.
3. Complete Phase 3 US1 monitoring activation and stop controls.
4. Run US1 contract, integration, and security tests independently.
5. Demonstrate monitoring state and safe-state blockers in PAPER mode before adding model evaluation or automation.

### Incremental Delivery

1. Add US2 to produce explainable, validated suggestions.
2. Add US3 to make every evaluation and outcome searchable and immutable.
3. Add US4 to connect only fully gated decisions to PAPER or existing ASSISTED boundaries.
4. Add US5 to harden failure, recovery, expiry, and investigation behavior.
5. Complete Phase 8 security, compatibility, build, and quickstart validation.

### Parallel Team Strategy

After Foundation:

- Developer A: US1 monitoring lifecycle and API/UI controls.
- Developer B: US2 model gateway and evaluation orchestration.
- Developer C: US3 append-only log repository and filtered read model.
- A later integration owner: US4 execution-boundary integration and US5 recovery once the shared decision contracts are stable.

## Completion Criteria

- All tasks use the required `- [ ] T### [P?] [US#] description with file path` format.
- Each user story has tests, implementation tasks, a checkpoint, and an independent test criterion.
- MVP scope is US1 after the foundational phase.
- No task enables unrestricted live trading or permits AI to bypass deterministic safety controls.
