# Implementation Plan: AI Trading Chart and Risk/Reward Engine

**Branch**: `004-ai-chart-risk-engine` | **Date**: 2026-09-10 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/004-ai-chart-risk-engine/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Build a deterministic, versioned analysis pipeline that validates OHLCV data, calculates indicators and market structure, detects patterns and zones, scores confirmations, derives trade levels and R:R, and projects the result onto the web chart. Reuse the existing Python quant engine as the calculation authority, adapt results through TypeScript domain/API contracts, record setup state and audit evidence, and keep AI limited to explanation.

## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: Python >=3.11 for deterministic analysis; TypeScript 5.7 / Next.js web and service contracts

**Primary Dependencies**: Existing quant package, domain/event contracts, signal and risk services, `lightweight-charts` 5.2.1, existing Next.js API routes, Vitest, pytest

**Storage**: Existing audit and domain persistence boundaries; analysis snapshots and lifecycle events must retain strategy/calculation versions. Chart annotations are derived projections.

**Testing**: pytest for quant calculations; Vitest for contracts/services; existing integration and Playwright suites for state, API, chart, and responsive behavior

**Target Platform**: Existing Python service/runtime and Next.js web application for desktop and supported responsive views; PAPER/review mode in local and test environments

**Project Type**: Quantitative analysis library plus web/API feature in a monorepo

**Performance Goals**: Return a single validated chart analysis within the existing dashboard request budget; keep chart interaction responsive at the repository's supported candle history and do not make explanation availability a prerequisite for deterministic results.

**Constraints**: Deterministic outputs for identical inputs and strategy version; fail closed on unsafe data; no LLM-calculated levels; no broker side effects; immutable strategy versions for reproducibility; no guaranteed-profit claims.

**Scale/Scope**: Supported Indian indices, stocks, futures, and options across nine timeframes; one analysis snapshot may include higher/setup/entry timeframe evidence and an underlying/option pair; MVP extends existing chart and paper/backtest paths.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Safety Gates Are Non-Negotiable**: PASS. Data-quality blockers, minimum R:R, risk calculations, and no-trade states remain deterministic gates; this feature does not submit orders.
- **II. Explainable, Auditable Decisions**: PASS. Analysis snapshots, evidence, strategy/calculation versions, reasons, blockers, state transitions, and AI explanation status are represented in the data model and contract.
- **III. Mode and Broker Isolation**: PASS. The plan adds no broker call path; chart analysis and backtests remain broker-neutral and local/test defaults remain PAPER or review.
- **IV. Validate Before Promotion**: PASS. Backtests use the same signal rules as live analysis, preserve immutable versions, and retain reproducibility metadata; outputs are labeled simulation.
- **V. Test the Risk-Critical Contracts**: PASS. The test plan covers invalid/stale data, R:R, state transitions, options conflicts, annotation ordering, API contracts, audit, and backtest parity.
- **Trading Safety and Compliance**: PASS. No live activation is included; unsafe market data blocks new entries and no product output promises accuracy or returns.
- **Delivery and Verification**: PASS. The feature is split into independently testable quant, contract, visualization, lifecycle, and backtest slices with a quickstart and visible safe states.

## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
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
quant/
├── src/tradepulse_quant/signals/
│   ├── engine.py                 # extend validation and deterministic signal pipeline
│   ├── market_structure.py       # swing and HH/HL/LH/LL evidence
│   ├── indicators.py             # configurable indicator set
│   ├── patterns.py               # candlestick and chart patterns
│   ├── confirmation.py           # weighted confirmation score and blockers
│   └── setup_levels.py            # entry, stop, targets, R:R
└── tests/
  ├── test_signal_engine.py
  ├── test_market_structure.py
  ├── test_patterns.py
  ├── test_setup_levels.py
  └── test_backtest_metrics.py

packages/domain-contracts/src/
└── entities.ts                   # versioned analysis/setup/annotation types

services/
├── signal/src/                    # setup lifecycle and audit events
├── risk/src/                      # reuse risk and R:R gate
├── backtest/src/                  # same engine and versioned result metadata
├── audit/src/                     # analysis snapshots and state evidence
└── market-data/src/               # quality and freshness boundary

apps/web/
├── app/api/analysis/              # analysis and annotation API routes
├── app/page.tsx                   # chart/setup integration
└── components/                    # chart annotations and setup evidence views

tests/
├── contract/                      # API/domain/market-data contracts
├── integration/                   # lifecycle, parity, audit, and no-broker behavior
└── e2e/                           # chart rendering and responsive no-trade states
```

**Structure Decision**: Extend the existing monorepo boundaries. Python owns deterministic calculations; shared TypeScript contracts define the service/UI boundary; services own lifecycle, risk, backtest, audit, and market-data integration; the web app only renders projections and requests analysis. No new standalone application is introduced.

## Complexity Tracking

No constitution violations. The feature uses existing quant, service, contract, audit, risk, and web boundaries; new modules are justified only where the current single signal function cannot represent the required evidence and test surfaces without duplication.
