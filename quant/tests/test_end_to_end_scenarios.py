import unittest
from dataclasses import replace

from tradepulse_quant.algo_engine.no_trade_engine import NoTradeEngine, PipelineEvidence


class V5EndToEndScenarioTests(unittest.TestCase):
    def setUp(self):
        self.engine = NoTradeEngine()
        self.base = PipelineEvidence(
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

    def assert_no_trade(self, evidence, reason):
        result = self.engine.evaluate(evidence)
        self.assertEqual(result.decision, "NO_TRADE")
        self.assertIn(reason, result.reasons)

    def test_scenario_a_normal_bullish_orb_ce(self):
        self.assertEqual(self.engine.evaluate(self.base).decision, "CONFIRMED")

    def test_scenario_b_normal_bearish_orb_pe(self):
        self.assertEqual(self.engine.evaluate(replace(self.base, regime="TRENDING_BEAR")).decision, "CONFIRMED")

    def test_scenario_c_gap_up_unresolved(self):
        self.assert_no_trade(replace(self.base, gap_state="GAP_UP_UNRESOLVED"), "GAP_UNRESOLVED")

    def test_scenario_d_gap_down_fill(self):
        self.assertEqual(self.engine.evaluate(replace(self.base, gap_state="GAP_FILL_CONFIRMED")).decision, "CONFIRMED")

    def test_scenario_e_chop(self):
        self.assert_no_trade(replace(self.base, regime="CHOP"), "REGIME_BLOCKED")

    def test_scenario_f_extreme_vix(self):
        self.assert_no_trade(replace(self.base, vix_regime="EXTREME"), "VIX_BLOCKED")

    def test_scenario_g_liquidity_failure(self):
        self.assert_no_trade(replace(self.base, liquidity_score=1), "LIQUIDITY_BLOCKED")

    def test_scenario_h_rr_below_two(self):
        self.assert_no_trade(replace(self.base, risk_reward=1.99), "RR_BELOW_MINIMUM")

    def test_scenario_i_daily_loss_limit(self):
        self.assert_no_trade(replace(self.base, daily_risk_allowed=False), "DAILY_RISK_BLOCKED")

    def test_scenario_j_partial_fill_not_ready(self):
        self.assert_no_trade(replace(self.base, execution_ready=False), "EXECUTION_NOT_READY")

    def test_scenario_k_broker_forced_exit(self):
        self.assert_no_trade(replace(self.base, broker_forced_exit=True), "BROKER_FORCED_EXIT")

    def test_scenario_l_reconciliation_mismatch_safe_mode(self):
        result = self.engine.evaluate(replace(self.base, reconciliation_ok=False, safe_mode=True))
        self.assertEqual(result.decision, "NO_TRADE")
        self.assertIn("RECONCILIATION_REQUIRED", result.reasons)
        self.assertIn("SAFE_MODE_ACTIVE", result.reasons)

    def test_scenario_m_kill_switch(self):
        self.assert_no_trade(replace(self.base, kill_switch=True), "KILL_SWITCH_ACTIVE")

    def test_scenario_n_mandatory_square_off(self):
        self.assert_no_trade(replace(self.base, session_allowed=False), "SESSION_BLOCKED")


if __name__ == "__main__":
    unittest.main()
