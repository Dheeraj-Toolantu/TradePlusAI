---
name: trader-exit
description: >-
  Exit Planner for NSE stocks. Sets your stop and your target before you
  enter, so you know when to get out. Reads the entry from trader-entry (or a
  rupee price you give), puts the stop at the opening-range midpoint by
  default (or the range low, your price, a percent, or a multiple of the ATR),
  rounds it down to the NSE tick for the price and the target up to it, sets
  the target at 2R (or 1R, or your price) and flat by 15:10 IST, ahead of the
  broker's intraday auto square-off. Refuses a stop at or above the entry, a
  target at or below it, or a stop too tight to survive the spread (fewer than
  5 ticks, or under 0.05% of the price), and says why. Shows the estimated
  round-trip charges (brokerage, STT, exchange, SEBI, stamp duty, GST) as
  information. Writes trader/plan.json for the Time Machine, the Budget
  Manager and Price Alerts. Long side only. --market US gives the original
  NYSE behaviour. Use when the user says "where's my stop", "set my stop and
  target", "plan the exit", "when do I get out", "stop loss", "what's my R",
  "risk reward", "what will the charges be", or right after /trader-entry
  triggers, before /trader-timemachine.
argument-hint: "[--stop or-mid|or-low|price:X|pct:X|atr:K] [--target 2R|1R|price:X] [--market IN|US]"
---

# trader-exit

The Exit Planner decides how a trade ends before it starts. The stop is where
the setup has failed. The target is where you take what you came for. Both
are set BEFORE the entry, written down and handed on, so nobody has to decide
anything in the middle of a fast move. A stop is a plan, not a guarantee: a
gap or a fast market can fill past it. Day trading loses most people money,
and a neat plan does not change that.

India (NSE, IST, rupees) is the default market. Ticks, the IST clock, NSE
holidays and the charge rates come from the shared `trader-market` profile.
Add `--market US` (or `"market": "US"` in `trader/config.json`) for the
original NYSE behaviour in dollars, cents and New York time, unchanged.

`${CLAUDE_SKILL_DIR}` below is this skill's folder (where this SKILL.md lives).

```bash
python3 "${CLAUDE_SKILL_DIR}/exit.py" plan                          # trader/entry.json: midpoint stop, 2R target
python3 "${CLAUDE_SKILL_DIR}/exit.py" plan --stop or-mid --target 1R --write
python3 "${CLAUDE_SKILL_DIR}/exit.py" plan --stop atr:1.5           # needs the session's bars (Yahoo or --offline)
python3 "${CLAUDE_SKILL_DIR}/exit.py" plan --symbol RELIANCE --entry 1415.30 --or-high 1412 --or-low 1398
python3 "${CLAUDE_SKILL_DIR}/exit.py" plan --symbol TCS --entry 3150 --setup level --stop pct:1 --ref-qty 10
python3 "${CLAUDE_SKILL_DIR}/exit.py" show                          # the current trader/plan.json
python3 "${CLAUDE_SKILL_DIR}/exit.py" --market US plan --symbol TSLA --entry 364.18 --or-high 362.18 --or-low 354.47
```

Other flags: `--flat-by 15:10`, `--json`, `--now "2026-10-30 09:51"` (IST;
a trailing ` IST` is fine), `--entry PRICE` with a waiting entry.json to plan
ahead, `--setup level`, `--offline FILE` (a saved Yahoo chart JSON for an ATR
stop), `--ref-qty N` (shares for the charges line).

## What it reads and writes

| file | what |
| --- | --- |
| `trader/entry.json` | the trigger from trader-entry: symbol, entry price, time, bar, opening range, market |
| `trader/config.json` | `flat_by` (15:10 IST), `min_reward_risk` (1.0: a note here, trader-risk enforces it), `"market"`, and `"charges"` overrides for the rates |
| Yahoo chart API | only for an `atr:K` stop: the session's bars (`RELIANCE.NS`) up to the entry bar, free and unofficial |
| `trader/plan.json` | with `--write`: entry, stop and its rule, target and its R, risk a share, reward:risk, flat by, plus `market`, `currency`, `tick` and `charges_ref`. trader-timemachine, trader-budget and trader-alerts read it |

## Stops and targets

| stop | where it goes |
| --- | --- |
| `or-mid` | the opening-range midpoint (the default for an opening-range breakout) |
| `or-low` | the opening-range low: wider, so fewer shares for the same max loss |
| `price:X` | your price (`price:1405`, `price:₹1,405` and `price:Rs 1405` all work) |
| `pct:X` | X percent under the entry |
| `atr:K` | K times the 14-bar ATR under the entry, on the session's bars up to the entry bar. With fewer than 14 bars by then it averages all of them and says so |

A level setup has no opening range to lean on, so it needs a stop you name.

- **Rounding to the NSE tick.** The tick depends on the price: 0.01 under
  Rs 250, 0.05 up to Rs 1,000, 0.10 up to Rs 5,000, 0.50 up to Rs 10,000, then
  1.00 and 5.00. The entry rounds to the nearest tick. The stop rounds AWAY
  from the entry (down, for a long). Risk = entry minus stop. Target = entry +
  R x risk, rounded UP to the tick. `2R` by default; `1R`, `1.5R` or `price:X`
  also work. In US mode it is the upstream rule: the stop down to the cent,
  the target half up to the cent.
- **Refused, with the reason.** A stop at or above the entry. A target at or
  below it. A stop too tight to survive the spread: on NSE, a risk under 5
  ticks or under 0.05% of the price, whichever is larger (RELIANCE at
  ₹1,415.30, tick 0.10, needs at least ₹0.71); in US mode under 0.05% of the
  price. Normal wiggle would stop you out. An entry.json that has not
  triggered (unless you give `--entry`), or one written for the other market.
  A short: v2 plans longs only.
- **Flat by.** 15:10 IST by default (or `flat_by` in the config). Out by
  then, win or lose, no overnight hold, and before the broker's intraday
  (MIS) auto square-off at about 15:10 to 15:20, which costs a fee. A later
  flat-by gets a note. An entry at or after the flat-by time is refused. In
  US mode: 15:55 ET, and 12:55 on a 1:00 p.m. early close.
- **Charges, as information.** The plan shows the estimated round-trip
  charges for a reference quantity: `--ref-qty N`, or the whole shares in
  ₹1,00,000. It shows them at the target and at the stop, per share, and the
  reward:risk after charges. Sizing is `/trader-budget`'s job, so these
  numbers never change the stop, the target or plan.json's upstream fields.

## Steps

1. Run it right after `/trader-entry` triggers. Before that, `--entry PRICE`
   plans ahead at the level you expect.
2. Use the default stop for an opening-range breakout unless the user names
   another. A level setup needs one: ask.
3. Run `exit.py plan --write`. Read back the entry, the stop and its rule,
   the target and its rule, the risk a share, reward:risk, the charges line
   and flat by.
4. If it refuses, say the reason and the fix (a wider stop, a farther
   target). Never loosen anything on your own.
5. Say once that the stop is a plan, not a guarantee.
6. Hand off to `/trader-timemachine` to replay the plan, then `/trader-budget`
   to size it to the max loss per trade. Offer `/trader-alerts` for the stop,
   the target and the flat-by time. Claude can keep `entry.py watch` running
   in the background or on a `/loop` until a setup triggers, then come here.

## Example: RELIANCE (synthetic bars)

RELIANCE, Friday 2026-10-30. The entry is 1,415.30 at 9:50 AM IST (the 9:45
bar, bar 6) and the opening range is 1,398.00 to 1,412.00. `exit.py plan
--write`:

```
Exit plan: RELIANCE long, Fri 2026-10-30, opening-range breakout on 5-minute bars
  Entry         ₹1,415.30 at 9:50 AM (bar 6)
  Stop          ₹1,405.00  opening-range midpoint: (₹1,412.00 + ₹1,398.00) / 2 = ₹1,405.00
  Target        ₹1,435.90  2R (two times the risk)
  Risk a share  ₹10.30 (0.73% of the entry)
  Reward:risk   2.0
  Charges       about ₹82.73 round trip at the target, ₹82.11 at the stop, on 70 shares (₹1,00,000 of stock), ₹1.18 / ₹1.17 a share; reward:risk after charges 1.69. Estimate, information only
  Flat by       15:10 IST, win or lose: no overnight hold (ahead of the broker's MIS auto square-off)
```

## Example: the reel, with --market US

TSLA, Monday 2026-10-19. The entry is 364.18 at 10:15 AM (bar 8) and the
opening range is 354.47 to 362.18. `exit.py --market US plan --stop or-mid
--target 1R --write` puts the stop at $358.32 (the midpoint $358.325, rounded
down), the target at $370.04, the risk a share at $5.86, flat by 15:55 ET.
The default 2R target would be 364.18 + 2 x 5.86 = 375.90. trader-budget then
sizes it: a $50 max loss per trade buys floor(50 / 5.86) = 8 shares.

## Rules

- The stop and the target are set before the entry, never after.
- Never move a stop further from the entry once the trade is on.
- Plain numbers only: entry, stop, target, risk a share, reward:risk, and
  the charges estimate. It never prints a P&L or a return.
- Nothing here promises winning trades or money. A 1R target is not a
  prediction that the price gets there.
- Long side only. v2 plans longs only.
- Rupees and IST unless the user chose `--market US`. Charges are an
  estimate at Groww's intraday rates; the contract note is what counts.

## What it never does

It never places an order, never sizes a position, never widens a stop to
make a plan pass, and never calls a stop a guarantee.

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
