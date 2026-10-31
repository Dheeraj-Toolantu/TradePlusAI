---
name: trader-budget
description: >-
  Budget Manager. Sizes every position to your budget and your max loss per
  trade, in rupees on NSE by default. Reads the trade plan from trader-exit
  (entry, stop, target), finds the whole shares that fit inside four limits
  (max loss per trade including brokerage, STT and the other charges,
  position cap, max order, cash after your buffer with no MIS leverage),
  says which limit decided it with the charges shown, checks reward:risk net
  of charges, and writes ONE order to trader/orders.json with its Groww
  place_order legs: a LIMIT BUY entry, then an SL-M SELL at the stop once it
  fills (Groww has no equity bracket order). A stop too far away for your max
  loss is a plain refusal, not a smaller order. Nothing is placed. Use when
  the user says "how many shares", "size this trade", "how much should I
  buy", "I have ₹1,00,000", "I only want to risk ₹500 a trade", "set my
  rules", "keep 10% in cash", or after /trader-exit writes a plan.
  --market US keeps the original NYSE / Alpaca bracket sizing.
argument-hint: "[budget in rupees]"
---

# trader-budget

The Budget Manager turns a plan ("buy RELIANCE at 1412.40, stop 1402.40")
into an exact order ("buy 43 shares"), inside rules the user sets once. The
stop decides the size: the further away the stop, the fewer shares. In India
the charges count too: brokerage, STT, the NSE transaction charge, SEBI fee,
stamp duty and GST are part of what a losing trade costs. It writes a
proposal only. trader-risk checks it and trader-broker asks the user yes or
no. Day trading loses most people money. Sizing to a max loss keeps each loss
small; it does not make a trade win.

`${CLAUDE_SKILL_DIR}` below is this skill's folder (where this SKILL.md lives).

```bash
python3 "${CLAUDE_SKILL_DIR}/size.py"                         # trader/plan.json + trader/config.json
python3 "${CLAUDE_SKILL_DIR}/size.py" --write                 # write trader/orders.json
python3 "${CLAUDE_SKILL_DIR}/size.py" --limit 1412.00 --write # a LIMIT entry at 1412.00
python3 "${CLAUDE_SKILL_DIR}/size.py" --market-order --json   # a MARKET entry instead of the LIMIT
python3 "${CLAUDE_SKILL_DIR}/size.py" --targets "${CLAUDE_SKILL_DIR}/targets.in.example.json" --budget 100000
python3 "${CLAUDE_SKILL_DIR}/size.py" --market US             # the original NYSE / Alpaca behaviour
```

`--now "2026-11-02 09:46"` pins the clock (IST; New York time with
`--market US`). A plan for another day is refused: make a new one with
trader-exit. The market comes from `--market`, then `"market"` in
`trader/config.json`, then the `TRADER_MARKET` environment variable, then
India.

## What it reads and writes

| file | what |
| --- | --- |
| `trader/config.json` | the rules (start from `config.example.json` in this folder; `config.us.example.json` is the US one) |
| `trader/plan.json` | the trade: entry, stop, target, setup, flat-by time (trader-exit writes it) |
| `trader/prices.json` | optional: a fresh price above the plan's entry means a bigger risk (trader-alerts writes it; `RELIANCE` or `RELIANCE.NS` both work) |
| `trader/portfolio.json` | optional: its cash caps the size (trader-broker keeps it) |
| `trader/orders.json` | the one proposed order it writes with `--write` |

## Step 1: set the rules once

If `trader/config.json` does not exist, copy `config.example.json` into
`trader/config.json` and ask the user for each value in plain words. Money
limits are in rupees and end in `_inr`:

- **budget**: how much money this is for (example ₹1,00,000). Only money they can afford to lose.
- **cash_buffer_pct**: how much always stays in cash (default 10).
- **max_loss_per_trade_inr**: the most one trade may lose if the stop fills at the stop, charges
  included (example ₹500).
- **max_position_pct**, **max_order_inr**, **min_order_inr**: the biggest position (80% of the
  budget), the biggest order (₹80,000) and the smallest order (₹100).
- The day limits trader-risk enforces: **max_daily_loss_inr** (₹1,500), **max_trades_per_day** (3),
  **min_reward_risk** (1.5, net of charges), **require_stop** (true), **no_entries_before** /
  **no_entries_after** ("09:30" / "14:45") and **flat_by** ("15:10"), all IST.
- **product**: "MIS" (intraday). Groww squares off open MIS positions itself from about 15:10 to
  15:20 and charges for that, which is why flat_by is 15:10.
- **include_charges** (true) and **charges** ({}): overrides for the charge rates in
  trader-market (`brokerage_pct`, `brokerage_max`, `stt_sell_pct`, `stamp_buy_pct`...).
- **allow_margin** false: the cash limit assumes no MIS leverage. **allow_short** and
  **allow_options** false.
- **blocked**: symbols they never want to trade (plain NSE symbols like `YESBANK`).
- Keep **paper** true. Groww has no paper account, so paper fills are simulated by trader-broker.

## Step 2: size the trade

```bash
python3 "${CLAUDE_SKILL_DIR}/size.py" --write
```

Whole shares only: NSE has no fractional shares. The size is the smallest of four limits:

| limit | shares |
| --- | --- |
| max loss | the most shares with qty x (entry minus stop) + charges(qty, entry, stop) <= `max_loss_per_trade_inr` |
| position cap | budget x `max_position_pct` / entry |
| max order | `max_order_inr` / entry |
| cash | (budget minus the cash buffer) / entry with the buy-side charges, no MIS leverage, never more than the cash in `trader/portfolio.json` |

The entry is a LIMIT at the price it sizes at, on the NSE tick (0.05 from
₹250, 0.10 from ₹1,000 and so on): the plan's entry, or the price in
`trader/prices.json` if it is fresh (under 15 minutes old) and higher.
`--limit P` sets your own limit; `--market-order` sends a MARKET entry. Off-tick
stops and targets are rounded down (the safer side for a long).

It refuses, and writes no order, when: the size is zero shares (it says
whether the charges pushed one share over), the order is under the minimum,
reward:risk net of charges is under `min_reward_risk`, the stop is not below
the entry, the target is not above it, the plan is for another day, the
symbol is blocked, or the plan is a short. Say the reason in one line.

## Step 3: show the user

Show the four limits, which one decided the size and why, the shares, the
rupees, the max loss at the stop as shares x risk + charges, and reward:risk
gross and net. Say plainly that a stop is an order, not a promise: in a fast
market it can fill below the stop. The charges are estimates; the contract
note has the real ones. Then hand over to `/trader-risk`.

## Groww: a bracket becomes legs

Groww has no bracket (or cover) order for equity in its Trade API, so the
order carries a `"groww"` block shaped like the Groww Trade API `place_order`
params (`trading_symbol`, `quantity`, `price`, `trigger_price`, `validity`
"DAY", `exchange` "NSE", `segment` "CASH", `product` "MIS", `order_type`
LIMIT / SL / SL_M / MARKET, `transaction_type` BUY / SELL,
`order_reference_id`):

1. **entry**: a LIMIT BUY, placed now.
2. **stop_loss**: an SL-M SELL with its trigger at the stop, placed only after the entry fills,
   for the filled quantity.
3. **target**: NOT a resting order. If a target sell and the SL-M both sat at Groww, both could fill
   and leave the user short. trader-alerts watches the target (`alerts.py add --from-plan`); when
   it rings, modify or cancel the SL-M and sell (`ticket.py flatten`).

The upstream fields (`symbol`, `qty`, `type`, `limit_price`, `order_class`
"bracket", `stop_loss_stop_price`, `take_profit_limit_price`, `why`, `plan`)
stay, because trader-risk and trader-broker read them.

## Example: RELIANCE (synthetic numbers)

RELIANCE on Monday 2026-11-02. Opening-range breakout: entry 1412.40 at 09:45
IST, stop 1402.40, target 1432.40 (2R). Risk 10.00 a share. The example
config: ₹1,00,000 budget, 10% buffer, ₹500 max loss, charges included.

| limit | the math | shares |
| --- | --- | --- |
| max loss | 43 x 10.00 = ₹430 + ₹68.60 charges = ₹498.60 (44 would be over ₹500) | **43 (decides it)** |
| position cap | 80% of ₹1,00,000 = ₹80,000 / 1412.40 | 56 |
| max order | ₹80,000 / 1412.40 | 56 |
| cash | ₹1,00,000 minus ₹10,000 = ₹90,000 / 1412.40, with the buy charges | 63 |

Without charges it would be 50 shares. 43 shares = ₹60,733.20. At the target:
₹860 less ₹68.97 charges = ₹791.03, so reward:risk is 2.00 gross and 1.59 net.
The Groww entry it writes:

```json
{"trading_symbol": "RELIANCE", "quantity": 43, "price": 1412.4, "validity": "DAY", "exchange": "NSE",
 "segment": "CASH", "product": "MIS", "order_type": "LIMIT", "transaction_type": "BUY",
 "order_reference_id": "TPE-261102-52b40717"}
```

and, for after the fill, the same with `"order_type": "SL_M"`,
`"transaction_type": "SELL"` and `"trigger_price": 1402.4`. With the target at
1428.40 instead (1.6R gross), the charges take it under 1.5 net: no order.

## Weights mode (kept from v1)

`--weights RELIANCE=25,TCS=20` or `--targets FILE` splits a budget across a
list by weight: the cash buffer comes off the top, weights are renormalised,
anything over `max_position_pct` is capped and the rest shared out, slices
under the minimum are dropped. In India it is always whole shares (it needs
prices) and each buy is a delivery (CNC) MARKET order with its own Groww
params. `targets.in.example.json` holds illustrative NSE weights (made up, not
an index); `targets.example.json` is the upstream US 13F example. These buys
have no stop, so trader-risk blocks them while `require_stop` is true and
flags CNC while `flat_by` is set: use a separate config (`--config`) with
`"flat_by": null` for a long-term split.

## US mode

`--market US` (or `"market": "US"`) is the upstream behaviour: dollars, New
York time, no charges, and one Alpaca bracket order in `place_stock_order`
shape. The TSLA reel: $5,000, $50 max loss, entry 364.18, stop 358.32, 8
shares, $46.88 at the stop. `config.us.example.json` is that config; it has no
`"market"` key (it is the upstream contract), so add `"market": "US"` when you
copy it, or pass `--market US`.

## Rules

- Proposals only. This skill never calls a broker tool.
- Never size money the user has not said is for this. Ask for the budget and the max loss.
- Every number comes from the config, the plan, the prices or the charge table. Nothing is guessed.
- No projections: never say what a trade will make. A target is a plan, not a forecast.
- Free Yahoo prices are unofficial and can lag. The broker's price is the one that fills.

## What it never does

It never places, approves or schedules an order, never raises a limit on its
own, never shrinks a stop to fit more shares, never adds MIS leverage, and
never sizes options, futures, margin or short positions.

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
