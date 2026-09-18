import unittest

from tradepulse_quant.algo_engine.gap_engine import evaluate_gap_day


class GapEngineTests(unittest.TestCase):
    def test_normal_day_does_not_change_or_duration_or_risk(self):
        result = evaluate_gap_day(101, 105, 95, 10)
        self.assertEqual(result.state, "NORMAL_DAY")
        self.assertEqual(result.required_or_duration_minutes, 15)
        self.assertEqual(result.first_trade_risk_multiplier, 1.0)

    def test_gap_up_requires_hold_or_fill_before_entry(self):
        unresolved = evaluate_gap_day(111, 105, 95, 10)
        held = evaluate_gap_day(111, 105, 95, 10, post_opening_lows=[108])
        filled = evaluate_gap_day(111, 105, 95, 10, post_opening_lows=[104])
        self.assertEqual(unresolved.state, "GAP_UP_UNRESOLVED")
        self.assertEqual(held.state, "GAP_HOLD_CONFIRMED")
        self.assertEqual(filled.state, "GAP_FILL_CONFIRMED")
        self.assertEqual(held.first_trade_risk_multiplier, 0.5)

    def test_gap_down_hold_and_fill_are_symmetric(self):
        held = evaluate_gap_day(89, 105, 95, 10, post_opening_highs=[92])
        filled = evaluate_gap_day(89, 105, 95, 10, post_opening_highs=[96])
        self.assertEqual(held.state, "GAP_HOLD_CONFIRMED")
        self.assertEqual(filled.state, "GAP_FILL_CONFIRMED")


if __name__ == "__main__":
    unittest.main()