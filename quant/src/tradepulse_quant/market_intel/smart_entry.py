"""Smart zone entry: trade reversals from confluence zones, confirmed on the 1-minute chart.

The idea an experienced NIFTY option buyer trades by, made deterministic:

1. **Where** (5-minute map): demand zones are built where a bullish order block / fair value
   gap overlaps support (previous-day low, session low, swing lows, equal lows) and put-writer
   OI walls; supply zones are the mirror image. More independent sources = stronger zone.
2. **When** (1-minute trigger): price must come INTO the zone (optionally sweeping the stops
   just beyond it), then the 1-minute structure must flip: a candle closes beyond the last
   1-minute lower-high (CHoCH) and price is still holding beyond it. No flip, no trade.
3. **Whether** (context score out of 10): 15m and 5m trend, option-writer flow and walls,
   PCR, VIX, India sentiment and the global macro tape. Hard gates block extreme VIX, late
   expiry, entries outside the window, trades with no room to the next opposing zone, and
   counter-trend trades that also fight the option writers.

Longs and shorts share one implementation: shorts are evaluated on price-mirrored candles
(every price negated), so a supply zone becomes a demand zone and a sell-off a rally.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import time

from ..algo_engine import indicators
from .candles import Bar, split_sessions
from .options_flow import select_contract
from .smart_money import find_swings

LOOKBACK_1M = 25  # the last 25 one-minute candles are searched for the zone test
MAX_TRIGGER_AGE = 3  # the CHoCH candle must be one of the last 4 completed 1m candles
MIN_LEG_ATR = 0.25  # the push into the zone must be at least 0.25 x ATR(5m)
LEVEL_BAND_ATR = 0.12  # a single price level (PDL, strike wall, swing) is a +/- band
MERGE_TOLERANCE_ATR = 0.15
MAX_ZONE_WIDTH_ATR = 1.2
ZONE_BREAK_ATR = 0.25  # a 1m close this far through the zone means the zone failed
SWEEP_DEPTH_ATR = 0.6  # how far below a zone a wick may reach and still count as a sweep
STOP_BUFFER_ATR = 0.1
MIN_RISK_ATR = 0.25
MAX_RISK_ATR = 3.0  # stop below the 1m sweep low; a real sweep-and-flip spans 2-3 x ATR(5m)
MAX_CHASE_ATR = 0.5  # entry may be at most this far beyond the 1m CHoCH level
MIN_ROOM_R = 1.5  # the next opposing zone/level must be at least 1.5R away
MIN_RR = 2.0
MIN_SCORE = 6.0
PREMIUM_STOP_FLOOR = 0.10
PREMIUM_STOP_CAP = 0.35


@dataclass(frozen=True)
class Zone:
    low: float
    high: float
    sources: tuple[str, ...]
    categories: frozenset[str]

    @property
    def strength(self) -> int:
        return len(self.categories)


def _mirror_bar(bar: Bar) -> Bar:
    return Bar(bar.time, -bar.open, -bar.low, -bar.high, -bar.close, bar.volume)


def _fmt(value: float) -> str:
    return f"{value:,.2f}"


def _band(label: str, category: str, level: float | None, atr: float) -> tuple[float, float, str, str] | None:
    if not level:
        return None
    return (level - LEVEL_BAND_ATR * atr, level + LEVEL_BAND_ATR * atr, label, category)


def _raw_items(smc: dict, flow: dict, tech: dict, atr: float, direction: int) -> list[tuple[float, float, str, str]]:
    """Zone ingredients in REAL prices for one side (+1 demand, -1 supply)."""
    wanted = "BULLISH" if direction > 0 else "BEARISH"
    items: list[tuple[float, float, str, str] | None] = []
    for block in smc.get("order_blocks") or []:
        if block["direction"] == wanted:
            items.append((block["bottom"], block["top"], f"5m {wanted.lower()} order block", "ORDER_BLOCK"))
    for gap in smc.get("fair_value_gaps") or []:
        if gap["direction"] == wanted:
            items.append((gap["bottom"], gap["top"], f"5m {wanted.lower()} FVG", "FVG"))
    pools = smc.get("liquidity") or {}
    swings = smc.get("swings") or []
    if direction > 0:
        items.append(_band("Previous day low", "LEVEL", pools.get("previous_day_low"), atr))
        items += [_band("5m swing low", "LEVEL", s["price"], atr) for s in swings if s["kind"] == "LOW"][-2:]
        items += [_band(f"Equal lows x{e['touches']}", "LEVEL", e["level"], atr) for e in pools.get("equal_lows") or []]
        items += [_band(f"Put-writer wall {int(w['strike'])}", "OI_WALL", w["strike"], atr) for w in (flow.get("support") or [])[:2]]
    else:
        items.append(_band("Previous day high", "LEVEL", pools.get("previous_day_high"), atr))
        items += [_band("5m swing high", "LEVEL", s["price"], atr) for s in swings if s["kind"] == "HIGH"][-2:]
        items += [_band(f"Equal highs x{e['touches']}", "LEVEL", e["level"], atr) for e in pools.get("equal_highs") or []]
        items += [_band(f"Call-writer wall {int(w['strike'])}", "OI_WALL", w["strike"], atr) for w in (flow.get("resistance") or [])[:2]]
    return [item for item in items if item is not None and item[1] > item[0]]


def build_zones(smc: dict, flow: dict, tech: dict, atr: float, direction: int) -> list[Zone]:
    """Cluster overlapping ingredients into zones, returned in MIRRORED space for supply."""
    items = sorted(_raw_items(smc, flow, tech, atr, direction), key=lambda item: item[0])
    zones: list[list] = []
    tolerance = MERGE_TOLERANCE_ATR * atr
    for low, high, label, category in items:
        current = zones[-1] if zones else None
        if current and low <= current[1] + tolerance and max(high, current[1]) - current[0] <= MAX_ZONE_WIDTH_ATR * atr:
            current[1] = max(current[1], high)
            current[2].append(label)
            current[3].add(category)
        else:
            zones.append([low, high, [label], {category}])
    result = [Zone(low, high, tuple(dict.fromkeys(labels)), frozenset(categories)) for low, high, labels, categories in zones]
    if direction < 0:
        result = [Zone(-zone.high, -zone.low, zone.sources, zone.categories) for zone in result]
    return result


def _confirmation(bars: list[Bar], zones: list[Zone], atr: float) -> dict | None:
    """Demand-side 1m logic on (possibly mirrored) bars: touch -> CHoCH -> hold."""
    window_start = max(len(bars) - LOOKBACK_1M, 0)
    window = range(window_start, len(bars))
    if len(window) < 8:
        return None
    extreme = min(window, key=lambda i: bars[i].low)
    low = bars[extreme].low
    candidates = [zone for zone in zones if zone.low - SWEEP_DEPTH_ATR * atr <= low <= zone.high + 0.1 * atr]
    if not candidates:
        return None
    zone = max(candidates, key=lambda z: (z.strength, -abs(low - z.high)))
    broken_at = zone.low - ZONE_BREAK_ATR * atr
    if any(bars[i].close < broken_at for i in window if i >= extreme):
        return {"zone": zone, "state": "BROKEN", "extreme": extreme}
    swings = find_swings(bars, 1)  # minor 1m swings: the last lower high is the CHoCH level
    prior_highs = [s for s in swings if s.kind == "HIGH" and s.index < extreme and s.index >= window_start - 10]
    if prior_highs:
        choch_level = prior_highs[-1].price
    else:
        lookback = bars[max(extreme - 6, 0):extreme]
        if not lookback:
            return {"zone": zone, "state": "IN_ZONE", "extreme": extreme}
        choch_level = max(bar.high for bar in lookback)
    leg = choch_level - low
    trigger = next((j for j in range(extreme + 1, len(bars)) if bars[j].close > choch_level), None)
    base = {"zone": zone, "extreme": extreme, "choch_level": choch_level, "leg": leg}
    if leg < MIN_LEG_ATR * atr:
        return {**base, "state": "NO_IMPULSE"}
    if trigger is None:
        return {**base, "state": "IN_ZONE"}
    if bars[-1].close <= choch_level:
        return {**base, "state": "FAILED_FLIP", "trigger": trigger}
    age = len(bars) - 1 - trigger
    bar = bars[trigger]
    body = abs(bar.close - bar.open) / max(bar.high - bar.low, 1e-9)
    swept = low < zone.low and any(bars[i].close > zone.low for i in range(extreme, len(bars)))
    return {**base, "state": "CONFIRMED" if age <= MAX_TRIGGER_AGE else "STALE", "trigger": trigger, "age": age, "body": body,
            "displacement": bar.close > bar.open and body >= 0.5, "swept": swept}


def _opposing_levels(smc: dict, flow: dict, tech: dict, atr: float, direction: int, entry: float) -> list[tuple[str, float]]:
    """Real-price levels that would stop a move in ``direction`` (nearest first)."""
    opposite = build_zones(smc, flow, tech, atr, -direction)
    levels: list[tuple[str, float]] = []
    for zone in opposite:
        # Opposite zones come back in the other side's space: supply is mirrored, demand is not.
        real_low, real_high = (-zone.high, -zone.low) if direction > 0 else (zone.low, zone.high)
        edge = real_low if direction > 0 else real_high
        levels.append((" + ".join(zone.sources[:2]), edge))
    pools = smc.get("liquidity") or {}
    extra = [("Previous day high", pools.get("previous_day_high")), ("Today's high", pools.get("session_high"))] if direction > 0 else [("Previous day low", pools.get("previous_day_low")), ("Today's low", pools.get("session_low"))]
    levels += [(label, float(value)) for label, value in extra if value]
    ahead = [(label, level) for label, level in levels if (level - entry) * direction > 0]
    return sorted(ahead, key=lambda item: abs(item[1] - entry))


def _factor(key: str, name: str, points: float, maximum: float, detail: str) -> dict:
    return {"key": key, "name": name, "points": round(points, 2), "max": maximum, "detail": detail}


def _score(direction: int, zone: Zone, conf: dict, tech: dict, smc: dict, flow: dict, verdict: dict, sentiment: dict | None, macro: dict | None) -> tuple[list[dict], bool, bool]:
    word = "bullish" if direction > 0 else "bearish"
    factors = []
    zone_points = {1: 0.5, 2: 1.25}.get(zone.strength, 2.0)
    factors.append(_factor("zone", "Zone confluence", zone_points, 2.0, f"{zone.strength} independent source(s): {', '.join(zone.sources)}"))
    confirm = 1.5 + (0.5 if conf.get("displacement") else 0.0)
    factors.append(_factor("trigger", "1-minute CHoCH", confirm, 2.0, f"1m close beyond {_fmt(conf['choch_level_real'])}{' with a strong-bodied candle' if conf.get('displacement') else ' (weak-bodied trigger candle)'}"))
    factors.append(_factor("sweep", "Liquidity sweep", 1.0 if conf.get("swept") else 0.0, 1.0, "Stops beyond the zone were hunted and price reclaimed it" if conf.get("swept") else "No stop-hunt beyond the zone"))
    htf = 0.0
    trend_15m = tech.get("trend_15m")
    with_15m = trend_15m == ("BULLISH" if direction > 0 else "BEARISH")
    against_15m = trend_15m == ("BEARISH" if direction > 0 else "BULLISH")
    htf += 1.0 if with_15m else 0.0
    smc_trend = smc.get("trend")
    last_event = smc.get("last_event") or {}
    with_5m = smc_trend == ("BULLISH" if direction > 0 else "BEARISH")
    htf += 1.0 if with_5m else 0.0
    factors.append(_factor("trend", "15m / 5m trend", htf, 2.0, f"15m {str(trend_15m or 'unknown').lower()}, 5m structure {str(smc_trend or 'unknown').lower()}{' (last ' + last_event.get('type', '') + ')' if last_event else ''}"))
    oi_score = flow.get("oi_direction_score") if flow.get("available") else None
    writers = 1.0 if oi_score is not None and oi_score * direction >= 1 else 0.0
    wall = 0.5 if "OI_WALL" in zone.categories else 0.0
    writers_against = oi_score is not None and oi_score * direction <= -1
    factors.append(_factor("writers", "Option writers", writers + wall, 1.5, (flow.get("oi_direction_label") or "Option chain unavailable") + ("; writer wall inside the zone" if wall else "")))
    pcr = flow.get("pcr_oi") if flow.get("available") else None
    pcr_points = 0.0
    if pcr is not None:
        if direction > 0:
            pcr_points = 0.5 if 1.0 <= pcr <= 1.6 else 0.25 if 0.9 <= pcr < 1.0 else 0.0
        else:
            pcr_points = 0.5 if 0.5 <= pcr <= 0.8 else 0.25 if 0.8 < pcr <= 0.95 else 0.0
    factors.append(_factor("pcr", "PCR", pcr_points, 0.5, f"PCR {pcr:.2f}" if pcr is not None else "Unavailable"))
    mood = 0.0
    notes = []
    if sentiment and sentiment.get("india_label") not in (None, "INSUFFICIENT_DATA") and not sentiment.get("contrarian_note"):
        india = float(sentiment.get("india_score") or 0.0)
        if india * direction >= 10:
            mood += 0.5
        notes.append(f"India sentiment {india:+.0f}")
    if macro and macro.get("available"):
        macro_score = float(macro.get("score") or 0.0)
        if macro_score * direction >= 12:
            mood += 0.5
        notes.append(f"global tape {macro.get('label', '').replace('_', ' ').lower()} ({macro_score:+.0f})")
    factors.append(_factor("mood", "Sentiment & global cues", mood, 1.0, ", ".join(notes) if notes else "Unavailable"))
    return factors, against_15m and not with_5m, writers_against


def _psychology(direction: int, zone: Zone, conf: dict, tech: dict, flow: dict, vol: dict, counter_trend: bool) -> list[str]:
    buyers, sellers = ("buyers", "sellers") if direction > 0 else ("sellers", "buyers")
    lines = [f"{sellers.title()} drove price into the {'demand' if direction > 0 else 'supply'} zone {_fmt(conf['zone_low'])}-{_fmt(conf['zone_high'])} ({', '.join(zone.sources[:3])}), where {buyers} have defended before."]
    if conf.get("swept"):
        lines.append(f"The move {'below' if direction > 0 else 'above'} the zone ran the obvious stop-losses and was immediately reclaimed: late {sellers} are now trapped and their exits fuel the reversal.")
    lines.append(f"On 1-minute the {sellers} failed to make a new {'low' if direction > 0 else 'high'} and a candle closed through the last {'lower high' if direction > 0 else 'higher low'} {_fmt(conf['choch_level_real'])} at {conf['trigger_time']}: control has shifted to {buyers}.")
    if flow.get("available"):
        walls = flow.get("support" if direction > 0 else "resistance") or []
        if walls:
            lines.append(f"{'Put' if direction > 0 else 'Call'} writers hold their biggest position at {int(walls[0]['strike'])}; they defend it because a break costs them money. {flow.get('oi_direction_label') or ''}".strip())
    trend_15m = str(tech.get("trend_15m") or "unknown").lower()
    lines.append(f"15-minute trend is {trend_15m}: {'this is a counter-trend reversal, so size is halved and the first target should be booked quickly' if counter_trend else 'this is a with-trend pullback entry, the highest-probability kind'}.")
    if vol.get("available"):
        lines.append(f"India VIX {vol['value']:.1f} ({str(vol.get('regime')).lower()}): expected day range {_fmt(vol['expected_range']['low'])}-{_fmt(vol['expected_range']['high'])}.")
    return lines


def _premium_plan(contract: dict | None, spot: float, direction: int, entry: float, stop: float, target1: float, target2: float) -> dict | None:
    if not contract or not contract.get("premium"):
        return None
    delta = abs(contract.get("delta") or 0.5)
    premium = contract["premium"]
    risk = min(max(delta * abs(entry - stop), premium * PREMIUM_STOP_FLOOR), premium * PREMIUM_STOP_CAP)
    reward1 = max(delta * abs(target1 - entry), risk * MIN_RR)
    reward2 = max(delta * abs(target2 - entry), reward1)
    return {"entry": round(premium, 2), "stop": round(max(premium - risk, 0.05), 2), "target1": round(premium + reward1, 2), "target2": round(premium + reward2, 2), "risk_reward": round(reward1 / risk, 2)}


def _nearest_zones(zones_by_side: dict[int, list[Zone]], price: float) -> list[dict]:
    out = []
    for direction, zones in zones_by_side.items():
        for zone in zones:
            low, high = (zone.low, zone.high) if direction > 0 else (-zone.high, -zone.low)
            distance = price - high if direction > 0 else low - price
            if distance >= -(high - low):
                out.append({"side": "DEMAND" if direction > 0 else "SUPPLY", "low": round(low, 2), "high": round(high, 2), "strength": zone.strength, "sources": list(zone.sources), "distance": round(distance, 2)})
    return sorted(out, key=lambda item: item["distance"])[:4]


def analyze_smart_entry(bars5: list[Bar], bars1: list[Bar], tech: dict, smc: dict, flow: dict, vol: dict, verdict: dict, sentiment: dict | None, macro: dict | None, session: dict, meta: dict) -> dict:
    atr = tech.get("atr14") or 0.0
    price = bars1[-1].close if bars1 else tech.get("last_price")
    if not smc.get("available") or not atr or not price:
        return {"available": False, "status": "WAIT", "reason": "5-minute structure is not available yet"}
    session_1m, _ = split_sessions(bars1)
    zones_by_side = {1: build_zones(smc, flow, tech, atr, 1), -1: build_zones(smc, flow, tech, atr, -1)}
    nearby = _nearest_zones(zones_by_side, price)
    base = {"available": True, "zones": nearby, "atr5": round(atr, 2), "min_score": MIN_SCORE}
    if len(session_1m) < 10:
        return {**base, "status": "WAIT", "reason": "Waiting for at least 10 one-minute candles today"}

    evaluated: list[dict] = []
    for direction in (1, -1):
        bars = session_1m if direction > 0 else [_mirror_bar(bar) for bar in session_1m]
        conf = _confirmation(bars, zones_by_side[direction], atr)
        if conf is None:
            continue
        zone: Zone = conf["zone"]
        real = (lambda value: value) if direction > 0 else (lambda value: -value)
        conf["zone_low"], conf["zone_high"] = (zone.low, zone.high) if direction > 0 else (-zone.high, -zone.low)
        if "choch_level" in conf:
            conf["choch_level_real"] = real(conf["choch_level"])
        extreme_price = real(bars[conf["extreme"]].low)
        conf["direction"] = direction
        if conf["state"] != "CONFIRMED":
            evaluated.append(conf)
            continue
        conf["trigger_time"] = session_1m[conf["trigger"]].time.strftime("%H:%M")
        entry = price
        stop = extreme_price - STOP_BUFFER_ATR * atr * direction
        risk = abs(entry - stop)
        if risk < MIN_RISK_ATR * atr:
            stop = entry - MIN_RISK_ATR * atr * direction
            risk = abs(entry - stop)
        chase = (entry - conf["choch_level_real"]) * direction
        factors, counter_trend, writers_against = _score(direction, zone, conf, tech, smc, flow, verdict, sentiment, macro)
        score = round(sum(f["points"] for f in factors), 2)
        ahead = _opposing_levels(smc, flow, tech, atr, direction, entry)
        room = abs(ahead[0][1] - entry) / risk if ahead else None
        target1 = entry + MIN_RR * risk * direction
        reach = (vol["expected_range"]["high"] if direction > 0 else vol["expected_range"]["low"]) if vol.get("available") else entry + 4 * risk * direction
        beyond = [(label, level) for label, level in ahead if (level - target1) * direction > 0 and (reach - level) * direction >= 0]
        target2_label, target2 = beyond[0] if beyond else ("3R extension", entry + 3 * risk * direction)
        late_expiry = bool(meta.get("expiry_today")) and meta["now"].time() >= time(13, 30)
        gates = [
            ("Inside the entry window (09:35-14:45 IST)", session.get("entry_permitted", False)),
            ("India VIX not extreme", vol.get("regime") != "EXTREME"),
            ("No late expiry-day gamma risk", not late_expiry),
            (f"Stop within {MAX_RISK_ATR} ATR (risk {risk:.1f} pts)", risk <= MAX_RISK_ATR * atr),
            (f"Not chasing ({chase:.1f} pts beyond the 1m CHoCH level, limit {MAX_CHASE_ATR * atr:.1f})", chase <= MAX_CHASE_ATR * atr),
            (f"Room to the next opposing level ({ahead[0][0]} at {_fmt(ahead[0][1])}: {room:.1f}R)" if ahead else "Room to the next opposing level (none nearby)", room is None or room >= MIN_ROOM_R),
            ("Not fighting both the 15m trend and the option writers", not (counter_trend and writers_against)),
            (f"Score {score:.1f}/10 >= {MIN_SCORE}", score >= MIN_SCORE),
        ]
        failed = [label for label, passed in gates if not passed]
        size = (0.5 if counter_trend else 1.0) * (0.5 if vol.get("regime") == "HIGH" else 1.0) * (0.5 if meta.get("expiry_today") else 1.0)
        side = "CE" if direction > 0 else "PE"
        contract = select_contract(flow.get("chain") or {}, meta["spot"], side) if flow.get("available") else None
        evaluated.append({
            **conf,
            "score": score,
            "factors": factors,
            "gates": [{"label": label, "passed": passed} for label, passed in gates],
            "failed": failed,
            "counter_trend": counter_trend,
            "size_multiplier": size,
            "side": side,
            "contract": contract,
            "spot": {"entry": round(entry, 2), "stop": round(stop, 2), "target1": round(target1, 2), "target2": round(target2, 2), "target2_label": target2_label, "risk_points": round(risk, 2)},
            "premium": _premium_plan(contract, meta["spot"], direction, entry, stop, target1, target2),
            "psychology": _psychology(direction, zone, conf, tech, flow, vol, counter_trend),
        })

    confirmed = [item for item in evaluated if item["state"] == "CONFIRMED"]
    ready = sorted([item for item in confirmed if not item["failed"]], key=lambda item: item["score"], reverse=True)
    pick = ready[0] if ready else (sorted(confirmed, key=lambda item: item["score"], reverse=True)[0] if confirmed else None)
    if pick is not None:
        direction = pick["direction"]
        status = "ENTRY" if not pick["failed"] else "BLOCKED"
        side_word = "BUY CE (bullish reversal from demand)" if direction > 0 else "BUY PE (bearish reversal from supply)"
        headline = f"{side_word}: score {pick['score']:.1f}/10" if status == "ENTRY" else f"1m reversal at a {'demand' if direction > 0 else 'supply'} zone, but blocked: {pick['failed'][0]}"
        return {
            **base,
            "status": status,
            "headline": headline,
            "id": f"{pick['side']}:{pick['zone_low']:.0f}-{pick['zone_high']:.0f}:{session_1m[pick['trigger']].time.isoformat()}",
            "side": pick["side"],
            "direction": "BULLISH" if direction > 0 else "BEARISH",
            "zone": {"low": round(pick["zone_low"], 2), "high": round(pick["zone_high"], 2), "sources": list(pick["zone"].sources), "strength": pick["zone"].strength},
            "trigger": {"type": "1m CHoCH", "level": round(pick["choch_level_real"], 2), "time": pick["trigger_time"], "candles_ago": pick["age"], "swept": pick["swept"], "displacement": pick["displacement"]},
            "score": pick["score"],
            "factors": pick["factors"],
            "gates": pick["gates"],
            "counter_trend": pick["counter_trend"],
            "size_multiplier": pick["size_multiplier"],
            "spot": pick["spot"],
            "contract": pick["contract"],
            "premium": pick["premium"],
            "psychology": pick["psychology"],
        }
    priority = {"IN_ZONE": 0, "STALE": 1, "FAILED_FLIP": 2, "NO_IMPULSE": 3, "BROKEN": 4}
    watching = sorted([item for item in evaluated if item["state"] in priority], key=lambda item: priority[item["state"]])
    if watching:
        item = watching[0]
        kind = "demand" if item["direction"] > 0 else "supply"
        zone_text = f"{kind} zone {_fmt(item['zone_low'])}-{_fmt(item['zone_high'])} ({', '.join(item['zone'].sources[:3])})"
        reason = {
            "IN_ZONE": f"Price is testing the {zone_text}; waiting for a 1-minute close through {_fmt(item.get('choch_level_real', 0.0))} to confirm the turn",
            "NO_IMPULSE": f"Price drifted into the {zone_text} without a real push; no reversal to trade yet",
            "STALE": f"1-minute reversal from the {zone_text} happened {item.get('age', 0)} candles ago; not chasing",
            "FAILED_FLIP": f"1-minute flip at the {zone_text} failed (price fell back through {_fmt(item.get('choch_level_real', 0.0))})",
            "BROKEN": f"The {zone_text} broke on a 1-minute close; waiting for the next zone",
        }[item["state"]]
        return {**base, "status": "ARMED" if item["state"] == "IN_ZONE" else "WAIT", "reason": reason, "direction": "BULLISH" if item["direction"] > 0 else "BEARISH"}
    nearest = nearby[0] if nearby else None
    reason = f"Price is between zones; nearest is the {nearest['side'].lower()} zone {_fmt(nearest['low'])}-{_fmt(nearest['high'])} ({nearest['distance']:.0f} pts away)" if nearest else "No demand or supply zone is mapped yet"
    return {**base, "status": "WAIT", "reason": reason}
