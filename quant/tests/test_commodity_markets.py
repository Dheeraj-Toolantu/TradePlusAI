"""MCX commodities (crude oil, gold) on the VWAP-EMA scalper, and the gap-state fix."""
import unittest
from datetime import datetime, timedelta

from tradepulse_quant.algo_engine import engine
from tradepulse_quant.algo_engine import scalp_strategy as S
from tradepulse_quant.algo_engine.engine import Candle, _gap_for, market_configuration
from tradepulse_quant.algo_engine.configuration import StrategyConfiguration
from tradepulse_quant.algo_engine.pipeline import evaluate_payload
from tradepulse_quant.algo_engine.session_engine import is_entry_permitted

from test_scalp_strategy import run

IST = engine.MARKET_TIMEZONE
OPS = {"data_quality_ok": True, "session_allowed": True, "option_quote_fresh": True, "daily_risk_allowed": True, "broker_healthy": True,
       "contract_metadata_available": True, "reconciliation_ok": True, "execution_ready": True, "gap_state": "NORMAL_DAY",
       "strategy_decision": "CONFIRMED", "breakout_valid": True, "retest_confirmed": True, "score": 11, "minimum_score": 11, "maximum_score": 11,
       "liquidity_score": 3, "risk_reward": 2.0, "minimum_risk_reward": 1.94, "regime_gate": False, "option_flow_gate": False}


class GapStateFromDailyBars(unittest.TestCase):
    def test_one_minute_feed_of_today_only_still_gets_a_gap_state(self):
        day = datetime(2026, 11, 17, 9, 15, tzinfo=IST)
        today = [Candle((day + timedelta(minutes=i)).isoformat(), 24000 + i, 24002 + i, 23998 + i, 24001 + i, 100) for i in range(60)]
        daily = [Candle(datetime(2026, 11, d, tzinfo=IST).isoformat(), 23900, 24100, 23850, 24020, 0) for d in (12, 13, 14, 16)]
        gap = _gap_for(today, StrategyConfiguration(), daily)
        self.assertIsNotNone(gap)
        self.assertEqual(gap.state, "NORMAL_DAY")  # opened inside yesterday's 23850-24100 range
        self.assertIsNone(_gap_for(today, StrategyConfiguration(), None))  # no prior data: still unknown, not guessed

    def test_gap_beyond_the_previous_daily_range_is_flagged(self):
        day = datetime(2026, 11, 17, 9, 15, tzinfo=IST)
        today = [Candle((day + timedelta(minutes=i)).isoformat(), 24400, 24410, 24390, 24405, 100) for i in range(30)]
        daily = [Candle(datetime(2026, 11, d, tzinfo=IST).isoformat(), 23900, 24100, 23850, 24020, 0) for d in (12, 13, 14, 16)]
        self.assertTrue(_gap_for(today, StrategyConfiguration(), daily).is_gap_day)


class McxSession(unittest.TestCase):
    def test_entries_follow_the_commodity_session(self):
        evening = datetime(2026, 11, 17, 20, 30, tzinfo=IST)
        self.assertTrue(is_entry_permitted(evening, market_configuration("MCX")))
        self.assertFalse(is_entry_permitted(evening, market_configuration("NSE")))
        self.assertFalse(is_entry_permitted(datetime(2026, 11, 17, 22, 50, tzinfo=IST), market_configuration("MCX")))


class McxScalp(unittest.TestCase):
    def test_vix_criterion_is_not_applicable_on_mcx(self):
        _, mcx, _, _ = run(ctx_extra={"market": "MCX"})
        keys = {c["key"] for c in mcx["scalp"]["criteria"]}
        self.assertNotIn("vix", keys)
        self.assertEqual(mcx["scalp"]["score"]["maximum"], 11.0)
        self.assertEqual(mcx["decision"], "CONFIRMED", mcx["reason"])
        self.assertEqual(S.score_card(mcx)["maximum"], 11.0)
        self.assertEqual(mcx["scalp"]["plan"]["cost_model"], "NSE_INDEX_OPTIONS_APPROXIMATION_FOR_MCX")
        _, nse, _, _ = run()
        self.assertIn("vix", {c["key"] for c in nse["scalp"]["criteria"]})
        self.assertEqual(S.score_card(nse)["maximum"], 12.0)

    def test_vix_gate_only_switches_off_when_the_engine_says_mcx(self):
        self.assertEqual(evaluate_payload({**OPS, "vix_gate": False})["decision"], "CONFIRMED")
        nse = evaluate_payload(OPS)  # an index scalp without a VIX regime still fails closed
        self.assertIn("MISSING_VIX_REGIME", nse["reasons"])

    def test_caller_evidence_cannot_switch_off_the_vix_gate_for_an_index(self):
        payload = {"symbol": "NIFTY", "strategy": "ORB_RETEST", "candles": [], "pipeline": {"vix_gate": False}}
        result = engine.analyze_payload(payload)
        self.assertIn("VIX_BLOCKED", {g["code"] for g in result["pipeline"]["gates"]})


if __name__ == "__main__":
    unittest.main()
