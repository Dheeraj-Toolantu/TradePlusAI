from datetime import datetime, timedelta, timezone

from tradepulse_quant.backtest.orb_backtest import replay


def test_replay_without_candles_returns_no_signals():
    assert replay({"symbol": "NIFTY", "from": "2026-09-01", "candles_5m": [], "daily_candles": []}) == {"signals": [], "evaluated_bars": 0}


def test_replay_only_evaluates_entry_window_bars_from_start_day():
    # 09:15 IST session on 2026-09-30, 75 flat 5-minute bars.
    start = int(datetime(2026, 9, 30, 9, 15, tzinfo=timezone(timedelta(hours=5, minutes=30))).timestamp())
    bars = [{"time": start + i * 300, "open": 100, "high": 101, "low": 99, "close": 100, "volume": 10} for i in range(75)]
    result = replay({"symbol": "NIFTY", "from": "2026-09-30", "candles_5m": bars, "daily_candles": []})
    # Bars closing 09:35..14:45 inclusive: 63 evaluations, and flat prices never confirm an ORB setup.
    assert result["evaluated_bars"] == 63
    assert result["signals"] == []
