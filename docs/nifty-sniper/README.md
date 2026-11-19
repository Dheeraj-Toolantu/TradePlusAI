# NIFTY Sniper AI (paper) — implementation notes

`REQUIREMENTS.md` is the product baseline (v1.1). This file records what is built, how to run it,
the assumptions made and what is still missing. Nothing here claims the strategy is profitable:
no option-level backtest has been run yet.

## How to use it

1. Open **Auto algo trading** (`/execution`).
2. In the strategy card choose **Strategy: NIFTY Sniper AI** (or choose it in the Scalper's
   *Auto option engine* selector — the two stay in sync). The page switches to NIFTY.
3. Turn on **Auto-execute on Scalper** (or **Trade: Automatic** on the Scalper). From then on the
   Node server re-runs the strategy a few seconds after every 1-minute close, with or without a
   browser open, and places a CONFIRMED setup on the paper Smart Scalper. With Automatic off, a
   confirmed setup waits for **Place on Scalper** / **Take trade**.
4. The panel shows the lifecycle state, setup family, direction, the 100-point score and its
   eight components, every hard filter, the sweep / MSS / FVG / order-block evidence, the contract
   (and rejected ones), the 2x feasibility read and the reference levels.

Paper only. Live orders keep going through the separate PIN-confirmed `/api/live-orders` flow and
are not wired to this strategy.

## What runs where

| Piece | File |
| --- | --- |
| Strategy engine (structure, setups, scoring, options, feasibility, hard filters) | `quant/src/tradepulse_quant/algo_engine/sniper_strategy.py` |
| V5 pipeline wiring (all operational gates still apply) | `quant/src/tradepulse_quant/algo_engine/engine.py` (`_sniper_evidence`) |
| Data fetch, placement, sniper daily locks | `apps/web/app/api/algo-trading/route.ts` (`runSniper`, `sniperPlan`, `placeOnScalper`) |
| Server-side auto-execution (strategy-aware) | `apps/web/lib/vwap-auto-trader.ts` |
| Fill-based stop/target, sniper trail, exits | `services/paper-trading/src/smart-scalper.ts`, `scalper-trail.ts` |
| Decision journal (Firestore `sniperSignals`) | `apps/web/lib/sniper-journal.ts` |
| UI | `apps/web/app/execution/page.tsx`, `components/execution/sniper-panel.tsx`, `components/scalper/scalper-desk.tsx` |
| Tests | `quant/tests/test_sniper_strategy.py`, `tests/unit/nifty-sniper.test.ts` |

Run the tests:

```bash
cd quant && PYTHONPATH=src python -m pytest -q tests/test_sniper_strategy.py
```

```bash
npx vitest run tests/unit/nifty-sniper.test.ts tests/unit/vwap-auto-trader.test.ts
```

## Rules as implemented (config `sniper-1.0.0`, all in `SniperConfig`)

* **Candles.** Timestamp = candle start; intervals are `[start, start + n)`. Forming candles are
  dropped. 15m bars are resampled from completed 5m bars, anchored at 09:15 IST.
* **Pivots.** Fractal 2-left / 2-right on 5m; confirmed only at the close of the 2nd right-side
  candle and never used before that bar.
* **Levels.** PDH / PDL (exchange daily bar, else the prior 5m session), confirmed 5m swings,
  equal highs / lows (within 0.10 ATR). A level is tradable only while *untaken*.
* **Liquidity reversal.** Sweep beyond an untaken level by ≥ 0.05 ATR, reclaim close within 2
  bars, then an MSS close beyond the last swing (opposite kind) confirmed *before* the sweep bar;
  a displacement candle (body ≥ 55% of range, close in the outer 30%, range ≥ 1.1 ATR) between
  the sweep and the MSS. Sweep without MSS = WATCH. MSS older than 3 completed 5m bars = EXPIRED.
* **Breakout expansion.** 6-bar range ≤ 2.5 ATR tall, a displacement close beyond it on ≥ 1.3×
  relative (futures) volume, every later close still beyond it, 15m regime not opposite.
* **Trend continuation.** 15m TREND_UP / TREND_DOWN, 5m HH/HL (LH/LL), pullback in the last 6
  bars into an FVG, order block, VWAP or EMA20 without breaking the protected swing.
* **1m trigger.** Latest completed 1m candle coloured in the trade direction, closing beyond its
  9 EMA and the prior candle's extreme, closed ≤ 180 s ago; price ≤ 1.0 ATR(5m) from the trigger
  level (no chasing).
* **Regime (15m).** HIGH_VOLATILITY if ATR / median bar range ≥ 1.8; LOW_VOLATILITY if ≤ 0.6 and
  EMAs flat; TREND_UP / TREND_DOWN from EMA 9/20, EMA20 slope and VWAP side; else RANGE;
  UNCLASSIFIED with < 4 bars. HIGH_VOLATILITY blocks entries; RANGE blocks trend continuation.
* **Score.** Weights 20/15/15/15/10/10/5/10, normalised to 100; minimum 85. Missing data scores 0
  with status `UNAVAILABLE`.
* **Contract.** Same-side contracts with delta 0.40–0.70, premium ≥ ₹15, OI and volume > 0, spread
  ≤ 2% when a quote exists; ranked by liquidity, closeness to the 0.45–0.65 band and spread.
* **Feasibility (heuristic).** Index move for 2x of the expected fill (delta + Black-Scholes gamma
  + theta over a 60-minute hold, or the time left to the 15:15 square-off if shorter + round-trip
  charges) vs `ATR(5m) × √(hold/5)`. Ratio ≤ 1.25 passes; charges ≤ 15% of the 2x reward; ≥ 5 min to
  the 15:15 square-off; ≥ 1 lot within the per-trade budget.
* **Order flow in the selected option (hard filters).**
  * *Premium buying volume rising*: the selected contract's own 1-minute candles (fetched in a
    second engine pass) — the last 5 completed minutes average ≥ 1.2 × the 20 before them, ≥ 55% of
    that volume traded on rising-premium candles, and the premium is up over those 5 minutes. For
    a PUT the rising put premium is the index sellers in control.
  * *Writer OI change rising*: CALL needs put writers, PUT needs call writers. Read from the
    server's stored 3-minute strike OI samples (the last 4, ±3 strikes around ATM): net build ≥ 0.3%,
    most intervals adding, the latest interval still adding, and faster than the opposite writers.
    With fewer than 3 fresh samples it falls back to market-intel's single 5-minute OI change
    (labelled a 5-min reading); with neither it fails closed.
* **Hard filters.** Setup confirmed, signal fresh, 1m trigger, not chasing, entry window
  09:15–15:15 IST, regime tradable, contract selected, spread, 2x feasibility, OI (optional by
  default), premium buying volume rising, writer OI rising, score ≥ 85 — then every V5 gate (data quality, session, option quote, daily risk,
  broker, contract master, reconciliation, execution, VIX, gap, liquidity, R:R, kill switch,
  SAFE_MODE).
* **Execution (paper).** Stop = 0.75 × and target = 2.0 × the **actual fill** (re-derived in
  `SmartScalper.place`); a fill > 2% above the plan is refused; size = floor(per-trade budget /
  stressed loss per lot), never rounded up. Trail: breakeven + charges at 1.25x, 1.2x locked at
  1.5x, 0.2 × entry under the best premium from 1.75x, exit at 2x. Also exits on the index
  invalidation (beyond the swept extreme / protected swing), after 90 min below 1.25x, on the
  per-trade max loss and at 15:15. Locks: 3 sniper entries and 2 consecutive sniper losses per
  day, on top of the Scalper's own trade cap, daily loss stop, cool-down and one-trade-at-a-time.

## Assumptions (please confirm — spec §25)

1. Broker / data: Groww (already the only provider in this repo) for candles, chain, quotes.
   Groww's chain carries no live bid/ask, so spreads are usually `UNAVAILABLE`; the spread filter
   then passes on liquidity alone and a capped half-spread estimate is charged in the costs.
2. Index candles carry near-month **futures** volume (attached by the history route). VWAP uses
   it; the volume score uses the selected option's own premium volume, else futures relative
   volume; without either it scores 0.
3. OI is snapshot-based (market-intel 5-minute flow); interpretations are labelled TENTATIVE.
   `require_oi` is off: missing OI costs 15 points, which makes 85 nearly unreachable — so in
   practice OI is required. Confirm whether that is the intent.
4. Entry window 09:15–15:15 (the V5 session gate uses the same window for the sniper; on expiry
   day the V5 gate still stops entries 15 minutes earlier), square-off 15:15 (the Scalper's),
   90-minute time stop. A setup needs one completed 5m candle today, so the first read is at 09:20.
5. Per-trade risk = the Scalper's *Max loss / trade* setting (default ₹1,500; spec example ₹1,000);
   daily loss = the Scalper's *Daily loss stop*.
6. Thresholds (85, ratio 1.25, delta band, displacement, sweep buffer, trail stages) are research
   defaults, **not** validated values.

## Known gaps (not done — do not treat as complete)

* **No option-level backtest / walk-forward / calibration** (spec §12.4, §15). Probabilities are
  reported as `UNAVAILABLE`; the feasibility ratio is a heuristic. Release gate G2 is not met.
* With default thresholds the 2x feasibility gate rejects most non-expiry-day setups (an ATM
  premium of ₹100+ needs a 150–250 point move). Expect few or no trades on many days.
* Partial exit at 1.5x is not implemented (the trail locks 1.2x instead); compare policies in a
  backtest before choosing.
* No PostgreSQL schema / migrations for the spec's tables; the decision journal goes to Firestore
  (`sniperSignals`) like the rest of this app.
* No live broker path for the sniper (by design until gates G2–G4 pass), no BANKNIFTY / SENSEX.
* Chart overlays (sweep / MSS / FVG markers on the chart) are listed as text, not drawn.
