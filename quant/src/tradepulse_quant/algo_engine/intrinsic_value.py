"""Intrinsic-value OTM strategy for NIFTY, BANKNIFTY and SENSEX option buying.

The trade is read in four steps, each one fail-closed:

1. Sentiment. The Index Sentiment Analyser score (-100..+100) must be extreme. The index score
   is a weight-averaged blend of ~50 constituents, so it rarely leaves -40..+40; the default
   cut-off is the analyser's own Greed/Fear zone edge (15), and ``EXTREME_PRESETS`` offers
   stricter ones. The direction is then taken from
   ``SENTIMENT_MAPPINGS``. The default mapping is CONTRARIAN, exactly as specified: a very
   positive index sentiment buys a PE, a very negative one buys a CE. Pass ``FOLLOW`` to
   trade with the sentiment instead.
2. Key value. The nearest significant price level in the trade direction (previous-day
   high/low/close, opening range, session extremes, VWAP, the option-writer OI wall and the
   round number), clustered so coinciding levels count as one stronger level.
3. Strike. Among OTM strikes that lie between spot and the key value, pick the one with the
   highest chance of turning ITM: the market's own odds (|delta|) lifted by sentiment
   conviction, keeping only strikes whose intrinsic value at the key value is a meaningful
   gain on today's premium.
4. Premium trigger. On the selected premium's own 5-minute candles: an impulse up, an orderly
   pullback (20-70% retrace that holds the impulse low), then a continuation candle. Entry is
   the continuation close, the stop sits under the pullback low, the target is the premium
   expected at the key value (intrinsic + residual time value), and the stop trails by the
   initial risk (breakeven at +1R).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, datetime
from typing import Protocol

STRATEGY_ID = "INTRINSIC_VALUE"

# Sentiment bias -> option to BUY. The user's rule is contrarian (extreme optimism is faded
# with a PE, extreme pessimism with a CE). Flip a trade to trend-following with "FOLLOW".
SENTIMENT_MAPPINGS: dict[str, dict[str, str]] = {
    "CONTRARIAN": {"BULLISH": "PE", "BEARISH": "CE"},
    "FOLLOW": {"BULLISH": "CE", "BEARISH": "PE"},
}
DEFAULT_MAPPING = "CONTRARIAN"

# Sentiment cut-offs the user can pick. ACTIVE is the analyser's Greed/Fear zone edge; STRICT is
# its STRONG_* label, which a constituent-weighted index score reaches only a few days a year.
EXTREME_PRESETS: dict[str, float] = {"ACTIVE": 15.0, "BALANCED": 25.0, "STRICT": 40.0}
DEFAULT_EXTREME = "ACTIVE"

STRIKE_STEP = {"NIFTY": 50.0, "BANKNIFTY": 100.0, "SENSEX": 100.0}
ROUND_STEP = {"NIFTY": 100.0, "BANKNIFTY": 500.0, "SENSEX": 500.0}


class CandleLike(Protocol):
    timestamp: str
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass(frozen=True)
class IntrinsicConfig:
    extreme_score: float = EXTREME_PRESETS[DEFAULT_EXTREME]
    sentiment_max_age_minutes: float = 45.0
    key_reach_daily_atr: float = 1.0  # a key value further than this many daily ATRs is out of reach
    key_cluster_pct: float = 0.0012  # levels within 0.12% of each other are one key value
    min_premium: float = 5.0
    min_delta: float = 0.12  # far-OTM lottery strikes are never selected
    sentiment_lift: float = 0.30  # sentiment conviction can add up to 30% of the remaining odds
    min_value_gain: float = 0.5  # premium expected at the key value must be >= 1.5x today's
    residual_time_value: float = 0.5  # share of today's premium assumed left at the key value
    impulse_lookback: int = 12
    impulse_min_pct: float = 8.0
    pullback_min: float = 0.20
    pullback_max: float = 0.70
    pullback_max_bars: int = 6
    max_chase_pct: float = 0.02  # continuation close may sit at most 2% above the impulse high
    stop_buffer_pct: float = 0.02
    max_stop_pct: float = 0.35
    min_rr: float = 2.0
    minimum_score: float = 5.0
    maximum_score: float = 10.0


def normalize_mapping(value: object) -> str:
    text = str(value or "").upper()
    return text if text in SENTIMENT_MAPPINGS else DEFAULT_MAPPING


def config_for(extreme: object) -> IntrinsicConfig:
    """A preset name (ACTIVE/BALANCED/STRICT) or a number 10..60 sets the sentiment cut-off."""
    text = str(extreme or "").upper()
    if text in EXTREME_PRESETS:
        return IntrinsicConfig(extreme_score=EXTREME_PRESETS[text])
    try:
        value = float(text)
    except ValueError:
        return IntrinsicConfig()
    return IntrinsicConfig(extreme_score=min(60.0, max(10.0, value))) if math.isfinite(value) else IntrinsicConfig()


def _parse(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _session_of(candles: list[CandleLike]) -> tuple[list[CandleLike], list[CandleLike]]:
    dated = [(stamp.date(), candle) for candle in candles if (stamp := _parse(candle.timestamp)) is not None]
    if not dated:
        return [], []
    today = dated[-1][0]
    previous_days = sorted({day for day, _ in dated if day < today})
    session = [candle for day, candle in dated if day == today]
    previous = [candle for day, candle in dated if previous_days and day == previous_days[-1]]
    return session, previous


def _normal_cdf(value: float) -> float:
    return 0.5 * (1.0 + math.erf(value / math.sqrt(2.0)))


def _round(value: float | None, digits: int = 2) -> float | None:
    return None if value is None else round(float(value), digits)


def _tick(value: float, tick: float = 0.05) -> float:
    return round(round(value / tick) * tick, 2)


# ---- 1. sentiment ---------------------------------------------------------------------

def read_sentiment(reading: dict | None, mapping: str, config: IntrinsicConfig, now: datetime) -> dict:
    """Direction from the index sentiment score. ``option_type`` is None unless it is extreme."""
    reading = reading or {}
    score = reading.get("score")
    out = {"score": score, "label": reading.get("label"), "zone": reading.get("zone"), "mapping": mapping,
           "threshold": config.extreme_score, "generated_at": reading.get("generated_at"),
           "age_minutes": None, "bias": None, "option_type": None, "side": None, "conviction": 0.0, "ok": False}
    if not isinstance(score, (int, float)):
        return {**out, "reason": "Index sentiment is unavailable for this index; the strategy will not guess a direction"}
    generated = _parse(str(reading.get("generated_at") or ""))
    if generated is not None and generated.tzinfo is not None:
        age = (now - generated).total_seconds() / 60.0
        out["age_minutes"] = round(age, 1)
        if age > config.sentiment_max_age_minutes:
            return {**out, "reason": f"Index sentiment is {age:.0f} min old (max {config.sentiment_max_age_minutes:.0f}); waiting for a fresh scan"}
    bias = "BULLISH" if score > 0 else "BEARISH"
    option_type = SENTIMENT_MAPPINGS[mapping][bias]
    if abs(score) < config.extreme_score:
        # Not tradable yet, but the side it leans to is known: the strategy shows the strike it
        # would buy so the setup is ready the moment sentiment crosses the cut-off.
        lean = option_type if score != 0 else None
        return {**out, "lean_option_type": lean, "reason": f"Sentiment {score:+.1f} is not extreme yet (needs {config.extreme_score:+.0f} or {-config.extreme_score:+.0f})" + (f"; watching the {lean} it leans to" if lean else "")}
    side = "BUY" if option_type == "CE" else "SELL"
    conviction = min(1.0, abs(score) / 100.0)
    rule = "contrarian: fade the crowd" if mapping == "CONTRARIAN" else "follow the sentiment"
    return {**out, "ok": True, "bias": bias, "option_type": option_type, "side": side, "conviction": round(conviction, 3),
            "reason": f"Sentiment {score:+.0f} is very {'positive' if bias == 'BULLISH' else 'negative'} -> buy {option_type} ({rule})"}


# ---- 2. key value ---------------------------------------------------------------------

def key_levels(symbol: str, spot: float, candles: list[CandleLike], chain: list[dict], option_type: str) -> list[dict]:
    """Candidate key values strictly beyond spot in the trade direction."""
    session, previous = _session_of(candles)
    levels: list[tuple[str, float]] = []
    if previous:
        levels += [("PDH", max(c.high for c in previous)), ("PDL", min(c.low for c in previous)), ("PDC", previous[-1].close)]
    if session:
        levels += [("Day high", max(c.high for c in session)), ("Day low", min(c.low for c in session))]
        opening = session[:3]
        levels += [("OR high", max(c.high for c in opening)), ("OR low", min(c.low for c in opening))]
        weights = [c.volume if c.volume > 0 else 1.0 for c in session]
        levels.append(("VWAP", sum((c.high + c.low + c.close) / 3.0 * w for c, w in zip(session, weights)) / sum(weights)))
    # Option writers defend their biggest strike: the call OI wall caps a rally, the put OI wall
    # floors a fall. That is where the move is expected to stall, so it is a key value.
    wall_type = "CALL" if option_type == "CE" else "PUT"
    walls = [row for row in chain if row.get("contract") == wall_type and ((row["strike"] > spot) if option_type == "CE" else (row["strike"] < spot))]
    if walls:
        wall = max(walls, key=lambda row: float(row.get("openInterest") or 0))
        if float(wall.get("openInterest") or 0) > 0:
            levels.append((f"{'Call' if option_type == 'CE' else 'Put'} OI wall", float(wall["strike"])))
    step = ROUND_STEP.get(symbol, 100.0)
    levels.append(("Round number", (math.floor(spot / step) + 1) * step if option_type == "CE" else (math.ceil(spot / step) - 1) * step))
    beyond = [(name, price) for name, price in levels if (price > spot if option_type == "CE" else price < spot)]
    return [{"name": name, "price": round(price, 2), "distance": round(abs(price - spot), 2)} for name, price in sorted(beyond, key=lambda item: abs(item[1] - spot))]


def key_values(levels: list[dict], spot: float, first_otm: float | None, reach: float | None, option_type: str, config: IntrinsicConfig) -> list[dict]:
    """Level clusters beyond the first OTM strike and within reach, nearest first."""
    if first_otm is None:
        return []
    tolerance = spot * config.key_cluster_pct
    clusters: list[list[dict]] = []
    for level in levels:
        if clusters and abs(level["price"] - clusters[-1][-1]["price"]) <= tolerance:
            clusters[-1].append(level)
        else:
            clusters.append([level])
    found = []
    for cluster in clusters:
        # The cluster edge nearest spot is the conservative key value.
        price = min(l["price"] for l in cluster) if option_type == "CE" else max(l["price"] for l in cluster)
        beyond_strike = price > first_otm if option_type == "CE" else price < first_otm
        if not beyond_strike:
            continue
        if reach is not None and abs(price - spot) > reach:
            break
        found.append({"price": round(price, 2), "distance": round(abs(price - spot), 2), "sources": [l["name"] for l in cluster], "strength": len(cluster)})
    return found


# ---- 3. strike ------------------------------------------------------------------------

def _years_to_expiry(expiry: object, now: datetime) -> float | None:
    try:
        day = date.fromisoformat(str(expiry)[:10])
    except ValueError:
        return None
    close = datetime(day.year, day.month, day.day, 15, 30, tzinfo=now.tzinfo)
    return max((close - now).total_seconds(), 1800.0) / (365.0 * 86400.0)


def market_itm_odds(row: dict, spot: float, option_type: str, now: datetime) -> float | None:
    """|delta| is the market's own ITM odds; without Greeks fall back to a lognormal estimate."""
    delta = abs(float(row.get("delta") or 0))
    if 0 < delta < 1:
        return delta
    iv = float(row.get("iv") or 0) / 100.0
    years = _years_to_expiry(row.get("expiry"), now)
    if iv <= 0 or years is None or spot <= 0:
        return None
    d2 = (math.log(spot / float(row["strike"])) - 0.5 * iv * iv * years) / (iv * math.sqrt(years))
    return _normal_cdf(d2) if option_type == "CE" else _normal_cdf(-d2)


def liquidity_score(row: dict, config: IntrinsicConfig) -> int:
    """0-3: premium above the floor, open interest present, traded today."""
    return int(float(row.get("premium") or 0) >= config.min_premium) + int(float(row.get("openInterest") or 0) > 0) + int(float(row.get("volume") or 0) > 0)


def rank_strikes(chain: list[dict], spot: float, key: dict, option_type: str, conviction: float, now: datetime, config: IntrinsicConfig) -> list[dict]:
    wanted = "CALL" if option_type == "CE" else "PUT"
    rows = []
    for row in chain:
        strike = float(row.get("strike") or 0)
        premium = float(row.get("premium") or 0)
        if row.get("contract") != wanted or premium <= 0:
            continue
        otm = strike > spot if option_type == "CE" else strike < spot
        inside = strike < key["price"] if option_type == "CE" else strike > key["price"]
        if not (otm and inside):
            continue
        odds = market_itm_odds(row, spot, option_type, now)
        if odds is None or odds < config.min_delta:
            continue
        intrinsic_at_key = abs(key["price"] - strike)
        premium_at_key = intrinsic_at_key + config.residual_time_value * premium
        value_gain = premium_at_key / premium - 1.0
        chance = odds + (1.0 - odds) * config.sentiment_lift * conviction
        rows.append({
            "symbol": row.get("symbol"), "strike": strike, "type": option_type, "expiry": row.get("expiry"), "premium": premium,
            "delta": row.get("delta"), "iv": row.get("iv"), "open_interest": row.get("openInterest"), "volume": row.get("volume"),
            "lot_size": row.get("lotSize"), "tick_size": row.get("tickSize"), "freeze_quantity": row.get("freezeQuantity"),
            "distance": round(abs(strike - spot), 2), "market_odds": round(odds, 3), "itm_chance": round(chance, 3),
            "intrinsic_at_key": round(intrinsic_at_key, 2), "premium_at_key": round(premium_at_key, 2), "value_gain": round(value_gain, 3),
            "liquidity_score": liquidity_score(row, config),
            "eligible": value_gain >= config.min_value_gain and liquidity_score(row, config) >= 2,
        })
    return sorted(rows, key=lambda item: (not item["eligible"], -item["itm_chance"], -item["value_gain"]))


# ---- 4. premium trigger ---------------------------------------------------------------

def premium_trigger(candles: list[CandleLike], config: IntrinsicConfig) -> dict:
    """Impulse -> orderly pullback -> continuation on the option's own premium candles."""
    session, _ = _session_of(candles)
    bars = session[-(config.impulse_lookback + config.pullback_max_bars):]
    if len(bars) < 5:
        return {"status": "WAIT_FOR_DATA", "reason": f"Only {len(bars)} premium candles today; need 5"}
    last, prior = bars[-1], bars[-2]
    # Impulse high: the highest high before the latest candle, with a lower low earlier.
    high_index = max(range(len(bars) - 1), key=lambda i: bars[i].high)
    if high_index == 0:
        return {"status": "NO_IMPULSE", "reason": "Premium has not made an impulse higher yet"}
    impulse_high = bars[high_index].high
    low_index = min(range(high_index), key=lambda i: bars[i].low)
    impulse_low = bars[low_index].low
    impulse = impulse_high - impulse_low
    base = {"impulse_low": _round(impulse_low), "impulse_high": _round(impulse_high)}
    if impulse_low <= 0 or impulse / impulse_low * 100.0 < config.impulse_min_pct:
        return {**base, "status": "NO_IMPULSE", "reason": f"Premium impulse {impulse / max(impulse_low, 0.05) * 100:.1f}% is below {config.impulse_min_pct:.0f}%"}
    after = bars[high_index + 1:]
    pullback_low = min(c.low for c in after)
    retrace = (impulse_high - pullback_low) / impulse
    base.update({"pullback_low": _round(pullback_low), "retrace": round(retrace, 3), "pullback_bars": len(after)})
    if pullback_low <= impulse_low:
        return {**base, "status": "PULLBACK_TOO_DEEP", "reason": "Pullback broke the impulse low; the premium move failed"}
    if retrace > config.pullback_max:
        return {**base, "status": "PULLBACK_TOO_DEEP", "reason": f"Pullback retraced {retrace:.0%} of the impulse (max {config.pullback_max:.0%})"}
    if len(after) > config.pullback_max_bars:
        return {**base, "status": "PULLBACK_STALE", "reason": f"Pullback has run {len(after)} candles (max {config.pullback_max_bars}); momentum is gone"}
    if retrace < config.pullback_min:
        return {**base, "status": "WAIT_FOR_PULLBACK", "reason": f"Premium is still extended ({retrace:.0%} retrace); waiting for a pullback of at least {config.pullback_min:.0%}"}
    continuation = last.close > last.open and last.close > prior.high
    if not continuation:
        return {**base, "status": "WAIT_FOR_CONTINUATION", "reason": f"Pullback of {retrace:.0%} is in place; waiting for a candle that closes above the prior candle high"}
    if last.close > impulse_high * (1 + config.max_chase_pct):
        return {**base, "status": "EXTENDED", "reason": "Continuation already ran past the impulse high; not chasing"}
    entry = last.close
    stop = pullback_low * (1 - config.stop_buffer_pct)
    return {**base, "status": "CONFIRMED", "entry": _round(entry), "stop": _round(stop), "time": last.timestamp,
            "reason": f"Premium pulled back {retrace:.0%} and resumed: continuation close {entry:.2f} above {prior.high:.2f}"}


# ---- strategy -------------------------------------------------------------------------

def select_strike(symbol: str, spot: float, candles: list[CandleLike], chain: list[dict], option_type: str, conviction: float, now: datetime, daily_atr: float | None, config: IntrinsicConfig, calc: dict) -> str | None:
    """Fill ``calc`` with the key value and the OTM strike; returns the reason when none qualifies."""
    strikes = sorted({float(row["strike"]) for row in chain})
    otm = [s for s in strikes if s > spot] if option_type == "CE" else sorted([s for s in strikes if s < spot], reverse=True)
    first_otm = otm[0] if otm else None
    reach = daily_atr * config.key_reach_daily_atr if daily_atr else None
    levels = key_levels(symbol, spot, candles, chain, option_type)
    calc["levels"] = levels[:8]
    keys = key_values(levels, spot, first_otm, reach, option_type, config)
    calc["reach"] = _round(reach)
    if not keys:
        why = f"within {reach:.0f} pts (1 daily ATR)" if reach else "on the chart"
        return f"No key value {why} {'above' if option_type == 'CE' else 'below'} the first OTM strike {first_otm:g}; an OTM premium has no level to gain intrinsic value towards" if first_otm else "No OTM strike in the chain"
    # The nearest key value that leaves room for a meaningful intrinsic gain on a liquid strike.
    key, candidates, pick = keys[0], [], None
    for level in keys:
        ranked = rank_strikes(chain, spot, level, option_type, conviction, now, config)
        best = next((row for row in ranked if row["eligible"]), None)
        if best is not None:
            key, candidates, pick = level, ranked, best
            break
        if not candidates:
            candidates = ranked
    calc["key_value"] = key
    calc["candidates"] = candidates[:5]
    if pick is None:
        return f"No liquid OTM {option_type} between spot {spot:.0f} and a key value (nearest {key['price']:.0f}) offers a {config.min_value_gain:.0%} intrinsic gain on its premium"
    calc["selected"] = pick
    return None


def analyze_intrinsic(symbol: str, candles: list[CandleLike], context: dict, now: datetime, daily_atr: float | None, config: IntrinsicConfig | None = None) -> dict:
    config = config or IntrinsicConfig()
    mapping = normalize_mapping(context.get("sentiment_mapping"))
    chain = [row for row in (context.get("option_chain") or {}).get("contracts", []) if isinstance(row, dict) and row.get("strike") is not None]
    spot = float((context.get("option_chain") or {}).get("spot") or 0) or (candles[-1].close if candles else 0.0)
    sentiment = read_sentiment(context.get("index_sentiment"), mapping, config, now)
    calc: dict = {"mapping": mapping, "sentiment": sentiment, "spot": _round(spot), "key_value": None, "levels": [], "candidates": [], "selected": None, "premium": None, "plan": None, "watch": False}
    base = {"symbol": symbol, "strategy": STRATEGY_ID, "confidence": 0, "setup": None, "side": sentiment.get("side"), "intrinsic": calc}
    if not sentiment["ok"]:
        lean = sentiment.get("lean_option_type")
        if lean and spot > 0 and chain:
            # Watch mode: the strike is shown, but nothing downstream (premium, gates) is armed.
            calc["watch"] = True
            select_strike(symbol, spot, candles, chain, lean, min(1.0, abs(float(sentiment["score"])) / 100.0), now, daily_atr, config, calc)
        return {**base, "decision": "NO_TRADE", "reason": sentiment["reason"]}
    option_type = sentiment["option_type"]
    if spot <= 0 or not chain:
        return {**base, "decision": "NO_TRADE", "reason": "Option chain is unavailable; cannot pick an OTM strike"}
    why_not = select_strike(symbol, spot, candles, chain, option_type, sentiment["conviction"], now, daily_atr, config, calc)
    if why_not:
        return {**base, "decision": "NO_TRADE", "reason": why_not}
    pick, key = calc["selected"], calc["key_value"]

    premium_rows = context.get("premium_candles") or {}
    if premium_rows.get("symbol") != pick["symbol"]:
        return {**base, "decision": "WAIT_FOR_CONFIRMATION", "needs_premium_candles": pick["symbol"], "reason": f"Selected {pick['symbol']}; premium candles are not loaded yet"}
    trigger = premium_trigger(premium_rows.get("candles") or [], config)
    calc["premium"] = trigger
    if trigger["status"] != "CONFIRMED":
        decision = "NO_TRADE" if trigger["status"] in {"PULLBACK_TOO_DEEP", "PULLBACK_STALE", "EXTENDED"} else "WAIT_FOR_CONFIRMATION"
        return {**base, "decision": decision, "reason": f"{pick['symbol']}: {trigger['reason']}"}

    entry, stop = trigger["entry"], trigger["stop"]
    risk = entry - stop
    if risk <= 0:
        return {**base, "decision": "NO_TRADE", "reason": "Stop is not below the entry premium"}
    if risk / entry > config.max_stop_pct:
        return {**base, "decision": "NO_TRADE", "reason": f"Pullback stop is {risk / entry:.0%} of the premium (max {config.max_stop_pct:.0%}); too wide for an option buy"}
    target = pick["intrinsic_at_key"] + config.residual_time_value * entry
    rr = (target - entry) / risk
    tick = float(pick.get("tick_size") or 0.05) or 0.05
    plan = {
        "entry": _tick(entry, tick), "stop_loss": _tick(stop, tick), "target": _tick(target, tick), "risk_reward": round(rr, 2),
        "trailing_distance": _tick(risk, tick), "breakeven_at": _tick(entry + risk, tick),
        "trailing_rule": f"Trail the stop {risk:.2f} under the highest premium; it reaches breakeven at {entry + risk:.2f} (+1R)",
    }
    calc["plan"] = plan
    if rr < config.min_rr:
        return {**base, "decision": "NO_TRADE", "reason": f"Only {rr:.2f}R from entry {entry:.2f} to the key-value premium {target:.2f}; minimum {config.min_rr:.0f}R"}
    return {**base, "decision": "CONFIRMED", "confidence": 100,
            "reason": f"{sentiment['reason']}; key value {key['price']:.0f} ({', '.join(key['sources'])}); {pick['symbol']} {pick['itm_chance']:.0%} ITM chance; {trigger['reason']}",
            "setup": {
                "side": sentiment["side"], "instrument": "OPTION_PREMIUM", "entry": plan["entry"], "stop_loss": plan["stop_loss"], "target": plan["target"],
                "risk_reward": plan["risk_reward"], "trailing_distance": plan["trailing_distance"], "breakeven_at": plan["breakeven_at"],
                "contract": {"symbol": pick["symbol"], "type": option_type, "strike": pick["strike"], "expiry": pick["expiry"], "lot_size": pick["lot_size"], "tick_size": pick["tick_size"], "freeze_quantity": pick["freeze_quantity"]},
                "spot": _round(spot), "key_value": key["price"], "target_method": "KEY_VALUE_INTRINSIC", "stop_method": "PREMIUM_PULLBACK_LOW",
            }}


def score(result: dict, option_evidence: dict | None, config: IntrinsicConfig) -> dict:
    """The strategy's own 10-point scorecard (replaces the trend-following ORB score)."""
    calc = result.get("intrinsic") or {}
    sentiment = calc.get("sentiment") or {}
    magnitude = abs(float(sentiment.get("score") or 0)) if sentiment.get("ok") else 0.0
    # Points are relative to the chosen cut-off, so a stricter preset is not double-counted.
    threshold = config.extreme_score
    sentiment_points = 3 if magnitude >= threshold + 25 else 2 if magnitude >= threshold + 10 else 1 if magnitude >= threshold else 0
    key = (calc.get("key_value") or {}) if sentiment.get("ok") else {}
    key_points = 2 if key.get("strength", 0) >= 2 else 1 if key.get("strength", 0) >= 1 else 0
    chance = float((calc.get("selected") or {}).get("itm_chance") or 0) if sentiment.get("ok") else 0.0
    chance_points = 2 if chance >= 0.40 else 1 if chance >= 0.25 else 0
    structure_points = 2 if (calc.get("premium") or {}).get("status") == "CONFIRMED" else 0
    evidence = option_evidence or {}
    option_type = sentiment.get("option_type")
    ors = evidence.get("ors_call") if option_type == "CE" else evidence.get("ors_put") if option_type == "PE" else None
    oi = evidence.get("oi_direction_score")
    direction = 1 if option_type == "CE" else -1 if option_type == "PE" else 0
    flow = (ors is not None and float(ors) >= 1.0) or (oi is not None and direction and float(oi) * direction >= 1)
    flow_points = 1 if flow else 0
    total = float(sentiment_points + key_points + chance_points + structure_points + flow_points)
    return {"sentiment_extreme": sentiment_points, "key_value": key_points, "itm_chance": chance_points, "premium_structure": structure_points, "option_flow": flow_points,
            "total": total, "minimum": config.minimum_score, "maximum": config.maximum_score}
