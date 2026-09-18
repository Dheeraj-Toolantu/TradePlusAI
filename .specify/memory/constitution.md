<!--
Sync Impact Report
- Version change: 0.1.0 -> 1.0.0 (initial project constitution)
- Modified principles: none; all principles established for the first ratified version
- Added sections: Trading Safety and Compliance; Delivery and Verification
- Removed sections: none
- Follow-up TODOs: confirm final broker, exchange, and regulatory requirements before live execution
-->

# TradePulse AI Constitution

## Core Principles

### I. Safety Gates Are Non-Negotiable
The deterministic risk engine MUST be a hard gate before every assisted or live order.
It MUST enforce configured risk per trade, minimum risk/reward, daily loss, open-position,
trade-count, quantity, liquidity, event-risk, and kill-switch rules. Uncertain market data,
broker state, authentication, risk-service availability, or protection-order state MUST fail
closed and prevent new live orders. No feature may imply guaranteed profit, accuracy, or returns.

### II. Explainable, Auditable Decisions
Every signal and live execution decision MUST preserve its input conditions, market and news
context, strategy version, AI outputs, risk decision, user or automation actor, order lifecycle,
fills, exits, and failure outcomes. AI MAY propose, explain, rank, or classify; it MUST NOT
independently submit a live order. Audit records MUST be append-only and sufficient to reconstruct
why an action was allowed, blocked, modified, or exited.

### III. Mode and Broker Isolation
PAPER, ASSISTED, and ALGO LIVE MUST be explicit, visible modes with distinct permissions and
order destinations. Paper mode MUST be technically unable to call live broker order endpoints.
Strategy logic MUST use a broker-neutral execution contract and MUST NOT call Groww or any other
broker directly. Broker credentials, tokens, and TOTP secrets MUST remain server-side and MUST
never appear in browser bundles, client logs, or ordinary application logs.

### IV. Validate Before Promotion
Strategies MUST progress through historical out-of-sample testing, walk-forward validation,
live-data paper trading, and limited live deployment with strict caps before broader automation.
Backtests MUST distinguish simulation from live performance and report trade-level and aggregate
metrics, including drawdown, costs, slippage, exposure, and regime-wise results. A strategy version
that has entered a live run MUST be immutable.

### V. Test the Risk-Critical Contracts
Unit, integration, contract, and end-to-end tests MUST cover risk calculations, lot-size rounding,
minimum R:R rejection, mode isolation, idempotency, partial fills, protective orders, broker
reconciliation, stale-data handling, kill-switch behavior, and audit completeness. Any change to
shared order, risk, strategy, market-data, or broker contracts MUST include compatibility tests.

## Trading Safety and Compliance

The product MUST clearly label PAPER, ASSISTED, and ALGO LIVE states and require explicit live
activation plus risk-limit confirmation. It MUST maintain secure authentication, least privilege,
role-based administrative access, encrypted credentials in transit and at rest, protected
kill-switch controls, security-event logging, and broker-position reconciliation. It MUST detect
stale, missing, crossed, or invalid market data; block new entries when data quality is unsafe;
reconcile unknown order status before retrying; and recalculate protection after partial fills.
Before live launch, the team MUST verify current Groww, exchange, and applicable SEBI retail
algo requirements and obtain specialist compliance review where the business model requires it.

## Delivery and Verification

Work MUST be delivered in independently demonstrable slices aligned to the product roadmap:
market intelligence, strategy and risk controls, backtesting and paper trading, contextual news
intelligence, broker-connected assisted trading, controlled live automation, and later broker or
analytics expansion. Each slice MUST include a written acceptance scenario, observability for
critical failures, user-visible safe-state behavior, and documentation of assumptions. The UI MUST
keep critical risk state, connection health, active mode, exposure, and blockers visible without
deep navigation, using the provided dark desktop trading-console reference as visual direction
without treating the image as a substitute for functional acceptance criteria.

## Governance

This constitution supersedes conflicting project practices. Every specification, plan, task list,
review, and release decision MUST identify how it complies with the principles above; exceptions
require explicit written rationale, named approval, compensating controls, and a removal or review
date. Amendments require a documented impact report, semantic version increment, review of affected
specifications and tests, and updates to downstream guidance when governance changes. Versioning is
semantic: MAJOR for incompatible governance changes, MINOR for new or materially expanded rules,
and PATCH for clarifications that do not change obligations. Compliance is reviewed at feature
planning, pre-live validation, incident follow-up, and release readiness.

**Version**: 1.0.0 | **Ratified**: 2026-09-08 | **Last Amended**: 2026-09-08
