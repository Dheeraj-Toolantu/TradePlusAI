import unittest
from datetime import date, timedelta

from tradepulse_quant.signals.option_engine import Candle, EngineInput, OptionContract, rank_options


def candles(direction: int = 1) -> list[Candle]:
    values = [100 + direction * index for index in range(22)]
    result = [Candle(value - 1, value + 1, value - 2, value, 1_000) for value in values]
    result[-1] = Candle(values[-1] - 1, values[-1] + 4, values[-1] - 1, values[-1] + 3, 1_500)
    return result


def contract(option_type: str = "CE", **changes) -> OptionContract:
    values = dict(
        symbol="NIFTY", expiry=(date.today() + timedelta(days=7)).isoformat(), strike=120,
        option_type=option_type, ltp=10, bid=9.9, ask=10.1, open_interest=10_000,
        oi_change=2_000, volume=4_000, iv=18, delta=.5, theta=-.2, lot_size=50,
        timestamp_age_seconds=0.5,
    )
    values.update(changes)
    return OptionContract(**values)


class OptionEngineTest(unittest.TestCase):
    def test_ranks_real_chain_fields_after_bullish_breakout(self):
        result = rank_options(EngineInput("NIFTY", 120, [contract()], candles()))
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["contract"], "CALL")
        self.assertEqual(result[0]["entry"], 10.1)
        self.assertEqual(result[0]["lotSize"], 50)
        self.assertGreaterEqual(result[0]["riskReward"], 2)

    def test_put_is_not_recommended_without_bearish_confirmation(self):
        result = rank_options(EngineInput("NIFTY", 120, [contract("PE")], candles()))
        self.assertEqual(result, [])

    def test_wide_spread_is_fail_closed(self):
        result = rank_options(EngineInput("NIFTY", 120, [contract(ask=12)], candles()))
        self.assertEqual(result, [])

    def test_missing_history_is_fail_closed(self):
        result = rank_options(EngineInput("NIFTY", 120, [contract()], candles()[:10]))
        self.assertEqual(result, [])

    def test_candidate_exposes_structured_recommendation_pipeline(self):
        result = rank_options(EngineInput("NIFTY", 120, [contract()], candles()))
        self.assertEqual(len(result), 1)
        candidate = result[0]
        self.assertIn("direction", candidate)
        self.assertIn("directional_score", candidate)
        self.assertIn("pipeline", candidate)
        self.assertIn("feasibility", candidate)
        self.assertIn("warnings", candidate)
        self.assertIn(candidate["direction"], {"BULLISH", "BEARISH", "NEUTRAL"})
        self.assertGreaterEqual(candidate["directional_score"], 0)
        self.assertLessEqual(candidate["directional_score"], 100)

    def test_strong_bullish_breakout_has_high_directional_and_trend_scores(self):
        result = rank_options(EngineInput("NIFTY", 120, [contract()], candles()))
        self.assertEqual(len(result), 1)
        candidate = result[0]
        self.assertEqual(candidate["direction"], "BULLISH")
        self.assertGreaterEqual(candidate["directional_score"], 80)
        self.assertGreaterEqual(candidate["trend_score"], 80)

    def test_move_feasibility_and_no_trade_gate_are_exposed(self):
        result = rank_options(EngineInput("NIFTY", 120, [contract(ltp=2.0, ask=2.1, bid=2.0, delta=0.12, open_interest=100, oi_change=10, volume=250, iv=8)], candles()))
        self.assertEqual(result, [])

    def test_default_configuration_weights_sum_to_one(self):
        from tradepulse_quant.signals.option_engine import DEFAULT_CONFIG, validate_config

        self.assertTrue(validate_config(DEFAULT_CONFIG))
        self.assertAlmostEqual(sum(DEFAULT_CONFIG["weights"].values()), 1.0, places=6)

    def test_audit_record_includes_required_recommendation_fields(self):
        from tradepulse_quant.signals.option_engine import build_audit_record

        result = rank_options(EngineInput("NIFTY", 120, [contract()], candles()))
        self.assertTrue(result)
        audit = build_audit_record(result[0], EngineInput("NIFTY", 120, [contract()], candles()))
        self.assertIn("timestamp", audit)
        self.assertIn("spot", audit)
        self.assertIn("symbol", audit)
        self.assertIn("expiry", audit)
        self.assertIn("strike", audit)
        self.assertIn("option_type", audit)
        self.assertIn("final_score", audit)
        self.assertIn("decision", audit)
        self.assertIn("warnings", audit)
        self.assertIn("reasons", audit)


if __name__ == "__main__":
    unittest.main()
