# NIFTY OPTIONS ALGO STRATEGY — V5 (MERGED SPECIFICATION)
### Correlation-Aware Signal Design + Production-Grade Execution Engineering

**Purpose:** Combine the strongest parts of two prior documents —
*v2.2 (signal-design rigor)* and *V4 (production execution rigor)* — into a
single strategy that is both statistically honest and safe to run with real
capital and a real broker connection.

> **Disclaimer:** This is an educational strategy/engineering framework, not
> a guarantee of profit. Options trading carries substantial risk, including
> rapid time decay and total loss of premium. Every threshold below is a
> *starting point* for backtesting — not a validated live-trading parameter.
> Backtest, walk-forward test, and paper-trade before risking real money.

---

## 0. WHAT WAS MERGED, AND WHY

| Kept from v2.2 | Kept from V4 |
|---|---|
| Correlation-aware "clustered" signal scoring (Section 5) | Full order execution / state machine engineering |
| Regime hysteresis (separate enter/exit ADX thresholds) | Data-quality gating (stale-quote rejection) |
| Explicit gap-day handling | OI/PCR multi-strike direction scoring |
| Theta-realistic backtesting as a mandatory gate | VIX percentile-based volatility regime |
| Crowded-trade / edge-decay caution | Position reconciliation, kill switch, SAFE MODE |
| Broker-forced-exit reconciliation logic | Expiry-day gamma protocol |
| | Liquidity scoring, freeze-quantity child orders |

**One factual correction carried into this version:** NSE moved NIFTY 50's
weekly options expiry from **Thursday to Tuesday, effective 1 September
2025**, per a SEBI directive standardizing one weekly-expiry index per
exchange. Neither "Thursday" nor "Tuesday" should ever be hard-coded in
code — always resolve `expiry_date` from the live contract master — but if
a human-readable default is needed for documentation, Tuesday is correct as
of this writing, and NSE has changed this before and may again.

---

## 1. SYSTEM OBJECTIVE

Trade a small number of **high-quality, liquid, statistically validated**
intraday NIFTY directional setups. Do not try to catch every move.

- Primary setup: 15-minute Opening Range Breakout (ORB) → 5-minute retest →
  multi-factor confirmation.
- Instruments: liquid NIFTY weekly/monthly CE/PE options only.
- Default direction: Bullish → CE, Bearish → PE.
- **No trade** when: regime is choppy/uncertain, gap-day rules are
  unresolved, data quality is poor, liquidity is poor, risk limits are
  exhausted, expected reward/risk is insufficient, or volatility is extreme
  without an explicitly backtested exception.

The objective is explicitly **not** "win every trade" or "maximize trade
count." It is: fewer, higher-quality, liquid, statistically validated,
well-risk-controlled, executable trades — sized honestly against
theta-realistic expectancy, not a theoretical spot-implied one.

---

## 2. MARKET DATA REQUIREMENTS

**Underlying:** spot/index LTP, 1m/5m/15m OHLCV, VWAP, EMA20, EMA50,
ADX(14), ATR(14) on 5m, previous day high/low/close, opening range high/low,
India VIX (level + percentile).

**Options:** LTP, bid/ask, bid/ask size, volume, OI, change in OI, IV,
delta, gamma, theta, expiry, strike, CE/PE flag, underlying reference.

**Data-quality gating (mandatory, non-negotiable):**
- Disable signal generation if the market data feed is stale > 1.5s.
- Reject entry if the option quote is stale > 1.5s.
- Reject entry on missing critical fields or large timestamp mismatch.
- On reconnect: synchronize full state (positions, orders, pending signals)
  before re-enabling new entries.
- Existing positions remain under the risk supervisor (Section 15) even
  during a data outage — an outage never means "do nothing," it means "risk
  controls stay active, entries stop."

**Contract specifications — never hard-code:**
Lot size, tick size, freeze quantity, and expiry calendar must always be
pulled from live instrument/exchange metadata. NSE has revised NIFTY
contract specs before (e.g., lot size changes, the 2025 expiry-day shift)
and will again. Anything hard-coded here — including the numbers implied
elsewhere in this document — will eventually be wrong.

---

## 3. TRADING WINDOW

```
09:15  Market open
09:30  Opening Range (ORB) complete
09:35–14:45  New entries permitted
14:45  No fresh entries after this time
15:15  Mandatory square-off
```
All times configurable. Emergency/operational exits must always comply with
current broker and exchange rules regardless of internal timers.

---

## 4. GAP-DAY HANDLING (from v2.2 — V4 had no equivalent)

NIFTY frequently opens outside the previous day's high-low range (global
cues, macro events, budget/election days, index-specific news). Standard
ORB logic behaves unpredictably on these days unless explicitly handled.

```
IF day's open is outside previous day's High-Low range
   by more than a configurable ATR multiple (default 0.5 × ATR14):

   THEN flag GAP DAY:
     1. Widen the opening-range confirmation window
        (default: first 30 minutes instead of 15).
     2. Require the gap to either HOLD (price stays beyond the gap
        boundary) or FILL (price returns inside prior day's range)
        before generating any entry signal. Do not trade the
        ambiguous transition.
     3. Cut position size for the first trade of the day to 50% of
        normally computed size, regardless of signal score, until one
        full confirmed cycle has completed.
```
This does not eliminate gap risk — it prevents mechanically applying
normal-day breakout logic to a structurally different session. Gap-day
trades must be tagged and tracked separately in performance metrics
(Section 19).

---

## 5. MARKET REGIME ENGINE (hysteresis, from v2.2 — sharper than V4's single cutoff)

A single ADX threshold causes regime "flapping" as ADX oscillates around one
number. Use separate enter/exit thresholds:

| Regime | Condition |
|---|---|
| **TRENDING (enter)** | ADX ≥ 22 AND price/EMA alignment consistent with direction |
| **TRENDING (stay in until)** | ADX drops below 16 |
| **RANGE** | ADX < 18 AND repeated VWAP crossings AND opening range intact |
| **CHOP / NO TRADE** | ADX between 16–22 with no clear prior state, OR conflicting timeframe signals, OR abnormal liquidity/spreads, OR unreliable data, OR unresolved gap day |

Bullish structural state (for CE bias): NIFTY > VWAP, EMA20 > EMA50, 15m
trend bullish, regime = TRENDING per the table above.
Bearish structural state: mirror image.

If structure is mixed, reduce signal confidence rather than forcing a
binary call. If the market is clearly range-bound, either reject the trade
or route to a defined-risk range strategy (Section 6C).

---

## 6. SETUPS

### 6A. Opening Range Breakout (primary)
- ORH = highest high, 09:15:00–09:29:59. ORL = lowest low, same window.
- No signal before the OR is complete (or the gap-day-adjusted window,
  Section 4).
- Bullish candidate: a 5m candle closes above ORH.
- Bearish candidate: a 5m candle closes below ORL.
- **Extension filter:** reject if price has already moved beyond a
  configured maximum extension from ORH/ORL before a valid retest.
  Initial parameter: max extension = 0.35% of NIFTY spot OR 1.0×ATR(5m),
  whichever is smaller.

### 6B. Retest Engine
- Bullish: after ORH breakout, price must retest ORH (or defined breakout
  zone) and hold above it; confirmation candle closes bullish.
- Bearish: mirror image, must hold below ORL.
- Retest timeout: max 3 completed 5m candles after breakout. No chasing
  after timeout.
- Failed retest: close back through the level with a VWAP loss →
  invalidate the setup entirely, do not re-attempt the same breakout.

### 6C. Range-Bound Alternative
When regime = RANGE (Section 5), do not force a directional breakout trade.
Route to a defined-risk range strategy (e.g., Iron Condor), subject to the
same volatility and liquidity filters as directional trades (Sections 9,
11). Extreme volatility still overrides this to NO TRADE (Section 9).

### 6D. VWAP Reversal (secondary, optional)
Bullish: NIFTY falls below VWAP → reaches significant support/PDL →
selling pressure rejected (higher low forms) → reclaims VWAP with
volume/price confirmation → CE entry. Bearish is the mirror image using
PDH/resistance. Do not enter simply because price touches support or
resistance — wait for the reclaim/rejection confirmation, and apply the
same theta-realism standard (Section 13) when backtesting this
sub-strategy.

---

## 7. SIGNAL SCORE — CORRELATION-AWARE (v2.2's design, replacing V4's naive additive score)

**Why this replaces V4's version:** V4's 10-point score gives near-separate
points to market regime, 15m trend, and VWAP/EMA alignment — but these three
mostly move together. When NIFTY is genuinely trending, all three fire
simultaneously, which inflates the apparent strength of a signal without
adding real independent information. This version groups correlated
signals into a single cluster and weights genuinely independent evidence
(volume, option relative strength, OI/PCR, IV regime) more heavily.

**Maximum score: 10 points**

**TREND CLUSTER (single combined score — not three/four separate additions):**
| Condition | Points |
|---|---|
| VWAP + EMA20/EMA50 alignment + 15m trend all agree | 3 |
| Partial agreement (2 of 3) | 1 |
| No agreement | 0 |

**STRUCTURE CLUSTER:**
| Condition | Points |
|---|---|
| ORB breakout/breakdown with retest confirmation held | 2 |
| PDH/PDL structure confirmation | 1 |

**INDEPENDENT EVIDENCE (weighted higher — not implied by trend):**
| Condition | Points |
|---|---|
| Volume expansion ≥ 1.5× average of prior 20 candles | 2 |
| Option premium relative strength (ORS, Section 8) confirms direction | 1 |
| OI/PCR Direction Score supportive (Section 10) | 1 |

**IV/VIX regime acceptable (Section 11):** required as a *gate*, not a
scored point — an unacceptable IV/VIX regime forces NO TRADE regardless of
the numeric score (see Section 12).

**Interpretation:**
- 8–10: A+ setup — trade
- 6–7: A setup — consider reduced size
- 4–5: Watchlist, wait for confirmation
- < 4: No trade

**Before trusting any threshold:** measure actual pairwise correlation
between components on historical data. If two components you believed were
independent move together more than expected, merge them into a cluster —
don't count them separately. This entire scoring system, including the
clustering boundaries, must be configurable and backtested, not hard-coded
on faith.

---

## 8. OPTION PREMIUM RELATIVE STRENGTH

Do not select an option purely because NIFTY broke ORH/ORL — confirm the
option is participating.

```
ORS (Option Relative Strength) = |option % change| / |underlying % change|
```
Use ORS as a confirmation input to the score (Section 7), never as a
standalone trigger. Reject when the option premium materially underperforms
the expected directional move, the spread widens abnormally, or the option
price behaves inconsistently with the underlying (possible bad print,
feed issue, or liquidity event).

---

## 9. OI / PCR STRUCTURE ENGINE

Never use absolute PCR alone as a signal.

Track: ATM CE OI, ATM PE OI, ±1 and ±2 strike OI, change in OI, price
change, volume, PCR, PCR change over 5m and 30m, OI concentration, OI
migration.

**OI Direction Score:** +2 strongly bullish, +1 bullish, 0 neutral, −1
bearish, −2 strongly bearish. Example bullish evidence: PE short covering
/ supportive PE OI behavior, and/or CE positioning consistent with upward
continuation. Bearish is the mirror image. Exact classification thresholds
must be backtested, not assumed from a single PCR cutoff.

---

## 10. IV / VIX REGIME

Use both VIX level and VIX percentile/change — not level alone.

| Regime | Percentile | Action |
|---|---|---|
| Low | < 20% | Require stronger breakout/volume confirmation before entry |
| Normal | 20–80% | Standard rules apply |
| High | 80–95% | Reduce position size; widen structural noise allowance; prefer liquid ITM options or defined-risk spreads |
| Extreme | > 95% | Default = NO TRADE unless an exceptional, backtested setup is explicitly enabled |

---

## 11. NO-TRADE ENGINE (hard gate, evaluated after the score)

Reject the trade if **any** of the following is true, regardless of signal
score:

- Score below minimum threshold (default 8/10)
- Regime = CHOP or unresolved gap day (Sections 4, 5)
- Data stale, or any data-quality rule from Section 2 fails
- Option spread above configured limit, or insufficient option volume/OI
- Liquidity score below minimum (Section 14)
- Breakout extension excessive (Section 6A)
- Retest failed or timed out (Section 6B)
- Expected reward/risk < 2.0R
- Daily loss limit reached, or consecutive-loss lock active
- Daily trade limit reached
- Extreme volatility regime without an explicit backtested exception
- Expiry-day restriction triggered (Section 16)
- Broker/API unhealthy, or existing correlated position conflicts
- Orderbook/depth abnormal, or option premium diverges materially from
  the underlying without an IV explanation

---

## 12. OPTION SELECTION ENGINE

Candidate universe: actual valid contracts from the live contract master,
correct expiry, correct CE/PE direction, adequate OI and volume, acceptable
spread.

Primary preference: ATM or slightly ITM/near-ATM liquid option with strong
delta and a premium response that tracks the underlying (Section 8). Use
delta, gamma, theta, and IV as selection inputs, not just strike distance.

Avoid: far OTM options bought simply because they're cheap, wide bid/ask,
low OI, low trade frequency, unstable quotes.

Do not hard-code a single strike-selection rule (e.g., "always ATM") unless
backtesting proves it superior to alternatives across regimes.

---

## 13. THETA-REALISTIC BACKTESTING (mandatory gate, from v2.2)

Buying ATM/near-ATM options intraday means paying time decay on every
trade, win or lose. A backtest that derives option P&L from the
underlying's move via a theoretical pricing model (e.g., Black-Scholes off
historical spot) will systematically overstate edge, because it ignores:

- Actual bid/ask spread at entry/exit — especially during the breakout
  candle itself, when spreads often widen.
- IV changes independent of the directional move (IV crush after a move
  that fails to continue).
- Partial fills and slippage at position open/close.

**Before this strategy is trusted with live capital:**
1. Backtest using actual historical option chain bid/ask data for the
   relevant strikes and expiries — never synthesized prices.
2. Report theta-adjusted expectancy separately from spot-move-implied
   expectancy, and explicitly flag the gap between them.
3. If theta-realistic expectancy is materially worse than the
   spot-implied version, treat the spot-implied number as unreliable —
   do not use it to size conviction or position sizing.

---

## 14. LIQUIDITY SCORE

| Score | Meaning |
|---|---|
| 0 | Unacceptable |
| 1 | Poor |
| 2 | Acceptable |
| 3 | Excellent |

Inputs: spread %, volume, OI, quote depth, trade frequency, LTP stability.
**Minimum liquidity score to trade: 2.**

---

## 15. RISK MODEL

**Position sizing:**
- Default risk per trade: 0.5% of strategy capital.
- Maximum normal risk: 0.75%.
- Exceptional upper bound: 1.0%, only if explicitly enabled and fully
  backtested — never as a default.
- Scale down for: high VIX, expiry day, wide spreads, poor liquidity, weak
  signal score, recent drawdown.

```
Effective risk per lot = option stop-loss loss + expected slippage
                         + spread cost + transaction costs

Lots = floor(risk_budget / effective_risk_per_lot)
```
Always round to a valid lot size and respect exchange freeze-quantity
constraints — pulled live, never hard-coded (Section 2).

**Structural stop-loss (not a premium percentage as the primary stop):**
- Bullish: below retest low / breakout structure, minus an ATR buffer
  (default 0.15–0.25 × ATR(5m), configurable).
- Bearish: mirror image.
- A premium-loss stop (default: exit if option loses >25% from entry) may
  exist as a **last-resort circuit breaker** alongside structural
  reasons like abnormal spread widening or an unexplained divergence
  from the underlying — but it must never replace the structural stop as
  the primary invalidation logic.

**Target model:**
- Minimum initial expected RR: 2.0R.
- Derive targets from OR width, ATR, PDH/PDL, VWAP, market structure, and
  liquidity zones — never force a 2R target if a major structural level
  makes it unrealistic.

**Trailing / partial exit:**
```
+1R   → move stop to breakeven (after transaction-cost allowance)
+1.5R → activate trailing logic
+2R   → optional partial exit, 25–50% of position
remainder → trail using prior 5m structure + ATR buffer
Never loosen a stop once set.
```

---

## 16. EXPIRY-DAY GAMMA PROTOCOL

```
is_expiry_day = current_date == contract.expiry_date   (never assume a weekday — read the contract master)
```
On expiry day:
- Increase required signal quality (raise minimum score).
- Reduce risk allocation.
- Avoid far-OTM contracts; reject wide spreads.
- Require strong premium confirmation (Section 8).
- Prefer ITM/near-ATM or defined-risk structures depending on liquidity/IV.
- Apply stricter time cutoffs for new entries.

---

## 17. POSITION MANAGEMENT

- Maximum concurrent NIFTY directional position: **1**.
- No averaging down, no martingale, no adding to a losing position.
- If an opposite signal appears mid-position, do not auto-reverse unless a
  separate reverse-entry validation explicitly passes.
- **Broker-forced exits** (margin call, SPAN shortfall, RMS square-off) are
  a distinct, explicitly logged event (`BROKER_FORCED_EXIT`) — never
  silently absorbed into normal reconciliation:
  1. On detection, immediately halt new signal generation for the rest of
     the session pending manual review — it usually indicates a
     recurring margin/capital problem.
  2. Never auto-re-enter to "correct" a broker-forced exit.

---

## 18. DAILY RISK CONTROLS

- Maximum daily loss: 2.0% of strategy capital.
- Maximum trades per day: 3.
- Maximum consecutive losses: 2.
- After loss #1: cooldown, minimum 15 minutes.
- After loss #2: disable new entries for the rest of the day.
- Daily profit protection: if daily P&L ≥ +1.5R, reduce subsequent risk; at
  a configured profit-lock level, stop trading for the day.
- All values configurable. **STOP TRADING FOR THE DAY** once the daily
  loss limit is hit — never increase size to "recover" a loss.

---

## 19. ORDER EXECUTION ENGINE

Never use unrestricted market orders for normal entry.

- Buy: reference = best ask; submit a marketable limit with a strict
  maximum-slippage cap.
- Sell: reference = best bid; same discipline.
- Do **not** use "LTP + 1.5× spread" as an unrestricted pricing formula.
- Order timeout: 3 seconds (initial value). If unfilled: cancel, refresh
  quote, revalidate the signal, recalculate spread/slippage, then either
  reprice within limits or abandon the trade.
- If the underlying signal becomes invalid before fill: cancel immediately.

**Order state machine:**
```
NEW → VALIDATING → SUBMITTED → ACKNOWLEDGED → PARTIALLY_FILLED → FILLED
   → EXIT_PENDING → EXIT_SUBMITTED → EXIT_FILLED → RECONCILED
```
Any unexpected broker state → enter SAFE MODE, reconcile broker positions
before allowing any new entry. Every order carries a unique client
reference ID.

**Freeze quantity:** if requested quantity exceeds the exchange freeze
limit, split into child orders, each carrying `parent_trade_id`,
`child_sequence`, and a unique broker reference. Verify aggregate filled
quantity after all child fills complete.

**Position reconciliation:** reconcile at least every 1 second while a
position is active — expected position vs. broker position vs. filled
quantity vs. average price vs. pending orders. On mismatch: stop new
entries, resolve state, keep the risk supervisor active throughout.

**Emergency risk supervisor** — immediate exit when: the underlying
invalidates the setup, a broker forced-exit condition fires, severe API
failure occurs, market data goes stale beyond the safe limit, an
unexpected position mismatch appears, the daily loss limit is exceeded, or
the manual kill switch is activated.

**Kill switch:** cancel all pending entry orders, exit active positions via
the safe execution procedure, disable new entries until a manual reset.

---

## 20. CROWDED-TRADE / EDGE-DECAY CAUTION (from v2.2)

ORB + VWAP + volume confirmation is one of the most commonly automated
NIFTY intraday setups. This doesn't make it worthless, but it does mean:

1. Backtested Sharpe/expectancy on 1–2 years of history should be
   *expected* to shrink in live/forward-tested performance — budget for
   this, don't be surprised by it.
2. Use out-of-sample and walk-forward testing (Section 21) as the primary
   gate for going live, not in-sample backtest metrics.
3. Build a live-vs-backtest tracking dashboard from day one of paper
   trading, so edge decay is caught in weeks, not discovered after months
   of losses.
4. Treat the daily/weekly loss limits (Section 18) as required
   infrastructure — they are the mechanism that caps the cost of
   discovering the edge has decayed.

---

## 21. BACKTESTING REQUIREMENTS

Backtest using tick or realistic 1m/5m data including:
- Actual historical option contracts, historical expiry calendar,
  historical OI, historical IV where available.
- Realistic bid/ask spread, slippage, brokerage/taxes, latency, rejected
  orders, partial fills.
- Avoid look-ahead bias — never use today's option chain structure to
  reconstruct historical trades.

**Required validation:** in-sample, out-of-sample, walk-forward, Monte
Carlo trade reshuffling, parameter sensitivity, across different
volatility regimes, expiry/non-expiry days, gap-up/gap-down sessions, and
trend/range sessions separately.

---

## 22. PERFORMANCE METRICS & TRADE JOURNAL

**Track:** total trades, win rate, average win/loss, profit factor,
expectancy per trade, max drawdown, recovery factor, Sharpe/Sortino where
meaningful, avg R/trade, avg holding time, slippage, fill rate, rejection
rate, signal-to-fill delay. Break down P&L by: score, VIX regime,
expiry/non-expiry, option delta bucket, time-of-day, and gap-day vs.
normal-day. Track theta-realistic expectancy vs. spot-implied expectancy
explicitly (Section 13), and live-vs-backtest divergence on a rolling
basis (Section 20). Count broker-forced exits and gap-day trades
separately from normal trades.

**Every trade record must store:** timestamp, regime, ORH/ORL, breakout
candle, retest candle, signal score (with cluster breakdown), OI score,
PCR, VIX regime, selected contract/strike/expiry, delta/gamma/theta/IV,
entry LTP/bid-ask/order price/fill price, slippage, quantity, stop,
target, exit reason, exit price, P&L, R multiple, and broker order IDs.

---

## 23. STRATEGIES PROHIBITED (both source docs agreed on this — kept as-is)

- Martingale, or averaging losing option positions
- Revenge trading, or unlimited trades per day
- Uncontrolled naked option selling
- Buying far-OTM options simply because they're cheap
- Entering on a single indicator (PCR alone, RSI alone, one crossover)
- Holding losing positions hoping for recovery
- Increasing size after a loss
- Auto-re-entering after a broker-forced exit
- Treating in-sample backtest expectancy as a live-performance guarantee

---

## 24. PRODUCTION SAFETY & ACCEPTANCE CRITERIA

**Deployment path (do not skip steps):**
```
1. Backtest → 2. Walk-forward → 3. Paper trading
→ 4. Small capital → 5. Controlled live rollout
→ 6. Full risk only after stable live statistics
```
Never enable live order placement solely because a backtest is profitable.

**Accepted only when:**
- Every signal condition and every rejection condition is machine-testable.
- Contract expiry, option selection, risk sizing, and SL/target are all
  deterministic (no hidden manual overrides).
- Order retry behavior is deterministic; broker reconciliation and kill
  switch are implemented and tested.
- Historical backtest can reproduce every trade; paper trading produces
  the same decisions as the backtest engine given identical data.
- All live trades have complete audit records.

---

## 25. FULL PIPELINE

```
NIFTY LIVE DATA
      |
      v
DATA-QUALITY GATE (Sec 2)
      |
      v
GAP-DAY CHECK (Sec 4)
      |
      v
MARKET REGIME (hysteresis, Sec 5)
      |
      +------------------+------------------+
      |                  |                  |
      v                  v                  v
   BULLISH            BEARISH            RANGE
   ORB SETUP          ORB SETUP        (Sec 6C, defined-risk)
      |                  |                  |
      +---------+--------+------------------+
                |
                v
   RETEST ENGINE (Sec 6B) --fail--> NO TRADE
                |
              hold
                v
  CLUSTERED SIGNAL SCORE (Sec 7)
  + Option Relative Strength (Sec 8)
  + OI/PCR Direction Score (Sec 9)
  + IV/VIX Regime Gate (Sec 10)
                |
                v
        NO-TRADE ENGINE (Sec 11) --any true--> NO TRADE
                |
               pass
                v
   OPTION SELECTION + LIQUIDITY SCORE (Sec 12, 14)
                |
                v
          RISK ENGINE (Sec 15)
                |
                v
       ORDER EXECUTION ENGINE (Sec 19)
                |
                v
   STRUCTURAL STOP + OPTION EMERGENCY STOP (Sec 15)
                |
                v
      TARGET / TRAILING / PARTIAL EXIT (Sec 15)
                |
                v
   BROKER-FORCED-EXIT / RECONCILIATION CHECK (Sec 17, 19)
                |
                v
                EXIT
                |
                v
           TRADE JOURNAL (Sec 22)
                |
                v
  LIVE-VS-BACKTEST + EDGE-DECAY TRACKING (Sec 20)
```

---

## 26. FINAL PHILOSOPHY

The objective is not to find a strategy that wins every trade, or to
maximize trade count. The objective is:

> Trade only when the probability and expected reward justify the risk —
> measured against realistic option pricing and execution costs, not a
> theoretical model — using genuinely independent confirmations rather
> than correlated indicators counted as if they were separate evidence.
> Control the downside mechanically when the market proves the thesis
> wrong, engineer the execution layer so a broker glitch or a stale quote
> can't turn a small loss into a large one, and detect quickly if the
> edge itself has decayed rather than assuming a good backtest stays
> good forever.

This framework should be validated on historical NIFTY data using
realistic option pricing, paper-traded with live-vs-backtest tracking, and
only then considered for live capital — starting at the minimum configured
risk level and earning its way up through the deployment path in
Section 24.
