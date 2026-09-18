# Research: TradePulse AI Trading Intelligence Platform

**Date**: 2026-09-08
**Feature**: [spec.md](spec.md)

## Decision 1: Modular monorepo with separate web, orchestration, domain, and quant boundaries

**Decision**: Use a single repository with a React/Next.js desktop console, a TypeScript API/BFF,
domain services for market/risk/execution concerns, and a Python quantitative runtime. Share only
versioned domain and event contracts.

**Rationale**: The requirements combine low-latency market state, user workflows, broker execution,
and statistical computation. Separate boundaries keep broker credentials and order side effects away
from UI and strategy code, while allowing the quantitative runtime to use its appropriate ecosystem.
It also supports staged delivery without requiring every capability to be deployed together.

**Alternatives considered**: A single full-stack application was rejected because it would make
paper/live isolation, failure containment, and independent scaling harder. A fully independent
microservice fleet was rejected for the first release because it adds operational complexity before
the domain contracts and safety tests are proven.

## Decision 2: PostgreSQL plus time-series storage and Redis event state

**Decision**: Store transactional entities and immutable audit records in PostgreSQL; use
TimescaleDB-compatible time-series tables for candles, options, and market events; use Redis for
latest values, session/risk state, and event fan-out.

**Rationale**: The product needs relational consistency for orders, fills, risk decisions, and
audit, time-window queries for market data, and fast ephemeral reads for the dashboard. This split
matches the access patterns without making Redis the system of record.

**Alternatives considered**: A document-only database was rejected because order, position,
protection, and audit relationships need transactional constraints. A time-series database alone
was rejected because it does not cover identity, permissions, strategy versions, or order lifecycle
consistency.

## Decision 3: Deterministic risk gate before broker side effects

**Decision**: Model risk evaluation as a synchronous, versioned domain contract. It receives a
signal context, account state, market-quality state, event-risk state, and risk configuration, and
returns an explicit allow/block decision with every evaluated rule and reason.

**Rationale**: The constitution makes risk a hard gate. A deterministic contract is testable,
auditable, replayable, and independent of AI output. It allows paper and live paths to reuse the
same decision behavior while preserving separate order destinations.

**Alternatives considered**: Embedding checks inside the broker adapter was rejected because paper
mode and pre-submission explanations would diverge. Allowing an AI model to make the final decision
was rejected because it is not deterministic or appropriate for a hard financial safety gate.

## Decision 4: Broker-neutral execution contract with Groww adapter

**Decision**: Define internal operations for authentication, health, quotes, historical data, funds,
positions, orders, trades, protective orders, and reconciliation. Translate them to Groww only inside
`adapters/groww`.

**Rationale**: Groww's current documentation exposes order create/modify/cancel/status/list and
trade retrieval, accepts user reference IDs, and exposes OCO smart orders for CASH and FNO. The
adapter must preserve those provider constraints while keeping strategy and risk code portable.
Unknown status is resolved by status/reference lookup before retry.

**Alternatives considered**: Calling Groww directly from strategies was rejected by the constitution.
Implementing several brokers in the first release was rejected because it would dilute safety and
validation effort.

**External references**:

- [Groww Orders](https://groww.in/trade-api/docs/curl/orders)
- [Groww Smart Orders](https://groww.in/trade-api/docs/curl/smart-orders)

## Decision 5: Explicit mode policy and promotion gates

**Decision**: Represent PAPER, ASSISTED, and ALGO LIVE as explicit policy contexts. Paper routes
only to an internal simulator; assisted requires confirmation; live requires activation, healthy
broker state, risk-limit confirmation, and promotion evidence.

**Rationale**: The same strategy and risk logic can be reused, but the order destination and user
permissions must be impossible to confuse. This directly satisfies mode isolation and makes the
backtest-to-live journey reviewable.

**Alternatives considered**: A single mode with a runtime flag was rejected because a flag alone is
too easy to misroute and too difficult to prove isolated in testing. Immediate live access was
rejected because the requirements mandate staged validation.

## Decision 6: Compliance is a release gate, not a later documentation task

**Decision**: Keep live execution behind a feature flag and release checklist that verifies current
Groww onboarding/API behavior, exchange requirements, security controls, user consent, disclosures,
and applicable SEBI obligations.

**Rationale**: SEBI's February 2025 circular and September 2025 timeline update state that the
retail-algo framework and operational modalities apply to broker/vendor workflows, with the update
stating applicability from April 1, 2026. Requirements may evolve, so the system must not treat a
static document as permanent authorization.

**Alternatives considered**: Treating compliance as a post-MVP concern was rejected because it could
lead to unsafe live behavior and rework in identity, audit, consent, and broker boundaries.

**External references**:

- [SEBI retail algo circular, 2025-02-04](https://www.sebi.gov.in/legal/circulars/feb-2025/safer-participation-of-retail-investors-in-algorithmic-trading_91614.html)
- [SEBI implementation timeline update, 2025-09-30](https://www.sebi.gov.in/legal/circulars/sep-2025/extension-of-timeline-for-implementation-of-sebi-circular-dated-february-04-2025-on-safer-participation-of-retail-investors-in-algorithmic-trading-_96979.html)

## Decision 7: Realtime UI uses event envelopes with safe-state events

**Decision**: Deliver quotes, signals, risk state, orders, positions, notifications, and health
changes through versioned event envelopes. Every event includes mode, subject, timestamp, freshness,
and correlation identifiers where relevant. Safe-state events are first-class and cannot be hidden
by stale cached values.

**Rationale**: The reference UI is a dense live console. Event envelopes make incremental updates,
replay, tracing, and visible data freshness possible without full-page refreshes.

**Alternatives considered**: Polling every screen independently was rejected because it increases
load and makes cross-panel state inconsistent. Unversioned ad hoc events were rejected because
contract drift would undermine audit and UI safety state.

## Resolved Technical Unknowns

- **Authentication**: Use a managed strong-auth provider with server-side session validation and
  role-based authorization; the exact provider is an implementation decision, not a product contract.
- **Cloud**: Keep deployment cloud-neutral across AWS, GCP, or Azure; use managed PostgreSQL,
  Redis, secrets, and observability equivalents.
- **News intelligence**: Require approved source registry, source tiers, clustering, and outcome
  evaluation; model/provider choice remains replaceable behind a structured event contract.
- **Charting**: Use a charting component that supports candles, indicators, markers, and accessibility;
  the chart vendor is not part of the product contract.
- **Performance baseline**: Target p95 under one second for normal realtime event delivery and
  under 200 ms for an already-loaded risk decision, then validate with representative fixtures.