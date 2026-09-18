import unittest

from tradepulse_quant.analytics.metrics import summarize_returns
from tradepulse_quant.backtest.engine import simulate_market_fill


class BacktestMetricsTest(unittest.TestCase):
    def test_fill_and_metrics(self):
        fill = simulate_market_fill(50, 100, slippage=0.5)
        self.assertEqual(fill.quantity, 50)
        self.assertEqual(fill.price, 100.5)
        self.assertAlmostEqual(summarize_returns([1.0, -0.5])["win_rate"], 0.5)


if __name__ == "__main__":
    unittest.main()