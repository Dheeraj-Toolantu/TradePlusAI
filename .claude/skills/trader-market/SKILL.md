---
name: trader-market
description: >-
  Market Clock and Costs. The market profile every trader-* skill shares, India
  (NSE) by default: NSE hours 9:15 to 15:30 IST, the 2026 NSE trading holiday
  list (with Diwali Muhurat noted), NSE tick sizes, rupee formatting in lakh and
  crore, and the round-trip charges of an intraday equity trade (brokerage at
  Groww's rate, STT, NSE transaction charge, SEBI fee, IPFT, stamp duty, GST).
  The original US profile (NYSE, New York time, USD) is one flag away. Use when
  the user says "is the market open", "is NSE open today", "is tomorrow a
  holiday", "NSE holidays", "when does the market open", "what is the tick
  size", "what will the charges be", "brokerage and STT on this trade",
  "breakeven after charges", or "switch to the US market".
argument-hint: "[status | holidays | tick PRICE | charges --qty N --buy P --sell P] [--market IN|US]"
---

# trader-market

The Market Clock answers four plain questions for the trader-* skills: is the
market open, which days are holidays, what price steps are allowed, and what a
trade costs in charges. Every other trader-* tool loads this file, so the
whole pack speaks the same market.

`${CLAUDE_SKILL_DIR}` below is this skill's folder (where this SKILL.md lives).

```bash
python3 "${CLAUDE_SKILL_DIR}/market.py" status                         # open, pre-open or closed, next open
python3 "${CLAUDE_SKILL_DIR}/market.py" status --at "2026-11-10 10:00" # any IST moment
python3 "${CLAUDE_SKILL_DIR}/market.py" holidays --year 2026           # NSE trading holidays
python3 "${CLAUDE_SKILL_DIR}/market.py" tick 1234.56                   # tick size, rounded down and up
python3 "${CLAUDE_SKILL_DIR}/market.py" charges --qty 40 --buy 1250 --sell 1262.5
python3 "${CLAUDE_SKILL_DIR}/market.py" --market US status             # the NYSE profile
```

Add `--json` before the command for machine-readable output.

## Which market

The first one set wins:

1. `--market IN` or `--market US` on any trader-* tool
2. `"market": "IN"` in `trader/config.json`
3. the `TRADER_MARKET` environment variable
4. India (`IN`), the TradePulse default

## The India profile

| | |
| --- | --- |
| Exchange | NSE capital market (equity, `EQ` series). Yahoo symbols get `.NS` (`RELIANCE` -> `RELIANCE.NS`); `.BO` (BSE) and `^` indices pass through |
| Hours | 9:15 to 15:30 IST, pre-open 9:00 to 9:08. IST is UTC+05:30 all year, with no daylight time |
| Holidays | the 16 weekday NSE holidays of 2026. NSE publishes the 2027 list in December; until it is added, 2027 dates are checked for weekends only and the tools say so |
| Muhurat | Diwali Muhurat trading on Sunday 8 November 2026 is a short special evening session. The tools treat that day as closed and mention the session |
| Tick size | below Rs 250: 0.01; 250 to 1,000: 0.05; 1,000 to 5,000: 0.10; 5,000 to 10,000: 0.50; 10,000 to 20,000: 1.00; above 20,000: 5.00 (from 15 Apr 2025). NSE reviews each stock's band periodically from its closing price, so a stock trading just across a boundary can still carry its old tick; the tools round a stop or target with the coarser of the tick at that price and at the entry, which is valid in either band and covers the common case |
| Day-trade window | entries from 09:30 (after a 15-minute opening range) to 14:45, flat by 15:10, ahead of the broker's intraday auto square-off (about 15:10 to 15:20, charged per position) |
| Money | rupees, grouped in lakh and crore: Rs 12,34,567.50 prints as `₹12,34,567.50` |

## Charges (intraday equity, per round trip)

| charge | rate | on |
| --- | --- | --- |
| Brokerage | 0.1%, at most Rs 20 and at least Rs 5 per executed order (Groww's intraday rate) | each leg |
| STT | 0.025% | sell value |
| NSE transaction charge | 0.00297% | both legs |
| SEBI fee | 0.0001% (Rs 10 per crore) | both legs |
| IPFT | 0.0001% | both legs |
| Stamp duty | 0.003% | buy value |
| GST | 18% | brokerage + transaction charge + SEBI fee |

Override any rate under `"charges"` in `trader/config.json`, for example
`{"brokerage_max": 0, "brokerage_min": 0}` for a zero-brokerage plan. The
budget and risk skills add these charges to the loss at the stop and take
them off the reward, so a small target that charges eat is visible before you
trade.

## How to answer

- "Is the market open?": run `status` and say it in one line, in IST, with
  the next open if it is closed. On a holiday, name the holiday.
- "Is tomorrow a holiday?": run `status --at "<tomorrow> 10:00"`.
- "What will this cost?": run `charges` with the planned quantity, entry and
  target (or stop), then give the total, the net P&L and the breakeven move
  per share (total charges / quantity).
- If the date is outside the holiday list's years, say so and point the user
  to nseindia.com (Exchange Communication, Holidays).

These are estimates from published rates. The contract note from the broker
is the real number. Rates and holidays change: check the NSE circulars and
the broker's pricing page when it matters. Not financial advice.
