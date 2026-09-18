import unittest

from tradepulse_quant.signals.engine import Candle, OptionSnapshot, SignalEngineInput, generate_signal


def candles(direction: int = 1, volume: float = 1_000) -> list[Candle]:
    return [
        Candle(100 + direction * index, 101 + direction * index, 99 + direction * index, 100 + direction * index, volume)
        for index in range(20)
    ]


class SignalEngineTest(unittest.TestCase):
    def test_bullish_call_contains_risk_plan_and_explanation(self):
        price = candles(volume=1_300)
        price[-1] = Candle(120, 123, 119, 122, 1_500)
        result = generate_signal(SignalEngineInput(price, OptionSnapshot("NIFTY", 122, 122, "CE", 10, 100, 140, 118, 125, 14)))
        self.assertEqual(result.direction, "BUY_CALL")
        self.assertEqual(result.option_type, "CE")
        self.assertGreaterEqual(result.reward_risk or 0, 1.8)
        self.assertTrue(result.smart_money)

    def test_stale_data_is_hard_blocked(self):
        result = generate_signal(SignalEngineInput(candles(), OptionSnapshot("BANKNIFTY", 100, 100, "PE", 10, 100, 100, 95, 105, 15, 120)))
        self.assertEqual(result.direction, "NO_TRADE")
        self.assertIn("stale market data", result.blocked_by)

    def test_mixed_structure_is_no_trade(self):
        mixed = [Candle(100 + index, 103 + index, 98 + index % 2, 101 + index, 1_000) for index in range(18)]
        mixed.extend([Candle(118, 122, 110, 119, 1_000), Candle(119, 121, 111, 120, 1_000)])
        result = generate_signal(SignalEngineInput(mixed, OptionSnapshot("SENSEX", 119, 119, "CE", 10, 100, 100, 115, 125, 15)))
        self.assertEqual(result.direction, "NO_TRADE")
        self.assertTrue(result.rationale)


if __name__ == "__main__":
    unittest.main()