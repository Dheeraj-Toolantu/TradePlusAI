# Implementation Plan: Groww Algo Trading and Explainable Flow Gates

**Branch**: `002-groww-algo-trading` | **Date**: 2026-09-08 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-groww-algo-trading/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Implement the flow-chart-driven algo path as an ordered, deterministic gate pipeline. News impact,
market regime, technical confirmation, options/OI, liquidity, R:R, and risk are evaluated before
the execution engine. The execution engine receives only an approved request and selects either a
Paper Broker or the authenticated Groww adapter through the same broker-neutral contract. Groww
credentials remain server-side, live execution stays disabled by default, and all decisions and
provider events are auditable.

## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: TypeScript 5.x and Node.js 20+ for gate orchestration, broker adapter,
API, and UI integration; Python 3.11+ remains the quantitative/backtest runtime.

**Primary Dependencies**: Existing TypeScript domain contracts, Vitest, Next.js/React, server-side
`fetch`, PostgreSQL/TimescaleDB, Redis event state, and the existing Groww adapter boundary. No
browser-side Groww SDK or credential access is permitted.

**Storage**: PostgreSQL for flow evaluations, gate results, broker connections, orders, fills,
protection, and audit; time-series storage for market/news outcomes; Redis for active gate/session,
kill-switch, and health state.

**Testing**: Vitest unit, contract, integration, security, and end-to-end tests; transport-stub
tests for Groww; Python unittest for quant outcomes; failure-injection tests for missing token,
provider errors, unknown order state, partial fills, reconciliation, and kill switch.

**Target Platform**: Existing desktop-first Next.js application and Node.js services on Windows
development and cloud-hosted server environments.

**Project Type**: Broker-connected web application with deterministic trading-domain services and
server-side external API adapter.

**Performance Goals**: Gate evaluation under 200 ms p95 for loaded state; provider latency measured
separately. Duplicate order attempts produce one provider submission. Health and reconciliation
state becomes visible to the UI within one realtime event cycle.

**Constraints**: No live order without every gate, explicit live flags, healthy Groww credentials,
fresh data, reconciled positions, and protection readiness. No secrets in client code or logs.
Paper mode cannot call the Groww transport. Unknown provider status blocks retry until reconciled.

**Scale/Scope**: One initial Groww adapter, one Paper Broker, NIFTY/BANKNIFTY/SENSEX and supported
F&O instruments, four flow-gate user stories, six news-outcome horizons, and controlled single-user
or small-team algo validation before broader broker expansion.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

*GATE: PASS*

- Ordered gates are deterministic and execute before broker side effects.
- News remains contextual and cannot submit orders.
- Paper and Groww execution share a broker-neutral contract but have isolated destinations.
- Credentials remain server-side and live execution requires explicit enablement and compliance approval.
- Groww failures, stale data, unknown status, unexpected positions, protection failures, and kill switch
  all fail closed.
- Gate decisions, broker events, fills, protection, and outcomes are auditable.
- Promotion requires out-of-sample, walk-forward, paper, assisted, capped-live, consent, and compliance evidence.

No constitution violation is proposed.

## Project Structure

### Documentation (this feature)

```text
specs/002-groww-algo-trading/
├── plan.md              # This file (/speckit-plan command output)
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)
<!--
  ACTION REQUIRED: Replace the placeholder tree below with the concrete layout
  for this feature. Delete unused options and expand the chosen structure with
  real paths (e.g., apps/admin, packages/something). The delivered plan must
  not include Option labels.
-->

```text
apps/
├── api/src/routes/
└── web/app/
services/
├── strategy/src/algo-flow-gate.ts
├── risk/src/
├── execution/src/
├── reconciliation/src/
├── news-intelligence/src/
└── audit/src/
adapters/
└── groww/src/
packages/
└── broker-contracts/src/
infra/
├── database/migrations/
└── observability/
tests/
├── contract/
├── integration/
├── security/
└── unit/
```

**Structure Decision**: Extend the existing monorepo. The flow gate belongs in the strategy domain,
the risk gate remains the final deterministic safety boundary, and execution selects an adapter only
after approval. Groww-specific HTTP mapping remains in `adapters/groww`; shared behavior is expressed
in `packages/broker-contracts`; UI/API routes expose health, current gate, and failure reason without
ever exposing credentials.

## Post-Design Constitution Check

*GATE: PASS*

- `contracts/algo-flow.md` records the ordered flow and first-failure semantics.
- `contracts/groww-adapter.md` keeps provider behavior behind a normalized server-side boundary.
- `contracts/execution-modes.md` proves Paper and Groww destinations are separate.
- `data-model.md` links gate results, orders, fills, protection, audit, and news outcomes.
- `quickstart.md` validates missing credentials, paper isolation, all gate failures, reconciliation,
  partial fills, and controlled live activation.

No post-design exception is required.

## Complexity Tracking

No constitution violations or unjustified complexity are recorded. The adapter boundary, ordered
gate pipeline, and audit entities are required by the safety and broker-isolation principles.
