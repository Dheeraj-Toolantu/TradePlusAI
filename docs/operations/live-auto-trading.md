# Live auto-trading (real money, Groww, intraday)

Confirmed **NIFTY Sniper** or **VWAP-EMA** setups can be bought on Groww automatically, intraday
(product **MIS**), at **exactly** the number of lots you arm. Off by default.

## 1. Server switches (environment; none can be set from the browser)

| Variable | Value | Purpose |
|---|---|---|
| `EXECUTION_MODE` | `ALGO_LIVE` | live execution mode |
| `LIVE_EXECUTION_ENABLED` | `true` | live orders allowed |
| `LIVE_COMPLIANCE_APPROVED` | `true` | your confirmation the account / API use is approved |
| `LIVE_TRADING_CONFIRMATION` | `true` | your confirmation you accept real-money risk |
| `GROWW_ACCESS_TOKEN` or `GROWW_API_KEY` + `GROWW_API_SECRET` | secrets | Groww Trade API |
| `LIVE_TRADING_PIN` | 6+ characters | needed to arm (and for manual live actions) |
| `LIVE_AUTO_EXECUTION_ENABLED` | `true` | **new**: allows AUTOMATIC live orders |

Limits (refuse, never resize — set them so your chosen lots fit):

| Variable | Default | Note |
|---|---|---|
| `LIVE_MAX_LOTS_PER_ORDER` | 1 | must be ≥ the lots you arm (arming above it is refused) |
| `LIVE_MAX_ORDER_VALUE` | 25000 | lots × lot size × premium must fit |
| `LIVE_MAX_DAILY_LOSS` | 2000 | today's realised loss + open risk + this trade's max loss must fit |
| `LIVE_MAX_TRADES_PER_DAY` | 3 | |
| `LIVE_MAX_OPEN_POSITIONS` | 1 | one live trade at a time |
| `LIVE_MIN_REWARD_RISK` | 2 | after charges; a 1:2 VWAP-EMA plan usually nets below 2 — lower to 1.5 to trade it |
| `LIVE_ENTRY_START` / `LIVE_ENTRY_END` | 09:35 / 14:45 | live entry window (IST) |
| `LIVE_SQUARE_OFF` | 15:15 | every live position is closed by then |

## 2. Daily use

1. Scalper desk header → **Money: Paper | Live** switch → **Live** → pick **Lots**, enter the PIN,
   **Go live** (or: algo page → **Live positions** tab → *Live auto-trading* → **Arm**). **Paper**
   switches new trades back to the paper book (open live trades stay open and managed).
   It is armed for the strategy selected on the page, today only (expires at the end of the IST
   day and on any server restart).
2. Switch **Auto-execute** on for that strategy (or press *Take trade*). Every confirmed setup is
   then sent to Groww instead of the paper book.
3. **Disarm** at any time (no PIN). Open live positions keep being managed.
4. Live positions also show at the top of the **scalper desk's right panel** (red *LIVE · real money*
   cards). Type the trading PIN once in that panel, then **Modify SL / target** or **Exit** a live
   trade. A new stop-loss moves the Groww SL-M order: the old one is cancelled and confirmed first,
   and if Groww refuses the new one the previous stop is put back. A stop you move by hand holds until
   the premium makes a new high; then the trail resumes.

## 3. What each live order does

* LIMIT BUY, MIS, `lots × lot size` from the Groww contract master, at the LTP + a 0.5% buffer.
  Unfilled after 8 s → the remainder is cancelled; a partial fill keeps only the filled lots
  (never more than armed).
* Every live check runs again on a fresh quote: server switches, broker health, entry window,
  contract, lots, freeze quantity, order value, stop/target structure, reward:risk, daily loss,
  trades today, open positions, duplicate contract. Any failure → nothing is placed.
* Stop and target: the strategy's plan (NIFTY Sniper: 0.75× / 2× the **actual fill**). An **SL-M
  stop is placed at Groww** right after the fill; if Groww rejects it the position is closed at once.
* Exits (server monitor, every 2 s): target, stop, trail (breakeven + charges at +1R, then 1R under
  the best premium; the Groww stop is moved up), 15:15 square-off, kill switch → flatten.
  Broker positions are reconciled; a mismatch is flagged, never silently closed.
* Each setup is sent once. Kill switch or SAFE_MODE blocks arming and new orders.

## 4. Not (yet) in live

Partial booking at 1.5× and the sniper's own staged trail run on the paper book only; live uses the
trail above. Test on paper first and start with 1 lot.
