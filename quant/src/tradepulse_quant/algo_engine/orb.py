"""Deterministic NIFTY 15-minute opening-range breakout and retest checks."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timedelta
from typing import Protocol

from .indicators import atr as calculate_atr


class CandleLike(Protocol):
    timestamp: str
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass(frozen=True)
class ORBResult:
    status: str
    side: str | None
    reason: str
    opening_range_high: float | None = None
    opening_range_low: float | None = None
    breakout_index: int | None = None
    retest_index: int | None = None
    atr: float = 0.0
    bars_since_retest: int | None = None
    retest_low: float | None = None
    retest_high: float | None = None
    breakout_time: str | None = None
    retest_time: str | None = None
    opening_minutes: int = 15


def _timestamp(value: str) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed


def _vwap(candles: list[CandleLike]) -> float:
    volume = sum(max(candle.volume, 1.0) for candle in candles)
    return sum(candle.close * max(candle.volume, 1.0) for candle in candles) / volume


RETEST_ZONE_ATR = 0.1  # spec 6B "or defined breakout zone": a retest may stop 0.1 x ATR short of the level
MAX_RETEST_CANDLES = 3


def evaluate_orb_retest(candles: list[CandleLike], atr_value: float | None = None, opening_minutes: int = 15) -> ORBResult:
    """Evaluate only completed, timestamped sessions; missing timestamps fail closed.

    ``atr_value`` should come from the full multi-session history (a session-only ATR is
    undefined until ~10:25 IST). ``opening_minutes`` is 15 on normal days and 30 on gap days
    (spec 4). Callers must pass COMPLETED candles only; a forming candle would repaint.
    """
    timestamps = [_timestamp(candle.timestamp) for candle in candles]
    if len(candles) < 6 or any(value is None for value in timestamps):
        return ORBResult("NO_TRADE", None, "ORB requires timestamped 5-minute candles", opening_minutes=opening_minutes)
    session_date = timestamps[-1].date()
    session = [(index, candle, timestamps[index]) for index, candle in enumerate(candles) if timestamps[index].date() == session_date]
    or_end = (datetime.combine(session_date, time(9, 15)) + timedelta(minutes=opening_minutes)).time()
    opening = [(index, candle) for index, candle, timestamp in session if time(9, 15) <= timestamp.time() < or_end]
    if len(opening) < opening_minutes // 5:
        return ORBResult("WAIT_FOR_BREAKOUT", None, f"{opening_minutes}-minute opening range is incomplete", opening_minutes=opening_minutes)
    opening_high = max(candle.high for _, candle in opening)
    opening_low = min(candle.low for _, candle in opening)
    after_opening = [(index, candle) for index, candle, _ in session if index > opening[-1][0]]
    base = {"opening_range_high": opening_high, "opening_range_low": opening_low, "opening_minutes": opening_minutes}
    if not after_opening:
        return ORBResult("WAIT_FOR_BREAKOUT", None, "Waiting for a candle after the opening range", **base)
    atr = atr_value if atr_value and atr_value > 0 else (calculate_atr(candles, 14) or 0.0)
    zone = RETEST_ZONE_ATR * atr
    last_index = len(candles) - 1
    stamp = lambda index: timestamps[index].isoformat()
    for position, (breakout_index, breakout) in enumerate(after_opening):
        direction = "BUY" if breakout.close > opening_high else "SELL" if breakout.close < opening_low else None
        if direction is None:
            continue
        level = opening_high if direction == "BUY" else opening_low
        # Spec 6A: max extension = min(0.35% of spot, 1.0 x ATR(5m)).
        max_extension = min(max(breakout.close, 1.0) * 0.0035, atr) if atr > 0 else max(breakout.close, 1.0) * 0.0035
        found = {**base, "breakout_index": breakout_index, "atr": atr, "breakout_time": stamp(breakout_index)}
        if abs(breakout.close - level) > max_extension:
            return ORBResult("NO_TRADE", None, f"Breakout candle closed {abs(breakout.close - level):.1f} pts beyond the level (limit {max_extension:.1f}); chasing is blocked", **found)
        # Furthest price travelled beyond the level before a valid retest (spec 6A: "before a valid retest").
        excursion = breakout.close - level if direction == "BUY" else level - breakout.close
        retest_window = after_opening[position + 1:position + 1 + MAX_RETEST_CANDLES]
        for retest_index, retest in retest_window:
            touched = retest.low <= level + zone if direction == "BUY" else retest.high >= level - zone
            held = retest.close > level if direction == "BUY" else retest.close < level
            confirmed_colour = retest.close > retest.open if direction == "BUY" else retest.close < retest.open
            if touched and held and confirmed_colour:
                if excursion > max_extension:
                    return ORBResult("NO_TRADE", None, f"Price ran {excursion:.1f} pts beyond the level before retesting (limit {max_extension:.1f}); chasing is blocked", **found)
                entry_distance = abs(retest.close - level)
                if entry_distance > max_extension:
                    return ORBResult("NO_TRADE", None, f"Retest candle closed {entry_distance:.1f} pts beyond the level (limit {max_extension:.1f}); entering there would be chasing", **found)
                return ORBResult("CONFIRMED", direction, f"ORB {'breakout' if direction == 'BUY' else 'breakdown'} and retest hold confirmed", **found, retest_index=retest_index, bars_since_retest=last_index - retest_index, retest_low=retest.low, retest_high=retest.high, retest_time=stamp(retest_index))
            # Spec 6B: a close back through the level invalidates the breakout entirely.
            if not held:
                return ORBResult("NO_TRADE", None, "ORB retest failed; price closed back inside the opening range", **found)
            excursion = max(excursion, (retest.high - level) if direction == "BUY" else (level - retest.low))
        if len(retest_window) >= MAX_RETEST_CANDLES:
            return ORBResult("NO_TRADE", None, f"No retest within {MAX_RETEST_CANDLES} candles of the breakout; chasing is blocked", **found)
        # Retest window still open: never re-read the pending retest candles as fresh breakouts.
        return ORBResult("WAIT_FOR_RETEST", direction, f"Breakout seen; waiting up to {MAX_RETEST_CANDLES - len(retest_window)} more candle(s) for a retest of {level:.2f}", **found)
    return ORBResult("WAIT_FOR_BREAKOUT", None, "No candle has closed outside the opening range yet", **base, atr=atr)
