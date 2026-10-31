---
name: trader-risk
description: >-
  Risk Manager. Checks every trade against your limits and stops anything
  over them, before it can reach the broker. India (NSE, IST, rupees, Groww)
  by default. For a day trade: a stop is required, the loss at the stop
  including brokerage, STT and the other charges must fit your max loss per
  trade (measured from the higher of the plan's entry and a fresh price),
  reward:risk net of charges must meet your minimum, the day's total risk
  must fit your daily loss limit, no more than your trades per day, MIS for
  an intraday trade, the order value must fit your cash (no MIS leverage),
  and no new entries outside your IST entry window, on an NSE holiday or
  when the market is closed. It also keeps the basics: blocked symbols,
  order size, position cap, cash buffer, margin, short sales, F&O and
  options, malformed orders or Groww legs, duplicates and a daily order
  limit. Getting out is never blocked by a day limit. Prints PASS or BLOCK
  with the reason and records the verdicts so trader-broker only shows an
  order that passed. Use when the user says "check my order", "is this
  safe", "risk check", "does this break my rules", "can I take this trade",
  "how much have I risked today", or before /trader-broker, always.
  --market US keeps the original NYSE checks.
argument-hint: "[path to orders.json]"
---

# trader-risk

The Risk Manager is the gate between a proposal and the broker. Every order
written by trader-budget or trader-broker's flatten passes through it. A
BLOCK is final for that order: it does not go to the user for a yes, and it
does not go to the broker. Most people who day trade lose money. These limits
keep each loss and each day's losses small. They do not make a trade win.

`${CLAUDE_SKILL_DIR}` below is this skill's folder (where this SKILL.md lives).

```bash
python3 "${CLAUDE_SKILL_DIR}/check.py"                           # trader/ files; writes trader/state/risk.json
python3 "${CLAUDE_SKILL_DIR}/check.py" --json
python3 "${CLAUDE_SKILL_DIR}/check.py" --no-write                # look without recording
python3 "${CLAUDE_SKILL_DIR}/check.py" --now "2026-11-02 09:46"  # pin the clock (IST)
python3 "${CLAUDE_SKILL_DIR}/check.py" --market US               # the original NYSE checks, New York time
```

The market comes from `--market`, then `"market"` in `trader/config.json`,
then `TRADER_MARKET`, then India. Limits are read from the `*_inr` keys
(`max_loss_per_trade_inr`, `max_daily_loss_inr`, `max_order_inr`,
`min_order_inr`); the US config uses `*_usd`.

## What it reads and writes

| file | what |
| --- | --- |
| `trader/orders.json` | the proposed orders (trader-budget, or trader-broker's flatten) |
| `trader/config.json` | the limits (trader-budget ships `config.example.json`, India) |
| `trader/portfolio.json` | cash and holdings; if missing, a fresh account funded with the budget |
| `trader/prices.json` | a fresh price raises the entry it measures risk from; also values holdings |
| `trader/state/broker.json` | what was placed today (live or simulated): duplicates, trades per day, daily loss |
| `trader/state/risk.json` | the verdicts it writes, with a fingerprint of each exact order (Groww legs included) |

## Entries and exits

An **entry** opens or adds to a position: a buy, or a sell that would go
short. An **exit** only reduces what you already hold. Getting out must
always be possible, so an exit is checked for format, asset and short sales
only. Every other rule (day limits, entry window, loss, reward:risk, product,
blocked list, size, duplicates) turns into a warning for an exit, never a
BLOCK. The 15:10 IST flatten sell passes even after the 14:45 cutoff.

## The checks

Orders are checked in file order, as if each passed order had filled, so a
batch that is fine order by order but breaks a limit together is caught.

| check | blocks when |
| --- | --- |
| format | no symbol, side not buy or sell, both or neither of qty and notional; in India a rupee amount (notional) or a fractional qty; a limit order with no limit price; a bracket that misses its stop or target; a `groww` block that does not match the order (symbol, quantity, side, LIMIT price, SL-M trigger, NSE / CASH / DAY, a valid `order_reference_id`, or a target set as a resting sell) |
| asset | an F&O contract (`NIFTY26NOV24000CE`, `RELIANCE26NOVFUT`) while `allow_options` is false; anything that is not an NSE equity symbol (`RELIANCE`, `M&M`, `BAJAJ-AUTO`; `.NS` is fine) |
| short | a sell of more than you hold (`allow_short` false) |
| product | (entries) a day trade (flat_by set) that is not MIS; CNC only when `flat_by` is off; anything else (NRML, MTF) |
| leverage | (entries) the order value plus its buy charges is more than your cash: no MIS leverage (`allow_margin` true makes it a warning) |
| blocked | (entries) the symbol is on the `blocked` list |
| size | (entries) under `min_order_inr` or over `max_order_inr` |
| position | (entries) the stock would be over `max_position_pct` of the account |
| cash | (entries) the buy would leave less than the cash buffer |
| stop | (entries) no stop while `require_stop` is true; a stop on the wrong side of the entry |
| loss | (entries) qty x (entry minus stop) + charges(qty, entry, stop) over `max_loss_per_trade_inr` |
| reward:risk | (entries) (reward minus charges at the target) / (the loss at the stop with charges) under `min_reward_risk` |
| daily loss | (entries) the max losses at the stops of today's entries, plus this one, over `max_daily_loss_inr` |
| trades | (entries) `max_trades_per_day` entries already placed today |
| window | (entries) before `no_entries_before` or after `no_entries_after` (IST), or the market is closed |
| duplicate | (entries) the same symbol and side twice in one batch, or already placed today |
| daily limit | (entries) `max_orders_per_day` orders already placed today |

How the numbers work:

- **The entry it measures from**: the limit price for a limit order. For a
  market order, the HIGHER of the plan's entry and a fresh price from
  `trader/prices.json` (under 15 minutes old). An older price is not used, and
  it says so.
- **Charges** (`"include_charges": true`): brokerage (Groww intraday: 0.1% a
  side, ₹5 to ₹20 per executed order), STT 0.025% of the sell, the NSE
  transaction charge, SEBI fee and IPFT both sides, stamp duty 0.003% of the
  buy, GST 18% on brokerage and fees. The rates live in trader-market;
  `"charges": {...}` in the config overrides them. They are estimates.
- **Daily loss** counts the full max loss (with charges) of every entry placed
  today, win or lose, as trader-broker logged it. Three full ₹500 trades use up
  a ₹1,500 day.
- **The window** is IST, worked out in the tool (India has no daylight
  saving), never from the computer's clock zone. The NSE session is 9:15 to
  15:30. Weekends and NSE 2026 holidays (Diwali Balipratipada on 10 November,
  Guru Nanak Jayanti on 24 November, Christmas...) are closed. The 2027 list
  is not out yet: a 2027 date gives a warning to check nseindia.com. Set both
  `no_entries_*` to null to switch the window off.
- **pdt_guard** is skipped in India with a note: there is no Indian
  pattern-day-trader rule. In US mode it works as upstream (off by default).

Warnings do not block, but say them to the user: a LIVE account, a stop that
lives only in the plan, a price too old to use, a 2027 date, `allow_margin`.

## Steps

1. If the price may have moved since the plan, refresh it first
   (trader-alerts: `alerts.py quote RELIANCE --write`).
2. Run `check.py`. Exit code 0 means every order passed, 1 means at least one
   was blocked.
3. Tell the user the result in plain words, order by order: the max loss at
   the stop with the charges, reward:risk net, and how much of today's limits
   it uses. For a BLOCK, give the reason and the fix (fewer shares, a closer
   stop from trader-exit, wait for the window, or skip the trade). Never
   change a limit yourself.
4. If the order changes in any way, run the check again. trader-broker matches
   each order to its verdict by fingerprint (the Groww block is part of it),
   so an edited order is not ready until it passes again, and a verdict from
   yesterday does not count today.

## Example: RELIANCE (synthetic numbers)

The RELIANCE order from trader-budget at 09:46 IST on Monday 2026-11-02, on a
fresh ₹1,00,000 paper account with the example config:

```
PASS  #1 buy RELIANCE 43 shares, entry
          charges: ₹68.60 at the stop, ₹68.97 at the target; reward ₹860 less charges = ₹791.03
          entry 1412.40 (the limit price), stop 1402.40, target 1432.40: risk 10.00 a share
          max loss ₹498.60 incl. ₹68.60 charges (limit ₹500), reward:risk 1.59 net (min 1.5)
          today before this: 0 of 3 trades, ₹0 of ₹1,500 daily loss

1 passed, 0 blocked at 2026-11-02 09:46 IST. Cash after the passed orders: ₹39,266.80 (paper account).
```

One more share is blocked: `loss: 44 shares x 10.00 risk a share = ₹440 +
₹69.10 charges = ₹509.10 at the stop, over your ₹500 max loss per trade`
(the charges decide it: ₹440 alone would fit). At 09:20 it is blocked by the
window (no new entries before 09:30 IST), on 10 November by the Diwali
holiday, with `"product": "CNC"` by the product check, and on a ₹50,000
account by the leverage check. The 15:10 sell that closes it passes.

## US mode

`--market US` (or `"market": "US"`) is the upstream check: dollars, New York
time, NYSE holidays and 1:00 p.m. early closes, no charges, the Alpaca
bracket format, and `pdt_guard`. The reel: 8 TSLA at 364.18, stop 358.32,
$46.88 at the stop, PASS at 10:15 New York; 9 shares is a BLOCK.

## Rules

- A PASS only means the order is allowed to be shown to the user. It is not a yes.
- Every number comes from the config, the order, the portfolio, the prices, the charge table or
  the broker log.
- Free Yahoo prices are unofficial and can lag; the broker's price is the one that fills, and a
  stop can fill worse than its price in a fast market.

## What it never does

It never places an order, never edits an order to make it pass, never
loosens a limit, never blocks a sell that only gets the user out, and never
treats a PASS as the user's yes.

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
