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


    def test_option_evidence_only_scores_when_it_agrees_with_the_setup_side(self):
        from test_orb_retest import fresh_session_candles

        candles = [{"timestamp": c.timestamp, "open": c.open, "high": c.high, "low": c.low, "close": c.close, "volume": c.volume} for c in fresh_session_candles()]
        agreeing = analyze_payload({"symbol": "NIFTY", "strategy": "ORB_RETEST", "candles": candles, "option_evidence": {"oi_direction_score": 2, "ors_call": 1.2, "ors_put": None, "vix_regime": "NORMAL", "liquidity_score": 3, "option_quote_fresh": True}})
        opposing = analyze_payload({"symbol": "NIFTY", "strategy": "ORB_RETEST", "candles": candles, "option_evidence": {"oi_direction_score": -2, "ors_call": 0.4, "ors_put": None, "vix_regime": "NORMAL", "liquidity_score": 3, "option_quote_fresh": True}})
        self.assertEqual(agreeing["calculations"]["score"]["option_relative_strength"], 1)
        self.assertEqual(agreeing["calculations"]["score"]["oi_direction"], 1)
        self.assertEqual(opposing["calculations"]["score"]["option_relative_strength"], 0)
        self.assertEqual(opposing["calculations"]["score"]["oi_direction"], 0)
        self.assertEqual(agreeing["calculations"]["score"]["total"] - opposing["calculations"]["score"]["total"], 2)
        self.assertIn("OI_PCR_NOT_SUPPORTIVE", opposing["pipeline"]["reasons"])
        self.assertIn("ORS_NOT_CONFIRMED", opposing["pipeline"]["reasons"])

    def test_extreme_vix_blocks_the_pipeline(self):
        from test_orb_retest import fresh_session_candles

        candles = [{"timestamp": c.timestamp, "open": c.open, "high": c.high, "low": c.low, "close": c.close, "volume": c.volume} for c in fresh_session_candles()]
        result = analyze_payload({"symbol": "NIFTY", "strategy": "ORB_RETEST", "candles": candles, "option_evidence": {"vix_regime": "EXTREME", "oi_direction_score": 2, "ors_call": 1.5}})
        self.assertIn("VIX_BLOCKED", result["pipeline"]["reasons"])


if __name__ == "__main__":
    unittest.main()
