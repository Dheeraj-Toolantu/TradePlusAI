# Day Trader skill pack in TradePlusAI (Indian markets)

This repository vendors the Claude Code day-trading skills from
[Jakeschincariol/day-trader-skill](https://github.com/Jakeschincariol/day-trader-skill)
(MIT, based on upstream commit `3d0f4ef6986f4984b7c6bd46f7ff4f87744c3abd`, 2026-10-20) and adapts
them to **Indian markets**: NSE cash equity, IST, rupees and Groww. They are **project-local
skills**: open TradePlusAI in Claude Code and `/trader-scanner`, `/trader-news` and the rest are
available, with no plugin install. The upstream README is kept as published in
[UPSTREAM-README.md](UPSTREAM-README.md).

The original US behaviour (NYSE, New York time, dollars, Alpaca, SEC, Congress) is still there:
add `--market US`, put `"market": "US"` in `trader/config.json`, or set `TRADER_MARKET=US`.

## How it works

Each skill has two parts:

- **`SKILL.md`** tells Claude when to use the skill, the method and the safety rules.
- **One standard-library Python tool** fetches the data and does the arithmetic. It needs
  Python 3.8+ and nothing from pip.

Every tool loads one shared market profile, `.claude/skills/trader-market/market.py`. It covers the
clock, holidays, tick size, money formatting, charges and symbols. The skills share a `trader/`
folder in the project root, and each one reads what the previous one wrote:

```
scanner -> news -> entry -> exit -> timemachine -> budget -> risk -> broker   (one trade)
alerts: stop, target, flat by 15:10 IST                                       (while it is open)
news / analyst / deals                                                         (on a schedule)
market: is NSE open, holidays, tick size, charges                              (any time)
```

| command | India (default) | US (`--market US`) |
| --- | --- | --- |
| `/trader-market` | NSE clock (9:15 to 15:30 IST), 2026 NSE holidays, tick sizes, intraday charges calculator | NYSE clock and holidays |
| `/trader-scanner` | NSE `EQ` universe from `EQUITY_L.csv`, Nifty 50/100/200/500 lists (default Nifty 500), daily setups and 9:15 opening-range breakouts on Yahoo `.NS` bars, rupee price and traded-value floors | Nasdaq Trader universe |
| `/trader-news` | Google News (en-IN) headlines, NSE corporate announcements, results and board-meeting RSS, India tags (results, dividend, bonus, buyback, SEBI order, pledge, promoter...) | Yahoo headlines, SEC 8-Ks |
| `/trader-entry` | opening range 9:15 to 9:30 IST, entries 09:30 to 14:45, prices on the NSE tick | 9:30 ET range |
| `/trader-exit` | stop rounded down and target rounded up to the tick, at least 5 ticks of risk, charges and net reward:risk shown, flat by 15:10 | cents, flat by 15:55 |
| `/trader-timemachine` | 10,000 replays over 75 five-minute NSE bars a session, the history replay over the last ~59 NSE sessions, average R gross **and net of charges** | unchanged |
| `/trader-budget` | whole shares, max loss **including charges**, no MIS leverage, Groww order legs | Alpaca bracket |
| `/trader-risk` | ₹ limits, net reward:risk, IST entry window, NSE holidays, MIS product and no-leverage checks, blocks F&O and non-NSE symbols. There is no PDT rule in India | + PDT guard |
| `/trader-broker` | Groww ticket in plain words plus the exact Groww `place_order` JSON; paper fills simulated locally | Alpaca MCP |
| `/trader-alerts` | Yahoo `.NS` quotes with a `.BO` (BSE) fallback, the 9:15 bell, flat by 15:10, Muhurat noted | + Stooq |
| `/trader-analyst` | quarterly revenue, margins, net profit and EPS from Yahoo's fundamentals timeseries, in ₹ crore with Indian fiscal quarters (Q2 FY27), plus the latest NSE result filing | SEC XBRL |
| `/trader-deals` | **new**: NSE bulk and block deals, alerting once per new deal, with your holdings flagged | (n/a) |
| `/trader-pelosi` | (US only) | House Clerk PTRs |

### What India changes, in numbers

- **Session**: 9:15 to 15:30 IST (pre-open 9:00 to 9:08). IST is UTC+05:30 with no daylight time.
- **Holidays**: the 16 weekday NSE holidays of 2026. NSE publishes the 2027 list in December. Until it
  is added to `market.py`, 2027 dates are checked for weekends only and the tools say so.
- **Tick size** (from 15 Apr 2025): below ₹250: 0.01, ₹250 to 1,000: 0.05, ₹1,000 to 5,000: 0.10,
  ₹5,000 to 10,000: 0.50, ₹10,000 to 20,000: 1.00, above ₹20,000: 5.00.
- **Charges per intraday round trip**:
  - brokerage at Groww's rate, 0.1% capped at ₹20 with a ₹5 minimum, per order
  - STT 0.025% of the sell value
  - NSE transaction charge 0.00297%, SEBI fee 0.0001% and IPFT 0.0001%, each on both legs
  - stamp duty 0.003% of the buy value
  - GST 18% on brokerage, the transaction charge and the SEBI fee

  Override any rate under `"charges"` in `trader/config.json`.
- **Day-trade window**: entries 09:30 to 14:45 and flat by 15:10, ahead of the broker's MIS auto
  square-off (about 15:10 to 15:20, charged per position).
- **Orders**: Groww has no equity bracket order, so a plan becomes legs:
  1. a LIMIT BUY (MIS);
  2. once it fills, a protective SL-M SELL at the stop;
  3. the target is **not** a second resting sell, since two live sells could both fill. trader-alerts
     rings at the target; you then cancel or modify the SL-M and sell.

An example run on the offline synthetic RELIANCE fixtures, with the default India config (₹1,00,000
budget, ₹500 max loss a trade):

1. **Entry**: the opening range is ₹1,398.00 to ₹1,412.00. It triggered at 9:50 AM IST, at ₹1,415.30.
2. **Exit**: the stop is ₹1,405.00 (the range midpoint) and the target ₹1,435.90 (2R). Reward:risk is
   1.69 after charges on 70 shares (₹1,00,000 of stock).
3. **Time Machine**: target first 34.6%, stop first 60.8%. Average R is +0.105 gross and -0.009 net
   of charges. The verdict is close to break-even.
4. **Budget**: 41 shares. ₹422.30 at the stop plus ₹67.65 charges is ₹489.95, which fits the ₹500
   limit (42 shares would not).
5. **Risk**: PASS, with net reward:risk 1.59 against a minimum of 1.5.
6. **Broker**: a PAPER ticket with the two Groww `place_order` legs. Nothing is placed without your yes.

## Safety

Nothing in the pack places an order by itself.

- **India**: there is no Groww order connector, so Claude **never places a live order**.
  - With `"paper": true` (the default), `ticket.py simulate` records a simulated fill after your
    recorded yes.
  - A live order is placed **by you**: in the Groww app, through the Groww Trade API, or through
    TradePulse's own execution service (`services/execution`), with its PIN, kill switch and `LIVE_*`
    limits.
- **US**: an order needs a risk PASS, your explicit yes and Claude's "Allow once" card on the Alpaca
  connector.
- **TradePulse gates are untouched.** The pack never reads or changes `LIVE_EXECUTION_ENABLED`,
  `EXECUTION_MODE`, the `ALGO_*` switches or the Groww adapter. Its limits in `trader/config.json` are
  separate from the `LIVE_MAX_*` limits in `.env`.

## What is in this repo

| path | what it holds |
| --- | --- |
| `.claude/skills/trader-*/` | the 13 skills: 11 upstream (adapted) plus `trader-market` and `trader-deals` |
| `.claude/skills/trader-market/market.py` | the shared market profile (IN and US) |
| `.claude/skills/trader-budget/config.example.json` | the India config: `₹` limits as `*_inr` keys, Groww, MIS, paper |
| `.claude/skills/trader-budget/config.us.example.json` | the original US config, with `"market": "US"` |
| `.claude/skills/trader-alerts/alerts.india.example.json` | India alert examples (`alerts.example.json` stays US) |
| `.claude/skills/LICENSE.day-trader-skill` | the upstream MIT license |
| `tests/day-trader-skill/` | the upstream suites (they run with `TRADER_MARKET=US`), plus `test_*_india.py`, `test_market.py`, `test_deals.py` and `test_skills_layout.py` |
| `tests/day-trader-skill/fixtures/*-in/`, `fixtures/trader-deals/` | **synthetic** India fixtures (each folder has a README.txt) |
| `.github/workflows/trader-skills.yml` | runs the suite when the skills or their tests change |

## Using it

1. Open this repository in Claude Code. Type `/trader-` to list the skills.
2. Run `/trader-budget` once. Claude copies `config.example.json` to `trader/config.json` and asks you
   for each limit (budget, max loss a trade, daily loss, entry window). Keep `"paper": true`. `trader/`
   is git-ignored.
3. Start the day with `/trader-market` ("is NSE open?"), then `/trader-scanner` and `/trader-news`.

Direct use from the repo root:

```bash
python3 .claude/skills/trader-market/market.py status
python3 .claude/skills/trader-market/market.py charges --qty 40 --buy 1250 --sell 1262.5
python3 .claude/skills/trader-scanner/scan.py universe --index nifty500
python3 .claude/skills/trader-scanner/scan.py orb --at 09:35
python3 .claude/skills/trader-entry/entry.py check RELIANCE --setup orb
python3 .claude/skills/trader-exit/exit.py plan --target 2R --write
python3 .claude/skills/trader-timemachine/timemachine.py run --write
python3 .claude/skills/trader-budget/size.py --write
python3 .claude/skills/trader-risk/check.py
python3 .claude/skills/trader-broker/ticket.py show
python3 .claude/skills/trader-deals/deals.py new
python3 .claude/skills/trader-analyst/facts.py TCS INFY
```

Run the offline tests:

```bash
npm run test:trader-skills
```

## Data sources and what is not verified

All the data is free and unofficial, and some of it is delayed. Check anything that matters against
your broker. The cloud sandbox this was built in could not reach Yahoo or NSE (blocked by the proxy),
so the India parsers were written against the published formats and are tested on **synthetic**
fixtures in those shapes. Check them on a first live run:

- Yahoo chart/spark for `.NS` (`gmtoffset` 19800, `exchangeName` NSI), the Yahoo fundamentals
  timeseries endpoint, and URL-quoted symbols such as `M%26M.NS`.
- NSE archives: `EQUITY_L.csv`, `ind_nifty500list.csv`, `bulk.csv` and `block.csv`. Also whether NSE
  serves them to a browser-like User-Agent without cookies.
- NSE RSS feeds (`Online_announcements.xml`, `Financial_Results.xml`, `Board_Meetings.xml`): the
  title and pubDate formats.
- Google News RSS (en-IN).
- Groww details: SL-M support for MIS equity, the auto square-off time and charge, and current
  brokerage.

If a live format differs, the fix is local to that tool's parser. Add a fixture cut from the real
response and a test.

## Updating from upstream

The tools are no longer verbatim copies, so updating is a merge, not a copy:

```bash
git clone https://github.com/Jakeschincariol/day-trader-skill /tmp/dts
git -C /tmp/dts diff 3d0f4ef6986f4984b7c6bd46f7ff4f87744c3abd HEAD -- trader-scanner trader-entry  # etc.
```

Apply the upstream changes by hand, then run `npm run test:trader-skills`. The upstream suites must
keep passing with `TRADER_MARKET=US`, and the India suites must keep passing too.

## Fine print

This is not financial advice. The tools read free, unofficial public data and do arithmetic. Most
people who day trade lose money. The Time Machine is a simulation, not a prediction. A stop is a plan,
not a guarantee: a gap or a circuit can fill past it. The charge figures are estimates; your contract
note is the real number. Bulk and block deals are public post-trade disclosures, not a signal to copy.
