# Implementation Plan: Platform Requirements Convergence

**Branch**: `003-platform-requirements-convergence` | **Date**: 2026-09-08 | **Spec**: [spec.md](spec.md)

## Summary

Complete the missing, safety-critical implementation slices identified by the business-document audit. Extend existing TypeScript analytics and risk boundaries, extend Python/TypeScript metric contracts without changing broker-neutral strategy APIs, and add operational evidence artifacts. Live execution remains disabled.

## Technical Context

**Language/Version**: TypeScript 5.x / Next.js 15 for application services and UI; Python 3.11+ for quantitative metrics and deterministic indicator validation.

**Existing boundaries**: `services/options-analytics`, `services/market-data`, `services/risk`, `services/paper-trading`, `services/backtest`, `services/audit`, `services/notifications`, `adapters/groww`, `apps/web`, and `tests`.

**Persistence**: Preserve current repository abstractions. Add interfaces and deterministic in-memory implementations first; production persistence/provider wiring must be explicit and must not silently downgrade safety.

**Testing**: Vitest contract/unit/integration tests, Python unittest/pytest-compatible tests, existing e2e/load tests, and security isolation tests.

**Constraints**:

- Paper mode cannot invoke live broker order endpoints.
- Stale, invalid, crossed, discontinuous, or outlier market data blocks new assisted/live entries.
- News and analytics produce context only and cannot submit orders.
- Live execution flags remain false and compliance readiness remains blocked until evidence is reviewed.
- No credentials may enter client bundles or ordinary logs.

## Constitution Check

**PASS with required safety preservation**

- Safety and fail-closed behavior remain first-class.
- No live activation is introduced.
- New analytics are explainable and versioned.
- Provider-specific work remains behind existing adapter/provider boundaries.
- Tests are required for every new risk or execution behavior.

## Architecture and Change Surfaces

1. Add pure indicator and price-action functions to `services/options-analytics/src/market-indicators.ts` with explicit insufficient-data status.
2. Add OI classification to `services/options-analytics/src/options-chain-service.ts` and preserve existing summary output compatibility.
3. Add a market-structure trade-setup validator beside the price-action functions. It must distinguish bullish momentum from an actionable entry, require a confirmed 5-minute breakout close or breakout-retest hold, and emit `WAIT_FOR_BREAKOUT` or `NO_LONG` when price is at/below nearby resistance without confirmation.
4. Derive structural invalidation, target, and position size in that order. A long stop must be below the confirmed swing/retest structure with a configurable buffer; targets must come from the next validated resistance or volatility projection. Calculate R:R before a setup is displayed, and block any setup below the configured minimum (default 2.0:1) rather than presenting it as executable.
5. Extend quantitative and TypeScript analytics to calculate cost-aware, R-aware, and regime-aware reports.
6. Strengthen `services/market-data/src/market-feed.ts` and `services/risk/src/data-quality-gate.ts` with quality checks that feed existing risk gates.
7. Add paper square-off orchestration through `services/paper-trading` and the existing mode policy.
8. Add notification outbox/provider contracts without requiring external credentials in tests.
9. Add operational/compliance evidence and release validation documentation.

## Project Structure

Changes remain within the existing modular monorepo:

```text
services/options-analytics/  services/market-data/  services/risk/
services/paper-trading/      services/backtest/     services/audit/
services/notifications/      adapters/groww/         apps/web/
quant/                        packages/domain-contracts/  tests/
docs/                         specs/003-platform-requirements-convergence/
```

## Implementation Approach

Use pure, deterministic calculations first; connect them to existing signal, risk, and paper boundaries second; add operational evidence last. Signal generation is staged as observation -> setup validation -> risk validation -> execution eligibility. A bullish EMA alignment or recovery may produce context, but it cannot by itself produce a LONG entry. Each phase is independently testable, and no task changes the default live-release flags.

### Trade-setup validation contract

The signal engine MUST expose the market context and the decision separately. The context may
include EMA alignment, momentum, volume expansion, support, resistance, and price-action markers;
the decision must include status, side, entry, structural stop, target, risk points, reward points,
R:R, confirmation type, and blocking reasons.

- For a potential long, if the proposed entry is at or below nearby resistance and there is no
  confirmed 5-minute close above it, the status is `WAIT_FOR_BREAKOUT`; it is not a LONG entry.
- A breakout confirmation requires a 5-minute close above resistance. Elevated volume is preferred
  evidence, but lack of volume confirmation must remain visible and configurable rather than hidden.
- A breakout-retest confirmation requires the broken resistance to hold as support, followed by a
  bullish 5-minute candle. Rejection in the resistance zone produces `NO_LONG`; a short is only
  eligible after its own bearish confirmation and risk validation.
- Structural stop placement precedes sizing. For a long, the stop is below the confirmed swing low
  or retest support plus the configured buffer; the system must not reuse a distant support merely
  because it makes the calculation convenient.
- Target selection uses the next validated resistance, a volatility projection, or another explicit
  structure rule. The system MUST calculate `reward / risk` and apply the minimum R:R gate before
  rendering an actionable signal. Invalid or insufficient structures produce a blocked/waiting state,
  never a fabricated target or zero-valued metric.

For the review fixture, current price `23,567.85` against resistance `23,571.05` must resolve to
`WAIT_FOR_BREAKOUT`; the 3.20-point gap and the displayed `0.36:1` R:R must not be rendered as an
executable LONG. This fixture is a regression case for both the resistance-location and R:R gates.

## Delivery Phases

### Phase 0: Baseline and contract inventory

Capture current tests, task-status discrepancies, and public return-shape compatibility before edits.

### Phase 1: Analytics completeness

Implement indicators, price-action markers, OI classification, and complete metrics with deterministic tests.

### Phase 2: Safety and paper operations

Implement data-quality blockers, square-off policy, notification outbox, and isolation tests.

### Phase 3: Operational readiness

Add load/accessibility evidence, compliance and incident-response artifacts, and update release validation.

### Phase 4: Final verification

Run focused tests, full test suite where available, production build, and confirm live flags remain disabled.

## Risks and Mitigations

- **False precision in indicators**: Return status/version and insufficient-data states; never substitute zeros.
- **Bullish context mistaken for permission to enter**: Keep observation, confirmation, and risk decisions separate; require breakout/retest confirmation when price is directly below resistance.
- **Unusable trade geometry**: Derive stop and target from structure, calculate R:R before display, and fail closed when the configured minimum is not met.
- **Provider outage**: Preserve safe state and expose fallback status; do not turn fallback data into live authorization.
- **Metric interpretation errors**: Use fixture-based formulas and explicit no-trade/no-loss representations.
- **Operational incompleteness**: Keep release evidence as a blocking artifact and retain disabled live flags.

## Completion Evidence

The feature is complete only when the focused tests pass, including resistance-location, breakout/retest,
rejection, structural-stop, target, and minimum-R:R cases; the web build passes; paper/live isolation
passes; the quality checklist is updated; and `docs/compliance/live-readiness.md` still records live
activation as blocked unless all external approvals are documented.
