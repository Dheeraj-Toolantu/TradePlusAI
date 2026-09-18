from math import isfinite

from .configuration import StrategyConfiguration
from .models import IndicatorSet
from .ohlcv import OHLCVSeries


def _ema(values: list[float], period: int) -> float | None:
    if len(values) < period:
        return None
    result = sum(values[:period]) / period
    multiplier = 2 / (period + 1)
    for value in values[period:]:
        result = (value - result) * multiplier + result
    return result


def _rsi(values: list[float], period: int = 14) -> float | None:
    if len(values) <= period:
        return None
    gains = [max(values[index] - values[index - 1], 0) for index in range(1, len(values))]
    losses = [max(values[index - 1] - values[index], 0) for index in range(1, len(values))]
    average_gain = sum(gains[-period:]) / period
    average_loss = sum(losses[-period:]) / period
    if average_loss == 0:
        return 100.0
    return 100 - 100 / (1 + average_gain / average_loss)


def _atr(series: OHLCVSeries, period: int) -> float | None:
    if len(series.candles) < period:
        return None
    ranges = [max(candle.high - candle.low, abs(candle.high - previous.close), abs(candle.low - previous.close)) for previous, candle in zip(series.candles[-period - 1:-1], series.candles[-period:])]
    return sum(ranges) / len(ranges)


def calculate_indicators(series: OHLCVSeries, config: StrategyConfiguration) -> IndicatorSet:
    closes = [candle.close for candle in series.candles]
    if series.quality.status != "VALID":
        return IndicatorSet(status=series.quality.status, reasons=series.quality.reasons)
    ema9 = _ema(closes, 9)
    ema20 = _ema(closes, 20)
    ema50 = _ema(closes, 50)
    ema200 = _ema(closes, 200)
    atr = _atr(series, config.atr_period)
    volume_values = [candle.volume for candle in series.candles]
    volume_sma = sum(volume_values[-config.volume_period:]) / config.volume_period if len(volume_values) >= config.volume_period else None
    vwap_volume = sum(candle.volume for candle in series.candles)
    vwap = sum(candle.close * candle.volume for candle in series.candles) / vwap_volume if vwap_volume else None
    fast = _ema(closes, 12)
    slow = _ema(closes, 26)
    macd_line = fast - slow if fast is not None and slow is not None else None
    signal = _ema([value for value in closes], 9) if macd_line is not None else None
    macd = (macd_line, signal, macd_line - signal) if macd_line is not None and signal is not None else None
    values = (ema9, ema20, ema50, ema200, _rsi(closes), atr, volume_sma, vwap)
    status = "VALID" if all(value is None or isfinite(value) for value in values) else "INVALID"
    relative_volume = series.candles[-1].volume / volume_sma if volume_sma else None
    return IndicatorSet(ema9, ema20, ema50, ema200, _rsi(closes), macd, None, vwap, atr, volume_sma, relative_volume, status, ())
