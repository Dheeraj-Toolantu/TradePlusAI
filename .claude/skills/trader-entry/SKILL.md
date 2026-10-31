---
name: trader-entry
description: >-
  Entry Timer for NSE stocks. Watches a setup bar by bar and tells you the
  moment to get in. Reads free Yahoo 1-minute or 5-minute bars (RELIANCE.NS,
  TCS.NS ...), builds the opening range from the 9:15 IST open (the first 15
  minutes by default: the 9:15, 9:20 and 9:25 bars) and calls the entry on the
  first completed bar that CLOSES above the range high, or above a level you
  give it (like a 20-day high from the scanner), with an optional volume
  check. Says not open yet, range forming, waiting and how far, triggered with
  the IST time and the rupee price, or expired (no new entries after 14:45
  IST by default), knows the NSE holidays and the next open, and writes
  trader/entry.json for /trader-exit. Long side only. It never places an
  order. --market US gives the original NYSE behaviour. Use when the user says
  "tell me when to get in", "watch RELIANCE", "has INFY broken out", "did it
  break the opening range", "entry signal", "time my entry", "check my
  watchlist", or after /trader-scanner and /trader-news, before /trader-exit.
argument-hint: "[SYMBOL] [--setup orb|level] [--interval 5m|1m] [--market IN|US]"
---

# trader-entry

The Entry Timer turns a setup into one moment: the bar that confirms it. It
reads bars, 1-minute or 5-minute, and waits for each one to finish. A price
that pokes above the high in the middle of a bar is not an entry. A bar that
CLOSES above it is. Then it says the time and the price, writes them down for
the Exit Planner, and stops. It never buys anything. Day trading loses most
people money, and a clean signal does not change that.

India (NSE, IST, rupees) is the default market. The clock, the NSE holiday
list, the tick sizes and the rupee formatting come from the shared
`trader-market` profile. Add `--market US` (or `"market": "US"` in
`trader/config.json`) for the original NYSE behaviour in New York time and
dollars, unchanged.

`${CLAUDE_SKILL_DIR}` below is this skill's folder (where this SKILL.md lives).

```bash
python3 "${CLAUDE_SKILL_DIR}/entry.py" check RELIANCE              # 15-minute opening range, 5-minute bars
python3 "${CLAUDE_SKILL_DIR}/entry.py" check RELIANCE --write      # also save trader/entry.json
python3 "${CLAUDE_SKILL_DIR}/entry.py" check TCS --setup level --level 3150
python3 "${CLAUDE_SKILL_DIR}/entry.py" check INFY --interval 1m --min-volume-x 1.5
python3 "${CLAUDE_SKILL_DIR}/entry.py" watch HDFCBANK --until 14:45 # one line per closed bar, stops on the trigger
python3 "${CLAUDE_SKILL_DIR}/entry.py" watchlist                   # every hit in trader/watchlist.json
python3 "${CLAUDE_SKILL_DIR}/entry.py" check TSLA --market US      # the NYSE, New York time
```

Other flags: `--or-minutes N` (default 15), `--json`, `--offline FILE` (a
saved Yahoo chart JSON, `.json` or `.json.gz`, or a folder of
`<SYMBOL>.json` or `<SYMBOL>.NS.json`), `--now "2026-10-30 09:50"` (IST; a
trailing ` IST` is fine) to replay a day. `watch` with `--now` or `--offline`
runs on a simulated clock and replays the day bar by bar without waiting.

Symbols are the plain NSE symbol: `RELIANCE`, `M&M`, `BAJAJ-AUTO`. A `.NS`
suffix is accepted and dropped; the tool adds it back only for the Yahoo
request (`RELIANCE.NS`, URL-quoted, so `M&M` works).

## What it reads and writes

| file | what |
| --- | --- |
| `trader/watchlist.json` | the scanner's hits (`hits[].symbol`), for `watchlist` |
| `trader/config.json` | `no_entries_before` (09:30) and `no_entries_after` (14:45), IST, and `"market"`. Optional |
| Yahoo chart API | today's bars, `range=1d&interval=5m` (or `1m`) for `RELIANCE.NS`: free, unofficial, can lag |
| `trader/entry.json` | with `check --write`, or when `watch` triggers: symbol (plain NSE symbol), setup, status, time, bar, price, level, opening range, plus `market` and `currency` |

## The rule

- **Opening range (orb).** The high and low of the first 15 minutes after the
  9:15 IST open: the 9:15, 9:20 and 9:25 five-minute bars, or fifteen 1-minute
  bars. The level to beat is the range high.
- **Level.** A price you give, like a 20-day high from `/trader-scanner`.
- **The trigger** is the first completed bar after the range that CLOSES
  above the level. A wick above is not a trigger. A close exactly at the
  level is not above it.
- **The time** is that bar's close time in IST (the 9:45 bar closes at 9:50
  AM). The price is its close, on the NSE tick (0.10 for a stock between
  Rs 1,000 and Rs 5,000), shown in rupees with lakh grouping.
- **Only closed bars count.** A bar is closed when the clock passes its start
  plus 5 (or 1) minutes and Yahoo has caught up to that moment (it waits a
  minute at most). Yahoo's live tick, like 10:49:45, is never a bar.
- **Volume, if you want it.** `--min-volume-x 1.5` also needs the trigger
  bar's volume at 1.5 times the range bars' average. The 9:15 bar holds the
  pre-open auction's fill, so 1.0 is already strict.
- **Time limits.** No entries before 09:30 or after 14:45 IST (config), so
  there is time to be flat by 15:10, ahead of the broker's intraday (MIS)
  auto square-off.
- **What it says.** Before 9:15: NOT OPEN YET. Before 9:30: RANGE FORMING.
  Then waiting (and how far the last close is from the level), triggered,
  expired, or no data. Weekends and NSE holidays (Diwali Balipratipada on
  10 November 2026, say): the market is closed, with the next open.

## Steps

1. Get the symbol from the user, or run `entry.py watchlist` after
   `/trader-scanner`. Check `/trader-news` for it first.
2. Run `entry.py check SYMBOL`. Tell the user the status in one line:
   waiting and how far, triggered at what IST time and rupee price, or expired.
3. To wait for it, Claude can run `entry.py watch SYMBOL --until 14:45` in
   the background, or `entry.py check SYMBOL --write` on a `/loop` every 5
   minutes. `watch` wakes just after each bar closes, prints one line per
   bar, and exits 0 on the trigger (it writes `trader/entry.json`) or 1 when
   the setup expires. Keep the computer awake while it watches: a sleeping
   laptop pauses it, and it catches up, late, when it wakes.
4. When it triggers, say the time and the price, and that nothing was placed.
   If the trigger is more than a bar old, say that too: a late entry is a
   different trade.
5. Hand off to `/trader-exit` to set the stop and the target BEFORE anything
   is bought.

## Example: RELIANCE (synthetic bars)

RELIANCE, Friday 2026-10-30, 5-minute bars. The opening range is 1,398.00 to
1,412.00. At 9:47 IST the 9:45 bar is still open, so it waits:

```
WAITING  last close ₹1,411.20 (9:40 bar), ₹0.80 under the range high ₹1,412.00 (-0.06%).
The 9:45 bar is still forming (₹1,415.30 so far, closes 9:50 AM); it does not count until it closes.
```

At 9:50 the bar has closed:

```
RELIANCE  Fri 2026-10-30 09:50 IST  opening-range breakout (15-minute range) on 5-minute bars (Yahoo, free, can lag)
Opening range 9:15-9:30: high ₹1,412.00, low ₹1,398.00 (3 of 3 bars).
TRIGGERED 9:50 AM IST at ₹1,415.30: the 9:45 bar (bar 6) closed above the range high ₹1,412.00 (+0.23%).
This is the moment to get in, if you take the trade. Nothing was placed.
Next: set the stop and target BEFORE you buy: /trader-exit (exit.py plan --from trader/entry.json).
```

## Example: the reel, with --market US

TSLA, Monday 2026-10-19, New York time. The opening range is 354.47 to
362.18; at 10:15 AM the 10:10 bar (bar 8) closes at $364.18, above the range
high $362.18, and the tool says TRIGGERED 10:15 AM at $364.18. With
`--min-volume-x 1` the 10:10 bar is too thin (0.60x the range's volume) and
the trigger moves to 10:35 AM at 365.75. In US mode the window is 09:45 to
15:30 ET and a 1:00 p.m. early close moves the cutoff up to 12:30.

## Rules

- Bar by bar, on free Yahoo 1-minute or 5-minute bars. They are unofficial
  and can lag. Say so when a minute matters.
- A signal is information, not an order, and not a promise. Nothing here
  promises winning trades or money.
- Long side only. v2 plans longs only. If the user wants a short, say that.
- One trigger per setup per day: the first close above. Later closes do not
  reset it.
- Never call an entry early because a bar looks like it will close above.
- Times are IST and prices are rupees unless the user chose `--market US`.

## What it never does

It never places an order, never sizes a position, never sets the stop (that
is `/trader-exit`), never moves the level after the fact, and never counts a
bar that has not closed. It never runs `/trader-broker` from a background
watch: nobody is there to say yes.

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
