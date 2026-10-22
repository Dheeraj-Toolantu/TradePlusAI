import unittest
from datetime import datetime, timedelta, timezone

from tradepulse_quant.algo_engine.pipeline import evaluate_payload
from tradepulse_quant.algo_engine.premium_math import PremiumConfig, bs_greeks, bs_price, evaluate, implied_vol, round_trip_costs, touch_probability

IST = timezone(timedelta(hours=5, minutes=30))
NOW = datetime(2026, 10, 22, 11, 0, tzinfo=IST)


def example(**overrides):
    # The user's worked example: NIFTY 22,624, key level 22,500, PE at Rs 80 with delta -0.35.
    args = dict(spot=22624, key_level=22500, option_type="PE", strike=22550, entry=80, expiry="2026-10-27", now=NOW, iv=14, delta=-0.35, bid=79, ask=81, liquidity=3, lot_size=65)
    args.update(overrides)
    return evaluate(**args)


def failed(result, blocking_only=True):
    return {c["id"] for c in result["checks"] if not c["passed"] and (c["blocking"] or not blocking_only)}


class ArithmeticTest(unittest.TestCase):
    def test_worked_example(self):
        r = example()
        self.assertEqual(r["move_points"], 124)
        self.assertAlmostEqual(r["move_pct"], 0.548, places=3)
        self.assertEqual((r["required_premium"], r["target_premium"], r["stop_premium"]), (120, 120, 60))
        self.assertEqual(r["return_pct"], 50)
        self.assertEqual(r["risk_reward"], 2.0)  # gross
        self.assertEqual(r["move_needed_delta"], 114.3)  # 40 / 0.35 with the chain delta
        self.assertEqual(r["delta_only_source"], "chain delta")
        self.assertEqual(r["index_target_delta"], 22509.7)


class ModelConsistencyTest(unittest.TestCase):
    def test_one_model_reprices_the_entry_and_drives_greeks_and_key_level(self):
        r = example()
        model = r["model"]
        self.assertEqual(model["iv_source"], "implied from the entry premium")
        self.assertEqual((model["strike"], model["expiry"], model["rate_pct"]), (22550, "2026-10-27", 6.5))
        sigma, years, rate = model["iv_pct"] / 100, model["days_to_expiry"] / 365, 0.065
        # The implied vol reprices the entry premium exactly.
        self.assertAlmostEqual(bs_price(22624, 22550, years, sigma, "PE", rate), 80, delta=0.05)
        # Greeks come from the same inputs.
        greeks = bs_greeks(22624, 22550, years, sigma, "PE", rate)
        self.assertAlmostEqual(r["greeks"]["gamma"], greeks["gamma"], places=5)
        self.assertAlmostEqual(r["greeks"]["delta"], greeks["delta"], places=3)
        # The Greeks expansion and the full reprice agree closely for a 124-point move.
        self.assertAlmostEqual(r["premium_at_key_greeks"], r["premium_at_key_model"], delta=2.0)
        self.assertAlmostEqual(r["move_needed_greeks"], r["move_needed_model"], delta=2.0)
        self.assertEqual(r["return_at_key_pct"], round((r["premium_at_key_model"] - 80) / 80 * 100, 2))

    def test_vol_scenario_is_explicit_and_moves_the_key_level_price(self):
        base = example()
        richer = example(config=PremiumConfig(iv_change=2.0))
        self.assertEqual(richer["model"]["scenario"]["iv_change_points"], 2.0)
        self.assertAlmostEqual(richer["model"]["scenario"]["scenario_iv_pct"], base["model"]["iv_pct"] + 2.0, places=1)
        self.assertGreater(richer["premium_at_key_model"], base["premium_at_key_model"])
        self.assertGreater(richer["premium_at_key_greeks"], base["premium_at_key_greeks"])  # vega x dIV

    def test_theta_is_charged_for_the_hold(self):
        quick = example(config=PremiumConfig(hold_days=0.0))
        slow = example(config=PremiumConfig(hold_days=1.0))
        self.assertGreater(slow["move_needed_model"], quick["move_needed_model"])
        self.assertGreater(slow["move_needed_greeks"], quick["move_needed_greeks"])

    def test_no_expiry_means_no_model_and_the_key_gate_stays_red(self):
        r = example(expiry=None)
        self.assertIsNone(r["premium_at_key_model"])
        self.assertIn("KEY_LEVEL_PAYS_TARGET", failed(r))

    def test_implied_vol_round_trip(self):
        price = bs_price(22624, 22550, 5 / 365, 0.13, "PE", 0.065)
        self.assertAlmostEqual(implied_vol(price, 22624, 22550, 5 / 365, "PE", 0.065), 0.13, places=4)


class GatesTest(unittest.TestCase):
    def test_key_gate_is_red_when_the_repriced_premium_is_below_the_required_premium(self):
        # The review's case: entry 124.90 needs 187.35; a key level that prices the PE near 165 fails.
        r = evaluate(22700, 22600, "PE", 22650, 124.90, "2026-10-27", NOW, bid=124, ask=125.8, liquidity=3, lot_size=65)
        self.assertEqual(r["required_premium"], 187.35)
        self.assertLess(r["premium_at_key_model"], 187.35)
        self.assertLess(r["return_at_key_pct"], 50)
        self.assertFalse(r["target_possible"])
        self.assertIn("KEY_LEVEL_PAYS_TARGET", failed(r))
        self.assertIn("50% option premium gain", r["checks"][0]["detail"])

    def test_key_level_on_the_wrong_side_is_rejected(self):
        self.assertIn("KEY_LEVEL_PAYS_TARGET", failed(example(key_level=22700)))

    def test_net_reward_to_risk_includes_costs(self):
        r = example()
        costs = r["costs"]["at_target"]
        for part in ("brokerage", "stt", "exchange", "sebi", "stamp", "gst", "slippage", "spread"):
            self.assertGreater(costs[part], 0, part)
        self.assertEqual(costs["spread"], 130.0)  # (81 - 79) per unit x 65
        self.assertLess(r["net_risk_reward"], r["risk_reward"])
        self.assertEqual(failed(r), {"REWARD_RISK"})  # 2:1 gross is about 1.5:1 after costs
        self.assertTrue(example(stop=70)["checks"][1]["passed"])  # a tighter structural stop clears it

    def test_wide_spread_and_low_liquidity_are_rejected(self):
        self.assertIn("SPREAD", failed(example(bid=74, ask=86, stop=70)))
        self.assertIn("LIQUIDITY", failed(example(liquidity=1, stop=70)))

    def test_costs_breakdown(self):
        c = round_trip_costs(80, 120, 65, 0.0, PremiumConfig())
        self.assertEqual(c["brokerage"], 40.0)
        self.assertAlmostEqual(c["stt"], 7.8)
        self.assertAlmostEqual(c["gst"], round(0.18 * (40 + c["exchange"] + c["sebi"]), 2), places=1)

    def test_pipeline_gate_only_runs_when_a_strategy_reports_it(self):
        codes = lambda payload: {g["code"]: g["passed"] for g in evaluate_payload(payload)["gates"]}
        self.assertNotIn("PREMIUM_TARGET_UNREACHABLE", codes({}))
        self.assertFalse(codes({"premium_target_reachable": False})["PREMIUM_TARGET_UNREACHABLE"])
        self.assertTrue(codes({"premium_target_reachable": True})["PREMIUM_TARGET_UNREACHABLE"])


class PossibleVsLikelyTest(unittest.TestCase):
    def test_possible_and_likely_are_separate(self):
        r = example(stop=70)
        self.assertTrue(r["target_possible"])
        self.assertIsNotNone(r["touch_probability_session"])
        self.assertGreater(r["touch_probability_expiry"], r["touch_probability_session"])
        likely = next(c for c in r["checks"] if c["id"] == "TARGET_LIKELY")
        self.assertFalse(likely["blocking"])
        # A far key level can pay the target (possible) while being unlikely to be touched today.
        far = example(key_level=22300, stop=70)
        self.assertTrue(far["target_possible"])
        self.assertFalse(far["target_likely"])
        self.assertLess(far["touch_probability_session"], r["touch_probability_session"])
        self.assertTrue(far["valid"])  # likelihood is reported, not a blocking gate
        # A near key level can be likely to be touched yet not pay the target.
        near = example(key_level=22590, stop=70)
        self.assertTrue(near["key_level_likely"])
        self.assertFalse(near["target_possible"])
        self.assertFalse(near["target_likely"])

    def test_touch_probability_bounds(self):
        self.assertAlmostEqual(touch_probability(100, 100.0001, 0.2, 0.01), 1.0, places=3)
        self.assertLess(touch_probability(100, 80, 0.2, 0.01), 0.01)


if __name__ == "__main__":
    unittest.main()
