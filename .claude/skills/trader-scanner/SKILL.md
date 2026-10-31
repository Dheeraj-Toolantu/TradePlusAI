---
name: trader-scanner
description: >-
  Chart Scanner. Scans hundreds of NSE charts for setups: opening-range
  breakouts, flags, oversold bounces. Builds the list of NSE stocks you can
  day trade from NSE's own equity list (EQ series only, so no BE / BZ
  trade-to-trade names), narrowed to the Nifty 50, 100, 200 or 500 (the
  default) or every EQ stock, runs a pre-market scan of daily closes (20-day
  closing-high breakout, bull flag, reclaimed the 20-day average, oversold,
  oversold bounce) and an intraday opening-range breakout scan on 5-minute
  bars from 9:15 IST, with price and traded-value floors in rupees, then
  writes trader/watchlist.json for trader-news and trader-entry. Free Yahoo
  data (.NS symbols), bar by bar. --market US gives the original NYSE /
  Nasdaq scanner. Use when the user says "scan the market", "scan the Nifty
  500", "find me setups", "what is breaking out", "opening range breakouts",
  "scan for bull flags", "oversold stocks", "pre-market scan", "build my
  watchlist", "what should I look at today", or at the start of a trading
  day before /trader-news.
argument-hint: "[universe [--index nifty50|nifty100|nifty200|nifty500|all] | daily | orb] [--at HH:MM] [--market IN|US]"
---

# trader-scanner

The Chart Scanner is the first step of a day trade. It reads hundreds of free
charts and lists the ones that match a rule. That is all it does. A scan is a
list of charts that match a rule, not a list of stocks to buy, and a setup on
a chart is not a prediction. SEBI's own studies found that about 7 in 10
individual intraday equity traders lost money; the scanner does not change
that. It only saves you from flipping through 500 charts by hand.

India (NSE, IST, rupees) is the default. `--market US` (or `"market": "US"`
in `trader/config.json`, or `TRADER_MARKET=US`) gives the original US scanner:
Nasdaq Trader's symbol lists, 9:30 to 16:00 New York time, dollars.

`${CLAUDE_SKILL_DIR}` below is this skill's folder (where this SKILL.md lives).

```bash
python3 "${CLAUDE_SKILL_DIR}/scan.py" universe                          # Nifty 500 -> trader/universe.txt
python3 "${CLAUDE_SKILL_DIR}/scan.py" universe --index nifty100         # or nifty50, nifty200, all
python3 "${CLAUDE_SKILL_DIR}/scan.py" daily                             # before 9:15 IST -> trader/watchlist.json
python3 "${CLAUDE_SKILL_DIR}/scan.py" daily --symbols RELIANCE,TCS,INFY,HDFCBANK
python3 "${CLAUDE_SKILL_DIR}/scan.py" orb                               # after 9:35 IST -> trader/watchlist.json
python3 "${CLAUDE_SKILL_DIR}/scan.py" orb --at 10:00                    # cut the clock at 10:00 IST
python3 "${CLAUDE_SKILL_DIR}/scan.py" orb --watchlist trader/watchlist.json --json
python3 "${CLAUDE_SKILL_DIR}/scan.py" --market US orb --at 10:15        # the NYSE scanner, 10:15 AM ET
```

Flags: `--min-price` (₹50), `--min-value-cr` (rupee crore: daily 10, orb 1),
`--min-volume` (shares, 0 = off in India), `--or-minutes 15`,
`--max-confirm 200` (orb stage 2), `--now "2026-10-29 10:00"` (IST) to pin the
clock, `--offline PATH` to read saved files, `--no-write`, `--show N`,
`--json`, `--market IN|US`. Symbols are plain NSE symbols (`RELIANCE`, `M&M`,
`BAJAJ-AUTO`); `RELIANCE.NS` is accepted and stored as `RELIANCE`. Exit code
0 when the scan found something, 1 when it found nothing or could not run
(the reason is one plain line).

## What it reads and writes

| file | what |
| --- | --- |
| `trader/universe.txt` | written by `universe`: one `SYMBOL\|Company Name\|Industry` a line (plain symbols, no `.NS`), read by `daily` and `orb` |
| `trader/cache/EQUITY_L.csv` | NSE's equity list, cached exactly as published. trader-news reads it for company names |
| `trader/cache/ind_<index>list.csv` | the index list (`ind_nifty500list.csv`...), cached as published |
| `trader/watchlist.json` | written by `daily` and `orb`: `mode`, `as_of` (IST), `universe`, `scanned`, `failed`, `market` "IN", `currency` "INR", `hits[]` with `symbol`, `name` and `industry`. trader-news and trader-entry read `hits[].symbol` |
| `trader/config.json` | `market`, and for `orb` `no_entries_after` (default 14:45 IST) |

## The universe (India)

`universe` downloads two CSVs from NSE's archives, with a browser-like
User-Agent and Accept headers (NSE refuses bare scripts):

1. `archives.nseindia.com/content/equities/EQUITY_L.csv`, header
   `SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT,
   ISIN NUMBER, FACE VALUE` (the column names carry leading spaces; the tool
   strips them). Only `SERIES == EQ` is kept. BE and BZ are trade-to-trade
   series: every trade must be delivered, so they cannot be day traded.
2. `archives.nseindia.com/content/indices/ind_<index>list.csv` for `--index`
   `nifty50`, `nifty100`, `nifty200` or `nifty500` (the default), header
   `Company Name,Industry,Symbol,Series,ISIN Code`. A member that is not in
   the EQ series of EQUITY_L today is dropped and counted. `--index all`
   keeps every EQ stock (about 2,000 names, many of them thin).

Both CSVs are saved raw under `trader/cache/`. When NSE cannot be reached
(it often answers 403 to data-centre IPs), the cached copy is used and the
tool says how old it is. Offline: `--offline DIR` (a folder holding
`EQUITY_L.csv` and the index CSV), or `--file EQUITY_L.csv` and
`--index-file ind_nifty500list.csv`. Run it once a week, and after index
rebalances (end of March and end of September).

## The floors (India defaults, and why)

| flag | default | why |
| --- | --- | --- |
| `--min-price` | ₹50 | below ₹50 the ₹0.01 tick is a large share of a typical stop, many such stocks sit in tight 5 % price bands or the ASM lists, and spreads are wide |
| `--min-value-cr` (daily) | ₹10 crore a day | the average daily traded value (close x volume) over the last 20 sessions when volumes are known, else the last session's price x volume. ₹10 crore a day means a ₹1 to 5 lakh intraday order is a tiny share of the flow, so it fills near the screen price and the stop can be honoured |
| `--min-value-cr` (orb) | ₹1 crore so far | the rupees traded since 9:15 by the cutoff (last price x volume so far). A breakout on a few lakh of turnover is one order, not a move |
| `--min-volume` | 0 | share counts mean little across ₹50 and ₹20,000 stocks; the rupee floor does the job. Set it if you want one |

Set any of them to 0 to turn it off. Pass your own: `--min-price 100
--min-value-cr 25` for large caps only.

## The daily scan (before the open)

Yahoo's spark endpoint returns closes for 20 symbols a request, so the Nifty
500 takes 25 requests. Liquidity comes from the spark meta (last price and
last session's volume) because spark has closes only. Run it before 9:15 IST
or after 15:30: during the session the volume is the day's so far, and
today's daily bar is left out until 15:30.

The setups are computed from daily closes only (spark has no highs or lows):

| setup | the rule on closes |
| --- | --- |
| `breakout_20d` | the last close is above every close of the 20 sessions before it |
| `bull_flag` | up more than 10 % over the 10 sessions before the last 5, then the last 5 closes inside a 5 % range |
| `reclaim_ma20` | the close before was under its 20-day average, the last close is above it |
| `oversold` | RSI 14 (Wilder) under 30 |
| `oversold_bounce` | RSI 14 was under 30 yesterday and today closed up |

Hits are listed most rupees traded first, each with its traded value in
crore, its company name and its industry.

## The opening-range breakout scan (during the session)

NSE's session runs 9:15 to 15:30 IST. The opening range is the first
`--or-minutes` (15) of the session: the 9:15, 9:20 and 9:25 five-minute bars.
The first bar after it closes at 9:35, so run `orb` after 9:35 IST (10:00 is
a common check). A hit is the first completed 5-minute bar to CLOSE above the
range high, at that bar's close time.

1. Stage 1, every symbol: spark closes of today's 5-minute bars, 20 a
   request. A chart goes on only if a completed bar after the range closed at
   or above the highest close of the range (a necessary condition, so no
   breakout is lost).
2. Stage 2, each candidate: the v8 chart with real highs and lows, one
   request each. Range high = the highest high of the range bars. At most
   `--max-confirm` (200) candidates are checked, the most traded first, and
   PARTIAL is printed with the count it skipped.

A chart is usable only when every 5-minute bar from 9:15 to the cutoff is
there; a missing bar means a freeze, a circuit or a thin stock. Before 9:35,
on a weekend or an NSE holiday (Diwali Balipratipada, 10 Nov 2026, for
example), after 15:30, or after `no_entries_after` (14:45 IST by default: an
expired setup) it prints one plain line and writes nothing.

## Data and limits

- Yahoo's NSE data (`RELIANCE.NS`) is free and unofficial. It is not an NSE
  feed, it can lag by several minutes, bars can arrive late or be revised,
  and Yahoo can change or block it without notice. Bars are 5-minute bars,
  never tick by tick. Before acting, check the price in your broker's app.
- Symbols with `&` (M&M) are URL-quoted (`M%26M.NS`).
- Avoid stocks at or near their circuit limit or in a narrow price band
  (2 %, 5 %, 10 %): a stock locked at its upper or lower circuit has no
  sellers or buyers, so a stop cannot fill. The scanner cannot see the bands.
- Avoid stocks on NSE's ASM (Additional Surveillance Measure) and GSM (Graded
  Surveillance Measure) lists: they carry higher margins, trade-to-trade
  settlement or price bands, and brokers often block intraday in them. The
  scanner cannot see these lists either; check nseindia.com (Surveillance)
  or your broker's app for each hit.
- The F&O ban list does not matter here: it limits new derivative positions,
  and this pack trades cash equity intraday (MIS) only.
- Partial results are said as partial: "Fetched 480 of 500 charts (20 failed
  or had no data)". Never round a partial scan up to "the whole market".
- NSE holidays come from the shared market profile (trader-market, 2026
  list). The 2027 list is not published yet: check nseindia.com.

## Steps

1. Once a week or so: `scan.py universe` (Nifty 500).
2. Before the open (by 9:00 IST): `scan.py daily`. Tell the user the counts
   (fetched, liquid, scanned, hits) and the top few by setup, with names.
3. After 9:35 IST (10:00 is a common check): `scan.py orb`. Tell the user how
   many usable charts broke their range and when, and that a later hit is
   closer to the price now.
4. The user picks one chart. Hand it on: `/trader-news RELIANCE` (what is
   moving it), then `/trader-entry RELIANCE` (the entry bar by bar). Never
   pick for them.

## Example (synthetic data)

Thursday 29 Oct 2026, scan at 10:00 IST
(`tests/day-trader-skill/fixtures/trader-scanner-in/`, made-up bars):

```
python3 scan.py orb --offline wall5m-synthetic-2026-10-29.json --now "2026-10-29 10:00"
Opening-range breakout scan, Thu 2026-10-29 10:00 AM IST: 15-minute range (9:15 AM to 9:30 AM), 5-minute bars, Yahoo.
Fetched 6 of 6 charts; 3 usable (2 under the price / traded-value floor); 2 candidates, 2 confirmed with real highs and lows.
2 of 3 charts closed above their opening-range high by 10:00 AM:
   9:35 AM  M&M           ₹3,212.40  range 3,182.96 to 3,200.00  +0.39% over
   9:45 AM  RELIANCE      ₹1,405.50  range 1,392.92 to 1,400.00  +0.39% over
```

RELIANCE's range is the 9:15 to 9:25 bars, high ₹1,400.00; the 9:40 bar
closed at ₹1,405.50, at 9:45 AM. TCS had a missing bar (unusable); a ₹31
stock and one with a few thousand rupees traded were under the floors. The
user picks RELIANCE and Claude hands it to `/trader-news RELIANCE`, then
`/trader-entry RELIANCE`.

## Rules

- Say what was scanned: which index, how many symbols, how many charts came
  back, how many were usable, and the time of the data in IST.
- Say "matched a rule", never "a buy", "a winner" or "a good trade".
- Never print a P&L, a return or a profit figure.
- A hit is stale once the price has moved on. Re-run before acting on it.
- Remind the user to check circuit bands and the ASM / GSM lists for a hit.

## What it never does

It never places, sizes or checks an order, never says which stock to buy,
never calls data real time, and never promises that a setup works. Nothing is
placed without your yes.

## Safety

- Education and tooling. Not financial advice. A PASS is a rules check, not a recommendation.
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
