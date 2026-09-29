"""Regression tests for the ORB + Retest strategy review (gap ATR, volume, expiry day)."""
import unittest
from datetime import datetime, timedelta

from tradepulse_quant.algo_engine.engine import MARKET_TIMEZONE, Candle, _gap_for, _observe, _relative_volume, analyze
from tradepulse_quant.algo_engine.configuration import StrategyConfiguration
from tradepulse_quant.algo_engine.no_trade_engine import NoTradeEngine, PipelineEvidence

CONFIG = StrategyConfiguration()


def session(day, rows, volume=1000):
    start = datetime(2026, 9, day, 9, 15)
    return [Candle((start + timedelta(minutes=5 * index)).isoformat(), *row, volume) for index, row in enumerate(rows)]


def wide_prior_days():
    # Four sessions with ~200-point daily ranges built from calm 5-minute bars (5m ATR ~ 20).
    candles = []
    for day in (21, 22, 23, 24):
        rows = [(25000 + i * 2.7, 25010 + i * 2.7, 24990 + i * 2.7, 25005 + i * 2.7) for i in range(75)]
        candles += session(day, rows)
    return candles  # last session: high ~25210, low 24990


class GapUsesDailyAtr(unittest.TestCase):
    def test_small_open_beyond_prior_high_is_not_a_gap_day(self):
        # Opens 30 points above the prior high: > 0.5 x 5m ATR, but far below 0.5 x daily ATR.
        today = session(25, [(25240, 25250, 25230, 25245), (25245, 25255, 25235, 25250)])
        gap = _gap_for(wide_prior_days() + today, CONFIG)
        self.assertEqual(gap.state, "NORMAL_DAY")
        self.assertEqual(gap.required_or_duration_minutes, 15)

    def test_large_gap_is_still_flagged(self):
        today = session(25, [(25400, 25410, 25390, 25405), (25405, 25415, 25395, 25410)])
        self.assertTrue(_gap_for(wide_prior_days() + today, CONFIG).is_gap_day)

    def test_classification_does_not_change_as_the_day_develops(self):
        opening = [(25240, 25250, 25230, 25245)] * 3
        early = _gap_for(wide_prior_days() + session(25, opening), CONFIG)
        # A violent later session must not re-classify the open (and flip the OR window).
        late = _gap_for(wide_prior_days() + session(25, opening + [(25245, 25600, 24800, 25000)] * 10), CONFIG)
        self.assertEqual(early.state, late.state)

    def test_exchange_daily_candles_take_precedence(self):
        today = session(25, [(25240, 25250, 25230, 25245), (25245, 25255, 25235, 25250)])
        # Tiny daily ranges => a 30-point open beyond the high becomes a real gap.
        daily = [Candle(datetime(2026, 9, d, 0, 0, tzinfo=MARKET_TIMEZONE).isoformat(), 25200, 25210, 25195, 25205, 0) for d in (21, 22, 23, 24)]
        self.assertTrue(_gap_for(wide_prior_days() + today, CONFIG, daily).is_gap_day)


class VolumeEvidence(unittest.TestCase):
    def test_candle_is_excluded_from_its_own_baseline(self):
        candles = session(25, [(100, 101, 99, 100)] * 21)
        candles[-1] = Candle(candles[-1].timestamp, 100, 101, 99, 100, 1500)
        self.assertAlmostEqual(_relative_volume(candles, len(candles) - 1), 1.5)

    def test_zero_index_volume_is_unavailable_not_zero(self):
        candles = session(25, [(100, 101, 99, 100)] * 21, volume=0)
        self.assertIsNone(_relative_volume(candles, len(candles) - 1))

    def test_orb_breakout_candle_volume_is_scored(self):
        prior = session(24, [(25000, 25020, 24980, 25000)] * 75)
        opening = [(25000, 25040, 24990, 25010), (25010, 25050, 25000, 25030), (25030, 25060, 25020, 25040)]
        today = session(25, opening + [(25050, 25075, 25045, 25070), (25068, 25080, 25058, 25076)])
        breakout = today[3]
        today[3] = Candle(breakout.timestamp, breakout.open, breakout.high, breakout.low, breakout.close, 2500)
        now = datetime(2026, 9, 25, 9, 45, tzinfo=MARKET_TIMEZONE)
        candles = prior + today
        result = analyze("NIFTY", candles)
        _, calculations, _ = _observe("NIFTY", candles, "ORB_RETEST", result, CONFIG, now)
        self.assertEqual(calculations["score"]["volume_evidence"], 2)
        self.assertAlmostEqual(calculations["underlying"]["relative_volume"], 2.5)


class ExpiryDay(unittest.TestCase):
    def test_expiry_day_raises_minimum_score_and_halves_size(self):
        prior = session(24, [(25000, 25400, 24900, 25000)] * 75)
        opening = [(25000, 25040, 24990, 25010), (25010, 25050, 25000, 25030), (25030, 25060, 25020, 25040)]
        today = session(25, opening + [(25050, 25075, 25045, 25070), (25068, 25080, 25058, 25076)])
        candles = prior + today
        normal = analyze("NIFTY", candles)
        expiry = analyze("NIFTY", candles, expiry_day=True)
        self.assertEqual(expiry["setup"]["size_multiplier"], normal["setup"]["size_multiplier"] * 0.5)
        now = datetime(2026, 9, 25, 9, 45, tzinfo=MARKET_TIMEZONE)
        _, calculations, _ = _observe("NIFTY", candles, "ORB_RETEST", expiry, CONFIG, now, {"expiry_today": True})
        self.assertEqual(calculations["score"]["minimum"], 9.0)

    def test_expiry_day_stops_entries_early(self):
        candles = session(25, [(100, 101, 99, 100)] * 21)
        late = datetime(2026, 9, 25, 14, 35, tzinfo=MARKET_TIMEZONE)
        _, _, normal = _observe("NIFTY", candles, "ORB_RETEST", {}, CONFIG, late)
        _, _, expiry = _observe("NIFTY", candles, "ORB_RETEST", {}, CONFIG, late, {"expiry_today": True})
        self.assertTrue(normal["entry_permitted"])
        self.assertFalse(expiry["entry_permitted"])


class DailyRiskDetail(unittest.TestCase):
    def test_gate_reports_why_daily_risk_blocked(self):
        decision = NoTradeEngine().evaluate(PipelineEvidence(daily_risk_allowed=False, daily_risk_detail="Blocked: 2 consecutive losses"))
        gate = next(g for g in decision.gates if g.code == "DAILY_RISK_BLOCKED")
        self.assertEqual(gate.detail, "Blocked: 2 consecutive losses")


if __name__ == "__main__":
    unittest.main()
