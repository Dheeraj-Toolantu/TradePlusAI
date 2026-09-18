import unittest
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from tradepulse_quant.configuration import StrategyConfiguration
from tradepulse_quant.data_quality_gate import DataQualityGate
from tradepulse_quant.models import Candle, MarketSnapshot, OptionQuote


class StrategyConfigurationTests(unittest.TestCase):
    def test_valid_configuration_passes(self):
        config = StrategyConfiguration()
        self.assertEqual(config.atr_period, 14)
        self.assertGreaterEqual(config.minimum_rr, 2.0)

    def test_invalid_configuration_fails_fast(self):
        with self.assertRaises(ValueError):
            StrategyConfiguration(atr_period=0)


class DataQualityGateTests(unittest.TestCase):
    def setUp(self):
        self.config = StrategyConfiguration()
        self.gate = DataQualityGate(self.config)
        self.now = datetime(2026, 9, 12, 9, 15, tzinfo=timezone.utc)

    def test_stale_market_data_rejected(self):
        snapshot = MarketSnapshot(
            symbol="NIFTY",
            timestamp=self.now - timedelta(seconds=2),
            open=Decimal("24500"),
            high=Decimal("24520"),
            low=Decimal("24490"),
            close=Decimal("24510"),
            volume=Decimal("1000"),
            source_connected=True,
            last_update_age_seconds=2.1,
        )
        ok, reasons = self.gate.validate_market_snapshot(snapshot, now=self.now)
        self.assertFalse(ok)
        self.assertIn("DATA_STALE", reasons)

    def test_invalid_ohlc_rejected(self):
        candles = [
            Candle(timestamp=self.now, open=Decimal("100"), high=Decimal("101"), low=Decimal("99"), close=Decimal("102"), volume=Decimal("1000")),
            Candle(timestamp=self.now + timedelta(minutes=5), open=Decimal("100"), high=Decimal("99"), low=Decimal("98"), close=Decimal("99"), volume=Decimal("1000")),
        ]
        ok, reasons = self.gate.validate_candles("NIFTY", candles, now=self.now + timedelta(minutes=5))
        self.assertFalse(ok)
        self.assertIn("INVALID_OHLC", reasons)

    def test_zero_range_candle_is_valid_market_data(self):
        candle = Candle(timestamp=self.now, open=Decimal("100"), high=Decimal("100"), low=Decimal("100"), close=Decimal("100"), volume=Decimal("1000"))
        ok, reasons = self.gate.validate_candles("NIFTY", [candle], now=self.now)
        self.assertTrue(ok)
        self.assertEqual(reasons, [])

    def test_duplicate_and_out_of_order_timestamps_are_blocked(self):
        candles = [
            Candle(timestamp=self.now, open=Decimal("100"), high=Decimal("101"), low=Decimal("99"), close=Decimal("100"), volume=Decimal("1000")),
            Candle(timestamp=self.now, open=Decimal("100"), high=Decimal("101"), low=Decimal("99"), close=Decimal("100"), volume=Decimal("1000")),
        ]
        ok, reasons = self.gate.validate_candles("NIFTY", candles, now=self.now)
        self.assertFalse(ok)
        self.assertTrue(any(reason in reasons for reason in ["DUPLICATE_TIMESTAMP", "OUT_OF_ORDER_CANDLES"]))

    def test_option_quote_stale_rejected(self):
        quote = OptionQuote(
            symbol="NIFTY",
            expiry="2026-09-18",
            option_type="CE",
            strike=Decimal("24500"),
            bid=Decimal("85.0"),
            ask=Decimal("86.0"),
            last=Decimal("85.5"),
            volume=Decimal("1000"),
            open_interest=Decimal("5000"),
            timestamp=self.now - timedelta(seconds=3),
            source_connected=True,
            last_update_age_seconds=3.0,
        )
        ok, reasons = self.gate.validate_option_quote(quote, now=self.now)
        self.assertFalse(ok)
        self.assertIn("OPTION_QUOTE_STALE", reasons)

    def test_reported_staleness_and_timestamp_mismatch_are_rejected(self):
        snapshot = MarketSnapshot(
            symbol="NIFTY", timestamp=self.now, open=Decimal("24500"), high=Decimal("24520"), low=Decimal("24490"), close=Decimal("24510"), volume=Decimal("1000"), source_connected=True, last_update_age_seconds=2.0,
        )
        ok, reasons = self.gate.validate_market_snapshot(snapshot, now=self.now)
        self.assertFalse(ok)
        self.assertIn("DATA_STALE", reasons)
        quote = OptionQuote(
            symbol="NIFTY", expiry="2026-09-18", option_type="CE", strike=Decimal("24500"), bid=Decimal("85"), ask=Decimal("86"), last=Decimal("85.5"), volume=Decimal("1000"), open_interest=Decimal("5000"), timestamp=self.now, source_connected=True, last_update_age_seconds=0.1,
        )
        ok, reasons = self.gate.validate_option_quote(quote, now=self.now, market_timestamp=self.now - timedelta(seconds=2))
        self.assertFalse(ok)
        self.assertIn("TIMESTAMP_MISMATCH", reasons)

    def test_reconnect_requires_sync_before_new_entries(self):
        snapshot = MarketSnapshot(
            symbol="NIFTY",
            timestamp=self.now,
            open=Decimal("24500"),
            high=Decimal("24520"),
            low=Decimal("24490"),
            close=Decimal("24510"),
            volume=Decimal("1000"),
            source_connected=False,
            last_update_age_seconds=0.1,
        )
        ok, reasons = self.gate.validate_market_snapshot(snapshot, now=self.now, requires_full_sync_on_reconnect=True)
        self.assertFalse(ok)
        self.assertIn("RECONNECT_SYNC_REQUIRED", reasons)


if __name__ == "__main__":
    unittest.main()
