---
name: trader-analyst
description: >-
  The Earnings Analyst. For NSE stocks (the default) it reads a company's
  quarterly results from Yahoo's fundamentals timeseries and points to the
  latest result filing in NSE's Financial Results feed; with --market US it
  reads SEC EDGAR (XBRL company facts, the 10-Q and 10-K, the earnings 8-K and
  its press release). It sums up what changed: revenue, gross, operating and
  net margins, net profit and diluted EPS, quarter by quarter with Indian
  fiscal labels (Q2 FY27) and amounts in rupees crore, each against the same
  quarter a year earlier, with the trailing twelve months. Reads an earnings
  call transcript when you paste one. Use when the user says "how did
  Reliance's results look", "TCS Q2 results", "analyze the earnings", "what
  changed this quarter", "is revenue growing", "check the 10-Q", "compare
  margins", "sum up the call", "does it report this week", or before trading
  a stock around its results.
argument-hint: "[NSE symbols]"
---

# trader-analyst

Results move stocks more than anything else on the calendar, and the press
release is written to put the best number first. This skill lines up the
reported numbers quarter by quarter and says plainly what changed. For a day
trader it answers two questions before a trade: what did the last result say,
and is the next one inside this trade?

Tool in this folder (standard library Python, no keys):

```bash
python3 "${CLAUDE_SKILL_DIR}/facts.py" --help
```

The market comes from `--market`, then `"market"` in `trader/config.json`,
then `TRADER_MARKET`, then India. `--market US` is the original SEC EDGAR
tool, unchanged.

## India (NSE, the default)

SEC EDGAR has no Indian companies, so in India the tool reads:

- `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/<SYM>.NS`
  (the endpoint yfinance uses, no login or crumb): quarterly total revenue,
  gross profit, operating income, net income, diluted and basic EPS, and the
  annual revenue, net income and EPS.
- `https://nsearchives.nseindia.com/content/RSS/Financial_Results.xml`, NSE's
  feed of result filings from the last few days, matched by company name, for
  a link to the latest result (XBRL or PDF).

How to read the output:

- Amounts are in rupees crore (1 crore = 1,00,00,000), written with Indian
  grouping: `2,70,000` crore is Rs 2.7 lakh crore. EPS is in rupees.
- Quarters carry Indian fiscal labels. The fiscal year runs April to March:
  Q1 FY27 is April to June 2026, Q2 FY27 July to September 2026, Q4 FY27
  January to March 2027.
- Growth is against the same quarter a year earlier (Q2 FY27 vs Q2 FY26).
- When the March quarter is missing but the fiscal-year total is there, the
  quarter is the year minus the three quarters inside it, marked "derived".
- Free Yahoo data often holds only the last 5 or so quarters, so year-on-year
  growth may exist only for the newest one or two. Some fields are missing for
  some companies: banks and NBFCs report no gross profit (and often no
  operating income), so those margins are blank, not zero. When diluted EPS is
  missing the tool uses basic EPS and says so.
- Symbols are plain NSE symbols (`RELIANCE`, `TCS`, `M&M`), with or without
  `.NS`.
- Feed matching is by name. A symbol can match two companies (RELIANCE also
  matches Reliance Infrastructure): the tool says "also matched" and you pass
  `--name "Reliance Industries"`. If the feed cannot be read (NSE often blocks
  scripts) or the result is older than the feed, the tool prints where to find
  it: nseindia.com > Companies > Corporate Filings > Financial Results.

```bash
python3 "${CLAUDE_SKILL_DIR}/facts.py" RELIANCE --name "Reliance Industries"
python3 "${CLAUDE_SKILL_DIR}/facts.py" TCS INFY HDFCBANK --metrics trader/metrics.json
python3 "${CLAUDE_SKILL_DIR}/facts.py" HDFCBANK --rss-file ~/Downloads/Financial_Results.xml
```

`--quarters 8` shows more rows when Yahoo has them, `--json` everything
machine-readable, `--no-filings` skips the NSE feed, `--offline DIR` reads
`timeseries-<SYM>.NS.json` and `Financial_Results.xml` from a folder.

## United States (`--market US`)

Needs the SEC User-Agent (`sec_user_agent` in `trader/config.json`, or
`SEC_USER_AGENT`): "Your Name you@example.com" with the user's real name and
email. It refuses to call SEC without one. It reads
`https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json`, the
company's submissions list (the newest 10-Q or 10-K and the newest 8-K with
item 2.02) and that 8-K's folder for the EX-99.1 press release. Companies do
not file a Q4 10-Q, so Q4 is the 10-K year minus three quarters, "derived".
When SEC's facts trail a filed 10-Q, the tool prints a NOTE with the link.

```bash
python3 "${CLAUDE_SKILL_DIR}/facts.py" --market US TSLA NVDA --metrics trader/metrics.json
```

## What it writes

- `trader/metrics.json` with `--metrics`: one row per company (TTM revenue,
  net income and diluted EPS, the latest margins and growth). India rows add
  `"market": "IN"`, `"currency": "INR"` and `revenue_ttm_cr` /
  `net_income_ttm_cr`; amounts stay in rupees. `metrics.example.json` in this
  folder is a documentation sample from a real US run (AAPL, AXP, GOOGL, KO,
  BAC on 2026-10-13); no tool reads it.
- Earnings calls: the tool does not fetch transcripts. If the user pastes one
  (or the company's investor page has it), read it and sum up what management
  said changed: guidance, margins, demand, anything they declined to answer.
- The next result date: in India, the board meeting intimation on NSE
  (Companies > Corporate Filings > Board Meetings) or `/trader-news`
  headlines. Say where it came from.

## The rules

- **Reported numbers first.** Use the result filing or press release for
  context (guidance, segment colour), and say which numbers came from where.
  Yahoo is a free aggregator: when a number matters, check it against the
  NSE filing.
- **Compare like with like.** Growth is against the same quarter a year
  earlier. Quarter-on-quarter changes are shown but many businesses are
  seasonal (retail and autos around festivals, IT in Q1).
- **Say what is derived** and that derived EPS is approximate.
- **Say what is missing.** Blank is "not reported here", never zero.
- **Flag one-offs.** When net profit is above operating profit, other income
  or exceptional items are inside it. The tool says so.

## Steps

1. Run it for the companies in question (or the symbols on
   `trader/watchlist.json`).
2. Open the latest result filing (the NSE link, or the 10-Q / EX-99 link in
   US mode) when the numbers need context, and read it.
3. Write the summary: one line on the quarter (revenue, EPS, growth), one on
   margins, one on anything unusual (a one-off, a derived quarter, missing
   fields), and the links. Plain words, real numbers, rupees in crore.
4. If the next result falls inside the planned trade (an overnight hold, or a
   result announced before the open), say it before `/trader-exit` sets the
   stop: a stop does not protect against a gap.

## Example

`facts.py RELIANCE --name "Reliance Industries"` (synthetic test data):
quarter ending 2026-09-30 (Q2 FY27), revenue Rs 2,70,000.0 Cr, +5.9% against
Q2 FY26, net profit Rs 20,000.0 Cr (+10.1%), diluted EPS Rs 14.78 (+10.1%);
gross margin 30.5%, operating margin 13.1%; last four quarters Rs 10,59,000.0
Cr revenue and Rs 60.49 EPS; Q4 FY26 derived from the fiscal-year total.
HDFCBANK: no gross or operating margin (a bank), net margin 41.4%, basic EPS.

## What it never does

- Never says a stock is cheap, expensive, a buy or a sell.
- Never invents a number the data does not have, or estimates a quarter it
  cannot derive.
- Never calls SEC without the User-Agent.

## Safety

Education and tooling, not financial advice. This skill only reads results.
Nothing places an order except `/trader-broker`, after `/trader-risk` passes
and the user types an explicit yes for that order.
