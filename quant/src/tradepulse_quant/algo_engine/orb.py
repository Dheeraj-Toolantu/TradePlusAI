"""Deterministic NIFTY 15-minute opening-range breakout and retest checks."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time
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


def evaluate_orb_retest(candles: list[CandleLike], atr_value: float | None = None) -> ORBResult:
    """Evaluate only completed, timestamped sessions; missing timestamps fail closed.

    ``atr_value`` should be computed from the full multi-session history supplied by the
    caller. Falling back to session-only candles leaves ATR undefined until ~10:25 IST,
    which previously collapsed the extension limit to 0.01 and rejected every early breakout.
    """
    timestamps = [_timestamp(candle.timestamp) for candle in candles]
    if len(candles) < 6 or any(value is None for value in timestamps):
        return ORBResult("NO_TRADE", None, "ORB requires timestamped 5-minute candles")
    session_date = timestamps[-1].date()
    session = [(index, candle, timestamps[index]) for index, candle in enumerate(candles) if timestamps[index].date() == session_date]
    opening = [(index, candle) for index, candle, timestamp in session if time(9, 15) <= timestamp.time() < time(9, 30)]
    if len(opening) < 3:
        return ORBResult("WAIT_FOR_BREAKOUT", None, "15-minute opening range is incomplete")
    opening_high = max(candle.high for _, candle in opening)
    opening_low = min(candle.low for _, candle in opening)
    after_opening = [(index, candle) for index, candle, _ in session if index > opening[-1][0]]
    if not after_opening:
        return ORBResult("WAIT_FOR_BREAKOUT", None, "Waiting for a candle after the opening range", opening_high, opening_low)
    atr = atr_value if atr_value and atr_value > 0 else (calculate_atr(candles, 14) or 0.0)
    last_index = len(candles) - 1
    for position, (breakout_index, breakout) in enumerate(after_opening):
        direction = "BUY" if breakout.close > opening_high else "SELL" if breakout.close < opening_low else None
        if direction is None:
            continue
        level = opening_high if direction == "BUY" else opening_low
        extension = abs(breakout.close - level)
        # Spec 6A: max extension = min(0.35% of spot, 1.0 x ATR(5m)).
        max_extension = min(max(breakout.close, 1.0) * 0.0035, atr) if atr > 0 else max(breakout.close, 1.0) * 0.0035
        if extension > max_extension:
            return ORBResult("NO_TRADE", None, "ORB breakout extension exceeded the configured limit", opening_high, opening_low, breakout_index, atr=atr)
        retest_window = after_opening[position + 1:position + 4]
        for retest_index, retest in retest_window:
            if direction == "BUY" and retest.low <= level and retest.close > level and retest.close > retest.open:
                return ORBResult("CONFIRMED", direction, "ORB breakout and retest hold confirmed", opening_high, opening_low, breakout_index, retest_index, atr, last_index - retest_index, retest.low, retest.high)
            if direction == "SELL" and retest.high >= level and retest.close < level and retest.close < retest.open:
                return ORBResult("CONFIRMED", direction, "ORB breakdown and retest hold confirmed", opening_high, opening_low, breakout_index, retest_index, atr, last_index - retest_index, retest.low, retest.high)
            # Spec 6B: a close back through the level invalidates the breakout entirely.
            if (direction == "BUY" and retest.close < level) or (direction == "SELL" and retest.close > level):
                return ORBResult("NO_TRADE", None, "ORB retest failed; price closed back inside the opening range", opening_high, opening_low, breakout_index, atr=atr)
        if len(retest_window) >= 3:
            return ORBResult("NO_TRADE", None, "ORB retest timed out; chasing is blocked", opening_high, opening_low, breakout_index, atr=atr)
        # Retest window still open: never re-read the pending retest candles as fresh breakouts.
        return ORBResult("WAIT_FOR_RETEST", direction, f"Breakout seen; waiting up to {3 - len(retest_window)} more candle(s) for a retest", opening_high, opening_low, breakout_index, atr=atr)
    return ORBResult("WAIT_FOR_BREAKOUT", None, "No valid ORB breakout is confirmed", opening_high, opening_low, atr=atr)
