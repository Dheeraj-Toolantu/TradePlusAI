# Release Validation Evidence

## Current validation

### AI-driven trading feature 007

- AI-specific Vitest suites: 20 files and 45 tests passing, covering monitoring lifecycle, model validation, deterministic replay, immutable log access, mode isolation, failure recovery, and paper/live blocking.
- AI-context contract: 1 Python test passing; deterministic quant regression: 21 tests passing.
- Next.js production build: passing with `/api/ai-monitoring`, `/api/ai-monitoring/log/[id]`, and the execution-page monitoring readout.
- Repository lint: passing. Repository-wide Prettier check remains failing on broad pre-existing formatting drift and is not auto-formatted to avoid unrelated churn.
- Remaining feature gaps: durable AI-record persistence, direct automation-decision integration with the existing order boundary, expiry/idempotency enforcement at execution time, Firestore authorization rules, and browser-level AI safe-state coverage.

- JavaScript test suite: 52 test files and 77 tests passing across contract, integration, unit, security, and e2e safety files.
- Next.js production build: passing with routes for dashboard, signals, trade detail, strategy builder,
  validation, execution, intelligence, and operations.
- Python quant modules: 6 tests passing with the standard library runner.
- Live execution: disabled unless both `LIVE_EXECUTION_ENABLED=true` and `LIVE_COMPLIANCE_APPROVED=true`.
- Groww flow tests: ordered first-failure, Paper isolation, credential boundary, lifecycle, protection,
  reconciliation, and fail-closed scenarios are covered by the Groww feature suite.
- Convergence analytics: indicators, options OI classification, complete metrics, data-quality boundaries,
  paper square-off, notification outbox, and live-readiness evidence tests are required and tracked in
  `specs/003-platform-requirements-convergence/tasks.md`.

## Required before live activation

- Run the complete local dependency and fixture workflow in `specs/001-trading-intelligence-platform/quickstart.md`.
- Review current broker, exchange, security, privacy, consent, disclosure, and SEBI requirements.
- Verify paper isolation, reconciliation, protection, kill switch, audit completeness, and load targets.
- Complete the evidence listed in `docs/compliance/live-readiness.md` and `docs/operations/incident-response.md`.