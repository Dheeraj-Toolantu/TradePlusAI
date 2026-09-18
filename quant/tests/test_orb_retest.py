import unittest
from datetime import datetime, timedelta

from tradepulse_quant.algo_engine.engine import Candle, analyze
from tradepulse_quant.algo_engine.orb import evaluate_orb_retest


def session_candles() -> list[Candle]:
    start = datetime(2026, 9, 12, 9, 15)
    candles = [Candle((start + timedelta(minutes=5 * index)).isoformat(), 100, 101, 99, 100, 1_000) for index in range(3)]
    candles.append(Candle((start + timedelta(minutes=15)).isoformat(), 101, 101.5, 100.5, 101.2, 2_000))
    candles.append(Candle((start + timedelta(minutes=20)).isoformat(), 100.8, 101.4, 100.5, 101.2, 1_800))
    for index in range(5, 21):
        timestamp = start + timedelta(minutes=5 * index)
        candles.append(Candle(timestamp.isoformat(), 102, 103, 101.5, 102.5, 1_000))
    return candles


class OrbRetestTest(unittest.TestCase):
    def test_breakout_and_retest_are_required(self):
        result = evaluate_orb_retest(session_candles())
        self.assertEqual(result.status, "CONFIRMED")
        self.assertEqual(result.side, "BUY")
        self.assertEqual(result.opening_range_high, 101)
        self.assertIsNotNone(result.retest_index)

    def test_missing_timestamps_fails_closed(self):
        candles = session_candles()
        candles[-1] = Candle("", candles[-1].open, candles[-1].high, candles[-1].low, candles[-1].close, candles[-1].volume)
        result = evaluate_orb_retest(candles)
        self.assertEqual(result.status, "NO_TRADE")

    def test_algo_engine_uses_orb_strategy(self):
        result = analyze("NIFTY", session_candles(), strategy="ORB_RETEST")
        self.assertEqual(result["strategy"], "ORB_RETEST")
        self.assertEqual(result["decision"], "CONFIRMED")
        self.assertEqual(result["setup"]["risk_reward"], 2.0)


if __name__ == "__main__":
    unittest.main()
