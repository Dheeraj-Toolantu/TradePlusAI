# Implementation Plan: AI-Driven Trading Monitor and Gated Automation

**Branch**: `007-ai-driven-trading` | **Date**: 2026-09-20 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/007-ai-driven-trading/spec.md`

## Summary

Add server-side AI monitoring for configured NIFTY, BANKNIFTY, and SENSEX contexts while keeping the existing deterministic analysis and risk pipeline authoritative. A bounded market-context service will call a validated, LiteLLM-compatible model gateway; a separate automation evaluator will combine the validated AI suggestion with deterministic gates and produce a mode-scoped `AutomationDecision`. The algo page will consume monitoring status and an immutable, filterable suggestion log. PAPER remains simulator-only, ASSISTED retains user confirmation, and ALGO LIVE remains blocked by existing release readiness controls.

## Technical Context

**Language/Version**: TypeScript 5.7, Next.js 15.1.3, React 19; Python >=3.11 for the existing deterministic quant engine.

**Primary Dependencies**: Existing pnpm workspace, Next.js route handlers, Vitest 2.1.8, pytest conventions, `lightweight-charts`, Firebase/Firestore integration where an approved server-side persistence boundary exists, and an internal LiteLLM-compatible model-gateway adapter. No provider SDK is currently present.

**Storage**: Existing Firestore/order persistence patterns for durable server-side records, behind a new append-only repository boundary for monitoring sessions, evaluations, suggestions, automation decisions, and lifecycle events. In-memory stores remain test doubles only.

**Testing**: Vitest unit, contract, security, and integration suites; pytest quant pipeline suites; deterministic model-gateway stubs; existing paper/live isolation and kill-switch tests.

**Target Platform**: Server-side Next.js/API execution and the existing Python subprocess on the repository's development/CI environment; browser client for the algo-trading page.

**Project Type**: Cross-layer web application feature spanning `apps/web`, TypeScript domain/service packages, server-side persistence, and the existing Python quantitative engine.

**Performance Goals**: At least 95% of valid scheduled evaluations expose a completed or safe non-actionable result within 10 seconds of model evaluation completion; each model invocation has a bounded timeout and response size; log queries support the specified filters with bounded page sizes.

**Constraints**: Fail closed on stale/invalid context, provider failure, malformed output, unsafe mode, risk or broker failure, reconciliation uncertainty, safe mode, and kill switch. Do not expose credentials or raw provider payloads. AI cannot change prices, stops, targets, quantity, risk limits, mode, or readiness. Paper mode cannot call live broker endpoints. ALGO LIVE remains unavailable until existing release gates pass.

**Scale/Scope**: Initial release supports user-scoped monitoring sessions for NIFTY, BANKNIFTY, and SENSEX underlyings and eligible options, configured timeframes, one current decision per instrument/setup/evaluation window, paginated suggestion history, and PAPER/ASSISTED workflows. Live autonomous submission is out of scope while current readiness gates are incomplete.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Pre-Phase 0

- **Safety Gates Are Non-Negotiable**: PASS. The plan treats AI output as an additional gate and retains deterministic data, session, strategy, risk, liquidity, contract, broker, reconciliation, safe-mode, kill-switch, and execution-readiness checks.
- **Explainable, Auditable Decisions**: PASS. The plan adds immutable evaluation, suggestion, automation, and lifecycle records with context, model/configuration versions, gate results, actors, and outcomes.
- **Mode and Broker Isolation**: PASS. Monitoring, automation, and execution mode are separate; PAPER is simulator-only, ASSISTED requires confirmation, and ALGO LIVE remains release-gated.
- **Validate Before Promotion**: PASS. The first release is limited to paper and assisted boundaries and uses deterministic replay; no live promotion is implied.
- **Test Risk-Critical Contracts**: PASS. The research and quickstart require coverage for stale data, timeouts, malformed model output, idempotency, audit completeness, mode isolation, kill switch, and live blocking.
- **Trading Safety and Compliance**: PASS. UI status, health, active mode, exposure/risk blockers, and safe state are part of the read model; credentials remain server-side.
- **Delivery and Verification**: PASS. The feature is divided into independently testable monitoring, suggestion, logging, and gated automation slices with observability and a runnable quickstart.

### Post-Phase 1

- **Safety Gates Are Non-Negotiable**: PASS. `AutomationDecision` owns ordered gate results and cannot be created as allowed from AI output alone; invalid or stale context expires decisions.
- **Explainable, Auditable Decisions**: PASS. `AISuggestionLogEntry` is append-only and links original context, deterministic analysis, model metadata, gate results, order lifecycle, and actor actions.
- **Mode and Broker Isolation**: PASS. API and data-model invariants explicitly prohibit PAPER live calls, require ASSISTED confirmation, and preserve existing live release policy.
- **Validate Before Promotion**: PASS. `quickstart.md` validates deterministic paper behavior and blocked live activation; the design does not alter the current live `403/501` boundary.
- **Test Risk-Critical Contracts**: PASS. Contract and quickstart scenarios cover duplicate suppression, provider failure, paper isolation, assisted confirmation, and risk-blocked AI confirmation.
- **Trading Safety and Compliance**: PASS. The API omits secrets and raw provider payloads, records safe-state blockers, and requires server-side authorization and risk acknowledgement.
- **Delivery and Verification**: PASS. Generated artifacts define concrete interfaces, state transitions, validation commands, and completion evidence.

## Project Structure

### Documentation (this feature)

```text
specs/007-ai-driven-trading/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── ai-monitoring-api.md
│   └── model-gateway.md
└── tasks.md                         # Created by /speckit-tasks
```

### Source Code (repository root)

```text
apps/web/
├── app/api/algo-trading/route.ts           # Existing execution boundary; retain mode gates
├── app/api/ai-monitoring/route.ts           # New monitoring lifecycle/status/log API
├── app/api/ai-monitoring/log/[id]/route.ts  # New immutable detail read
├── app/execution/page.tsx                   # Algo page read model and controls
└── lib/ai-monitoring-client.ts              # Typed client contract/read model if needed

packages/domain-contracts/src/
├── ai-trading.ts                            # Configuration, evaluation, suggestion, decision types
├── analysis.ts                              # Existing deterministic analysis contract
└── execution-modes.ts                       # Existing capability policy

packages/event-schemas/src/
└── events.ts                                # Versioned monitoring/evaluation lifecycle envelopes

services/ai-monitoring/src/
├── monitoring-service.ts                    # Session lifecycle and evaluation orchestration
├── market-context-service.ts                # Bounded fresh context assembly
├── model-gateway.ts                         # Provider-neutral interface and validation
├── automation-decision-service.ts          # AI + deterministic gate composition
├── suggestion-log-repository.ts             # Append-only persistence boundary
└── monitoring-read-model.ts                 # Page status and filtered log projection

services/audit/src/
├── audit-service.ts                         # Existing audit boundary
└── ai-trading-audit.ts                      # AI-specific append-only event adapter

services/risk/src/
└── risk-gate.ts                             # Existing gate reused without AI bypass

services/execution/src/
├── mode-policy.ts                           # Existing mode isolation
└── live-release-policy.ts                   # Existing live readiness boundary

quant/src/tradepulse_quant/algo_engine/
├── engine.py                                # Existing deterministic analysis entry point
└── no_trade_engine.py                       # Existing fail-closed gate authority

tests/
├── unit/ai-monitoring-service.test.ts
├── unit/model-gateway.test.ts
├── unit/automation-decision.test.ts
├── contract/ai-monitoring-route.test.ts
├── security/ai-model-output.test.ts
├── security/paper-live-isolation.test.ts
└── integration/ai-suggestion-audit.test.ts

quant/tests/
└── test_ai_context_contract.py              # Python boundary/replay fixtures if quant changes are required
```

**Structure Decision**: Use the existing monorepo boundaries. AI orchestration, provider validation, audit persistence, and automation composition belong in server-side TypeScript services; deterministic market analysis remains in the Python quant package; the web page consumes typed API read models; shared contracts live in the existing domain and event packages. No new standalone application or broker adapter is introduced.

## Implementation Sequencing

1. Add versioned domain/event types and repository interfaces for configuration, sessions, evaluations, suggestions, automation decisions, and log events.
2. Implement bounded market-context assembly by reusing existing history, option-chain, instrument, session, freshness, and deterministic analysis outputs.
3. Implement the model-gateway interface, LiteLLM-compatible adapter configuration, strict response validation, redaction, timeout, cancellation, and failure mapping.
4. Implement monitoring lifecycle and evaluation orchestration with configuration/version capture, correlation IDs, idempotency, and append-only audit writes.
5. Implement the automation decision service that rechecks deterministic gates and maps outcomes to PAPER/ASSISTED/LIVE capabilities without changing existing execution boundaries.
6. Add monitoring/status/log API routes and typed page integration for enable/disable, automation toggle, health, latest suggestion, blockers, and filters.
7. Add deterministic gateway stubs and tests for valid, blocked, duplicate, stale, malformed, unavailable, recovery, paper, assisted, and live-blocked paths.
8. Run the quickstart, existing security/contract/integration suites, Python regression suite, type/build checks, and audit the UI for visible mode and safe-state information.

## Complexity Tracking

No constitution violations or exceptions require justification. The additional service and repository boundaries are required to isolate model/provider concerns, preserve append-only auditability, and keep the existing execution route and deterministic gate ownership intact.
