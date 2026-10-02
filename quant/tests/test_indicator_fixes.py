from tradepulse_quant.signals.indicators import _ema, _ema_series, _rsi


def test_rsi_uses_wilder_smoothing_through_latest_close():
    up_then_down = [100 + i for i in range(20)] + [119 - i * 2 for i in range(20)]
    assert _rsi(up_then_down) < 30
    assert _rsi([100 + i for i in range(30)]) == 100.0
    assert _rsi([100.0] * 30) == 50.0


def test_macd_signal_is_ema_of_macd_line_not_price():
    closes = [100 + i * 0.5 for i in range(80)]
    fast = _ema_series(closes, 12)
    slow = _ema_series(closes, 26)
    macd_series = [f - s for f, s in zip(fast[len(fast) - len(slow):], slow)]
    signal = _ema(macd_series, 9)
    # In a steady trend MACD flattens, so the signal sits right on the MACD line (an EMA of
    # price would be ~100+ points away).
    assert abs(macd_series[-1] - signal) < 0.05
