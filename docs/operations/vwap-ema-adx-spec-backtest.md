# VWAP–EMA–ADX Intraday Strategy (spec v1.0) on the Backtesting page

The specification "VWAP–EMA–ADX Intraday Strategy, Implementation Specification & Backtesting
Requirements" (v1.0, 03 November 2026) is implemented as the **VWAP–EMA–ADX (spec v1.0)** strategy
in the Backtest lab (`/validation`). It is separate from the live scalper (VWAP + 5/9 EMA + ADX
scalp), which is unchanged.

## Where each part lives

| Spec section | Implementation |
| --- | --- |
| 3. Data contract and validation | `services/backtest/src/spec-research.ts` → `validateMinuteBars`. It sorts ascending, keeps the first of duplicate timestamps, drops inconsistent OHLC, and counts missing minutes and sessions without volume. Nothing is forward-filled. It runs for every strategy, and the report goes in the notes and the Provenance panel. |
| 4. Indicators | `vwap-ema-adx-spec-strategy.ts` holds the session VWAP (typical price × volume, reset each session, undefined without volume) and EMA 9/21 (alpha 2/(n+1), seeded with an SMA). `indicators.ts` holds Wilder's ADX/+DI/−DI. It is checked against the reference implementation (`indicators.adx`) and the live Python strategy. |
| 5. Parameters | Settings: signal timeframe (5 m baseline, 1/3 selectable), ADX threshold (25), stop points (20), reward multiple (2), trades per day (3), daily loss limit, slippage, charges, square-off (15:15). |
| 6. Signal rules | `specSignal` is a pure function. BUY CE needs close > VWAP, EMA9 > EMA21, ADX > threshold, +DI > −DI and close > previous high. BUY PE is the mirror. |
| 7. Timing, look-ahead | A candle counts only once its last minute has closed (by the clock, never inferred from a later bar). The entry is at the next candle's open, and a missing next bar or a session change skips the entry with a logged reason. |
| 8. Risk | SL = open ∓ stop points and target = open ± stop points × multiple, both from the entry candle's open. The fill pays slippage. Positions are sized as lots × lot size, not the spec's risk-budget formula. |
| 9. Exits | SL first when one candle touches both. Then the target, then the optional EMA9/EMA21 opposite-cross exit (`SIGNAL_EXIT`, off by default), then EOD at the close of the 1-minute bar that reaches the square-off. Exit reasons are SL, TARGET, EOD, SIGNAL_EXIT and DATA/SAFETY. |
| 10. Engine | `runBacktest` (management `FIXED_POINTS`) processes bars chronologically with one position at a time and daily counters that reset each session. Rejected signals appear under "Skipped" with a reason and a count. The funnel note counts candles rejected by each rule, and the signal log CSV lists every signal with its point-in-time indicator values. |
| 11. Metrics | Win rate, gross and net P&L, profit factor (∞ when there is no loss), expectancy, averages and extremes, win and loss streaks, drawdown, the equity curve, daily P&L, long/short counts, time in market and trades per day. Results are segmented by month, weekday, direction, ADX bucket and trend/range day. One-at-a-time sensitivity covers the ADX threshold (including no filter), stop distance, reward multiple, timeframe and entry window. |
| 12. Validation | The walk-forward optimizer chooses on the first two thirds of the sessions and reports the last third. The baselines are "No ADX filter" and an intraday buy-and-hold. |
| 16.10 Provenance | The response and the JSON report hold the strategy version, every setting, the data source, sessions, bar count and a data fingerprint (FNV-1a of the tested candles). The same inputs give identical results. |

## Deviations and limits

- **VWAP without volume:**
  - Index candles carry no volume except where near-month futures volume is attached (recent days).
  - In the spec's STRICT mode, those sessions give no signals, and the run says so.
  - "Time-weighted when no volume" is an explicit, labelled deviation, for testing the price rules on older history.
- **Sizing:** sizing uses lots × lot size; the spec's risk-budget quantity formula is not implemented. P&L defaults to index points, as the spec asks.
- **Validation split:** the optimizer splits the data two ways (in-sample and out-of-sample), not into three periods (in-sample, validation and out-of-sample).
- **Out of scope here:** the options module (spec section 13) and live broker execution (section 14) are not part of this backtest.
- **Not Python:** the implementation is TypeScript inside the app's existing backtester, not the standalone Python package that section 17 describes.

## Open questions from section 18

- Is 5-minute the primary timeframe, with 1-minute confirmation? The sensitivity table compares 1, 3 and 5 minutes.
- Should the fixed 20-point stop become an ATR-based stop? Today the stop-distance sensitivity covers 10–40 points.
- Should the EMA crossover be an exit? It is available as a variant, off by default.
- Is the daily limit 3 trades, and is the risk budget fixed or a percentage of capital?
- Which strike policy applies to options (ATM, 1-step ITM or delta)? That belongs to the separate options module.
