# Crude oil and gold (MCX) on the algo page

CRUDEOIL and GOLD sit next to NIFTY, BANK NIFTY and SENSEX on the Auto algo trading page, the
trade desk and the Smart Scalper. The VWAP-EMA scalper can trade them (paper only), manually or
through server-side auto-execution. NIFTY Sniper AI stays NIFTY-only, as its spec requires.

## How the contracts are found

Nothing about Groww's MCX symbol format or segment name is hard-coded. At runtime, on your server,
`apps/web/lib/underlying-catalog.ts` reads Groww's instrument list and takes the MCX rows whose
underlying symbol is exactly `CRUDEOIL` or `GOLD` (never the mini contracts CRUDEOILM / GOLDM).
The exchange, segment and trading symbol sent to every Groww call (quotes, option chain, history)
are those rows' own values. If the list has no such rows, the page shows that error instead of
guessing.

**Not yet verified against Groww.** Groww's documentation was not reachable from the build
environment, so the MCX calls have not been exercised against a live Groww account. On the first
run with your credentials, check the option chain and the chart for CRUDEOIL and GOLD. Any Groww
error is shown as is and blocks trading (fail closed).

## What differs from the index options

| | Index options | MCX commodities |
| --- | --- | --- |
| Spot and chart | Index cash quote / candles | Nearest unexpired future (MCX options are options on futures) |
| VWAP volume | Near-month future's volume | The future's own volume |
| Entries (scalper V5 gate) | 09:35-14:45 IST | 09:20-22:45 IST |
| Square-off | 15:15 IST | 23:00 IST (before the 23:30 close) |
| India VIX | Criterion and V5 gate | Not applicable: both are off (the engine decides, not the caller) |
| Live premiums | Streamed over the quote socket | Refreshed with the option-chain poll |
| Charges | NSE schedule | NSE schedule as an approximation (MCX levies CTT and its own fees) |

Session times live in `apps/web/lib/underlyings.ts` and `MCX_TRADING_WINDOWS` in
`quant/.../algo_engine/engine.py`. Exchange holidays are not modelled.

## Sizing

GOLD options are large: one lot can risk more than the Scalper's default ₹1,500 max loss per
trade, and then the plan is refused (one lot never rounds past the limit). Raise *Max loss / trade*
on the Scalper if you mean to trade it.

## Also fixed

The engine took the gap-day state only from intraday candles, and the 1-minute feed carries only
today, so the V5 gap gate reported `MISSING_GAP_STATE` and blocked every VWAP-EMA scalp (indices
included). It now falls back to the last completed daily bar for the previous session's range.
