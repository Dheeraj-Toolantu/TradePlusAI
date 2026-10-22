import unittest
from datetime import datetime, timedelta, timezone

from tradepulse_quant.algo_engine.premium_math import PremiumConfig, bs_greeks, evaluate
from tradepulse_quant.algo_engine.pipeline import evaluate_payload

IST = timezone(timedelta(hours=5, minutes=30))
NOW = datetime(2026, 10, 22, 11, 0, tzinfo=IST)


def example(**overrides):
    # The user's worked example: NIFTY 22,624, key level 22,500, PE at Rs 80 with delta -0.35.
    args = dict(spot=22624, key_level=22500, option_type="PE", strike=22550, entry=80, expiry="2026-10-27", now=NOW, iv=14, delta=-0.35, bid=79, ask=81, liquidity=3)
    args.update(overrides)
    return evaluate(**args)


class CalculatorTest(unittest.TestCase):
    def test_worked_example(self):
        r = example()
        self.assertEqual(r["move_points"], 124)
        self.assertAlmostEqual(r["move_pct"], 0.548, places=3)
        self.assertEqual((r["target_premium"], r["stop_premium"]), (120, 60))
        self.assertEqual(r["return_pct"], 50)
        self.assertEqual(r["risk_reward"], 2.0)
        self.assertEqual(r["move_needed_delta"], 114.3)
        self.assertEqual(r["index_target_delta"], 22509.7)
        self.assertTrue(r["valid"], r["reason"])

    def test_greeks_estimate_includes_gamma_and_theta(self):
        r = example()
        greeks = r["greeks"]
        self.assertGreater(greeks["gamma"], 0)
        self.assertLess(greeks["theta"], 0)
        # Gamma shortens the move, theta lengthens it; both are in the Greeks figure.
        delta_only = example(iv=None)  # no IV: no gamma/theta, the Greeks figure falls back to delta only
        self.assertIsNone(delta_only["greeks"]["gamma"])
        self.assertEqual(delta_only["move_needed_greeks"], delta_only["move_needed_delta"])
        no_decay = evaluate(22624, 22500, "PE", 22550, 80, "2026-10-27", NOW, iv=14, delta=-0.35, config=PremiumConfig(hold_days=0))
        self.assertLess(no_decay["move_needed_greeks"], no_decay["move_needed_delta"])
        self.assertGreater(r["move_needed_greeks"], no_decay["move_needed_greeks"])
        self.assertGreater(r["premium_at_key_greeks"], 120)
        self.assertGreater(r["premium_at_key_model"], 120)

    def test_key_level_too_close_for_the_target_is_rejected(self):
        r = example(key_level=22560)  # only 64 points away; the premium needs ~107
        self.assertFalse(r["valid"])
        failed = {c["id"] for c in r["checks"] if not c["passed"]}
        self.assertEqual(failed, {"KEY_LEVEL_PAYS_TARGET"})
        self.assertIn("needs about", r["reason"])

    def test_key_level_on_the_wrong_side_is_rejected(self):
        self.assertFalse(example(key_level=22700)["valid"])

    def test_wide_spread_low_liquidity_and_poor_reward_risk_are_rejected(self):
        failed = lambda r: {c["id"] for c in r["checks"] if not c["passed"]}
        self.assertEqual(failed(example(bid=74, ask=86)), {"SPREAD"})
        self.assertEqual(failed(example(liquidity=1)), {"LIQUIDITY"})
        self.assertEqual(failed(example(stop=50)), {"REWARD_RISK"})  # 40 / 30 = 1.33R

    def test_call_side_and_put_call_greeks(self):
        call = evaluate(22624, 22750, "CE", 22700, 70, "2026-10-27", NOW, iv=14)
        self.assertGreater(call["greeks"]["delta"], 0)
        self.assertGreater(call["index_target_delta"], 22624)
        greeks = bs_greeks(22624, 22600, 5 / 365, 0.14, "PE")
        self.assertLess(greeks["delta"], 0)


class GateTest(unittest.TestCase):
    def test_gate_only_runs_when_a_strategy_reports_it(self):
        codes = lambda payload: {g["code"]: g["passed"] for g in evaluate_payload(payload)["gates"]}
        self.assertNotIn("PREMIUM_TARGET_UNREACHABLE", codes({}))
        self.assertFalse(codes({"premium_target_reachable": False})["PREMIUM_TARGET_UNREACHABLE"])
        self.assertTrue(codes({"premium_target_reachable": True})["PREMIUM_TARGET_UNREACHABLE"])


if __name__ == "__main__":
    unittest.main()
