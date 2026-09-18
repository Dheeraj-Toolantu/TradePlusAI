from dataclasses import dataclass
from typing import Literal

from .ohlcv import OHLCVSeries


@dataclass(frozen=True)
class CandlestickPattern:
    name: str
    direction: Literal["BULLISH", "BEARISH", "NEUTRAL"]
    state: Literal["UNCONFIRMED", "WEAK", "POTENTIAL", "CONFIRMED", "STRONG"]
    index: int


def detect_candlestick_patterns(series: OHLCVSeries) -> tuple[CandlestickPattern, ...]:
    if series.quality.status != "VALID" or not series.candles:
        return ()
    candles = series.candles
    current = candles[-1]
    body = abs(current.close - current.open)
    total = current.high - current.low
    if total <= 0:
        return ()
    upper = current.high - max(current.open, current.close)
    lower = min(current.open, current.close) - current.low
    found: list[CandlestickPattern] = []
    if body <= total * 0.1:
        found.append(CandlestickPattern("Doji", "NEUTRAL", "POTENTIAL", len(candles) - 1))
    if len(candles) >= 2:
        previous = candles[-2]
        if previous.close < previous.open and current.close > current.open and current.open <= previous.close and current.close >= previous.open:
            found.append(CandlestickPattern("Bullish Engulfing", "BULLISH", "POTENTIAL", len(candles) - 1))
        if previous.close > previous.open and current.close < current.open and current.open >= previous.close and current.close <= previous.open:
            found.append(CandlestickPattern("Bearish Engulfing", "BEARISH", "POTENTIAL", len(candles) - 1))
    if lower >= body * 2 and upper <= max(body, total * 0.1):
        found.append(CandlestickPattern("Hammer", "BULLISH", "POTENTIAL", len(candles) - 1))
    if upper >= body * 2 and lower <= max(body, total * 0.1):
        found.append(CandlestickPattern("Shooting Star", "BEARISH", "POTENTIAL", len(candles) - 1))
    return tuple(found)
