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


def fresh_session_candles() -> list[Candle]:
    """Previous session history, then an opening range, a breakout and a retest as the latest candle."""
    previous = datetime(2026, 9, 11, 9, 15)
    candles = [Candle((previous + timedelta(minutes=5 * index)).isoformat(), 99.5, 100.6, 99.4, 100 + (index % 3) * 0.1, 1_000) for index in range(40)]
    start = datetime(2026, 9, 12, 9, 15)
    candles += [Candle((start + timedelta(minutes=5 * index)).isoformat(), 100, 101, 99, 100, 1_000) for index in range(3)]
    candles.append(Candle((start + timedelta(minutes=15)).isoformat(), 100.9, 101.5, 100.8, 101.3, 2_000))
    candles.append(Candle((start + timedelta(minutes=20)).isoformat(), 100.8, 101.4, 100.5, 101.2, 1_800))
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

    def test_stale_retest_is_not_chased(self):
        result = analyze("NIFTY", session_candles(), strategy="ORB_RETEST")
        self.assertEqual(result["strategy"], "ORB_RETEST")
        self.assertEqual(result["decision"], "SIGNAL_EXPIRED")
        self.assertIsNone(result["setup"])

    def test_fresh_retest_uses_structural_stop(self):
        result = analyze("NIFTY", fresh_session_candles(), strategy="ORB_RETEST")
        self.assertEqual(result["decision"], "CONFIRMED")
        setup = result["setup"]
        self.assertEqual(setup["side"], "BUY")
        self.assertLess(setup["stop_loss"], 100.5)  # below the retest low, minus the ATR buffer
        self.assertEqual(setup["risk_reward"], 2.0)
        self.assertEqual(setup["stop_method"], "RETEST_EXTREME_MINUS_ATR_BUFFER")

    def test_pending_retest_candles_are_not_reread_as_breakouts(self):
        candles = fresh_session_candles()[:-1]
        result = evaluate_orb_retest(candles)
        self.assertEqual(result.status, "WAIT_FOR_RETEST")
        self.assertEqual(result.side, "BUY")

    def test_early_breakout_uses_multi_session_atr(self):
        # Only 5 session candles exist, so a session-only ATR would be undefined.
        result = evaluate_orb_retest(fresh_session_candles())
        self.assertEqual(result.status, "CONFIRMED")
        self.assertGreater(result.atr, 0.5)

    def test_failed_retest_invalidates_breakout(self):
        candles = fresh_session_candles()[:-1]
        last = candles[-1]
        candles.append(Candle((datetime.fromisoformat(last.timestamp) + timedelta(minutes=5)).isoformat(), 101.1, 101.2, 99.8, 100.2, 1_500))
        result = evaluate_orb_retest(candles)
        # The break is dead; the scan waits for a fresh break of either side instead of ending the day.
        self.assertEqual(result.status, "WAIT_FOR_BREAKOUT")
        self.assertIsNone(result.side)
        self.assertIn("failed", result.reason)


if __name__ == "__main__":
    unittest.main()
