# Validation: upstream day-trader logic vs the TradePlusAI India adaptation

Date: 2026-10-31. Upstream: [Jakeschincariol/day-trader-skill](https://github.com/Jakeschincariol/day-trader-skill)
at `3d0f4ef`. Suite: `npm run test:trader-skills` (552 tests, all passing).

## 1. US mode is the upstream, unchanged

The upstream README pipeline (TSLA, 19 Oct 2026, real data) was run with the original repo and with
TradePlusAI (`--market US`) in separate folders:

```
entry check -> exit plan -> timemachine run -> size -> risk check -> ticket show -> alerts add
```

Every file written to `trader/` and every printed line was **byte-identical**, apart from the
`checked_at` wall-clock stamp. The results reproduce the upstream README:
- the trade triggered at 10:15 at $364.18, with a stop of $358.32 and a target of $370.04;
- the replays gave target first 29.4 %, stop first 25.5 %;
- in the history the setup fired 33 times;
- sizing gave 8 shares, and the risk check passed.

The upstream unittest suites run unmodified against the TradePlusAI tools, except for one config
path repoint. They pass.

## 2. India mode runs the same logic

`tests/day-trader-skill/test_upstream_parity.py` takes the same real TSLA candles and moves them onto
the NSE clock: US bar k (9:30 ET + 5k) becomes NSE bar k (9:15 IST + 5k), and 75 bars are kept. The 60
sessions are mapped onto 60 NSE trading days. It then runs the India pipeline:

| step | upstream (US) | India (NSE) | why they differ |
| --- | --- | --- | --- |
| opening range | 354.47 to 362.18 | ₹354.45 to ₹362.20 | NSE prices sit on the 0.05 tick |
| trigger | bar 8, 10:15 AM ET | bar 8, 10:00 AM IST | same bar, IST clock |
| stop / target (1R) | 358.32 / 370.04 | ₹358.30 / ₹370.10 | stop rounded down, target rounded up, to the tick |
| replays (seed 19), same plan, flat at 15:10 IST = 15:25 on the US bar clock | 26.2 / 22.2 / 51.6 % | 26.2 / 22.2 / 51.6 % | **identical** |
| history | 33 fired, 13 target, 15 stop, 5 neither | 33 fired, 12 / 16 / 5 | one trade flips: see below |
| sizing, upstream limits, charges off | 8 shares, bound by max loss | 8 shares, bound by max loss | identical |

The one history flip is 6 Aug, which this table calls the tick difference. The bar high was 323.00:
- **Upstream:** the target of 322.98 filled.
- **NSE:** the target rounds up to ₹323.05, one tick out of reach, so the trade ran to the stop.

That is the correct NSE behaviour, because 322.98 is not a valid price on a 0.05 tick.

## 3. India-only rules, checked against independent calculations

- **Charges:** 20,000 random round trips match an independent Groww and NSE formula within ₹0.005.
  - The formula is brokerage of 0.1% capped at ₹20 with a ₹5 minimum, STT 0.025% on the sell, NSE
    0.00297%, SEBI 0.0001%, IPFT 0.0001%, stamp 0.003% on the buy, and GST 18%.
- **Sizing:** on 3,000 random plans, the quantity never breaks the ₹500 max loss including charges,
  and one more share would always break it.
- **Risk gates** on the default India config:

  | case | verdict |
  | --- | --- |
  | 09:14 (closed), 09:29 (before the window) | BLOCK |
  | 09:30 and 14:45 | PASS |
  | 14:46 and 15:31 | BLOCK |
  | Diwali Balipratipada (10 Nov), the Muhurat Sunday, a Saturday | BLOCK |
  | F&O symbol, CNC on a day trade, an order over cash (no MIS leverage) | BLOCK |
  | net reward:risk under 1.5 once charges are counted (1.60 gross, 0.89 net) | BLOCK |
  | no stop, a Groww leg that doesn't match its order | BLOCK |
  | 4th trade of the day, daily loss over ₹1,500, the same symbol twice | BLOCK |
  | an exit sell with every limit used up, including the next morning | PASS |
- **Paper trades:** simulated paper fills count toward the trades-per-day and daily-loss limits.
- **Groww tickets:** the fields match TradePulse's `adapters/groww`, including the `order_reference_id` rule
  (8 to 20 characters, at most two hyphens).

## 4. Defects found and fixed during validation

| area | defect | fix |
| --- | --- | --- |
| exit / timemachine | a stop next to a price-band edge could land off the stock's tick (999.25 on a 0.10 stock) | stop and target use the coarser tick of the entry's and the price's band |
| timemachine | history took entries after 14:45 | India history enters only 09:30 to 14:45 (upstream has the same gap; US kept as is) |
| exit / scan / timemachine | no warning on an NSE holiday, or for 2027 dates | holiday and calendar-unknown notes |
| deals | the NSE website CSV header (`"Buy / Sell "`) was rejected; a second `--file` replaced the first | both fixed, plus a reader for the website JSON |
| analyst | the filing lookup matched subsidiaries (M&M Financial, ITC Hotels) and Reliance Infrastructure | exact name match from `--name`, `names.json` or the `EQUITY_L.csv` cache; feed sorted by date |
| news | false tags ("As a result" tagged results, "Pat Cummins", "bonus data pack", "hackathon"); zone-less NSE times read as UTC | tags tightened; zone-less, AM/PM and dd/mm times read as IST |
| alerts | Alpaca and bracket wording in India; flat-by could ring after the close | Groww and SL-M wording; a missed flat-by is reported as missed |

## 5. Not verifiable here (no network in the build sandbox)

The parsers for these sources are tested on synthetic fixtures in their published shapes. A first live
run should confirm them:
- Yahoo `.NS` charts and the fundamentals timeseries;
- NSE `EQUITY_L.csv`, the Nifty index lists, `bulk.csv` / `block.csv` and the RSS feeds;
- Google News RSS;
- the Groww specifics: SL-M for MIS equity, the square-off time and fee, and current brokerage.

Open follow-up: Groww OCO smart orders (TradePulse's adapter uses them for F&O) could replace the
"alert at the target, then cancel the SL-M" step for cash MIS, if Groww supports OCO in that segment.
