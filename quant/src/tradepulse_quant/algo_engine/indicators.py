"""Reference implementations of the V5 technical indicators."""
from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol


class CandleLike(Protocol):
    high: float
    low: float
    close: float
    volume: float


def ema(values: Sequence[float], period: int) -> float | None:
    if period <= 0:
        raise ValueError("period must be positive")
    if len(values) < period:
        return None
    result = sum(values[:period]) / period
    multiplier = 2.0 / (period + 1)
    for value in values[period:]:
        result = (value - result) * multiplier + result
    return result


def true_range(current: CandleLike, previous_close: float | None = None) -> float:
    if previous_close is None:
        return current.high - current.low
    return max(current.high - current.low, abs(current.high - previous_close), abs(current.low - previous_close))


def atr(candles: Sequence[CandleLike], period: int = 14) -> float | None:
    if period <= 0:
        raise ValueError("period must be positive")
    if len(candles) < period:
        return None
    ranges = [true_range(candle, candles[index - 1].close if index else None) for index, candle in enumerate(candles)]
    result = sum(ranges[:period]) / period
    for value in ranges[period:]:
        result = ((result * (period - 1)) + value) / period
    return result


def vwap(candles: Sequence[CandleLike]) -> float | None:
    total_volume = sum(candle.volume for candle in candles)
    if total_volume <= 0:
        return None
    return sum(((candle.high + candle.low + candle.close) / 3.0) * candle.volume for candle in candles) / total_volume


def adx(candles: Sequence[CandleLike], period: int = 14) -> float | None:
    if period <= 0:
        raise ValueError("period must be positive")
    if len(candles) < period * 2:
        return None
    true_ranges: list[float] = []
    positive_moves: list[float] = []
    negative_moves: list[float] = []
    for previous, current in zip(candles, candles[1:]):
        upward = current.high - previous.high
        downward = previous.low - current.low
        true_ranges.append(true_range(current, previous.close))
        positive_moves.append(upward if upward > downward and upward > 0 else 0.0)
        negative_moves.append(downward if downward > upward and downward > 0 else 0.0)

    smoothed_tr = sum(true_ranges[:period])
    smoothed_positive = sum(positive_moves[:period])
    smoothed_negative = sum(negative_moves[:period])
    directional_indices: list[float] = []
    for index in range(period, len(true_ranges) + 1):
        if smoothed_tr == 0:
            directional_indices.append(0.0)
        else:
            positive_di = 100.0 * smoothed_positive / smoothed_tr
            negative_di = 100.0 * smoothed_negative / smoothed_tr
            denominator = positive_di + negative_di
            directional_indices.append(0.0 if denominator == 0 else 100.0 * abs(positive_di - negative_di) / denominator)
        if index < len(true_ranges):
            smoothed_tr = smoothed_tr - (smoothed_tr / period) + true_ranges[index]
            smoothed_positive = smoothed_positive - (smoothed_positive / period) + positive_moves[index]
            smoothed_negative = smoothed_negative - (smoothed_negative / period) + negative_moves[index]

    if len(directional_indices) < period:
        return None
    result = sum(directional_indices[:period]) / period
    for value in directional_indices[period:]:
        result = ((result * (period - 1)) + value) / period
    return result