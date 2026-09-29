"""Operator footprint and fair-value-gap fill odds.

"Operators" (institutions, prop desks, large option writers) cannot be seen directly, but
their orders leave evidence. An operator entry zone is scored from independent footprints:

- displacement: a range-expansion candle leg (>= 1.4 ATR, body >= 55% of range) that only
  large orders can print; its origin candle is where the orders were filled
- the leg broke market structure (BOS / CHoCH)
- a stop hunt just before it (liquidity swept to fill a large order against retail stops)
- the leg left an imbalance (fair value gap)
- a volume spike (when the feed carries volume; index cash candles usually do not)
- option writers defending the same price (heavy / fresh put OI at or just below a long zone,
  call OI at or just above a short zone)
- the zone was retested and held

Fair value gap fill odds (probability that price trades back to the gap's midpoint, its
"consequent encroachment", before the session ends) start from an empirical base rate
measured on the supplied candle history (every unfilled intraday gap, sampled at each later
close, bucketed by distance in ATR, shrunk towards a conservative prior) and are then
adjusted in log-odds space for context: directional pressure (confluence verdict, 5-minute
option-writer flow, market structure, India and global sentiment, crude/dollar/rupee macro),
OI walls in the path, max-pain pull, premium/discount, liquidity magnets beyond the gap,
India-VIX reach in the time left, partial fills, gap size and age.

Every weight is an initial value that must be backtested; the output shows each driver's
effect so a trader can disagree with it. Nothing here is synthesised: missing inputs are
skipped and reported, never guessed.
"""
from __future__ import annotations

import math
from datetime import datetime, time

from .candles import Bar
from .smart_money import find_swings, market_structure

DISPLACEMENT_RANGE_ATR = 1.4
DISPLACEMENT_BODY = 0.55
MIN_ENTRY_CONFIDENCE = 40
MAX_ENTRIES = 4
DISTANCE_BUCKETS = (0.5, 1.0, 2.0, 3.0)  # ATR multiples; last bucket is open-ended
PRIOR_STRENGTH = 4.0  # pseudo-gaps of prior weight per bucket
SESSION_OPEN, SESSION_CLOSE = time(9, 15), time(15, 30)
SESSION_MINUTES = 375


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def _logit(p: float) -> float:
    p = min(max(p, 0.01), 0.99)
    return math.log(p / (1.0 - p))


def _fmt(value: float | None) -> str:
    return "--" if value is None else f"{value:,.2f}"


def rolling_atr(bars: list[Bar], period: int = 14) -> list[float]:
    """Per-bar ATR using only bars up to and including that bar (no lookahead)."""
    values: list[float] = []
    ranges: list[float] = []
    for index, bar in enumerate(bars):
        previous = bars[index - 1].close if index else None
        true_range = bar.high - bar.low if previous is None else max(bar.high - bar.low, abs(bar.high - previous), abs(bar.low - previous))
        ranges.append(true_range)
        window = ranges[-period:]
        values.append(max(sum(window) / len(window), 1e-9))
    return values


def _median(values: list[float]) -> float:
    ordered = sorted(values)
    return ordered[len(ordered) // 2] if ordered else 0.0


# --------------------------------------------------------------------------- operator entries

def _displacement_legs(bars: list[Bar], atr: list[float], start: int) -> list[tuple[int, int, int]]:
    """(first, last, direction) of consecutive same-direction displacement candles."""
    legs: list[tuple[int, int, int]] = []
    for index in range(max(start, 1), len(bars)):
        bar = bars[index]
        span = bar.high - bar.low
        if span <= 0:
            continue
        body = abs(bar.close - bar.open)
        direction = 1 if bar.close > bar.open else -1
        prior_volume = [b.volume for b in bars[max(index - 20, 0):index] if b.volume > 0]
        volume_spike = bool(prior_volume) and bar.volume >= 1.8 * _median(prior_volume)
        strong = span >= DISPLACEMENT_RANGE_ATR * atr[index] and body >= DISPLACEMENT_BODY * span
        if not strong and not (volume_spike and span >= atr[index] and body >= 0.5 * span):
            continue
        if legs and legs[-1][2] == direction and legs[-1][1] >= index - 2:
            legs[-1] = (legs[-1][0], index, direction)
        else:
            legs.append((index, index, direction))
    return legs


def _origin(bars: list[Bar], first: int, direction: int) -> int:
    """Last opposite-colour candle up to 3 bars before the leg (the classic order block)."""
    for index in range(first - 1, max(first - 4, -1), -1):
        bar = bars[index]
        if (direction > 0 and bar.close < bar.open) or (direction < 0 and bar.close > bar.open):
            return index
    return first - 1


def _near_writer_wall(flow: dict, low: float, high: float, direction: int) -> str | None:
    if not flow.get("available"):
        return None
    step = flow.get("strike_step") or 0.0
    if direction > 0:
        walls = [(item["strike"], "put wall") for item in flow.get("support") or []] + [(item["strike"], "fresh put writing") for item in flow.get("put_writing") or []]
        hits = [(strike, label) for strike, label in walls if low - 1.5 * step <= strike <= high + 0.5 * step]
    else:
        walls = [(item["strike"], "call wall") for item in flow.get("resistance") or []] + [(item["strike"], "fresh call writing") for item in flow.get("call_writing") or []]
        hits = [(strike, label) for strike, label in walls if low - 0.5 * step <= strike <= high + 1.5 * step]
    if not hits:
        return None
    strike, label = hits[0]
    return f"{'Put' if direction > 0 else 'Call'} writers defend {strike:,.0f} ({label})"


def operator_entries(bars: list[Bar], atr: list[float], flow: dict) -> list[dict]:
    if len(bars) < 15:
        return []
    days = sorted({bar.time.date() for bar in bars})
    recent_days = set(days[-2:])
    start = next(index for index, bar in enumerate(bars) if bar.time.date() in recent_days)
    _, events, _ = market_structure(bars, find_swings(bars))
    price = bars[-1].close
    today = bars[-1].time.date()
    entries: list[dict] = []
    for first, last, direction in _displacement_legs(bars, atr, start):
        origin = _origin(bars, first, direction)
        if origin < 0:
            continue
        base = bars[origin]
        low, high = base.low, base.high
        later = bars[last + 1:]
        if direction > 0 and any(bar.close < low for bar in later):
            continue
        if direction < 0 and any(bar.close > high for bar in later):
            continue
        entry = (low + high) / 2.0
        extreme = max(bar.high for bar in bars[first:last + 1]) if direction > 0 else min(bar.low for bar in bars[first:last + 1])
        leg_atr = abs(extreme - entry) / atr[last]
        evidence: list[str] = [f"Displacement {abs(extreme - entry):,.0f} pts ({leg_atr:.1f} ATR) in {last - first + 1} candle(s)"]
        confidence = 10.0 + min(leg_atr / 4.0, 1.0) * 25.0
        wanted = "BULLISH" if direction > 0 else "BEARISH"
        broke = next((event for event in events if event["direction"] == wanted and first <= event["index"] <= last + 2), None)
        if broke:
            confidence += 20
            evidence.append(f"Broke structure ({broke['type']} at {_fmt(broke['level'])})")
        lookback = bars[max(origin - 14, 0):max(origin - 2, 0)]
        hunt_window = bars[max(origin - 2, 0):first]
        if lookback and hunt_window:
            if direction > 0:
                pool = min(bar.low for bar in lookback)
                if any(bar.low < pool and bar.close > pool for bar in hunt_window):
                    confidence += 15
                    evidence.append(f"Swept sell-side stops below {_fmt(pool)} first (stop hunt to fill buys)")
            else:
                pool = max(bar.high for bar in lookback)
                if any(bar.high > pool and bar.close < pool for bar in hunt_window):
                    confidence += 15
                    evidence.append(f"Swept buy-side stops above {_fmt(pool)} first (stop hunt to fill sells)")
        for index in range(max(first, 2), min(last + 2, len(bars))):
            a, c = bars[index - 2], bars[index]
            if (direction > 0 and c.low > a.high) or (direction < 0 and c.high < a.low):
                confidence += 10
                evidence.append("Left a fair value gap (orders filled too fast for the other side)")
                break
        prior_volume = [b.volume for b in bars[max(first - 20, 0):first] if b.volume > 0]
        leg_volume = [b.volume for b in bars[first:last + 1] if b.volume > 0]
        if prior_volume and leg_volume:
            ratio = (sum(leg_volume) / len(leg_volume)) / max(_median(prior_volume), 1e-9)
            if ratio >= 1.5:
                confidence += 10
                evidence.append(f"Volume {ratio:.1f}x normal")
        wall = _near_writer_wall(flow, low, high, direction)
        if wall:
            confidence += 15
            evidence.append(wall)
        tested = any((bar.low <= high) if direction > 0 else (bar.high >= low) for bar in later[1:])
        if tested:
            confidence += 5
            evidence.append("Retested and held (operator defended the zone)")
        confidence = min(round(confidence), 95)
        if confidence < MIN_ENTRY_CONFIDENCE:
            continue
        pnl = (price - entry) * direction
        entries.append({
            "direction": "LONG" if direction > 0 else "SHORT",
            "zone_low": round(low, 2),
            "zone_high": round(high, 2),
            "entry_price": round(entry, 2),
            "time": base.time.isoformat(),
            "today": base.time.date() == today,
            "index": origin,
            "confidence": confidence,
            "status": "DEFENDED" if tested else "UNTESTED",
            "pnl_points": round(pnl, 2),
            "in_profit": pnl > 0,
            "evidence": evidence,
        })
    entries.sort(key=lambda item: (item["today"], item["index"]), reverse=True)
    return entries[:MAX_ENTRIES]


def writer_positions(flow: dict, spot: float) -> list[dict]:
    """Largest option-writer camps with their breakevens: the prices they must defend."""
    chain = flow.get("chain") or {}
    if not flow.get("available") or not chain:
        return []
    rows = {row["strike"]: row for row in flow.get("strikes") or []}
    positions: list[dict] = []
    for side, items in (("PE", flow.get("support") or []), ("CE", flow.get("resistance") or [])):
        for item in items:
            leg = chain.get(item["strike"], {}).get(side)
            if leg is None:
                continue
            strike = item["strike"]
            breakeven = strike - leg.ltp if side == "PE" else strike + leg.ltp
            fresh = rows.get(strike, {}).get(f"{side.lower()}_oi_change")
            if side == "PE":
                state = "SAFE" if spot > strike else "UNDER_PRESSURE" if spot > breakeven else "LOSING"
                role = "Support"
            else:
                state = "SAFE" if spot < strike else "UNDER_PRESSURE" if spot < breakeven else "LOSING"
                role = "Resistance"
            positions.append({"side": side, "role": role, "strike": strike, "oi": leg.oi, "oi_change_5m": fresh, "premium": leg.ltp, "breakeven": round(breakeven, 2), "state": state})
    return positions


# ------------------------------------------------------------------------- directional context

def directional_context(verdict: dict, flow: dict, smc: dict, sentiment: dict | None, macro: dict | None) -> tuple[float, list[dict]]:
    """Signed pressure in [-1, 1] (+ = up) and its parts, for the fill-probability model."""
    parts: list[tuple[str, float, float, str]] = []  # (name, value -1..1, weight, detail)
    if verdict:
        parts.append(("Confluence verdict", max(-1.0, min(1.0, verdict.get("score", 0.0) / 7.0)), 0.30, f"{verdict.get('bias', '--')} {verdict.get('score', 0):+.1f}/10"))
    if flow.get("available") and flow.get("oi_direction_score") is not None:
        parts.append(("Option writers (5m OI)", flow["oi_direction_score"] / 2.0, 0.25, flow.get("oi_direction_label") or ""))
    if smc.get("available") and smc.get("trend") in ("BULLISH", "BEARISH"):
        parts.append(("Price structure", 1.0 if smc["trend"] == "BULLISH" else -1.0, 0.15, f"{smc['trend'].title()} ({smc.get('swing_sequence', '').replace('_', '/')})"))
    if sentiment and sentiment.get("india_label") not in (None, "INSUFFICIENT_DATA"):
        score = float(sentiment.get("india_score") or 0.0)
        value = 0.0 if sentiment.get("contrarian_note") else max(-1.0, min(1.0, score / 50.0))
        parts.append(("India news & forums", value, 0.10, f"{score:+.0f}/100" + (" (crowd extreme: ignored)" if sentiment.get("contrarian_note") else "")))
    if sentiment and sentiment.get("global_label") not in (None, "INSUFFICIENT_DATA"):
        score = float(sentiment.get("global_score") or 0.0)
        parts.append(("Global news & forums", max(-1.0, min(1.0, score / 50.0)), 0.05, f"{score:+.0f}/100"))
    if macro and macro.get("available"):
        top = ", ".join(f"{d['name']} {d['change_pct']:+.1f}%" for d in macro.get("drivers", [])[:3])
        parts.append(("Crude, dollar, rupee & global futures", max(-1.0, min(1.0, macro["score"] / 50.0)), 0.15, f"{macro['score']:+.0f}/100 · {top}"))
    weight = sum(p[2] for p in parts)
    pressure = sum(p[1] * p[2] for p in parts) / weight if weight else 0.0
    return pressure, [{"name": name, "value": round(value, 2), "weight": w, "signal": "BULLISH" if value > 0.1 else "BEARISH" if value < -0.1 else "NEUTRAL", "detail": detail} for name, value, w, detail in parts]


# ------------------------------------------------------------------------ fvg fill probability

def _bucket(distance_atr: float) -> int:
    for position, edge in enumerate(DISTANCE_BUCKETS):
        if distance_atr < edge:
            return position
    return len(DISTANCE_BUCKETS)


def _bucket_label(position: int) -> str:
    edges = (0.0,) + DISTANCE_BUCKETS
    return f"{edges[position]:g}-{edges[position + 1]:g} ATR" if position < len(DISTANCE_BUCKETS) else f">{DISTANCE_BUCKETS[-1]:g} ATR"


def _prior(position: int) -> float:
    edges = (0.0,) + DISTANCE_BUCKETS + (DISTANCE_BUCKETS[-1] + 1.5,)
    centre = (edges[position] + edges[position + 1]) / 2.0
    return 0.9 * math.exp(-0.45 * centre)


def fvg_base_rates(bars: list[Bar], atr: list[float]) -> dict:
    """Empirical P(an unfilled intraday gap's midpoint is reached before the close | distance).

    Uses completed sessions only (the latest session's outcome is not known yet). Each gap
    contributes a total weight of 1 spread over its observations, so long-lived gaps do not
    dominate, and each bucket is shrunk towards a conservative prior.
    """
    sessions: dict = {}
    for index, bar in enumerate(bars):
        sessions.setdefault(bar.time.date(), []).append(index)
    completed = sorted(sessions)[:-1]
    hits = [0.0] * (len(DISTANCE_BUCKETS) + 1)
    totals = [0.0] * (len(DISTANCE_BUCKETS) + 1)
    gaps_seen = 0
    for day in completed:
        indices = sessions[day]
        end = indices[-1]
        for index in indices[2:]:
            first, third = bars[index - 2], bars[index]
            if third.low > first.high:
                mid = (third.low + first.high) / 2.0
                reached = lambda b, m=mid: b.low <= m  # noqa: E731
            elif third.high < first.low:
                mid = (first.low + third.high) / 2.0
                reached = lambda b, m=mid: b.high >= m  # noqa: E731
            else:
                continue
            observations: list[tuple[int, bool]] = []
            for t in range(index + 1, end):
                if reached(bars[t]):
                    break
                future = any(reached(bars[u]) for u in range(t + 1, end + 1))
                observations.append((_bucket(abs(bars[t].close - mid) / atr[t]), future))
            if not observations:
                continue
            gaps_seen += 1
            share = 1.0 / len(observations)
            for position, outcome in observations:
                totals[position] += share
                hits[position] += share * outcome
    rates = []
    for position in range(len(totals)):
        prior = _prior(position)
        rate = (hits[position] + prior * PRIOR_STRENGTH) / (totals[position] + PRIOR_STRENGTH)
        rates.append({"bucket": _bucket_label(position), "rate": round(rate, 3), "observed_rate": round(hits[position] / totals[position], 3) if totals[position] >= 0.5 else None, "weight": round(totals[position], 2), "prior": round(prior, 3)})
    return {"sessions": len(completed), "gaps": gaps_seen, "buckets": rates}


def _minutes_left(now: datetime | None, market_open: bool) -> float:
    if now is None or not market_open:
        return float(SESSION_MINUTES)  # plan for the next full session
    close = now.replace(hour=SESSION_CLOSE.hour, minute=SESSION_CLOSE.minute, second=0, microsecond=0)
    return max((close - now).total_seconds() / 60.0, 0.0)


def fvg_fill_odds(bars: list[Bar], atr: list[float], smc: dict, flow: dict, vol: dict, tech: dict, pressure: float, entries: list[dict], meta: dict) -> dict:
    gaps = smc.get("fair_value_gaps") or []
    if not bars or not gaps:
        return {"gaps": [], "most_likely": None, "base_rates": None}
    price = bars[-1].close
    atr_now = tech.get("atr14") or atr[-1]
    base = fvg_base_rates(bars, atr)
    minutes_left = _minutes_left(meta.get("now"), meta.get("market_open", False))
    if vol.get("available") and vol.get("expected_daily_move"):
        reach = vol["expected_daily_move"] * math.sqrt(max(minutes_left, 1.0) / SESSION_MINUTES)
        reach_basis = "India VIX"
    else:
        reach = atr_now * 0.8 * math.sqrt(max(minutes_left / 5.0, 1.0))
        reach_basis = "ATR random walk"
    zone = (smc.get("dealing_range") or {})
    pools = smc.get("liquidity") or {}
    today = bars[-1].time.date()
    results = []
    for gap in gaps:
        top, bottom, mid = gap["top"], gap["bottom"], gap["mid"]
        inside = bottom <= price <= top
        need = 1 if mid > price else -1
        near_edge = 0.0 if inside else (bottom - price if need > 0 else price - top)
        distance_mid = abs(mid - price)
        distance_atr = distance_mid / atr_now
        bucket = base["buckets"][_bucket(distance_atr)]
        drivers: list[tuple[str, float, str]] = []

        drivers.append(("Market pressure", 1.3 * need * pressure, f"Needs a move {'up' if need > 0 else 'down'}; combined pressure is {pressure:+.2f} ({'with' if need * pressure > 0.05 else 'against' if need * pressure < -0.05 else 'neutral to'} the move)"))
        if flow.get("available") and not inside:
            walls = flow.get("resistance") if need > 0 else flow.get("support")
            blocking = [w["strike"] for w in walls or [] if (w["strike"] - price) * need > 0 and (w["strike"] - (bottom if need > 0 else top)) * need < 0]
            if blocking:
                drivers.append(("OI wall in the path", -0.6 * min(len(blocking), 2), f"{'Call' if need > 0 else 'Put'} writers at {', '.join(f'{s:,.0f}' for s in blocking)} stand between price and the gap"))
            max_pain = flow.get("max_pain")
            if max_pain and (max_pain - mid) * need >= -0.25 * atr_now and (max_pain - price) * need > 0:
                drivers.append(("Max-pain pull", 0.6 if meta.get("expiry_today") else 0.3, f"Max pain {max_pain:,.0f} lies at/beyond the gap{' (expiry today: strong magnet)' if meta.get('expiry_today') else ''}"))
        if zone.get("zone") == "PREMIUM" and need < 0:
            drivers.append(("Premium → discount", 0.35, "Price is in the premium half; a pull back toward equilibrium passes the gap"))
        elif zone.get("zone") == "DISCOUNT" and need > 0:
            drivers.append(("Discount → premium", 0.35, "Price is in the discount half; a push back toward equilibrium passes the gap"))
        elif zone.get("zone") in ("PREMIUM", "DISCOUNT"):
            drivers.append(("Against premium/discount", -0.2, f"Gap lies deeper into the {zone['zone'].lower()} half"))
        magnets = [("PDH", pools.get("previous_day_high")), ("Today's high", pools.get("session_high"))] + [("Equal highs", level["level"]) for level in pools.get("equal_highs") or []] if need > 0 else \
                  [("PDL", pools.get("previous_day_low")), ("Today's low", pools.get("session_low"))] + [("Equal lows", level["level"]) for level in pools.get("equal_lows") or []]
        beyond = [(label, level) for label, level in magnets if level and (level - mid) * need > 0 and abs(level - price) <= reach * 1.2]
        if beyond:
            label, level = min(beyond, key=lambda item: abs(item[1] - price))
            drivers.append(("Liquidity magnet beyond", 0.3, f"{label} {level:,.2f} (resting stops) sits just past the gap"))
        ratio = near_edge / reach if reach > 0 else 0.0
        if ratio > 2.0:
            drivers.append(("Out of reach today", -1.5, f"Gap is {ratio:.1f}x the {reach_basis}-implied move left ({reach:,.0f} pts)"))
        elif ratio > 1.25:
            drivers.append(("Stretch for today", -0.8, f"Gap is {ratio:.1f}x the {reach_basis}-implied move left ({reach:,.0f} pts)"))
        elif ratio > 0.8:
            drivers.append(("Edge of today's range", -0.3, f"Needs most of the {reach_basis}-implied move left ({reach:,.0f} pts)"))
        if meta.get("market_open") and minutes_left < 30:
            drivers.append(("Little time left", -0.5, f"{minutes_left:.0f} min to the close"))
        if gap.get("partially_filled"):
            drivers.append(("Already partly filled", 0.3, "Price has started trading into the gap"))
        size_atr = (top - bottom) / atr_now
        if size_atr > 1.5:
            drivers.append(("Large gap", -0.25, f"Gap is {size_atr:.1f} ATR tall; big imbalances often only partly fill"))
        if datetime.fromisoformat(gap["time"]).date() != today:
            drivers.append(("Carried over", -0.2, "Formed in an earlier session; stale gaps fill less reliably"))
        overlapping = [e for e in entries if e["zone_low"] <= top and e["zone_high"] >= bottom]
        if overlapping:
            e = overlapping[0]
            drivers.append(("Operator zone overlap", 0.2, f"Overlaps an operator {e['direction'].lower()} zone ({e['confidence']}%): price is drawn to it, and it is likely to be defended there"))
        if inside:
            drivers.append(("Price inside the gap", 1.5, "Price is trading inside the gap now"))

        base_logit = _logit(bucket["rate"])
        total = base_logit + sum(effect for _, effect, _ in drivers)
        probability = min(max(_sigmoid(total), 0.03), 0.97)
        shown = []
        for name, effect, detail in drivers:
            if abs(effect) < 0.02:
                continue
            without = min(max(_sigmoid(total - effect), 0.03), 0.97)
            shown.append({"name": name, "effect_pct": round((probability - without) * 100, 1), "detail": detail})
        shown.sort(key=lambda item: abs(item["effect_pct"]), reverse=True)
        overlapping_ids = [e["entry_price"] for e in overlapping]
        results.append({
            "direction": gap["direction"],
            "top": top,
            "bottom": bottom,
            "mid": round(mid, 2),
            "time": gap["time"],
            "partially_filled": gap.get("partially_filled", False),
            "move_needed": "UP" if need > 0 else "DOWN",
            "distance_points": round(distance_mid, 2),
            "distance_atr": round(distance_atr, 2),
            "probability": round(probability * 100, 1),
            "base_rate": round(bucket["rate"] * 100, 1),
            "base_bucket": bucket["bucket"],
            "drivers": shown,
            "operator_overlap": overlapping_ids,
            "trade_idea": (f"Fill trade: {'CE' if need > 0 else 'PE'} toward {mid:,.2f}" if probability >= 0.6 and not inside else None),
        })
    results.sort(key=lambda item: item["probability"], reverse=True)
    return {"gaps": results, "most_likely": results[0] if results else None, "base_rates": base, "reach_points": round(reach, 1), "reach_basis": reach_basis, "minutes_left": round(minutes_left)}


# ---------------------------------------------------------------------------------- summary

def analyze_operator(bars: list[Bar], tech: dict, smc: dict, flow: dict, vol: dict, verdict: dict, sentiment: dict | None, macro: dict | None, meta: dict) -> dict:
    if len(bars) < 20 or not smc.get("available"):
        return {"available": False, "reason": "Not enough candles to read operator activity"}
    atr = rolling_atr(bars)
    entries = operator_entries(bars, atr, flow)
    writers = writer_positions(flow, meta.get("spot") or bars[-1].close)
    pressure, context = directional_context(verdict, flow, smc, sentiment, macro)
    fills = fvg_fill_odds(bars, atr, smc, flow, vol, tech, pressure, entries, meta)

    long_weight = sum(e["confidence"] * (1.0 if e["today"] else 0.5) for e in entries if e["direction"] == "LONG")
    short_weight = sum(e["confidence"] * (1.0 if e["today"] else 0.5) for e in entries if e["direction"] == "SHORT")
    writer_tilt = (flow.get("oi_direction_score") or 0) * 25 if flow.get("available") else 0
    net = long_weight - short_weight + writer_tilt
    if net >= 60:
        stance, stance_text = "ACCUMULATING", "Operators are positioned long: buying dips into their zones and writing puts"
    elif net <= -60:
        stance, stance_text = "DISTRIBUTING", "Operators are positioned short: selling rallies into their zones and writing calls"
    else:
        stance, stance_text = "TWO_SIDED", "No clear operator side: they are active in both directions (range play)"
    comfort = None
    put_be = [w["breakeven"] for w in writers if w["side"] == "PE"]
    call_be = [w["breakeven"] for w in writers if w["side"] == "CE"]
    if put_be and call_be:
        comfort = {"low": max(put_be), "high": min(call_be)}
    best = fills.get("most_likely")
    headline_parts = [stance_text + "."]
    if entries:
        top = max(entries, key=lambda e: e["confidence"])
        headline_parts.append(f"Strongest footprint: {top['direction'].lower()} entry {top['zone_low']:,.2f}–{top['zone_high']:,.2f} ({top['confidence']}% confidence, {'in profit' if top['in_profit'] else 'under water'} {top['pnl_points']:+,.0f} pts).")
    if best:
        headline_parts.append(f"Gap most likely to fill: {best['bottom']:,.2f}–{best['top']:,.2f} ({best['probability']:.0f}%).")
    return {
        "available": True,
        "stance": stance,
        "stance_score": round(net, 1),
        "headline": " ".join(headline_parts),
        "entries": entries,
        "writers": writers,
        "writer_comfort_zone": comfort,
        "pressure": round(pressure, 3),
        "context": context,
        "macro": macro if macro and macro.get("available") else None,
        "fvg_fill": fills,
        "method": "Operator zones = displacement origin candles scored by structure break, stop hunt, imbalance, volume, option-writer defence and retests. FVG odds = empirical midpoint-fill rate from the supplied history (by distance in ATR, shrunk to a prior), adjusted in log-odds for pressure, OI walls, max pain, premium/discount, liquidity, VIX reach and time left. Heuristic weights: backtest before relying on them.",
    }
