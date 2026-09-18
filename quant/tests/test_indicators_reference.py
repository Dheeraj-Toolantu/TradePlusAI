import unittest
from dataclasses import dataclass

from tradepulse_quant.algo_engine.indicators import adx, atr, ema, vwap


@dataclass(frozen=True)
class Candle:
    high: float
    low: float
    close: float
    volume: float


class IndicatorReferenceTests(unittest.TestCase):
    def test_sma_seeded_ema_reference_value(self):
        self.assertEqual(ema([1, 2, 3, 4, 5], 3), 4.0)

    def test_wilder_atr_uses_previous_close_gaps(self):
        candles = [Candle(12, 9, 11, 2), Candle(14, 10, 13, 1), Candle(15, 12, 14, 1)]
        self.assertAlmostEqual(atr(candles, 3) or 0, 10 / 3)

    def test_vwap_uses_typical_price_weighted_by_volume(self):
        candles = [Candle(12, 9, 11, 2), Candle(14, 10, 13, 1)]
        self.assertAlmostEqual(vwap(candles) or 0, 101 / 9)

    def test_adx_is_100_for_a_unidirectional_reference_series(self):
        candles = [Candle(101 + index, 99 + index, 100 + index, 100) for index in range(6)]
        self.assertEqual(adx(candles, 3), 100.0)


if __name__ == "__main__":
    unittest.main()