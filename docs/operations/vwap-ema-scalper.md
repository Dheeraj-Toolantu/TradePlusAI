# VWAP-EMA Scalper (index options)

The execution page's V5 rule engine runs one strategy, the **VWAP-EMA Scalper**. It replaced the
Intrinsic Value OTM engine. It buys a CE for a long and a PE for a short on NIFTY, BANKNIFTY or
SENSEX. It reads its tape on the **near-month future's own 1-minute OHLCV**: the index has no traded
volume, and a true VWAP needs one instrument's own price and volume. Future points and index points
move together intraday, so index levels are the future's levels minus the basis.

Code:

| File | What it does |
| --- | --- |
| `quant/src/tradepulse_quant/algo_engine/scalp_strategy.py` | Rules, strike selection, the delta-gamma plan |
| `quant/src/tradepulse_quant/algo_engine/engine.py` | V5 evidence (`_scalp_evidence`) |
| `apps/web/app/api/algo-trading/route.ts` | Inputs, the server re-check, place-on-scalper |
| `services/paper-trading/src/smart-scalper.ts` | `SmartScalper.place`, `vwapEmaTrail`, `emaMomentumLost` |
| `apps/web/components/scalper/scalper-desk.tsx` | The strategy selector, auto and manual placing, the OI-picked strike, the drawings |
| `apps/web/app/execution/page.tsx` | The panel |
| `apps/web/components/scalper/premium-chart.tsx` | The risk-reward drawing |

## The criteria (all 10 points needed)

| Criterion | Points | Long (CE) rule; the short (PE) side is the mirror |
| --- | --- | --- |
| VWAP | 2 | The future's close is above its own session VWAP (the future's price and volume). VWAP rises over the last 5 bars. Price is at most 1.5 ATR(1m) above VWAP, so no chasing. Without the future's OHLCV, VWAP fails closed. |
| 5/9 EMA | 2 | The 5 EMA is above the 9 EMA, which is above VWAP. A pullback inside the last 3 bars tags the 9 EMA. Then a green candle closes above the 5 EMA and the prior high, on at least 1.2× the futures volume of the prior 20 bars. The trigger counts on the latest completed candle, or on the one before it while price is within 0.5 ATR. |
| Delta | 1 | The selected strike's \|delta\| is 0.40-0.60. |
| OI | 2 | (1) The 5-minute writer flow score is +1 or higher. (2) The ATM strike shows put writing, call short covering or call buying, with no fresh call writing. The biggest call-OI wall above spot must be beyond the target. |
| PCR | 1 | Explicit zones: stretched < 0.50 ≤ bearish < 0.80 ≤ neutral ≤ 1.20 < bullish ≤ 1.60 < stretched. A long needs neutral or bullish with a PCR that is not falling (5-minute change ≥ 0). A short needs bearish or neutral with a PCR that is not rising (≤ 0). Stretched zones block both sides. |
| Volume profile | 1 | Built on the selected premium's own 1-minute candles: the point of control (POC) and the 70% value area (VAH/VAL). The premium must close above its POC, and either at or above the VAH or on a volume burst of at least 1.5×. |
| India VIX | 1 | The VIX regime is LOW, NORMAL or HIGH, and the value is between 10 and 24. Below 10, premiums barely move; EXTREME means whipsaws. |

**Strike auto-selection from OI.** The candidates are the trade side's strikes with delta 0.35-0.65,
a premium of at least ₹20 and a spread of at most 3%. They are ranked on four things:
- open interest and volume;
- the option's own 5-minute build-up: long build-up and short covering score +2, fresh writing scores −2;
- how close the delta is to 0.5;
- spread (a wide one is penalised).

## Risk-reward from delta and gamma (1:1 or 1:2), measured on the fill

The stop is set on the future's tape. It goes beyond the pullback extreme or the 9 EMA, whichever is
further, plus a buffer of 0.15 ATR. R (points) is the distance from the entry to that stop:
- **Too tight:** below 0.3 ATR, the stop is widened to 0.3 ATR, because tighter is inside 1-minute noise.
- **Too wide:** above 1.5 ATR, the trade is refused as not a scalp.

```
premium SL      = M − (|Δ|·R − ½·Γ·R² + θ·hold/375)     structural, from the market premium M
expected fill F = ask × (1 + slippage), rounded up to the tick
premium R       = F − premium SL
premium target  = F + k · premium R,   k = 1 (1:1) or 2 (1:2)
index move x the target needs:  |Δ|·x + ½·Γ·x² = target − M + θ·hold/375
```

In these formulas:
- Δ is the chain's delta.
- Γ is the Black-Scholes gamma from the chain's IV and the expiry.
- θ is the per-day theta, charged over a 10-minute hold.

R:R is measured on what the scalper actually pays, so 1:1 and 1:2 hold on the real fill. The index
must move a little more than k × R (the fill pays the spread and slippage). The engine solves for that
move and checks it against the OI wall. The V5 R:R gate wants at least 97% of the chosen ratio at the
fill (0.97 or 1.94). Every other strategy keeps its 2.0 minimum.

**Costs.**
- **Fees:** brokerage, STT, exchange and SEBI fees, stamp duty and GST.
- **Spread:** the entry spread is in the ask-based fill; the exit half-spread is charged at the bid.
  The estimate is capped at 0.5% of the premium per side, because Groww's chain has no live bid/ask.
- **Slippage:** the Smart Scalper's own fill slippage (`SCALPER_SLIPPAGE_PCT`, 0.3% by default),
  applied adversely on both legs. The route passes it to the engine, so the plan and the fills agree.

If these costs, plus what the fill paid above the market, exceed 25% of the reward, the trade is
refused. On NIFTY with a 10-15 point stop, a 1:1 is usually refused this way (30% in the tests); a
larger move, e.g. BANKNIFTY, qualifies.

**Planned versus stressed loss, and lots.**

```
planned loss / lot  = (F − SL) × lot + fees + exit half-spread + exit slippage
stop gap / unit     = max(2 ticks, 10% × premium R)        a stop can fill through its price
stressed loss / lot = planned loss / lot + stop gap × lot
lots                = ⌊ max loss per trade ÷ stressed loss / lot ⌋   (≤ the desk's lots setting)
```

Both losses and both R:R figures (net and stressed) are shown before the trade.

## Trading it on the Scalper (auto or manual)

The Scalper desk has a **Strategy** selector. It defaults to *VWAP-EMA scalper*; the other choice is
*Level scalper*, the desk's original support/resistance engine. With VWAP-EMA selected:

- **Engine on + Automatic.** A CONFIRMED setup is placed in the Smart Scalper's paper book as soon as
  all 7 criteria and every V5 gate pass.
- **Engine on + Manual.** "⚡ Take trade" lights up when the setup is confirmed, and you place it with
  a click.
- **Level engine.** It never enters while VWAP-EMA is selected. It still manages exits.
- **Auto-selected premium.** The trade side's card and chart follow the strike the scalper picked from
  OI, marked with an "OI pick" badge. ▲▼ still move the strike, and the next new pick re-centres it.
- **Risk-reward drawing.** It appears on that premium's chart. Before entry it shows the plan. After
  entry it shows the live position: entry, the current SL and the target. Once the SL has trailed above
  the entry, the drawing shows the profit it locks.

Every placement goes through the server first. `POST /api/algo-trading` with
`action: PLACE_ON_SCALPER` re-runs the strategy and checks every V5 gate itself: broker health, daily
risk, contract metadata, SAFE_MODE and the kill switch. Nothing the browser sends can confirm a trade.

`SmartScalper.place` then applies the book's own limits:
- the kill switch and SAFE_MODE;
- the daily loss limit, a 5-minute cool-down after a loss, and 3 losses in a row;
- the trade cap and one engine position per index;
- market hours (09:15-15:15 IST, trading days).

**Re-plan on the actual fill.** The fill is the live ask plus slippage, rounded against the trader.
- **Stale setup:** a fill above the plan's `max_entry` (expected fill + max(2 ticks, 0.2 × R)) is refused.
- **Stop:** stays at its structural price; slippage never moves it.
- **Target:** R and the target are re-derived from the fill (target = fill + k × R), never beyond
  `max_target`. That cap is the premium with the index at the OI wall, or the worst-fill target if lower.
- **R:R:** must still reach the minimum.
- **Lots:** re-sized so the stressed loss at that fill fits the max loss per trade.
- **Record:** the position stores the planned versus actual fill and the planned and stressed loss,
  and the desk shows them.

Each setup is placed once, keyed on its trigger candle and side. Placing is **paper only**. It never
sends a live order; live orders still go through `/api/live-orders`, with a preview and a PIN.

### Systematic SL, target and trailing SL

R is the initial premium risk: the entry minus the delta-gamma SL. The stop only ever moves up.

| Stage | When | SL moves to |
| --- | --- | --- |
| Initial | entry | the delta-gamma SL |
| Breakeven | the best premium reaches +0.5R | the entry plus round-trip charges per unit (cost-covered breakeven) |
| Locked | +1R | the entry + 0.5R |
| Trailing | beyond +1R | the best premium − 0.6R |

Exits:
- **Target.** The premium target, or the index target (`SPOT_TARGET`).
- **Stop.** `STOP_LOSS`, `BREAKEVEN_STOP`, `LOCKED_PROFIT_STOP` or `TRAILING_STOP`, depending on the stage.
- **Momentum lost.** After breakeven, a completed 1-minute index candle closes back through the 9 EMA
  (`EMA9_LOST`).
- **Index invalidation.** `SPOT_LEVEL_BROKEN`.
- **Time stop.** The trade hasn't reached +0.5R within the desk's scalp time stop.
- **Risk limits.** The max loss per trade, and the 15:15 square-off.

The stage, the initial SL and the costs per unit are saved with the order, so a restart resumes the
same trail.

**Exits run on the server.** `apps/web/lib/scalper-monitor.ts` runs in the Node server process every
5 seconds. It fetches live option quotes, the index spot and 1-minute candles itself, and calls
`SmartScalper.manage()`.
- **Startup:** `apps/web/instrumentation.ts` starts it at boot, which also reloads persisted open
  positions after a restart.
- **Bad quotes:** a missing spot quote never triggers an index exit, and the 15:15 square-off runs
  even without a fresh option quote.
- **Desk:** the desk shows the monitor's status. Its own 10-second scan still runs, and the scalper
  serialises both, so a position is never closed twice.

## The panel

The panel shows:
- the criteria tiles and the reason for each;
- the auto-selected premium with its Greeks, OI, OI change and build-up;
- the delta-gamma working of the stop and the target;
- the gross and net R:R, the charges share, the lots and the max loss;
- the selected premium's 1-minute chart, marked with POC, VAH and VAL and with a risk-reward drawing.
  The drawing shows a green reward zone and a red risk zone with rupee amounts, drawn from the trigger
  candle;
- the 17 V5 gates.

## Not verified live

The build sandbox had no market access, so nothing here has run against live Groww data yet. The
strategy is covered by tests on synthetic 1-minute tapes:
- `quant/tests/test_scalp_strategy.py`
- `tests/unit/scalp-place.test.ts`
- `tests/contract/algo-trading-route.test.ts`

Check the first live sessions in paper mode, in particular:
- the 1-minute futures-volume attachment for VWAP;
- the per-strike 5-minute OI build-up that market-intel produces;
- the option-history 1-minute candles that feed the volume profile.
