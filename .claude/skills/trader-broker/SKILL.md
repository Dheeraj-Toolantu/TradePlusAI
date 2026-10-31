---
name: trader-broker
description: >-
  Order Executor. Turns an approved order into a ticket for your broker,
  Groww on NSE by default, paper trading by default, never without your yes.
  Shows each order as a plain ticket (the LIMIT BUY entry, the SL-M stop to
  place once it fills, the target that trader-alerts watches, and the max
  loss at the stop with charges) plus the exact Groww Trade API place_order
  JSON, and records your yes word for word. Claude never places a live Groww
  order: you place it in the Groww app, the Trade API or TradePulse's gated
  execution service. Groww has no paper account, so on paper it records a
  simulated fill in the local ledger. Builds the sell ticket that closes a
  day trade by your flat-by time (ahead of the MIS auto square-off), records
  fills, and logs each trade's max loss so trader-risk can hold the daily
  limit. Covers Groww Trade API keys (in env vars, never in chat), charges,
  STT and T+1, and, with --market US, Alpaca's MCP server and Interactive
  Brokers. Use when the user says "place the order", "buy it", "execute",
  "send it to my broker", "close my position", "flatten", "get me out",
  "connect Groww", "set up paper trading", or after /trader-risk passes.
argument-hint: "[order number]"
---

# trader-broker

The Order Executor is the only skill in this pack that leads to a real
order, so it is the strictest. In India (the default) an order reaches the
market only after three separate gates, every time, for every order:

1. **trader-risk passed this exact order today** (matched by fingerprint, Groww legs included).
2. **The user typed an explicit yes for this one order** in the chat, recorded word for word.
3. **The user places it themselves** on Groww. Claude never places a live Groww order: there is
   no Groww connector in this pack, and Claude never calls the Groww API, never runs a script
   that does, and never asks for Groww keys.

On paper (`"paper": true`, the default) nothing goes to Groww at all: Groww has
no paper account, so `ticket.py simulate` records a simulated fill in the same
local ledger upstream keeps. No yes, no order, simulated or real.

`${CLAUDE_SKILL_DIR}` below is this skill's folder (where this SKILL.md lives).

```bash
python3 "${CLAUDE_SKILL_DIR}/ticket.py" show                     # every ticket, READY or not
python3 "${CLAUDE_SKILL_DIR}/ticket.py" approve --index 1 --reply "yes"
python3 "${CLAUDE_SKILL_DIR}/ticket.py" simulate --index 1       # paper: the simulated fill
python3 "${CLAUDE_SKILL_DIR}/ticket.py" result --index 1 --status placed --broker-id GROWW_ORDER_ID
python3 "${CLAUDE_SKILL_DIR}/ticket.py" fill --symbol RELIANCE --side sell --qty 43 --price 1432.40
python3 "${CLAUDE_SKILL_DIR}/ticket.py" flatten --symbol RELIANCE --qty 43
python3 "${CLAUDE_SKILL_DIR}/ticket.py" log
python3 "${CLAUDE_SKILL_DIR}/ticket.py" show --market US         # the original Alpaca / IBKR tickets
```

`ticket.py` never talks to a broker. It renders tickets, checks that a reply
is a real yes for that order, builds the flatten ticket, simulates paper
fills, and keeps the log in `trader/state/broker.json`. `--now "2026-11-02
09:46"` pins the clock (IST; New York time with `--market US`).

## What it reads and writes

| file | what |
| --- | --- |
| `trader/orders.json` | the proposed orders (trader-budget writes it; `flatten` replaces it) |
| `trader/state/risk.json` | trader-risk's verdicts; only a PASS from today is READY |
| `trader/state/broker.json` | every yes, no, placed (live or simulated), failed and filled, with each entry's max loss |
| `trader/portfolio.json` | cash and shares, updated by `simulate`, `fill` and `result --filled-qty` |
| `trader/plan.json` | the flat-by time for `flatten` |

## The Groww ticket: a bracket becomes legs

Groww's Trade API has no bracket order for equity, so each day trade is
placed as legs, and the ticket shows each one in plain words plus the exact
`place_order` params (`POST /v1/order/create`):

1. **now**: the entry, a LIMIT BUY, `product` "MIS", `segment` "CASH", `exchange` "NSE",
   `validity` "DAY", with its own `order_reference_id` (8 to 20 letters, digits, at most two hyphens).
2. **once the entry fills**: the protective stop, an SL-M SELL for the filled quantity with
   `trigger_price` at the stop. Place it straight away: until it is in, nothing protects the trade.
3. **the target is NOT a resting order.** A target sell next to the SL-M could fill as well and
   leave the user short. trader-alerts watches the target (`alerts.py add --from-plan`). When it
   rings, cancel (or modify) the SL-M first, then sell: `ticket.py flatten`.

```
ORDER 1 of 1, PAPER (simulated fills in your local ledger; Groww has no paper account), Groww
  BUY 43 RELIANCE, limit 1412.40, good for today, NSE MIS
  then, once it fills, SL-M sell 43 at trigger 1402.40 (the stop-loss)
  target 1432.40 is watched by trader-alerts, not a resting order
  max loss about ₹498.60 incl. ₹68.60 charges if the stop fills at 1402.40 (it can fill worse in a fast market)
  READY: trader-risk PASS, waiting for your yes
  Groww place_order, step 1 (now):
    {"trading_symbol": "RELIANCE", "quantity": 43, "price": 1412.4, "validity": "DAY", "exchange": "NSE",
     "segment": "CASH", "product": "MIS", "order_type": "LIMIT", "transaction_type": "BUY",
     "order_reference_id": "TPE-261102-52b40717"}
  Groww place_order, step 2 (only after step 1 fills, for the filled quantity):
    {... "trigger_price": 1402.4, "order_type": "SL_M", "transaction_type": "SELL", ...}
```

(Synthetic numbers. If Groww rejects an SL-M for a stock, an SL order with a
limit a few ticks under the trigger is the fallback; it can miss in a gap.)

## Groww Trade API setup (live only, the user's own step)

Only for a user who has decided to go live, and only on their own computer:

1. In the Groww app or website, the user subscribes to the Groww Trade API (check Groww's current
   terms and fees) and creates an API key and secret there.
2. The key and secret go in environment variables, the same names as TradePulse's `.env.example`:
   `GROWW_API_KEY` and `GROWW_API_SECRET` (optionally `GROWW_ACCESS_TOKEN`). **Never in the chat.**
   Never ask for them, never read `.env` back into the conversation, and if the user pastes one
   anyway, tell them to delete that message and make a new key in Groww.
3. API access tokens expire daily; the user renews them with Groww's approval flow.
4. SEBI's rules for retail algo and API orders apply (Groww may ask for a static IP and caps the
   order rate). TradePulse keeps its own switch for this: `LIVE_COMPLIANCE_APPROVED`.

Where the user places the order:

- **the Groww app** (simplest): enter the ticket's legs by hand, MIS, LIMIT, then the SL-M.
- **the Groww Trade API**, with their own code and their own keys, passing the ticket's params.
- **TradePulse's own execution service** (`services/execution` with the Groww adapter): it is gated by
  `EXECUTION_MODE=ALGO_LIVE`, `LIVE_EXECUTION_ENABLED`, `LIVE_COMPLIANCE_APPROVED`,
  `LIVE_TRADING_CONFIRMATION`, a preview plus `LIVE_TRADING_PIN` on every live confirm, the
  `ALGO_KILL_SWITCH` and `ALGO_SAFE_MODE`, and the `LIVE_MAX_*` limits in `.env`. Those gates and
  limits are separate from `trader/config.json`; changing one does not change the other. It is
  built for the app's own F&O flow, so an NSE cash MIS ticket may need the Groww app instead.

## Costs and settlement in India

- **Charges** on an intraday (MIS) round trip: brokerage (Groww: 0.1% of the order value, ₹5 to
  ₹20 per executed order), **STT** 0.025% of the sell value, the NSE transaction charge, SEBI fee,
  stamp duty 0.003% of the buy, GST 18% on brokerage and fees. A delivery (CNC) trade pays STT
  of 0.1% on both sides and a different brokerage. trader-budget and trader-risk include them in
  the max loss; they are estimates, and the contract note is the record.
- **MIS auto square-off**: Groww closes open MIS positions itself from about 15:10 to 15:20 IST and
  charges an extra fee per order for it (₹50 + GST when this was written: check Groww's pricing).
  That is why `flat_by` is 15:10: be flat before the broker does it for you.
- **T+1**: NSE equity settles T+1. Intraday gains and losses settle the next trading day; shares
  bought for delivery (CNC) reach the demat account the next trading day.
- No short selling here: an MIS short that cannot be covered is an auction risk.

## Steps: the entry (India)

1. `ticket.py show`. Only READY tickets go to the user. A ticket that is NOT
   READY or BLOCKED goes back to `/trader-risk`.
2. Show ONE ticket and ask: "Approve this order? Reply yes or no." One order
   per question. Never offer "yes to all".
3. Run `ticket.py approve --index N --reply "<the user's reply, word for word>"`.
   If it prints "Not recorded", the reply was not an explicit yes for this
   order (for example "sure", "yes to all", or a yes that names a different
   stock or amount). Ask again. Never turn a reply into a yes yourself.
4. Paper: `ticket.py simulate --index N` records the fill at the limit price
   (or `--price P`, the quote at the time) in `trader/portfolio.json` and the
   log. Nothing is sent anywhere.
5. Live: the ticket prints the Groww JSON. The user places step 1, then, once it
   fills, step 2, themselves. Then record what happened: `ticket.py result
   --index N --status placed --broker-id <groww_order_id> --filled-qty Q
   --filled-price P`, or `--status denied` (they chose not to), or `--status
   failed --note ...`. A failed order is not retried without a new check and a
   new yes. The log keeps the entry's max loss for trader-risk's daily limit.

## Steps: while it is open, and out by 15:10 IST

- trader-alerts watches the stop, the target and the flat-by time
  (`alerts.py add --from-plan`). On Groww the SL-M does the stopping.
- When the SL-M fills, record it: `ticket.py fill --symbol RELIANCE --side sell --qty 43 --price 1402.40`.
- At the target, or by `flat_by` (15:10 IST):
  1. Check the position in Groww (or `trader/portfolio.json` on paper).
  2. `ticket.py flatten --symbol RELIANCE --qty 43` writes a MARKET MIS sell with its Groww params.
  3. `/trader-risk`. A sell that only closes what the user holds is never blocked.
  4. `ticket.py show`, then the user's yes for that one order, as above.
  5. Live: the user cancels (or modifies) the open SL-M FIRST, then places the sell. Paper:
     `ticket.py simulate`.

## US mode: Alpaca and Interactive Brokers

`--market US` (or `"market": "US"` in the config) keeps the upstream flow:
dollars, New York time, one Alpaca bracket in `place_stock_order` shape, and
the third gate is Claude's own Allow once / Deny card on the Alpaca MCP tool.
`claude_desktop_config.example.json` here is the Alpaca block; there is no
Groww counterpart because there is no Groww connector.

### US setup A: Alpaca (official MCP server, Claude Desktop)

Alpaca's own server is github.com/alpacahq/alpaca-mcp-server (MIT). It runs on
the user's computer inside Claude Desktop. It is not in Claude's connector
directory. It trades on a **paper** account unless told otherwise. Checked
against its source on 2026-10-20 (version 2.4.0).

1. The user makes an Alpaca account and creates **paper trading** API keys in
   the Alpaca dashboard. Paper keys are separate from live keys.
2. The user installs `uv` (it provides `uvx`), from docs.astral.sh/uv.
3. In Claude Desktop: Settings > Developer > Edit Config. That opens
   `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`,
   Windows: `%APPDATA%\Claude\`). The user adds this block (also in
   `claude_desktop_config.example.json` here) and types their own keys into the file:

```json
{
  "mcpServers": {
    "alpaca": {
      "command": "uvx",
      "args": ["alpaca-mcp-server"],
      "env": {
        "ALPACA_API_KEY": "paste your paper key here, in this file only",
        "ALPACA_SECRET_KEY": "paste your paper secret here, in this file only",
        "ALPACA_PAPER_TRADE": "true",
        "ALPACA_TOOLSETS": "account,trading,stock-data"
      }
    }
  }
}
```

   The `env` block hands the keys to the server as environment variables.
   **Keys never go in the chat.** Never ask for them, never read this file
   back into the conversation, and if the user pastes a key anyway, tell them
   to delete that message and make new keys in the Alpaca dashboard.
   `ALPACA_PAPER_TRADE` is already true by default; writing it makes it
   visible. `ALPACA_TOOLSETS` is optional and hides the tools they do not need.
4. Restart Claude Desktop.
5. **Set the tool permissions.** Customize > Connectors (Settings > Connectors
   in older versions), open alpaca, and for each tool pick Always allow, Needs
   approval or Blocked:
   - `place_stock_order`: **Needs approval**. Never Always allow.
   - every other tool that places, changes, cancels or closes anything
     (`cancel_order_by_id`, `replace_order_by_id`, `close_position`,
     `update_account_config`): Needs approval.
   - `place_option_order`, `place_crypto_order`, `close_all_positions`,
     `cancel_all_orders`, `exercise_options_position`,
     `do_not_exercise_options_position`: **Blocked** unless the user has a
     reason and says so.
   - read-only tools (`get_account_info`, `get_all_positions`, `get_open_position`,
     `get_orders`, `get_clock`, `get_stock_snapshot`, `get_stock_latest_quote`):
     Always allow is fine.
6. Check it: ask Claude for the Alpaca account info (read only) and confirm
   in the Alpaca dashboard that it is the paper account.

In Claude Code instead of Claude Desktop, keep the order tool on ask in
`.claude/settings.json`: `"permissions": {"ask": ["mcp__alpaca__place_stock_order"]}`,
and never put an order tool in `allow`.

**Bracket orders on Alpaca.** `place_stock_order` takes
`take_profit_limit_price` and `stop_loss_stop_price` (and an optional
`stop_loss_limit_price`). When either is there, the server sets
`order_class` to "bracket" by itself; trader-budget writes it anyway so the
ticket shows it. A bracket is whole shares only, with `time_in_force` day or
gtc. After the entry fills, the stop-loss and the take-profit wait at the
broker as two orders that cancel each other. They are day orders too, so they
end at the close: one more reason to be flat by then.

### US setup B: Interactive Brokers (connector in Claude's directory)

Interactive Brokers publishes a verified connector: claude.ai/directory/interactive-brokers
(connector URL `https://api.ibkr.com/v1/api/mcp`). Add it from Customize >
Connectors > Browse connectors and sign in to IBKR there, not in the chat.
Its listing says Claude can draft trade instructions that are sent to the
user's IBKR account for their review and approval, and that Claude never
submits orders directly to the market. So with IBKR the final yes happens in
IBKR as well. Set `"broker": "ibkr"` in `trader/config.json`. Set its tools
that draft orders to Needs approval too.

### US steps

1. `ticket.py show --market US`, one READY ticket, the user's yes, `ticket.py approve`.
2. Only after "Recorded your yes", call `place_stock_order` with exactly the JSON the ticket printed.
   Claude's card appears: Allow once or Deny. Then `ticket.py result`.
3. By `flat_by` (15:55 New York): `get_open_position`, `ticket.py flatten`, `/trader-risk`, a yes,
   cancel the bracket's open legs (`cancel_order_by_id`, Needs approval), then `place_stock_order`.

The reel: `BUY 8 TSLA, market, good for today / stop-loss 358.32 / take-profit
370.04 / max loss about $46.88`, on the Alpaca paper account.

## What it never does

- Never places a live Groww order, never calls the Groww API, and never runs code that does.
- Never places an order without all three gates, and never two orders on one yes.
- Never places or simulates orders from a scheduled or background task: nobody is there to say yes.
- Never asks for, reads, stores or repeats API keys, secrets, tokens, PINs or passwords.
- Never switches `"paper"`, `ALPACA_PAPER_TRADE`, `EXECUTION_MODE` or any `LIVE_*` switch to live.
- Never calls `close_all_positions`, `cancel_all_orders`, option or crypto order tools on its own.
- Never promises a fill price: a market order and a stop fill at whatever the market gives.

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
