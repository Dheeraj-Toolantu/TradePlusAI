---
name: trader-deals
description: >-
  Bulk and Block Deals Tracker, the Indian counterpart of the Pelosi tracker.
  Reads NSE's daily bulk-deal and block-deal files (who bought or sold how
  many shares of which stock, at what price), shows each deal with its value
  in rupees crore, filters by symbol, client name, buy or sell and minimum
  value, alerts once per new deal, and flags deals in stocks you hold or
  watch. Points to the manual route for SEBI insider-trading (PIT) and
  takeover (SAST) disclosures. Use when the user says "bulk deals today",
  "block deals", "who bought RELIANCE", "did any fund buy INFY", "big
  investor deals", "track this investor", "promoter selling", "insider
  trading disclosures", "alert me on bulk deals", or "run the deals skill".
argument-hint: "[fetch|new] [--symbol X] [--client TEXT]"
---

# trader-deals

Indian exchanges publish every large trade the same day. A bulk deal is a
client's trading in one stock in one session that adds up to more than 0.5%
of the company's listed equity shares; the broker reports it to the
exchange, and NSE posts the day's list after the close. A block deal is a
single large trade (at least Rs 10 crore) done in the exchange's separate
block-deal window, a short special session where two parties cross a
pre-agreed block. This skill reads both lists, notices what is new, and
tells you when one touches a stock you hold.

It is fast. It is not early. Both lists are PUBLIC post-trade disclosures:
the trade is done before anyone can read about it. A famous fund or investor
buying is not a signal to copy: they may be a market maker, an arbitrage
desk hedged elsewhere, a promoter group moving shares between its own
entities, or buying at a price and size you cannot get. There is no inside
information here: only public filings, read quickly. Say that every time.

This skill is for Indian markets (NSE). For US Congress trades use
`/trader-pelosi`.

Tool in this folder (standard library Python):

```bash
python3 "${CLAUDE_SKILL_DIR}/deals.py" --help
```

## What it reads and writes

- Reads `https://archives.nseindia.com/content/equities/bulk.csv` and
  `https://archives.nseindia.com/content/equities/block.csv` (one trading day
  each: Date, Symbol, Security Name, Client Name, Buy/Sell, Quantity Traded,
  Trade Price / Wght. Avg. Price, Remarks). A day with no deals comes back
  as "NO RECORDS" and shows as nothing.
- Writes `trader/deals.json` (the deals that matched, with `"market": "IN"`,
  `"currency": "INR"`, and for `new` a `"new": true` on the unseen ones) and
  `trader/state/deals.json` (the deals already shown, so each alerts once).
- Reads `trader/portfolio.json` (`"positions": [{"ticker": "RELIANCE", ...}]`,
  the format `/trader-risk` and `/trader-alerts` use; `"symbol"` works too)
  and `trader/watchlist.json` (the scanner's `"hits"`) to flag your stocks.

NSE sometimes refuses scripted downloads. If a fetch fails, the user opens
nseindia.com > Market Data > Bulk / Block Deals in a browser, downloads the
CSV and you pass it with `--file` (the kind is read from the file name, or
use `--bulk-file` / `--block-file`). `--file` can be repeated: every file is
read. The website's report download (header `"Buy / Sell "`, quoted, with
trailing spaces) is read as well as the archive CSV.

`--file` also reads the JSON the nseindia.com website API returns:
`{"data": [{"BD_DT_DATE", "BD_SYMBOL", "BD_SCRIP_NAME", "BD_CLIENT_NAME",
"BD_BUY_SELL", "BD_QTY_TRD", "BD_TP_WATP", "BD_REMARKS"}]}` (historical bulk
or block deals) or the snapshot `{"BULK_DEALS_DATA": [...],
"BLOCK_DEALS_DATA": [...]}` with `date`, `symbol`, `name`, `clientName`,
`buySell`, `qty`, `watp`, `remarks` (one file, both kinds). These field names
were written from memory and are NOT verified against the live site: if a
saved JSON does not parse, check its keys and use the CSV instead.

## The rules

- **Quote the exchange file, not a tracker.** Every row comes from NSE's
  file, with its date, client name as published and price.
- **Value is quantity times the (weighted average) price**, shown in rupees
  crore. Bulk-deal prices are a weighted average of the client's trades.
- **Look at both sides.** A big buy is often matched by a big sell the same
  day (a block changing hands, or a client buying and selling the same
  stock). Show the pair, not just the buy.
- **Names are as published.** "A/C" lines name the scheme of a fund house.
  Do not guess who is behind an LLP or a foreign portfolio investor.
- **No copying.** Report what was disclosed. A deal is a reason to look at a
  chart, not a setup.

## Step 1: today's deals

```bash
python3 "${CLAUDE_SKILL_DIR}/deals.py" fetch
python3 "${CLAUDE_SKILL_DIR}/deals.py" fetch --kind block --min-value-cr 100
python3 "${CLAUDE_SKILL_DIR}/deals.py" fetch --symbol RELIANCE --symbol INFY
python3 "${CLAUDE_SKILL_DIR}/deals.py" fetch --client "mutual fund" --side buy
python3 "${CLAUDE_SKILL_DIR}/deals.py" fetch --mine     # only what you hold or watch
```

`--symbol` takes plain NSE symbols (`M&M`, `BAJAJ-AUTO`, with or without
`.NS`) and repeats. `--client` matches any part of the client name, in any
case. `--json` prints everything machine-readable. Exit code 1 means no deal
matched.

## Step 2: watch for new ones

```bash
python3 "${CLAUDE_SKILL_DIR}/deals.py" new
python3 "${CLAUDE_SKILL_DIR}/deals.py" new --min-value-cr 50 --mine
```

Shows only deals not seen at the last check and records them in the state
file. Exit code 1 means nothing new. NSE posts the files after the close
(bulk deals in the evening, block deals after each window), so checking once
around 18:00 IST and once around 21:00 IST on trading days is plenty: run it
with `/loop` or a scheduled task.

## Example

```
NEW NSE deals: 3, 2 in symbols you hold
date       kind  symbol       side       quantity        price          value  client
2026-10-30 block RELIANCE     SELL      45,00,000    ₹1,468.20     ₹660.69 Cr  EXAMPLE PROMOTER HOLDINGS LLP  <- you hold RELIANCE
2026-10-30 block RELIANCE     BUY       45,00,000    ₹1,468.20     ₹660.69 Cr  DEMO INSURANCE COMPANY LIMITED  <- you hold RELIANCE
2026-10-30 block INFY         BUY        8,00,000    ₹1,502.00     ₹120.16 Cr  SAMPLE SOVEREIGN FUND
```

(synthetic test data.) Then: "A promoter entity sold a block of RELIANCE to
an insurer at the same price in the block window. This is a public
disclosure of a finished trade. It tells you who owns the shares now, not
where the price goes next."

If the user wants to act on it, it goes the long way: `/trader-scanner` and
`/trader-entry` decide if there is a trade today; then shares only (the
config has `allow_options: false`), sized by `/trader-budget`, checked by
`/trader-risk`, placed by `/trader-broker` only after their yes.

## Insider and takeover disclosures: the manual route

Two other SEBI disclosures are close cousins of these lists, and NSE shows
them on its website rather than as a simple file:

- **SEBI (Prohibition of Insider Trading) Regulations, 2015 (PIT):**
  promoters, directors and designated persons disclose their own trades in
  the company's shares (generally above Rs 10 lakh in a calendar quarter)
  within two trading days.
- **SEBI (Substantial Acquisition of Shares and Takeovers) Regulations, 2011
  (SAST):** anyone crossing 5% of a company, and every 2% change after that,
  discloses it; promoters disclose pledges.

The route:

1. The user opens nseindia.com > Companies > Corporate Filings and picks
   "Insider Trading" (PIT) or "Substantial Acquisition of Shares and
   Takeover" (SAST).
2. They type the company name or symbol and set the date range.
3. They download the table (CSV) or copy it, and paste it into the chat (or
   give you the file).
4. You write it up in the same shape as the deals table: who, their category
   (promoter, director, KMP), buy or sell, quantity, value, the date of the
   trade and the date of the disclosure, with the same "public, after the
   fact" caveat.

## What it never does

- Never says or implies a deal shows inside information, or that copying a
  big investor beats the market. No return claims.
- Never guesses who is behind a client name.
- Never places an order.

## Safety

- Education and tooling, not financial advice. Nothing in this pack is a
  recommendation to buy or sell anything.
- Paper trading by default (`"paper": true` in `trader/config.json`).
- Nothing places an order except `/trader-broker`, and only after
  `/trader-risk` passes AND the user types an explicit yes for that order in
  the chat, AND the brokerage tool is set to "Needs approval" in Claude
  (Customize > Connectors > tool permissions) so Claude's own "Allow once /
  Deny" card appears too. Never "Always allow" an order tool.
- No options, margin, shorting or leverage unless the config allows it and
  the user confirms.
- Bulk and block deals are PUBLIC post-trade disclosures. This skill reads
  them fast; it has no inside information, and it says so.
