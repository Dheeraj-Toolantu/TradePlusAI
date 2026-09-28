"""Smart Money Concepts on completed 5-minute candles.

Deterministic, no-lookahead implementations of:
- swing highs/lows (fractal, confirmed only after ``SWING_STRENGTH`` later candles close)
- market structure: Break of Structure (BOS, continuation) and Change of Character
  (CHoCH, first break against the prevailing structure)
- Fair Value Gaps (3-candle imbalances) with fill tracking
- Order Blocks (last opposite candle before the impulse that broke structure)
- Liquidity pools (previous-day high/low, equal highs/lows) and liquidity sweeps
- Premium / discount position within the current dealing range
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

from .candles import Bar, split_sessions

SWING_STRENGTH = 2
MAX_ZONES = 4


@dataclass(frozen=True)
class Swing:
    index: int
    kind: str  # "HIGH" | "LOW"
    price: float
    time: str


def find_swings(bars: list[Bar], strength: int = SWING_STRENGTH) -> list[Swing]:
    swings: list[Swing] = []
    for index in range(strength, len(bars) - strength):
        left = bars[index - strength:index]
        right = bars[index + 1:index + 1 + strength]
        bar = bars[index]
        if all(bar.high > other.high for other in left) and all(bar.high >= other.high for other in right):
            swings.append(Swing(index, "HIGH", bar.high, bar.time.isoformat()))
        if all(bar.low < other.low for other in left) and all(bar.low <= other.low for other in right):
            swings.append(Swing(index, "LOW", bar.low, bar.time.isoformat()))
    return swings


def _order_block(bars: list[Bar], start: int, end: int, bullish: bool) -> dict | None:
    """Last opposite-colour candle at or before the extreme of the leg that broke structure."""
    if end <= start:
        return None
    leg = range(start, end + 1)
    extreme = min(leg, key=lambda i: bars[i].low) if bullish else max(leg, key=lambda i: bars[i].high)
    for index in range(extreme, max(start - 6, -1), -1):
        bar = bars[index]
        if (bullish and bar.bearish) or (not bullish and bar.bullish):
            return {"index": index, "direction": "BULLISH" if bullish else "BEARISH", "top": bar.high, "bottom": bar.low, "time": bar.time.isoformat()}
    return None


def market_structure(bars: list[Bar], swings: list[Swing]) -> tuple[str, list[dict], list[dict]]:
    """Walk candles forward, using only swings already confirmed at each close."""
    trend = "UNKNOWN"
    events: list[dict] = []
    blocks: list[dict] = []
    last_high: Swing | None = None
    last_low: Swing | None = None
    broken: set[int] = set()
    pending = sorted(swings, key=lambda swing: swing.index + SWING_STRENGTH)
    cursor = 0
    for index, bar in enumerate(bars):
        while cursor < len(pending) and pending[cursor].index + SWING_STRENGTH <= index:
            swing = pending[cursor]
            if swing.kind == "HIGH":
                last_high = swing
            else:
                last_low = swing
            cursor += 1
        if last_high is not None and last_high.index not in broken and bar.close > last_high.price:
            kind = "CHOCH" if trend == "BEARISH" else "BOS"
            events.append({"type": kind, "direction": "BULLISH", "level": last_high.price, "index": index, "time": bar.time.isoformat()})
            block = _order_block(bars, last_high.index, index, bullish=True)
            if block:
                blocks.append(block)
            broken.add(last_high.index)
            trend = "BULLISH"
        elif last_low is not None and last_low.index not in broken and bar.close < last_low.price:
            kind = "CHOCH" if trend == "BULLISH" else "BOS"
            events.append({"type": kind, "direction": "BEARISH", "level": last_low.price, "index": index, "time": bar.time.isoformat()})
            block = _order_block(bars, last_low.index, index, bullish=False)
            if block:
                blocks.append(block)
            broken.add(last_low.index)
            trend = "BEARISH"
    return trend, events, blocks


def _active_blocks(bars: list[Bar], blocks: list[dict]) -> list[dict]:
    active = []
    for block in blocks:
        later = bars[block["index"] + 1:]
        if block["direction"] == "BULLISH":
            invalidated = any(bar.close < block["bottom"] for bar in later)
            tested = any(bar.low <= block["top"] for bar in later[2:])
        else:
            invalidated = any(bar.close > block["top"] for bar in later)
            tested = any(bar.high >= block["bottom"] for bar in later[2:])
        if not invalidated:
            active.append({**block, "tested": tested})
    unique = {(b["direction"], round(b["top"], 2), round(b["bottom"], 2)): b for b in active}
    return sorted(unique.values(), key=lambda block: block["index"], reverse=True)[:MAX_ZONES]


def fair_value_gaps(bars: list[Bar], atr_value: float | None) -> list[dict]:
    """Unfilled 3-candle imbalances inside a single session (overnight gaps are excluded)."""
    minimum = max((atr_value or 0.0) * 0.1, (bars[-1].close if bars else 0.0) * 0.0001)
    gaps: list[dict] = []
    for index in range(2, len(bars)):
        first, middle, third = bars[index - 2], bars[index - 1], bars[index]
        if not (first.time.date() == middle.time.date() == third.time.date()):
            continue
        later = bars[index + 1:]
        if third.low > first.high and third.low - first.high >= minimum:
            bottom, top = first.high, third.low
            deepest = min((bar.low for bar in later), default=top)
            if deepest > bottom:
                gaps.append({"direction": "BULLISH", "top": top, "bottom": bottom, "mid": (top + bottom) / 2, "index": index - 1, "time": middle.time.isoformat(), "partially_filled": deepest < top})
        elif third.high < first.low and first.low - third.high >= minimum:
            top, bottom = first.low, third.high
            highest = max((bar.high for bar in later), default=bottom)
            if highest < top:
                gaps.append({"direction": "BEARISH", "top": top, "bottom": bottom, "mid": (top + bottom) / 2, "index": index - 1, "time": middle.time.isoformat(), "partially_filled": highest > bottom})
    return sorted(gaps, key=lambda gap: gap["index"], reverse=True)[:MAX_ZONES * 2]


def liquidity(bars: list[Bar], swings: list[Swing], atr_value: float | None) -> dict:
    session, previous = split_sessions(bars)
    price = bars[-1].close if bars else 0.0
    tolerance = max((atr_value or 0.0) * 0.1, price * 0.0003)
    highs = [s for s in swings if s.kind == "HIGH"]
    lows = [s for s in swings if s.kind == "LOW"]

    def equal_levels(points: list[Swing], above: bool) -> list[dict]:
        levels = []
        for first, second in zip(points, points[1:]):
            if abs(first.price - second.price) > tolerance:
                continue
            level = max(first.price, second.price) if above else min(first.price, second.price)
            later = bars[second.index + 1:]
            swept = any(bar.high > level for bar in later) if above else any(bar.low < level for bar in later)
            if swept:
                continue
            existing = next((item for item in levels if abs(item["level"] - level) <= tolerance), None)
            if existing:
                existing["touches"] += 1
                existing["level"] = max(existing["level"], level) if above else min(existing["level"], level)
            else:
                levels.append({"level": level, "touches": 2, "time": second.time})
        return levels[-3:]

    return {
        "previous_day_high": max((bar.high for bar in previous), default=None),
        "previous_day_low": min((bar.low for bar in previous), default=None),
        "session_high": max((bar.high for bar in session), default=None),
        "session_low": min((bar.low for bar in session), default=None),
        "equal_highs": equal_levels(highs, above=True),
        "equal_lows": equal_levels(lows, above=False),
    }


def liquidity_sweeps(bars: list[Bar], swings: list[Swing], pools: dict, lookback: int = 6) -> list[dict]:
    """A wick through resting liquidity that closes back inside = a sweep (stop hunt)."""
    sweeps: list[dict] = []
    start = max(len(bars) - lookback, 1)
    for index in range(start, len(bars)):
        bar = bars[index]
        confirmed_highs = [s.price for s in swings if s.kind == "HIGH" and s.index + SWING_STRENGTH < index]
        confirmed_lows = [s.price for s in swings if s.kind == "LOW" and s.index + SWING_STRENGTH < index]
        buy_side = [("Previous day high", pools.get("previous_day_high"))] + [("Swing high", level) for level in confirmed_highs[-3:]]
        sell_side = [("Previous day low", pools.get("previous_day_low"))] + [("Swing low", level) for level in confirmed_lows[-3:]]
        for label, level in buy_side:
            if level and bar.high > level and bar.close < level:
                sweeps.append({"side": "BUY_SIDE", "bias": "BEARISH", "label": label, "level": level, "index": index, "time": bar.time.isoformat()})
                break
        for label, level in sell_side:
            if level and bar.low < level and bar.close > level:
                sweeps.append({"side": "SELL_SIDE", "bias": "BULLISH", "label": label, "level": level, "index": index, "time": bar.time.isoformat()})
                break
    return sweeps[-3:]


def dealing_range(bars: list[Bar], swings: list[Swing]) -> dict | None:
    session, _ = split_sessions(bars)
    if len(session) >= 6:
        high, low = max(bar.high for bar in session), min(bar.low for bar in session)
        basis = "Today's range"
    else:
        highs = [s for s in swings if s.kind == "HIGH"]
        lows = [s for s in swings if s.kind == "LOW"]
        if not highs or not lows:
            return None
        high, low = highs[-1].price, lows[-1].price
        basis = "Last swing range"
    if high <= low:
        return None
    price = bars[-1].close
    position = (price - low) / (high - low)
    zone = "PREMIUM" if position > 0.55 else "DISCOUNT" if position < 0.45 else "EQUILIBRIUM"
    return {"high": high, "low": low, "equilibrium": (high + low) / 2, "position_pct": round(position * 100, 1), "zone": zone, "basis": basis}


def swing_sequence(swings: list[Swing]) -> str:
    highs = [s.price for s in swings if s.kind == "HIGH"][-2:]
    lows = [s.price for s in swings if s.kind == "LOW"][-2:]
    if len(highs) < 2 or len(lows) < 2:
        return "INSUFFICIENT"
    if highs[1] > highs[0] and lows[1] > lows[0]:
        return "HH_HL"
    if highs[1] < highs[0] and lows[1] < lows[0]:
        return "LH_LL"
    return "MIXED"


def analyze_smart_money(bars: list[Bar], atr_value: float | None) -> dict:
    if len(bars) < 10:
        return {"available": False, "reason": "At least 10 completed 5-minute candles are required"}
    swings = find_swings(bars)
    trend, events, blocks = market_structure(bars, swings)
    pools = liquidity(bars, swings, atr_value)
    price = bars[-1].close
    fvgs = fair_value_gaps(bars, atr_value)
    for gap in fvgs:
        gap["distance"] = round(price - gap["mid"], 2)
    return {
        "available": True,
        "trend": trend,
        "swing_sequence": swing_sequence(swings),
        "last_event": events[-1] if events else None,
        "events": events[-5:],
        "swings": [asdict(s) for s in swings[-8:]],
        "fair_value_gaps": fvgs,
        "order_blocks": _active_blocks(bars, blocks),
        "liquidity": pools,
        "sweeps": liquidity_sweeps(bars, swings, pools),
        "dealing_range": dealing_range(bars, swings),
    }
