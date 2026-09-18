from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from math import isfinite
from typing import Iterable, Literal

from .models import AnalysisQuality

Timeframe = Literal["1m", "3m", "5m", "15m", "30m", "1h", "4h", "Daily", "Weekly"]


@dataclass(frozen=True)
class OHLCV:
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass(frozen=True)
class OHLCVSeries:
    symbol: str
    timeframe: Timeframe
    candles: tuple[OHLCV, ...]
    quality: AnalysisQuality


def _interval(timeframe: Timeframe) -> timedelta:
    values = {"1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "Daily": 1440, "Weekly": 10080}
    return timedelta(minutes=values[timeframe])


def validate_series(symbol: str, timeframe: Timeframe, candles: Iterable[OHLCV], *, now: datetime | None = None, max_age: timedelta = timedelta(minutes=10)) -> OHLCVSeries:
    values = tuple(candles)
    reasons: list[str] = []
    if len(values) < 2:
        reasons.append("insufficient candle history")
    previous: OHLCV | None = None
    expected = _interval(timeframe)
    for candle in values:
        numbers = (candle.open, candle.high, candle.low, candle.close, candle.volume)
        if not all(isfinite(value) for value in numbers):
            reasons.append("non-finite candle value")
            break
        if candle.high < max(candle.open, candle.close, candle.low) or candle.low > min(candle.open, candle.close, candle.high):
            reasons.append("invalid OHLC relationship")
            break
        if candle.volume < 0:
            reasons.append("negative volume")
            break
        if previous is not None:
            gap = candle.timestamp - previous.timestamp
            if gap <= timedelta(0):
                reasons.append("timestamps must be strictly increasing")
                break
            if gap != expected:
                reasons.append("discontinuous candle timestamps")
                break
        previous = candle
    reference = now or datetime.now(timezone.utc)
    if values and reference - values[-1].timestamp > max_age:
        reasons.append("latest candle is stale")
    status = "VALID"
    if any("stale" in reason for reason in reasons):
        status = "STALE"
    elif any("discontinuous" in reason or "timestamps" in reason for reason in reasons):
        status = "DISCONTINUOUS"
    elif any("insufficient" in reason for reason in reasons):
        status = "INSUFFICIENT_DATA"
    elif reasons:
        status = "INVALID"
    return OHLCVSeries(symbol, timeframe, values, AnalysisQuality(status, tuple(reasons)))
