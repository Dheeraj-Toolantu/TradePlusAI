---
name: trader-alerts
description: >-
  Price Alerts for NSE stocks. Rings when a price, a stop or the opening bell
  hits. Turns the trade plan into three alerts in one go (the stop, the target
  and "flat by close" at your flat-by time, 15:10 IST by default, ahead of the
  broker's intraday auto square-off), plus above / below / stop / target
  levels in rupees, percent moves from the previous close, any time of day,
  and the NSE opening bell at 9:15 IST, each ringing once so you are not
  spammed. Knows NSE hours (9:15 to 15:30 IST) and the 2026 NSE trading
  holidays, notes the Diwali Muhurat session, works out IST itself, fetches
  free delayed Yahoo quotes for <SYMBOL>.NS one ticker at a time (falling back
  to the BSE quote when the NSE one fails) and writes trader/prices.json for
  sizing and the risk check. --market US keeps the original NYSE behaviour.
  Use when the user says "alert me when", "tell me if RELIANCE hits", "watch
  my stop", "watch my trade", "remind me to square off by 3:10", "is the
  market open", "is NSE open today", "when does the market open", "get me a
  price", or right after /trader-exit writes a plan.
argument-hint: "[symbol] [price] [--market IN|US]"
---

# trader-alerts

Price Alerts watches the numbers so the user does not have to stare at a
chart. An alert is information, never an order: when a stop alert rings,
nothing is sold by this skill. With a bracket order the stop-loss and the
target already sit at the broker and do the work; the alerts tell the user
what happened and when it is time to be flat.

India (NSE, IST, rupees) is the default. Symbols are plain NSE symbols:
`RELIANCE`, `TCS`, `INFY`, `HDFCBANK`, `M&M`, `BAJAJ-AUTO`. `RELIANCE.NS`
is accepted and stored as `RELIANCE`. Add `--market US` (or `"market": "US"`
in `trader/config.json`) for the original NYSE / New York / dollar profile.

`${CLAUDE_SKILL_DIR}` below is this skill's folder (where this SKILL.md lives).

```bash
python3 "${CLAUDE_SKILL_DIR}/alerts.py" clock                          # NSE open or closed, next open
python3 "${CLAUDE_SKILL_DIR}/alerts.py" add --from-plan                # stop, target, flat by close from trader/plan.json
python3 "${CLAUDE_SKILL_DIR}/alerts.py" add --opening-bell             # rings at 9:15 IST
python3 "${CLAUDE_SKILL_DIR}/alerts.py" add --symbol RELIANCE --stop 2945
python3 "${CLAUDE_SKILL_DIR}/alerts.py" add --symbol RELIANCE --target 2985.20
python3 "${CLAUDE_SKILL_DIR}/alerts.py" add --at 15:10 --label "flat by close" --symbol RELIANCE
python3 "${CLAUDE_SKILL_DIR}/alerts.py" add --symbol INFY --pct 3
python3 "${CLAUDE_SKILL_DIR}/alerts.py" check                          # exit 0 = something rang
python3 "${CLAUDE_SKILL_DIR}/alerts.py" quote RELIANCE TCS --write     # -> trader/prices.json
python3 "${CLAUDE_SKILL_DIR}/alerts.py" quote --holdings --write       # portfolio + plan tickers
python3 "${CLAUDE_SKILL_DIR}/alerts.py" list
python3 "${CLAUDE_SKILL_DIR}/alerts.py" reset reliance-plan-stop
python3 "${CLAUDE_SKILL_DIR}/alerts.py" --market US clock              # the NYSE profile
```

`--now "2026-10-30 15:10"` pins the clock (IST; New York time with
`--market US`); `--offline DIR` reads saved quote files instead of the network.

## What it reads and writes

| file | what |
| --- | --- |
| `trader/plan.json` | the trade from trader-exit, for `add --from-plan` |
| `trader/config.json` | `"market"` and `flat_by` (used when the plan has none) |
| `trader/alerts.json` | the rules (`alerts.india.example.json` in this folder; `alerts.example.json` is the US one) |
| `trader/state/alerts.json` | which rules rang and when, so each rings once |
| `trader/prices.json` | the latest quotes, merged in, for trader-budget and trader-risk; India adds `"market": "IN"`, `"currency": "INR"` and each quote's exchange |
| `trader/portfolio.json` | the tickers held, for `quote --holdings` |

## Rule types

| type | rings when | rings again |
| --- | --- | --- |
| `above` / `target` | price at or above `price` | after `reset`, or on its own if `"rearm": true` and the price fell back |
| `below` / `stop` | price at or below `price` | same |
| `pct_move` | moved `pct` percent from the previous close (or `ref`), optional `direction` up or down | once per day at most |
| `time` | the IST clock passed `at` ("15:10") on a trading day | once per trading day |
| `opening_bell` | the NSE is open (9:15 IST) | once per trading day |

A rule with `"date"` is watched on that IST date only; `--from-plan` rules
carry the plan's date, so yesterday's stop never rings today. Flat-by comes
from the plan, then `flat_by` in the config, then 15:10 IST: brokers square
off intraday (MIS) positions from about 15:10 to 15:20 and charge for it, so
be flat before they do it for you. `"before_close": true` only matters on the
NYSE's 1:00 p.m. early-close days (it moves the alert 3 hours earlier); the
NSE has no early closes.

## Quotes

- `yahoo` (default): `query2.finance.yahoo.com/v8/finance/chart/RELIANCE.NS`,
  an unofficial free JSON endpoint, one request per ticker, half a second
  apart. Symbols are URL-quoted (`M&M` is fetched as `M%26M.NS`). On a 429 it
  waits and tries once more; on a 429 or a 5xx after that it tries `query1`.
- **BSE fallback.** Stooq does not cover NSE stocks reliably, so in India it
  is not used. Instead, when the NSE (`.NS`) quote fails for any reason, the
  tool reads the same company's BSE quote on Yahoo (`RELIANCE.BO`), tags it
  `yahoo-bse`, prints a note, and records `"exchange": "BSE"` and the reason
  in `trader/prices.json`. The BSE price can differ from the NSE one by a few
  paise; say which one it is. `--source bse` reads BSE only. `--source stooq`
  is refused in India with a clear message (it still works with `--market US`).
- Prices print in rupees with Indian grouping: `RELIANCE ₹2,958.40 (+1.49% vs
  prev close ₹2,915.00)  2026-10-30 10:52 IST`.
- Free quotes are unofficial, delayed and can lag. They are fine for alerts
  and for checking a size, not for timing an order. The broker's price is the
  one that fills. Each price in `trader/prices.json` keeps its quote time, and
  trader-risk only uses one under 15 minutes old.
- If both are down, read the price from the broker (the Groww or Kite app, or
  the broker connector) and write it into `trader/prices.json` as
  `{"as_of": "...Z", "market": "IN", "currency": "INR", "prices": {"RELIANCE": 2958.4}}`.

## The NSE clock

Regular session 9:15 to 15:30 IST (pre-open call auction 9:00 to 9:08),
closed on weekends and on the 2026 NSE trading holidays from the shared
market profile (`trader-market`): Jan 15, Jan 26, Mar 3 (Holi), Mar 26,
Mar 31, Apr 3, Apr 14, May 1, May 28, Jun 26, Sep 14, Oct 2, Oct 20
(Dussehra), Nov 10 (Diwali Balipratipada), Nov 24, Dec 25.

- **Diwali Muhurat trading** is on Sunday 2026-11-08: a short special evening
  session whose timings NSE announces by circular. The clock notes it on that
  date and on the days around it ("Special session: 2026-11-08: Muhurat
  trading ..."), but does not treat it as a regular session, so the opening
  bell and time alerts do not ring for it. Check the NSE circular for the times.
- IST is UTC+5:30 all year, with no daylight saving; the tool ignores the
  computer's own time zone.
- The 2027 NSE list is not published yet (NSE issues it in December): for
  2027 dates the clock says the holiday list is unknown. Check
  nseindia.com (Exchange Communication, Holidays).

With `--market US` the clock is the NYSE: 9:30 to 16:00 New York time, the
2026 and 2027 NYSE holidays and the 1:00 p.m. early closes.

## Steps

1. Right after trader-exit writes the plan, run `add --from-plan`. Confirm
   the three alerts back to the user: the stop, the target and the flat-by
   time, in rupees and IST.
2. Run `check` while the trade is open: every few minutes from a Claude
   scheduled task or `/loop`. Each run fetches only the tickers in today's
   rules and rings each alert once. A check reads the latest delayed quote;
   it is not a live feed, and a price can pass a level between two checks.
3. Tell the user what rang in one line each. A stop or target alert means the
   bracket order has probably filled: check the position and record the fill
   with trader-broker. "Flat by close" means close anything still open:
   trader-broker `flatten`, then trader-risk, then the user's yes. Never act
   for them.

## Example: an NSE day trade

RELIANCE on Friday 2026-10-30: entry ₹2,958.40 at 09:45 IST, stop ₹2,945
(opening-range midpoint), target ₹2,985.20 (2R), no flat_by in the plan, so
15:10 IST. `add --from-plan` writes `reliance-plan-stop`,
`reliance-plan-target` and `reliance-flat-by` for that day. A `check` at
10:53 reads the 10:52 quote, between the stop and the target:

```
NSE OPEN (2026-10-30 10:53 IST, regular session).
Nothing hit. 3 rule(s) watched today, RELIANCE ₹2,958.40.
```

At 15:10 IST:

```
ALERT Flat by close: it is 15:10 IST (set for 15:10), the market closes at 15:30. If RELIANCE is still
open, close it: trader-broker flatten --symbol RELIANCE builds the sell ticket, then trader-risk and your yes.
```

It rings once. On Monday the plan's three alerts are no longer watched; with
`add --opening-bell`, the bell rings at 9:15 IST.

## Rules

- An alert is a fact about a price or the clock. Say it as a fact.
- Never present a quote as live. Free quotes are delayed and unofficial.
- Say when a price is the BSE fallback rather than the NSE quote.
- Confirm every new rule back to the user: symbol, type, level in rupees, day.

## What it never does

It never places, cancels or changes an order, never claims a quote is
live, and never predicts where a price is going.

## Safety

- Education and tooling, not financial advice. A PASS is a rules check, not a recommendation.
- Paper trading by default (`"paper": true`). Going live is the user's own decision, in their own config.
- Nothing in this pack places an order except trader-broker, and only when all three hold: trader-risk
  passed that exact order today, the user typed an explicit yes for that one order in the chat, and the
  user clicked Allow once on Claude's own card because the order tool is set to "Needs approval"
  (Customize > Connectors > tool permissions). Never set an order tool to "Always allow".
- India (Groww): there is no order connector, so Claude never places a live order. Paper fills are
  simulated locally. A live order is placed by the user, in the Groww app or Trade API or through
  TradePulse's own execution service with its PIN, kill switch and LIVE_* limits.
- No options, margin, short selling or leverage unless the config allows it and the user confirms.
- Broker keys live in environment variables or the Claude Desktop config, never in the chat.
