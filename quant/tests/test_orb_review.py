"""Regression tests for the ORB + Retest review (spec 005 sections 4, 5, 6A, 6B, 15)."""
import unittest
from datetime import datetime, timedelta

from tradepulse_quant.algo_engine.engine import MARKET_TIMEZONE, Candle, analyze, completed_candles
from tradepulse_quant.algo_engine.orb import evaluate_orb_retest
from tradepulse_quant.algo_engine.pipeline import evaluate_payload

IST_TODAY = datetime(2026, 9, 28, 9, 15)
PREVIOUS = datetime(2026, 9, 25, 9, 15)


def bars(start, rows):
    return [Candle((start + timedelta(minutes=5 * index)).isoformat(), *row, 1000) for index, row in enumerate(rows)]


def previous_day(high=25020, low=24980):
    return bars(PREVIOUS, [(25000, high, low, 25000)] * 75)


OPENING = [(25000, 25040, 24990, 25010), (25010, 25050, 25000, 25030), (25030, 25060, 25020, 25040)]  # ORH 25060


class ExtensionBeforeRetest(unittest.TestCase):
    def test_run_away_then_retest_is_rejected(self):
        # The drop back into the level is a 130-pt counter-candle: a rejection, not a retest.
        today = bars(IST_TODAY, OPENING + [(25050, 25075, 25045, 25070), (25070, 25230, 25065, 25220), (25220, 25225, 25080, 25090), (25090, 25110, 25055, 25105)])
        result = evaluate_orb_retest(previous_day() + today)
        self.assertEqual(result.status, "WAIT_FOR_PULLBACK")
        self.assertIn("counter-candle", result.reason)

    def test_orderly_breakout_and_retest_confirms_with_timeline(self):
        today = bars(IST_TODAY, OPENING + [(25050, 25075, 25045, 25070), (25068, 25080, 25058, 25076)])
        result = evaluate_orb_retest(previous_day() + today)
        self.assertEqual(result.status, "CONFIRMED")
        self.assertTrue(result.breakout_time.startswith("2026-09-28T09:30"))
        self.assertTrue(result.retest_time.startswith("2026-09-28T09:35"))


    def test_excursion_between_breakout_and_retest_is_rejected(self):
        # Breakout, a candle that runs +120 without touching the level, then a clean retest.
        today = bars(IST_TODAY, OPENING + [(25050, 25075, 25045, 25070), (25072, 25180, 25071, 25170), (25170, 25172, 25090, 25095), (25062, 25100, 25058, 25090)])
        result = evaluate_orb_retest(previous_day() + today)
        self.assertEqual(result.status, "WAIT_FOR_PULLBACK")
        self.assertIsNone(result.retest_index)


class PullbackReentry(unittest.TestCase):
    def test_orderly_pullback_after_an_extended_breakout_confirms(self):
        # Breakout runs +60 (beyond the 40-pt max extension), drifts back, then tags ORH and holds.
        run = [(25050, 25075, 25045, 25070), (25070, 25125, 25068, 25120), (25120, 25122, 25095, 25100), (25100, 25104, 25080, 25085)]
        today = bars(IST_TODAY, OPENING + run + [(25072, 25090, 25058, 25088)])
        result = evaluate_orb_retest(previous_day() + today)
        self.assertEqual(result.status, "CONFIRMED")
        self.assertEqual(result.side, "BUY")
        self.assertEqual(result.bars_since_retest, 0)
        self.assertIn("pullback retest", result.reason)

    def test_stale_retest_is_refreshed_by_a_later_pullback(self):
        drift = [(25080 + step, 25090 + step, 25075 + step, 25085 + step) for step in range(0, 40, 5)]
        first = OPENING + [(25050, 25075, 25045, 25070), (25068, 25080, 25058, 25076)] + drift
        stale = analyze("NIFTY", previous_day() + bars(IST_TODAY, first), strategy="ORB_RETEST")
        self.assertEqual(stale["decision"], "SIGNAL_EXPIRED")
        self.assertIn("next pullback", stale["reason"])
        pullback = first + [(25110, 25112, 25080, 25082), (25070, 25088, 25059, 25084)]
        fresh = analyze("NIFTY", previous_day() + bars(IST_TODAY, pullback), strategy="ORB_RETEST")
        self.assertEqual(fresh["decision"], "CONFIRMED")
        self.assertEqual(fresh["setup"]["side"], "BUY")

    def test_failed_break_then_opposite_breakdown_is_traded(self):
        # Bull trap above ORH, back inside, then a breakdown below ORL (24990) and a retest.
        moves = [(25050, 25075, 25045, 25070), (25065, 25068, 25030, 25035), (25030, 25035, 24975, 24980), (24983, 24994, 24972, 24976)]
        result = evaluate_orb_retest(previous_day(high=25100, low=24800) + bars(IST_TODAY, OPENING + moves))
        self.assertEqual(result.status, "CONFIRMED")
        self.assertEqual(result.side, "SELL")
        self.assertIn("earlier: BUY break", result.reason)

    def test_repeated_failed_breaks_mark_a_whipsaw_day(self):
        up_fail = [(25050, 25075, 25045, 25070), (25065, 25068, 25030, 25035)]
        down_fail = [(25030, 25035, 24975, 24980), (24985, 25010, 24984, 25005)]
        result = evaluate_orb_retest(previous_day() + bars(IST_TODAY, OPENING + up_fail + down_fail + up_fail + down_fail))
        self.assertEqual(result.status, "NO_TRADE")
        self.assertIn("whipsaw", result.reason)

    def test_level_expires_after_the_pullback_window(self):
        drift = [(25080 + step, 25090 + step, 25075 + step, 25085 + step) for step in range(0, 125, 5)]
        today = bars(IST_TODAY, OPENING + [(25050, 25075, 25045, 25070)] + drift)
        result = evaluate_orb_retest(previous_day() + today)
        self.assertEqual(result.status, "NO_TRADE")
        self.assertIn("not retested", result.reason)


class RetestZone(unittest.TestCase):
    def test_near_miss_within_a_tenth_of_atr_counts(self):
        # ATR of the fixture is ~40 pts, so the zone is ~4 pts above ORH.
        today = bars(IST_TODAY, OPENING + [(25050, 25075, 25045, 25070), (25070, 25080, 25063, 25078)])
        self.assertEqual(evaluate_orb_retest(previous_day() + today).status, "CONFIRMED")

    def test_far_miss_still_times_out(self):
        today = bars(IST_TODAY, OPENING + [(25050, 25075, 25045, 25070), (25070, 25085, 25072, 25080), (25080, 25090, 25074, 25086), (25086, 25096, 25078, 25090)])
        result = evaluate_orb_retest(previous_day() + today)
        # No touch inside the retest window: keep the level live for a pullback, never chase.
        self.assertEqual(result.status, "WAIT_FOR_PULLBACK")
        self.assertIsNone(result.retest_index)


class GapDay(unittest.TestCase):
    def test_gap_day_uses_a_30_minute_opening_range_and_half_size(self):
        opening = [(25400, 25420, 25390, 25410), (25410, 25430, 25400, 25420), (25420, 25425, 25405, 25410), (25410, 25450, 25405, 25445), (25445, 25455, 25430, 25440), (25440, 25448, 25432, 25444)]
        # 30-minute ORH is 25455; a breakout candle, then a retest of 25455.
        today = bars(IST_TODAY, opening + [(25450, 25470, 25448, 25466), (25464, 25475, 25452, 25472)])
        candles = previous_day() + today
        result = analyze("NIFTY", candles, strategy="ORB_RETEST")
        self.assertEqual(result["calculations"]["orb"]["opening_minutes"], 30)
        self.assertEqual(result["calculations"]["orb"]["opening_range_high"], 25455)
        self.assertEqual(result["decision"], "CONFIRMED")
        self.assertEqual(result["setup"]["size_multiplier"], 0.5)
        self.assertTrue(result["setup"]["gap_day"])


class StructuralTarget(unittest.TestCase):
    def test_previous_day_high_inside_2r_blocks_the_trade(self):
        today = bars(IST_TODAY, OPENING + [(25050, 25075, 25045, 25070), (25068, 25080, 25058, 25076)])
        result = analyze("NIFTY", previous_day(high=25085) + today, strategy="ORB_RETEST")
        # PDH 25085 would also make this a gap day otherwise; open is inside the prior range here.
        self.assertEqual(result["decision"], "NO_TRADE")
        self.assertIn("PDH", result["reason"])

    def test_clear_path_keeps_2r(self):
        today = bars(IST_TODAY, OPENING + [(25050, 25075, 25045, 25070), (25068, 25080, 25058, 25076)])
        result = analyze("NIFTY", previous_day(high=25400, low=24900) + today, strategy="ORB_RETEST")
        self.assertEqual(result["decision"], "CONFIRMED")
        self.assertEqual(result["setup"]["risk_reward"], 2.0)


class RegimeDirection(unittest.TestCase):
    base = dict(data_quality_ok=True, session_allowed=True, option_quote_fresh=True, daily_risk_allowed=True, broker_healthy=True, contract_metadata_available=True, reconciliation_ok=True, execution_ready=True, strategy_decision="CONFIRMED", breakout_valid=True, retest_confirmed=True, ors_confirmed=True, oi_pcr_supportive=True, vix_regime="NORMAL", gap_state="NORMAL_DAY", score=9, minimum_score=8, liquidity_score=3, risk_reward=2.0)

    def test_buy_setup_in_bear_trend_is_blocked(self):
        result = evaluate_payload({**self.base, "regime": "TRENDING_BEAR", "setup_side": "BUY"})
        self.assertEqual(result["decision"], "NO_TRADE")
        self.assertIn("REGIME_CONFLICT", result["reasons"])

    def test_aligned_setup_passes(self):
        self.assertEqual(evaluate_payload({**self.base, "regime": "TRENDING_BULL", "setup_side": "BUY"})["decision"], "CONFIRMED")


class VolumeUnobservable(unittest.TestCase):
    def test_minimum_score_is_scaled_when_no_volume_proxy_exists(self):
        from tradepulse_quant.algo_engine.engine import analyze_payload
        today = bars(IST_TODAY, OPENING + [(25050, 25075, 25045, 25070), (25068, 25080, 25058, 25076)])
        rows = [{"timestamp": c.timestamp, "open": c.open, "high": c.high, "low": c.low, "close": c.close, "volume": 0} for c in previous_day() + today]
        score = analyze_payload({"symbol": "NIFTY", "strategy": "ORB_RETEST", "candles": rows})["calculations"]["score"]
        self.assertFalse(score["volume_observable"])
        self.assertEqual(score["minimum"], 6.4)
        with_volume = [{**row, "volume": 1000} for row in rows]
        self.assertEqual(analyze_payload({"symbol": "NIFTY", "strategy": "ORB_RETEST", "candles": with_volume})["calculations"]["score"]["minimum"], 8.0)


class FormingCandle(unittest.TestCase):
    def test_forming_candle_is_dropped(self):
        candles = bars(IST_TODAY, OPENING + [(25050, 25075, 25045, 25070)])
        now = (datetime.fromisoformat(candles[-1].timestamp) + timedelta(minutes=2)).replace(tzinfo=MARKET_TIMEZONE)
        kept = completed_candles(candles, now)
        self.assertEqual(len(kept), len(candles) - 1)


if __name__ == "__main__":
    unittest.main()
