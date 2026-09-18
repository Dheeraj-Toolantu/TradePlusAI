# Implementation Plan: TradePulse AI Trading Intelligence Platform

**Branch**: `001-trading-intelligence-platform` | **Date**: 2026-09-08 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-trading-intelligence-platform/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Build a broker-neutral, desktop-first trading intelligence platform for Indian markets. The
first delivery must establish a safe vertical path from market data through explainable signals,
deterministic risk checks, paper trading, and auditable execution contracts. Groww is the first
adapter, but strategy and risk logic remain independent of broker details. The product will be
delivered as staged capabilities so no live execution is enabled before paper validation,
reconciliation, security, and regulatory gates pass.

## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: TypeScript 5.x for web/API services; Python 3.11+ for quantitative
calculation and backtesting; exact patch versions are pinned during repository bootstrap.

**Primary Dependencies**: Next.js/React for the desktop web UI; Node.js TypeScript services;
Python quantitative service; WebSockets and Redis Streams or Pub/Sub for realtime delivery;
PostgreSQL with TimescaleDB-compatible time-series support; a secure authentication provider;
cloud secret manager; OpenTelemetry-compatible observability. Dependency selection MUST preserve
the broker, risk, and mode boundaries described in the contracts.

**Storage**: PostgreSQL for identity, strategies, orders, risk decisions, positions, audit, and
configuration; TimescaleDB-compatible tables for candles, option snapshots, and market events;
Redis for latest quote/risk/session state and event fan-out; object storage for large backtest
artifacts and exported reports.

**Testing**: TypeScript unit and integration tests; Python unit and property tests for indicators,
position sizing, backtesting, and metrics; contract tests for broker adapters; end-to-end tests
with deterministic market, news, broker, and failure fixtures; security tests for secret and mode
isolation; load tests for market-session update and risk-state paths.

**Target Platform**: Desktop-first browser application with responsive narrow-screen behavior;
service workloads deploy to a supported cloud environment; local development runs on Windows,
macOS, or Linux with containerized dependencies.

**Project Type**: Modular monorepo containing a web application, TypeScript domain services,
Python quantitative service, shared contracts, and broker adapters.

**Performance Goals**: Dashboard and risk-state updates MUST arrive without full-page refresh;
target p95 event-to-screen latency is under 1 second for normal session traffic. Risk decisions
MUST complete within 200 ms p95 for an already-loaded signal context. Order commands MUST be
idempotent and observable, with broker latency reported separately from internal latency.

**Constraints**: Live execution fails closed on stale data, unavailable risk service, invalid
authentication, unknown broker state, unexpected positions, or missing protection. Paper mode
cannot reach live order endpoints. Secrets never reach client bundles or ordinary logs. OCO
quantity cannot exceed the absolute net position quantity. Groww capabilities and regulatory
requirements are externally controlled and MUST be revalidated before launch.

**Scale/Scope**: Initial scope is one user-facing product for NIFTY, BANK NIFTY, SENSEX, and
selected liquid F&O instruments; 14 primary UI views; one initial broker adapter; staged rollout
from market intelligence to controlled live algo. The architecture must support later adapters
without coupling strategy code to a broker.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

*GATE: PASS*

- Safety gates are first-class domain behavior and precede every assisted/live order.
- AI and news are contextual and explanatory; neither can independently submit a live order.
- PAPER, ASSISTED, and ALGO LIVE have separate destinations and permissions; paper is isolated.
- Broker integration is behind a broker-neutral adapter contract; Groww-specific details stay at
  the adapter boundary.
- Strategy promotion includes out-of-sample, walk-forward, paper, and capped live stages.
- Risk, idempotency, partial fills, reconciliation, stale data, kill switch, and audit behavior
  receive unit, contract, integration, and end-to-end coverage.
- Security, observability, compliance, and UI safe-state visibility are included in the design.

No constitution violation is proposed. Live execution remains disabled until the post-design
compliance and operational review described in the specification passes.

## Project Structure

### Documentation (this feature)

```text
specs/001-trading-intelligence-platform/
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
├── web/                         # Desktop-first trading console
└── api/                         # Authenticated BFF and orchestration APIs
services/
├── market-data/
├── options-analytics/
├── news-intelligence/
├── market-regime/
├── strategy/
├── signal/
├── risk/
├── paper-trading/
├── execution/
├── reconciliation/
├── notifications/
└── audit/
quant/
├── indicators/
├── backtest/
└── analytics/
packages/
├── domain-contracts/
├── event-schemas/
├── broker-contracts/
└── ui-foundation/
adapters/
└── groww/
infra/
├── database/
├── observability/
└── local/
tests/
├── contract/
├── integration/
├── e2e/
├── security/
└── load/
```

**Structure Decision**: Use a modular monorepo with a thin web/API boundary, domain services
organized by responsibility, a separate quantitative runtime, shared versioned contracts, and a
Groww adapter isolated under `adapters/groww`. Risk and execution are separate services so the
system can fail closed and be tested independently. The source tree is a target structure for
implementation; this repository currently contains planning artifacts only.

## Post-Design Constitution Check

*GATE: PASS*

- **Safety gates**: `contracts/risk-gate.md` makes risk checks explicit, persisted, and side-effect
  free on `BLOCK`; `contracts/broker-adapter.md` requires reconciliation and safe retry behavior.
- **Explainability and audit**: `data-model.md` links signals, risk decisions, orders, execution
  events, notifications, and append-only audit events; `contracts/events.md` preserves correlation.
- **Mode and broker isolation**: The plan separates paper simulation, assisted confirmation, and live
  adapter paths; Groww-specific behavior is confined to the adapter contract.
- **Promotion validation**: The strategy state machine and [quickstart.md](quickstart.md) require
  out-of-sample, walk-forward, paper, capped-live, and compliance evidence.
- **Risk-critical testing**: The quickstart covers R:R, limits, lot sizing, stale data, idempotency,
  partial fills, OCO, reconciliation, kill switch, audit, security, and responsive safety UI.
- **Operational safety**: The event and UI contracts keep mode, freshness, health, exposure,
  blockers, and kill-switch state visible without deep navigation.

No post-design violation or complexity exception is required.

## Complexity Tracking

No constitution violations or unjustified complexity are recorded. The service boundaries are
required by the safety, isolation, scaling, and auditability principles rather than by preference.
