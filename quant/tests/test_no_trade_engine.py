import unittest
from dataclasses import replace

from tradepulse_quant.algo_engine.no_trade_engine import NoTradeEngine, PipelineEvidence
from tradepulse_quant.algo_engine.pipeline import evaluate_payload


class NoTradeEngineTests(unittest.TestCase):
    def setUp(self):
        self.valid = PipelineEvidence(
            data_quality_ok=True,
            session_allowed=True,
            strategy_decision="CONFIRMED",
            regime="TRENDING_BULL",
            gap_state="NORMAL_DAY",
            breakout_valid=True,
            retest_confirmed=True,
            ors_confirmed=True,
            oi_pcr_supportive=True,
            vix_regime="NORMAL",
            score=8,
            option_quote_fresh=True,
            liquidity_score=2,
            risk_reward=2,
            daily_risk_allowed=True,
            broker_healthy=True,
            contract_metadata_available=True,
            reconciliation_ok=True,
            execution_ready=True,
        )

    def test_valid_evidence_confirms(self):
        decision = NoTradeEngine().evaluate(self.valid)
        self.assertEqual(decision.decision, "CONFIRMED")
        self.assertEqual(decision.reasons, ())

    def test_missing_evidence_fails_closed(self):
        decision = NoTradeEngine().evaluate(PipelineEvidence())
        self.assertEqual(decision.decision, "NO_TRADE")
        self.assertIn("MISSING_DATA_QUALITY_BLOCKED", decision.reasons)
        self.assertIn("MISSING_RISK_REWARD", decision.reasons)

    def test_all_failures_are_reported_in_stable_order(self):
        evidence = replace(self.valid, data_quality_ok=False, liquidity_score=1, risk_reward=1.5, safe_mode=True)
        decision = NoTradeEngine().evaluate(evidence)
        self.assertEqual(decision.decision, "NO_TRADE")
        self.assertEqual(decision.reasons[:3], ("DATA_QUALITY_BLOCKED", "LIQUIDITY_BLOCKED", "RR_BELOW_MINIMUM"))
        self.assertIn("SAFE_MODE_ACTIVE", decision.reasons)

    def test_serialized_payload_is_deterministic(self):
        payload = {field: getattr(self.valid, field) for field in self.valid.__dataclass_fields__}
        first = evaluate_payload(payload)
        second = evaluate_payload(payload)
        self.assertEqual(first, second)
        self.assertEqual(first["decision"], "CONFIRMED")


if __name__ == "__main__":
    unittest.main()
