import unittest

from tradepulse_quant.algo_engine.engine import analyze_payload


class AlgoEnginePipelineIntegrationTests(unittest.TestCase):
    def test_candle_payload_populates_observable_evidence_but_stays_fail_closed(self):
        candles = [
            {
                "timestamp": f"2026-09-13T09:{15 + index // 2:02d}:{(index % 2) * 30:02d}+05:30",
                "open": 100 + index,
                "high": 101 + index,
                "low": 99 + index,
                "close": 100.5 + index,
                "volume": 1000,
            }
            for index in range(21)
        ]
        result = analyze_payload({"symbol": "NIFTY", "strategy": "ORB_RETEST", "candles": candles})
        self.assertEqual(result["decision"], "NO_TRADE")
        self.assertIn("MISSING_OPTION_QUOTE_STALE", result["pipeline"]["reasons"])
        self.assertIn("MISSING_BROKER_UNHEALTHY", result["pipeline"]["reasons"])
        self.assertNotIn("MISSING_DATA_QUALITY_BLOCKED", result["pipeline"]["reasons"])

    def test_invalid_timestamp_is_a_data_quality_failure(self):
        result = analyze_payload({
            "symbol": "NIFTY",
            "strategy": "ORB_RETEST",
            "candles": [{"timestamp": "invalid", "open": 100, "high": 101, "low": 99, "close": 100, "volume": 1}],
        })
        self.assertEqual(result["decision"], "NO_TRADE")
        self.assertIn("DATA_QUALITY_BLOCKED", result["pipeline"]["reasons"])

    def test_duplicate_candle_timestamp_is_a_data_quality_failure(self):
        candle = {"timestamp": "2026-09-13T09:35:00+05:30", "open": 100, "high": 101, "low": 99, "close": 100, "volume": 1}
        result = analyze_payload({"symbol": "NIFTY", "strategy": "ORB_RETEST", "candles": [candle, candle]})
        self.assertEqual(result["decision"], "NO_TRADE")
        self.assertIn("DATA_QUALITY_BLOCKED", result["pipeline"]["reasons"])


if __name__ == "__main__":
    unittest.main()
