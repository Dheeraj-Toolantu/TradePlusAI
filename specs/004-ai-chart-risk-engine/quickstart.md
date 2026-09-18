# Quickstart: AI Trading Chart and Risk/Reward Engine

This guide validates the feature through deterministic fixtures and existing repository test conventions. It does not enable live execution.

## Prerequisites

- Node.js and pnpm installed according to the repository package manager metadata.
- Python 3.11 or newer with the `quant` project available.
- Repository dependencies installed.
- Local services and database fixtures available only when running integration or browser tests.

## Run Existing Baseline Tests

From the repository root:

```powershell
pnpm test
```

Run the quant tests:

```powershell
python -m pytest quant/tests
```

Expected result: existing signal, risk, options, backtest, and contract tests pass before feature-specific work is added.

## Validate Deterministic Analysis

Use fixed OHLCV fixtures covering:

1. Valid candles with known swing highs/lows and HH/HL relationships.
2. Each required bullish, bearish, and neutral candlestick pattern.
3. A pattern-only case with weak volume and no confirming structure.
4. Long and short setups with known support, resistance, ATR buffer, targets, and R:R.
5. Stale, invalid, duplicate, discontinuous, and insufficient candle data.
6. Aligned and conflicting underlying/option candles.

Expected results:

- Valid fixtures produce stable indicator, structure, confirmation, setup, and annotation outputs.
- Invalid or insufficient fixtures return explicit blockers and no confirmed setup.
- Pattern-only fixtures never become confirmed.
- Long and short R:R values match independently calculated references.
- Underlying/option conflicts reduce confidence or produce a waiting/no-trade status.

## Validate the API Contract

Start the web application using the repository's normal development command, then submit the request shape in [contracts/analysis-api.md](contracts/analysis-api.md) to the analysis endpoint through the existing local API path.

Verify:

- A valid result includes version metadata, evidence, setup levels, R:R, reasons, risks, invalidation, and annotations.
- A no-trade result has no setup levels and includes status plus blockers.
- Annotation retrieval returns projections of the saved analysis and does not accept client-provided price levels.
- Explanation failure leaves the deterministic response unchanged.

## Validate Lifecycle and Audit

Run the signal state-machine and integration tests with candidates that move through confirmation, entry trigger, active, targets, completion, and invalidation. Confirm each transition records from-state, to-state, reason, actor, timestamp, strategy version, and calculation version, with no broker call.

## Validate Backtest Reproducibility

Run the same backtest twice with identical symbol, timeframe, date range, capital, risk-per-trade, strategy version, and candle fixture. Compare trade records, levels, states, aggregate metrics, and reproducibility key.

Expected result: both runs are identical and are labeled historical simulation. The report includes wins, losses, win rate, average R:R, profit factor, maximum drawdown, average win/loss, expectancy, costs, slippage, exposure, and regime breakdown where available.

## Safety Checks

- Confirm local and test defaults remain PAPER or review mode.
- Confirm no analysis endpoint calls a broker adapter.
- Confirm no AI response is used to calculate or modify entry, stop, target, R:R, confidence, or state.
- Confirm stale or invalid data blocks new entries while preserving an auditable reason.
- Confirm the UI makes the active mode, data quality, setup status, and invalidation visible.
