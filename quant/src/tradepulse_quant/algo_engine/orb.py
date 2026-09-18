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


def evaluate_orb_retest(candles: list[CandleLike]) -> ORBResult:
    """Evaluate only completed, timestamped sessions; missing timestamps fail closed."""
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
    atr = calculate_atr([candle for _, candle, _ in session], 14) or 0.0
    latest = candles[-1]
    for position, (breakout_index, breakout) in enumerate(after_opening):
        direction = "BUY" if breakout.close > opening_high else "SELL" if breakout.close < opening_low else None
        if direction is None:
            continue
        level = opening_high if direction == "BUY" else opening_low
        extension = abs(breakout.close - level)
        max_extension = min(max(latest.close, 1.0) * 0.0035, max(atr, 0.01))
        if extension > max_extension:
            return ORBResult("NO_TRADE", None, "ORB breakout extension exceeded the configured limit", opening_high, opening_low, breakout_index, atr=atr)
        retest_window = after_opening[position + 1:position + 4]
        for retest_index, retest in retest_window:
            if direction == "BUY" and retest.low <= level and retest.close > level and retest.close > retest.open:
                return ORBResult("CONFIRMED", direction, "ORB breakout and retest hold confirmed", opening_high, opening_low, breakout_index, retest_index, atr)
            if direction == "SELL" and retest.high >= level and retest.close < level and retest.close < retest.open:
                return ORBResult("CONFIRMED", direction, "ORB breakdown and retest hold confirmed", opening_high, opening_low, breakout_index, retest_index, atr)
        if len(retest_window) >= 3:
            return ORBResult("NO_TRADE", None, "ORB retest timed out; chasing is blocked", opening_high, opening_low, breakout_index, atr=atr)
    return ORBResult("WAIT_FOR_BREAKOUT", None, "No valid ORB breakout is confirmed", opening_high, opening_low, atr=atr)
