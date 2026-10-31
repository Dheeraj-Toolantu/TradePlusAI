---
name: trader-timemachine
description: >-
  Time Machine for NSE day trades. Replays every possible outcome of a trade
  before you risk a rupee: 10,000 simulated sessions plus every past time the
  setup fired. Takes the plan from trader-exit (entry, stop, target, flat by),
  rebuilds the rest of the day 10,000 times from the stock's own 5-minute bars
  (75 a session, 9:15 to 15:30 IST) over the last 60 days, NSE holidays left
  out, and re-runs the same rule on every past session. Prints the odds of
  target first, stop first, or neither by the flat-by time (15:10 IST by
  default), where the price sits then, the average R before and after the
  estimated charges (brokerage, STT, stamp duty, GST), the history, and one
  honest verdict, then hands off to /trader-budget. --market US gives the
  original NYSE behaviour. Use when the user says "run the time machine",
  "replay this trade", "what are the odds", "simulate this trade", "monte
  carlo", "backtest this setup", "how often does this hit the target", "is
  this a coin flip", "is it worth it after charges", or after /trader-exit
  writes a plan, before /trader-budget.
argument-hint: "[path to plan.json, or SYMBOL] [--market IN|US]"
---

# trader-timemachine

The Time Machine sits between the plan and the money. trader-exit has set
the entry, the stop and the target. Before anything is sized or sent, this
skill asks one question: if today plays out like the stock's own last 60
days, how often does this plan hit the target first, the stop first, or
neither? It answers with 10,000 replays and with the real record of the same
rule on every past session. It is a simulation built from the stock's own
recent bars, not a prediction. Day trading loses most people money, and a
good-looking replay does not change that.

India (NSE, IST, rupees) is the default market, from the shared
`trader-market` profile. Add `--market US` (or `"market": "US"` in
`trader/config.json`) for the original NYSE run: 78 bars, 9:30 to 4:00 PM New
York time, replays to the close, no charges.

`${CLAUDE_SKILL_DIR}` below is this skill's folder (where this SKILL.md lives).

```bash
python3 "${CLAUDE_SKILL_DIR}/timemachine.py" run                    # trader/plan.json, 10,000 replays, seed 19
python3 "${CLAUDE_SKILL_DIR}/timemachine.py" run --write            # also save trader/timemachine.json
python3 "${CLAUDE_SKILL_DIR}/timemachine.py" run --until 15:30      # replay to the close instead of flat-by
python3 "${CLAUDE_SKILL_DIR}/timemachine.py" run --json
python3 "${CLAUDE_SKILL_DIR}/timemachine.py" run --symbol RELIANCE --date 2026-10-30 \
    --entry 1415.30 --stop 1405 --target 1435.90 --entry-time "9:50 AM"
python3 "${CLAUDE_SKILL_DIR}/timemachine.py" chart --from           # ASCII fan chart of the saved run
python3 "${CLAUDE_SKILL_DIR}/timemachine.py" --market US run --plan us-plan.json
```

Other flags: `--replays N`, `--seed N` (default 19), `--window N` (default 2
bars), `--offline FILE` (a saved Yahoo chart JSON, `.json` or `.json.gz`),
`--now "2026-10-30 15:40"` (IST; a trailing ` IST` is fine) to pin the clock,
`--config` (for `"market"` and `"charges"` rate overrides).

## What it reads and writes

| file | what |
| --- | --- |
| `trader/plan.json` | the plan from trader-exit: symbol (plain NSE symbol), date, entry, entry_time / entry_bar, stop, stop_rule, target, target_r, opening range, flat_by, and `qty` or `charges_ref.qty` for the charges |
| Yahoo chart API | one request: 60 days of 5-minute bars for `RELIANCE.NS` (`range=60d&interval=5m`), free and unofficial, can lag |
| `trader/timemachine.json` | with `--write`: `{plan, mc, history}` plus the verdict, `market`, `currency` and `charges`. `mc` holds the odds, percentiles, the fan-chart bands, 160 sample paths, a 24-bin histogram of the price at the end, `avg_R` and `avg_R_net` |

## How it works

1. **The pool.** It keeps only FULL sessions before the plan's date: all 75
   five-minute bars, 9:15 to 15:30 IST, bucketed by IST time of day. Gaps,
   today, and any day that is not a regular NSE trading day (a holiday, or a
   Muhurat evening session) are left out. Every bar becomes four ratios to
   the bar before it: open, high, low and close over the previous close.
2. **One replay.** Start at the entry price. For each bar left in the day,
   pick a past bar from the same time of day (plus or minus 2 bars) at
   random, and scale it to the current price. Bar by bar, it checks the stop
   first, then the target. A bar that touches both counts as the stop.
3. **10,000 replays** give four odds. Target first. Stop first. Neither,
   which means the trade was still open at `--until`: by default the plan's
   flat_by, 15:10 IST, ahead of the broker's intraday auto square-off (in US
   mode the close, 4:00 PM, or 1:00 PM on an NYSE early-close day). Green,
   which means target first or above the entry at `--until`.
   R is the target's R at the target, -1 at the stop, and otherwise the
   distance from the entry at `--until` divided by the risk. A gap through
   the stop still counts as -1R here. A real fill can be worse.
4. **Charges.** Each replay's round trip pays the estimated intraday charges
   for a reference quantity: the plan's `qty`, else the `charges_ref.qty`
   trader-exit wrote, else the whole shares in ₹1,00,000. The average R is
   printed gross and net of those charges. It never sizes the trade.
5. **The history.** The plan's own rule (the same opening range, stop rule
   and target R, stops and targets on the NSE tick) runs again on every one
   of those past sessions, with its average R gross and net. That is what
   really happened, not a simulation.
6. **The verdict** is one line from the numbers. It looks only at the
   replays that hit one side, and asks how often the target came first. A
   bigger target needs to win less often to break even: 1 in (1 + R). That
   is 50 % at 1R, 33 % at 2R, 25 % at 3R. Less than 5 points from break-even:
   "Close to a coin flip" at 1R, "Close to break-even" at any other R. 5 to
   15 points: "Leans toward the target" or "Leans toward the stop". 15 or
   more: "Strongly toward" one of them. The verdict is gross; read it with
   the net average R next to it.
7. **Below the verdict**, when it applies: a line when more than 40 % of the
   replays hit neither (the price at `--until` decides those), and the
   average R when its sign goes against the lean.

**The seed.** The draws come from Python's `random.Random(seed)`, seed 19 by
default. Same plan, same data, same seed: the same numbers, on any machine.
Say the seed with every result so the user can repeat it.

**5-minute bars only.** Yahoo keeps 60 days of 5-min bars but only about 7
days of 1-min bars, too few sessions for a fair pool. It refuses, in one
plain line, when there are fewer than 20 full sessions, when the entry bar is
not in the data (wrong date, not closed yet, a future day), when the plan
was written for the other market, or when the plan does not make sense (a
stop above a buy's entry, an entry off the 5-minute grid). A live
in-progress bar is never used.

## Steps

1. Make sure `trader/plan.json` is today's plan from `/trader-exit`. If there
   is none, run that first, or pass the plan as flags.
2. Run `timemachine.py run --write`. It replays to the plan's flat-by time,
   so "neither" means still open at the time you would get out.
3. Tell the user, in this order: the four odds, the median and the 5 to 95
   range of the price at the flat-by time, the average R gross and after
   charges, the history line, then the verdict line and any line under it
   exactly as printed. Say the seed.
4. If the verdict is a coin flip or close to break-even, say so plainly, and
   say when the charges turn a small plus into a minus. Do not dress it up.
   If the history and the replays disagree, say that too.
5. Say once that this is built from the last 60 days and is not a prediction.
   Results, news, block deals and circuit limits can do things those 60 days
   never did. Check `/trader-news` for the stock before going on.
6. If the user still wants the trade, hand off to `/trader-budget` to size it.

## Example: RELIANCE (synthetic bars)

RELIANCE, Friday 2026-10-30. Entry ₹1,415.30 at 9:50 AM IST (bar 6), stop
₹1,405.00 (the range midpoint), target ₹1,435.90 (2R, risk ₹10.30 a share),
flat by 15:10.

```
10,000 replays of the rest of the session, 9:50 AM to 3:10 PM (64 five-minute bars), seed 19.
  target first   34.6 %
  stop first     60.8 %
  neither        4.6 %    still open at 3:10 PM
  green          38.0 %   target first, or above the entry at 3:10 PM
  Price at 3:10 PM: median ₹1,417.20, 90 % of replays between ₹1,377.09 and ₹1,459.19.
  Average R: +0.105 (R = the ₹10.30 risk: +2R at the target, -1R at the stop).
  Average R after charges: -0.009 (gross +0.105). About ₹82.73 round trip at the target, ₹82.11 at the stop, on 70 shares
History: the same rule on each of those 58 real sessions fired 51 times:
16 target, 32 stop, 3 neither. Average R -0.010, -0.243 after charges.
Close to break-even: at 2R the target has to come first in 33 % of the replays that hit one side; it did in 36 %.
```

The replays came out close to break-even, and after about ₹82 of charges on
70 shares the average R is slightly negative. That is the honest answer for
this setup, and it is what the user should hear before `/trader-budget`
sizes anything. (These bars are a synthetic test fixture, not RELIANCE's
real history.)

With `--market US`, the upstream reel: TSLA on 2026-10-19, entry 364.18 at
10:15 AM, stop 358.32, target 370.04, 10,000 replays to 4:00 PM give target
first 29.4 %, stop first 25.5 %, neither 45.1 %, and "Close to a coin flip".

## Rules

- Every number comes from the run. Never round a coin flip up into an edge.
- The verdict line and the lines under it are printed by the tool. Repeat
  them, do not rewrite them. Never judge a 2R or 3R plan by target first vs
  stop first alone: the verdict already weighs the target's R.
- Simulated odds are not predictions and not promises. Say it once, plainly.
- Free Yahoo data is unofficial and can lag. Bars are 5-minute bars, checked
  bar by bar, never one trade at a time.
- Charges are an estimate at Groww's intraday rates (override them under
  `"charges"` in the config); the contract note is what counts.
- Always say the seed, so any run can be repeated.
- One plan per run. A changed entry, stop, target or date is a new run.

## What it never does

It never places an order, never sizes a position, never changes the plan,
and never calls a result a sure thing. It never prints a P&L.
It never uses a bar that has not closed yet, and never mixes today's bars
into the pool.

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
