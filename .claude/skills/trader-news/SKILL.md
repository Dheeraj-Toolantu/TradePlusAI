---
name: trader-news
description: >-
  News Monitor for NSE stocks. Tracks breaking news on every stock you watch
  and flags what moves it: Google News headlines per company (India edition,
  searched by company name and symbol, optionally Yahoo Finance's .NS feed),
  NSE exchange filings from NSE's corporate announcements, financial results
  and board meetings feeds (results, dividend, bonus, split, buyback, rights
  issue, SEBI order, pledge, promoter, credit rating, insider / PIT), and how
  far each stock is from yesterday's close in rupees. Shows only what is new
  since the last check, newest first, in IST, tags each item and never
  repeats one. --market US keeps the original Yahoo + SEC 8-K behaviour. Use
  when the user says "any news on RELIANCE", "why is TCS moving", "what's
  the news on my watchlist", "morning briefing", "pre-market news", "monitor
  the news", "did anything break", "check the NSE announcements", "any
  results today", or after /trader-scanner finds setups.
argument-hint: "[symbols] [--market IN|US]"
---

# trader-news

A chart can look perfect and still be about to gap on results, a board
meeting, a SEBI order or a promoter pledge. Before a setup becomes a trade,
this skill reads the feeds that carry those first, for every stock on the
watchlist, and tells you only what is new. It also prints how far each stock
has moved today, so a headline and a move sit side by side.

India (NSE, IST, rupees) is the default. Symbols are plain NSE symbols
(`RELIANCE`, `TCS`, `INFY`, `HDFCBANK`, `M&M`); `RELIANCE.NS` is accepted.
`--market US` (or `"market": "US"` in `trader/config.json`) gives the
original Yahoo headlines + SEC EDGAR 8-K monitor in New York time.

Tool in this folder (standard library Python, no keys):

```bash
python3 "${CLAUDE_SKILL_DIR}/news.py"                               # watchlist + plan + portfolio
python3 "${CLAUDE_SKILL_DIR}/news.py" --tickers RELIANCE TCS --hours 12
python3 "${CLAUDE_SKILL_DIR}/news.py" --tickers HDFCBANK --yahoo     # add Yahoo's HDFCBANK.NS feed
python3 "${CLAUDE_SKILL_DIR}/news.py" --no-filings --json            # headlines only
python3 "${CLAUDE_SKILL_DIR}/news.py" --market US --tickers TSLA     # Yahoo + SEC 8-Ks, ET
```

## What it reads and writes

| file / feed | what |
| --- | --- |
| `--tickers`, else `trader/watchlist.json` | the scanner's hits (trader-scanner) |
| `trader/plan.json` | the trade you are planning (trader-exit) |
| `trader/portfolio.json` | what you hold (trader-broker records fills there) |
| Google News RSS | `https://news.google.com/rss/search?q="Reliance Industries" OR RELIANCE.NS&hl=en-IN&gl=IN&ceid=IN:en` (URL-encoded), one search per ticker |
| Yahoo Finance headline RSS (`--yahoo`) | `https://feeds.finance.yahoo.com/rss/2.0/headline?s=RELIANCE.NS&region=IN&lang=en-IN` |
| NSE corporate announcements | `https://nsearchives.nseindia.com/content/RSS/Online_announcements.xml` |
| NSE financial results | `https://nsearchives.nseindia.com/content/RSS/Financial_Results.xml` |
| NSE board meetings | `https://nsearchives.nseindia.com/content/RSS/Board_Meetings.xml` |
| Yahoo chart for `<SYM>.NS` | the last price against yesterday's close (unofficial, can lag) |
| `trader/cache/EQUITY_L.csv` | NSE's equity list (symbol to company name), fetched from `https://archives.nseindia.com/content/equities/EQUITY_L.csv` when missing or over 7 days old |
| `trader/names.json` or `--names FILE` | your own `{"RELIANCE": "Reliance Industries Limited"}` names, which win |
| `trader/state/news.json` | what has been shown (kept 30 days) |

The three NSE feeds are read once per check, not once per ticker. Their items
are RSS 2.0 whose titles start with the company name, so each one is matched
to your watchlist by name (the full name with Limited / Ltd, the name without
it followed by a separator, or the symbol itself; `&` and "and" are the same,
and "Zentra Power Transmission Limited" never matches "Zentra Power"). A
ticker with no known name gets a note: add it to `trader/names.json`. NSE's
archive hosts refuse non-browser clients, so those requests send a
browser-like User-Agent. No SEC User-Agent is needed in India, and none is
asked for.

## The rules

- **Headlines are leads, not facts.** Before telling the user something
  happened, open the story or the filing and read it. Quote the source and
  link it. Never summarise a paywalled story you could not read: say so.
  Google News links go through news.google.com; the line shows the publisher
  (`via Mint`).
- **Filings beat headlines.** If an NSE filing and a headline disagree, the
  filing is what the company told the exchange.
- **Say what it touches.** Every item lists the tickers it touches and its
  tags. India tags: results, board meeting, dividend, bonus, split, buyback,
  rights issue, sebi order, block/bulk deal, pledge, promoter, credit rating,
  insider/pit, plus the generic earnings, analyst, legal (NCLT, insolvency,
  CCI...), deal, capital, people, risk, halt, regulatory (SEBI, RBI, USFDA...)
  and macro (RBI policy, repo rate, CPI, FII / DII flows, GST, Sensex,
  Nifty...). NSE filings marked `!` carry results, a SEBI order, a pledge, a
  credit rating action, a buyback, bonus, split or rights issue, or a risk or
  halt word.
- **MOVING** marks a stock 3 % or more from yesterday's close (`--move-pct`).
  A move with no headline is worth saying out loud too.
- **No predictions.** Report what was published and how far the price is from
  yesterday's close. Never say what the stock will do next.

## Steps

1. Run the check: `python3 "${CLAUDE_SKILL_DIR}/news.py"`. Exit code 1 means
   nothing new. `--all` shows items already seen, `--json` gives everything
   machine readable (with IST `local_time` per item and the company names
   used), `--dry-run` leaves the state alone.
2. Read the items that matter: every `!` filing, anything tagged results,
   board meeting, sebi order, pledge, halt, legal or risk, and every MOVING
   ticker first.
3. Write a short brief, per ticker: what happened, the source and link, the
   move in rupees, and one line on why it matters to the setup (for example
   "results are after the close today: the stock can gap tomorrow past any
   stop").
4. If a story changes the picture, say so before `/trader-entry` and
   `/trader-exit`: results or a board meeting inside the trade, a SEBI order,
   a pledge, a fund raise. Never act on a headline alone.

During the session: `/loop 15m /trader-news`, or a scheduled task each
morning before the 9:15 IST open (NSE posts many filings after 15:30 and
in the evening, so an evening run catches results).

## Example

Friday 2026-10-30 at 10:50 IST, watching RELIANCE, TCS and M&M (synthetic
data from the test fixtures):

```
RELIANCE ₹3,011.20 +3.30% vs yesterday's close ₹2,915.00 at 10:50 IST  MOVING
TCS    ₹3,150.00 -0.94% vs yesterday's close ₹3,180.00 at 10:50 IST

! 2026-10-30 09:30 IST  M&M         NSE           Mahindra and Mahindra Ltd., board meeting: To consider a bonus issue and a stock split
      tags: board meeting, bonus, split, capital  https://nsearchives.nseindia.com/corporate/...
! 2026-10-29 19:05 IST  RELIANCE    NSE           Reliance Industries Limited, announcement: Outcome of Board Meeting - ...
      tags: results, board meeting, dividend, earnings, capital  https://nsearchives.nseindia.com/corporate/...
! 2026-10-29 16:45 IST  TCS         NSE           Tata Consultancy Services Limited, financial results: Financial Results for the quarter ended 30-Sep-2026
```

The brief: "RELIANCE is up 3.3 % on its Q2 results and an interim dividend
filed last evening; the move is the news, not a fresh breakout. M&M has a
board meeting on a bonus and a split. Nothing new on TCS beyond yesterday's
results." When a ticker has no news, say so rather than padding the brief.

## What it never does

- Never invents or embellishes a story, a filing, a quote or a number.
- Never trades on news, and never tells the user to buy or sell because of a
  headline.
- Never hammers a server: one Google News request per ticker, the three NSE
  feeds once per check, a pause between calls, and the NSE equity list at
  most once a week.

## Safety

Education and tooling, not financial advice. This skill only reads and
reports. Nothing places an order except `/trader-broker`, after
`/trader-risk` passes and the user types an explicit yes for that order.
