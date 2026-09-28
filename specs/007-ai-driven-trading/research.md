# Phase 0 Research: AI-Driven Trading Monitor and Gated Automation

## Research Questions

- Where should continuous monitoring and AI evaluation live in the existing application?
- How should AI output interact with the deterministic Python and TypeScript safety gates?
- How should LiteLLM-compatible provider routing be introduced without coupling trading contracts to a provider?
- Where should immutable evaluations, suggestion logs, and monitoring actions be persisted?
- What API and UI contract supports monitoring, log filtering, and safe automation?
- How should the feature be tested against existing paper/live isolation and risk-critical contracts?

## Decision: Server-side monitoring orchestration with a narrow model gateway

**Decision**: Add a server-side monitoring service and a `ModelGateway` interface. The service will collect a bounded market-context snapshot, invoke the configured LiteLLM-compatible gateway adapter, validate the structured response, and pass only validated AI evidence to the automation decision evaluator.

**Rationale**:

- The current algo route already owns market-history and option-chain acquisition, but it also mixes Python orchestration, broker checks, and order persistence.
- Browser code must not receive provider credentials or become authoritative for monitoring, risk, or execution.
- A narrow gateway keeps LiteLLM configuration replaceable and prevents a provider-specific SDK from entering domain contracts.
- Bounded context and schema validation protect the deterministic pipeline from raw provider payloads, malformed output, unsupported instructions, and prompt-injection-like content.

**Alternatives considered**:

- Calling LiteLLM directly from the browser: rejected because it exposes credentials, permits client-side bypasses, and violates server-side trading control boundaries.
- Adding AI logic directly to the Python deterministic engine: rejected because AI availability and probabilistic output must not alter deterministic calculation or safety behavior.
- Calling a provider from the existing algo route: rejected because it further concentrates unrelated responsibilities and makes timeout, cancellation, and audit behavior difficult to test.

## Decision: AI is an additional confirmation signal, never an execution authority

**Decision**: The deterministic analysis and risk pipeline remains authoritative for levels, quantity, risk/reward, session, contract, liquidity, broker, reconciliation, safe mode, and kill switch. A separate automation evaluator accepts a validated AI suggestion plus deterministic evidence and returns an immutable `AutomationDecision`.

**Rationale**:

- The constitution requires hard safety gates before assisted or live orders and forbids AI from independently submitting live orders.
- Existing Python `NoTradeEngine`, TypeScript risk gate, mode policy, and live release policy already encode relevant protections.
- This preserves current fail-closed behavior when the model is unavailable or disagrees with deterministic evidence.

**Alternatives considered**:

- Letting a high-confidence model result directly enable auto trading: rejected because confidence cannot override stale data, risk, contract, session, or readiness failures.
- Replacing the deterministic signal engine with an LLM result: rejected because it would remove reproducibility, make risk calculations opaque, and violate the existing strategy contract.

## Decision: Separate monitoring activation, automation activation, and execution mode

**Decision**: Persist and expose three independent controls: monitoring enabled, automation enabled, and execution mode (`PAPER`, `ASSISTED`, `ALGO_LIVE`). Monitoring can produce suggestions without automation. Automation can only produce a mode-scoped decision after all gates pass.

**Rationale**:

- The feature specification requires monitoring to be explicitly enabled without accidentally enabling orders.
- Existing mode policy distinguishes simulator and broker capabilities; live activation is already blocked by release policy and route behavior.
- Separate state makes the UI and audit trail unambiguous during stops, recovery, and configuration changes.

**Alternatives considered**:

- One combined AI trading toggle: rejected because it conflates observation with execution and makes consent difficult to prove.
- Reusing process-local auto-trading state: rejected because it resets on restart and cannot support durable audit or multi-request idempotency.

## Decision: Append-only server-side AI records with correlation and immutable snapshots

**Decision**: Add repository boundaries for monitoring sessions, evaluations, suggestion log entries, automation decisions, and lifecycle events. Each record stores correlation ID, actor, configuration/model versions, context references, gate results, outcome, and timestamps. The repository must reject updates to original evaluation evidence; later outcomes are appended as linked events or fields controlled by the audit boundary.

**Rationale**:

- Existing `AnalysisAuditStore` and `AuditService` are in-memory and the current Firestore helper primarily persists orders.
- The feature requires later investigation of the exact model suggestion, context, gate decisions, and outcome.
- Append-only records support reproducibility and incident review without allowing UI grouping or subsequent evaluations to overwrite history.

**Alternatives considered**:

- Reusing the current client Firebase helper as the authoritative audit writer: rejected because credentials and permissive rules are not appropriate for trusted audit writes.
- Persisting only the latest suggestion: rejected because it loses rejected, superseded, and invalidated evaluations.
- Logging raw provider requests and responses indiscriminately: rejected because secrets and sensitive account data must not enter ordinary logs; records should store redacted, bounded references and validated output.

## Decision: Dedicated monitoring API surface with a read model for the algo page

**Decision**: Introduce a dedicated server API surface for monitoring lifecycle, evaluation, status, and suggestion-log querying. The existing algo-trading endpoint remains the execution boundary and receives only an approved automation decision or a user-confirmed assisted request.

**Rationale**:

- The existing algo route is already large and has different failure semantics for analysis, order validation, and history.
- A dedicated surface allows monitoring status and log filters to be tested independently from order submission.
- The algo page can poll or subscribe to a compact read model containing monitoring state, model health, data freshness, latest suggestion, automation state, and blockers.

**Alternatives considered**:

- Add all monitoring behavior to `/api/algo-trading`: rejected because it expands an already mixed route and risks coupling suggestion reads to order actions.
- Have the client invoke the model and call the order route directly: rejected due to security and mode-bypass risk.

## Decision: Structured provider response with strict validation and bounded operational limits

**Decision**: The gateway accepts a versioned request and returns only a schema-validated response containing direction, confidence, evidence references, explanation, invalidation, and non-authoritative setup intent. It cannot return authoritative prices, quantities, risk limits, mode changes, or order commands. Requests and responses use correlation IDs, bounded size, timeout, cancellation, provider/model identity, and latency metadata.

**Rationale**:

- Structured output is required to reliably distinguish bullish, bearish, neutral, waiting, no-trade, and unavailable states.
- Explicitly excluding execution controls enforces the constitution's AI boundary.
- Timeouts and output limits prevent a continuous monitor from hanging or consuming unbounded resources.

**Alternatives considered**:

- Free-form model text parsed with regular expressions: rejected because ambiguous text can create unsafe state transitions.
- Allowing the model to return complete orders: rejected because the deterministic execution and risk contracts own those values.

## Decision: Test with deterministic replay, failure fixtures, and existing isolation suites

**Decision**: Extend TypeScript unit/contract/security/integration tests and Python pipeline tests with deterministic AI gateway stubs. Cover enable/disable, stale context, provider timeout, malformed output, unsupported instruction rejection, duplicate suppression, immutable logging, AI-confirmed-but-risk-blocked, PAPER isolation, ASSISTED confirmation, and live activation blocking.

**Rationale**:

- Existing Vitest and pytest suites already cover the route, risk, audit, Python no-trade engine, and paper/live boundaries.
- Deterministic gateway stubs make repeated evaluation reproducible without external network calls or nondeterministic model behavior.
- Failure-path coverage matches the feature's safety and success criteria.

**Alternatives considered**:

- Testing only with a live provider: rejected because it is slow, nondeterministic, costly, and cannot reliably exercise malformed or unavailable responses.
- Testing only the UI: rejected because the safety boundary must hold for direct API callers and service-level integrations.

## Resolved Technical Context

- Web/API language: TypeScript 5.7 with Next.js 15.1.3 and React 19.
- Quantitative engine: Python >=3.11, standard-library-only project dependencies, JSON stdin/stdout subprocess contract.
- Existing package manager and test runner: pnpm 9.15.5 and Vitest 2.1.8; Python tests use pytest conventions in `quant/tests`.
- Existing execution modes: `PAPER`, `ASSISTED`, `ALGO_LIVE`; current live route is blocked or not implemented and must remain so for this feature.
- Existing market inputs: normalized market history, quote, option-chain, instrument catalog, session, safe-mode, kill-switch, broker health, reconciliation, risk, and contract metadata.
- No `.specify/extensions.yml` exists, so no before/after planning hooks are dispatched.
