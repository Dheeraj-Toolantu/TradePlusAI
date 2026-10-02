"""Regression tests for the ORB-retest audit fixes (replay dedup, failed-break fall-through,
deep-wick holds, PDH/PDL from exchange daily bars, gap-free intraday ATR)."""
import unittest
from datetime import datetime, timedelta, timezone

from tradepulse_quant.algo_engine.engine import Candle, _normalize_timestamp, analyze
from tradepulse_quant.algo_engine.indicators import atr
from tradepulse_quant.algo_engine.orb import evaluate_orb_retest
from tradepulse_quant.backtest.orb_backtest import replay

IST = timezone(timedelta(hours=5, minutes=30))


def flat_day(date: tuple[int, int, int], base: float = 25_000.0) -> list[dict]:
    start = int(datetime(*date, 9, 15, tzinfo=IST).timestamp())
    return [{"time": start + i * 300, "open": base, "high": base + 10, "low": base - 10, "close": base, "volume": 0} for i in range(75)]


def today(rows: list[tuple[float, float, float, float]]) -> list[dict]:
    """Rows in units where 100 = 25,000 and 1 = 10 points; the rest of the day is quiet at the last close."""
    scaled = [tuple(25_000 + 10 * (value - 100) for value in row) for row in rows]
    last = scaled[-1][3]
    full = scaled + [(last, last + 5, last - 5, last)] * (75 - len(scaled))
    start = int(datetime(2026, 9, 30, 9, 15, tzinfo=IST).timestamp())
    return [{"time": start + i * 300, "open": o, "high": h, "low": l, "close": c, "volume": 0} for i, (o, h, l, c) in enumerate(full)]


PRIOR = flat_day((2026, 9, 28)) + flat_day((2026, 9, 29))
OPENING = [(100, 101, 99, 100)] * 3  # opening range 24,990–25,010


def candles_of(bars: list[dict]) -> list[Candle]:
    return [Candle(_normalize_timestamp(b["time"]), b["open"], b["high"], b["low"], b["close"], 0) for b in bars]


class OrbReplayDedupTest(unittest.TestCase):
    def test_one_breakout_signals_once_while_price_keeps_tagging_the_level(self):
        rows = OPENING + [(100.5, 102.2, 100.5, 102), (101.6, 102, 101.0, 101.8), (101.5, 102, 101.0, 101.9), (101.4, 102, 101.0, 101.7)]
        signals = replay({"symbol": "NIFTY", "from": "2026-09-30", "candles_5m": PRIOR + today(rows), "daily_candles": []})["signals"]
        self.assertEqual(len(signals), 1)
        self.assertEqual(signals[0]["side"], 1)

    def test_the_same_retest_is_not_reported_twice(self):
        rows = OPENING + [(100.5, 102.2, 100.5, 102), (102, 102, 97.5, 97.6), (97.6, 97.7, 96.9, 97.0), (97.0, 98.9, 96.9, 98.8), (98.9, 99.0, 98.0, 98.2)]
        signals = replay({"symbol": "NIFTY", "from": "2026-09-30", "candles_5m": PRIOR + today(rows), "daily_candles": []})["signals"]
        self.assertEqual(len(signals), 1)
        self.assertEqual(signals[0]["side"], -1)


class OrbStateMachineTest(unittest.TestCase):
    def test_a_failed_buy_break_that_closes_below_the_range_is_the_sell_breakout(self):
        rows = OPENING + [(100.5, 102.2, 100.5, 102), (102, 102, 97.5, 97.6)]
        result = evaluate_orb_retest(candles_of(PRIOR + today(rows)[: len(rows)]))
        self.assertEqual(result.side, "SELL")
        self.assertTrue(result.breakout_time.startswith("2026-09-30T09:35"))

    def test_a_retest_whose_wick_fell_through_half_the_range_is_not_a_hold(self):
        # Breakout at 09:30, then a green candle that wicks to 24,989 (below the 25,000 midpoint) and closes above.
        rows = OPENING + [(100.5, 102.2, 100.5, 102), (101.2, 101.8, 98.9, 101.6)]
        result = evaluate_orb_retest(candles_of(PRIOR + today(rows)[: len(rows)]))
        self.assertNotEqual(result.status, "CONFIRMED")


class OrbTargetAndAtrTest(unittest.TestCase):
    def test_pdh_comes_from_the_exchange_daily_bar_when_the_intraday_feed_understates_it(self):
        rows = OPENING + [(100.5, 102.2, 100.5, 102), (101.6, 102, 101.0, 101.8)]
        bars = PRIOR + today(rows)[: len(rows)]
        without_daily = analyze("NIFTY", candles_of(bars), 1000.0, "ORB_RETEST", None)
        self.assertEqual(without_daily["decision"], "CONFIRMED")
        # The real previous-day high (25,030) sits inside the 2R target: no trade.
        daily = [Candle(_normalize_timestamp(int(datetime(2026, 9, 29, 9, 15, tzinfo=IST).timestamp())), 25_000, 25_030, 24_990, 25_000, 0)]
        with_daily = analyze("NIFTY", candles_of(bars), 1000.0, "ORB_RETEST", daily)
        self.assertEqual(with_daily["decision"], "NO_TRADE")
        self.assertIn("PDH 25030", with_daily["reason"])

    def test_overnight_gap_does_not_inflate_intraday_atr(self):
        day1 = [Candle(_normalize_timestamp(int(datetime(2026, 9, 29, 9, 15, tzinfo=IST).timestamp()) + i * 300), 100, 105, 95, 100, 0) for i in range(15)]
        gap = Candle(_normalize_timestamp(int(datetime(2026, 9, 30, 9, 15, tzinfo=IST).timestamp())), 250, 255, 245, 250, 0)
        self.assertAlmostEqual(atr(day1 + [gap], 14), 10.0)


if __name__ == "__main__":
    unittest.main()
