import unittest

from tradepulse_quant.analytics.metrics import summarize_returns, summarize_regimes


class MetricsCompletenessTest(unittest.TestCase):
    def test_risk_and_cost_metrics(self):
        result = summarize_returns([2.0, -1.0, 3.0], r_multiples=[2.0, -1.0, 3.0], costs=10.0, slippage=4.0, exposure=500.0)
        self.assertEqual(result["profit_factor"], 5.0)
        self.assertAlmostEqual(result["median_r"], 2.0)
        self.assertEqual(result["costs"], 10.0)
        self.assertEqual(result["exposure"], 500.0)

    def test_regime_breakdown(self):
        result = summarize_regimes([2.0, -1.0, 3.0], ["BULL", "BEAR", "BULL"])
        self.assertEqual(result["BULL"]["trades"], 2)
        self.assertEqual(result["BEAR"]["win_rate"], 0.0)


if __name__ == "__main__":
    unittest.main()
