import unittest

from tradepulse_quant.algo_engine.regime_engine import classify_regime


class RegimeEngineTests(unittest.TestCase):
    def test_enters_and_holds_bullish_trend_with_hysteresis(self):
        inputs = dict(close=102, vwap_value=100, ema_fast=101, ema_slow=99, trend_15m="BULL")
        self.assertEqual(classify_regime(22, **inputs), "TRENDING_BULL")
        self.assertEqual(classify_regime(16, previous="TRENDING_BULL", **inputs), "TRENDING_BULL")
        self.assertEqual(classify_regime(15.9, previous="TRENDING_BULL", **inputs), "CHOP")

    def test_orb_entry_threshold_accepts_an_emerging_trend(self):
        inputs = dict(close=102, vwap_value=100, ema_fast=101, ema_slow=99, trend_15m="BULL")
        self.assertEqual(classify_regime(19, **inputs), "CHOP")
        self.assertEqual(classify_regime(19, entry_threshold=18, **inputs), "TRENDING_BULL")
        self.assertEqual(classify_regime(19, entry_threshold=18, close=102, vwap_value=100, ema_fast=99, ema_slow=101, trend_15m="BULL"), "CHOP")

    def test_range_conflict_and_gap_override_are_blocked(self):
        self.assertEqual(classify_regime(17, 100, 100, 100, 100, vwap_crosses=2), "RANGE")
        self.assertEqual(classify_regime(25, 102, 100, 101, 99, trend_15m="BEAR"), "CHOP")
        self.assertEqual(classify_regime(25, 102, 100, 101, 99, trend_15m="BULL", gap_state="GAP_UP_UNRESOLVED"), "CHOP")


if __name__ == "__main__":
    unittest.main()