from datetime import datetime, timedelta, timezone

from tradepulse_quant.signals.configuration import StrategyConfiguration
from tradepulse_quant.signals.ohlcv import OHLCV, validate_series


def candles(count=3):
    start = datetime(2026, 9, 10, 9, 15, tzinfo=timezone.utc)
    return [OHLCV(start + timedelta(minutes=index), 10, 11, 9, 10.5, 100) for index in range(count)]


def test_valid_series_and_reproducibility_key():
    series = validate_series("NIFTY", "1m", candles(), now=candles()[-1].timestamp)
    assert series.quality.status == "VALID"
    assert StrategyConfiguration().reproducibility_key() == StrategyConfiguration().reproducibility_key()


def test_invalid_ohlc_is_blocked():
    values = candles()
    values[1] = OHLCV(values[1].timestamp, 10, 8, 9, 9, 100)
    result = validate_series("NIFTY", "1m", values, now=values[-1].timestamp)
    assert result.quality.status == "INVALID"
    assert "invalid OHLC relationship" in result.quality.reasons


def test_gap_and_stale_data_are_explicit():
    values = candles()
    values[1] = OHLCV(values[0].timestamp + timedelta(minutes=2), 10, 11, 9, 10.5, 100)
    result = validate_series("NIFTY", "1m", values, now=values[-1].timestamp + timedelta(minutes=11))
    assert result.quality.status == "STALE"
    assert "discontinuous candle timestamps" in result.quality.reasons
    assert "latest candle is stale" in result.quality.reasons
