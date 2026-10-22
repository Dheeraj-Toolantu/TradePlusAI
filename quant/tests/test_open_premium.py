import unittest
from datetime import datetime, timedelta, timezone

from tradepulse_quant.algo_engine.open_premium import OpenConfig, analyze_payload, estimate, next_open
from tradepulse_quant.algo_engine.premium_math import PremiumConfig, bs_price, implied_vol, years_to_expiry

IST = timezone(timedelta(hours=5, minutes=30))
THURSDAY_CLOSE = datetime(2026, 10, 22, 15, 30, tzinfo=IST)
FRIDAY_CLOSE = datetime(2026, 10, 23, 15, 30, tzinfo=IST)
EXPIRY = "2026-10-27"


class NextOpenTest(unittest.TestCase):
    def test_after_the_close_it_is_the_next_weekday(self):
        self.assertEqual(next_open(THURSDAY_CLOSE), datetime(2026, 10, 23, 9, 15, tzinfo=IST))
        self.assertEqual(next_open(FRIDAY_CLOSE), datetime(2026, 10, 26, 9, 15, tzinfo=IST))

    def test_before_the_open_it_is_today(self):
        self.assertEqual(next_open(datetime(2026, 10, 22, 8, 0, tzinfo=IST)).date().isoformat(), "2026-10-22")


class EstimateTest(unittest.TestCase):
    def test_flat_open_only_loses_overnight_decay(self):
        result = estimate(25000, 25000, "PE", 24900, 80, EXPIRY, THURSDAY_CLOSE, iv_change=0)
        self.assertLess(result["estimate"], 80)
        self.assertEqual(result["breakdown"]["index_move"], 0)
        self.assertEqual(result["breakdown"]["iv_change"], 0)
        self.assertAlmostEqual(result["breakdown"]["overnight_decay"], result["estimate"] - 80, delta=0.05)

    def test_weekend_decay_is_larger_than_one_night(self):
        weekday = estimate(25000, 25000, "PE", 24900, 80, "2026-10-30", THURSDAY_CLOSE, iv_change=0)
        weekend = estimate(25000, 25000, "PE", 24900, 80, "2026-10-30", FRIDAY_CLOSE, iv_change=0)
        self.assertEqual(weekend["inputs"]["calendar_days_to_open"], 2.74)
        self.assertLess(weekend["breakdown"]["overnight_decay"], weekday["breakdown"]["overnight_decay"])

    def test_gap_down_to_the_key_level_reprices_the_put_with_every_factor(self):
        result = estimate(25000, 24800, "PE", 24900, 80, EXPIRY, THURSDAY_CLOSE, bid=79.5, ask=80.5)
        # The model reprices today's premium exactly, then moves time, spot and vol.
        sigma = result["inputs"]["iv_pct"] / 100
        rate = PremiumConfig().rate
        self.assertAlmostEqual(bs_price(25000, 24900, years_to_expiry(EXPIRY, THURSDAY_CLOSE), sigma, "PE", rate), 80, delta=0.1)  # IV is reported to 2 decimals
        self.assertEqual(result["inputs"]["iv_change_points"], 1.6)  # 0.8% fall x 2 pts
        parts = result["breakdown"]
        self.assertLess(parts["overnight_decay"], 0)
        self.assertGreater(parts["index_move"], 0)
        self.assertGreater(parts["iv_change"], 0)
        self.assertAlmostEqual(80 + parts["overnight_decay"] + parts["index_move"] + parts["iv_change"], result["estimate"], delta=0.05)
        self.assertEqual(parts["intrinsic_at_open"], 100)
        low, base, high = result["cases"]
        self.assertLess(low["premium"], base["premium"])
        self.assertLess(base["premium"], high["premium"])
        self.assertEqual(result["range"], [low["premium"], high["premium"]])
        self.assertLess(result["opening_quote"]["bid"], result["estimate"])
        self.assertGreater(result["opening_quote"]["ask"], result["estimate"])

    def test_rally_drains_iv_for_a_call(self):
        result = estimate(25000, 25200, "CE", 25100, 80, EXPIRY, THURSDAY_CLOSE)
        self.assertEqual(result["inputs"]["iv_change_points"], -0.8)
        self.assertLess(result["breakdown"]["iv_change"], 0)
        self.assertGreater(result["estimate"], 80)

    def test_iv_change_is_capped_and_can_be_overridden(self):
        crash = estimate(25000, 23000, "PE", 24900, 80, EXPIRY, THURSDAY_CLOSE)
        self.assertEqual(crash["inputs"]["iv_change_points"], OpenConfig().iv_cap)
        crush = estimate(25000, 24800, "PE", 24900, 80, EXPIRY, THURSDAY_CLOSE, iv_change=-4)
        self.assertEqual(crush["inputs"]["iv_change_source"], "your input")
        self.assertLess(crush["estimate"], estimate(25000, 24800, "PE", 24900, 80, EXPIRY, THURSDAY_CLOSE)["estimate"])

    def test_later_reach_times_decay(self):
        ladder = estimate(25000, 24800, "PE", 24900, 80, EXPIRY, THURSDAY_CLOSE)["ladder"]
        prices = [row["premium"] for row in ladder]
        self.assertEqual(ladder[0]["time"], "09:15")
        self.assertEqual(prices, sorted(prices, reverse=True))

    def test_contract_expiring_before_the_next_session_is_refused(self):
        result = estimate(25000, 24800, "PE", 24900, 80, "2026-10-22", THURSDAY_CLOSE)
        self.assertEqual(result["status"], "ERROR")
        self.assertIn("expires", result["reason"])

    def test_premium_below_intrinsic_falls_back_to_chain_iv(self):
        result = estimate(25000, 24800, "PE", 25200, 150, EXPIRY, THURSDAY_CLOSE, iv=12.0)
        self.assertIsNone(implied_vol(150, 25000, 25200, years_to_expiry(EXPIRY, THURSDAY_CLOSE), "PE", PremiumConfig().rate))
        self.assertEqual(result["inputs"]["iv_pct"], 12.0)
        self.assertIn("chain", result["inputs"]["iv_source"])


def chain() -> dict:
    return {"spot": 25000, "contracts": [
        {"symbol": "NIFTY26OCT24900PE", "contract": "PUT", "strike": 24900, "premium": 80, "bid": 79.5, "ask": 80.5, "iv": 11.5, "expiry": EXPIRY},
        {"symbol": "NIFTY26NOV24900PE", "contract": "PUT", "strike": 24900, "premium": 160, "expiry": "2026-11-03"},
        {"symbol": "NIFTY26OCT24900CE", "contract": "CALL", "strike": 24900, "premium": 170, "expiry": EXPIRY},
    ]}


class PayloadTest(unittest.TestCase):
    def test_chain_fills_premium_expiry_and_spot(self):
        result = analyze_payload({"symbol": "nifty", "option_type": "PE", "strike": 24900, "key_level": 24800, "now": THURSDAY_CLOSE.isoformat(), "option_chain": chain()})
        self.assertEqual(result["status"], "READY")
        self.assertEqual(result["contract"], "NIFTY26OCT24900PE")
        self.assertEqual(result["inputs"]["premium"], 80)
        self.assertEqual(result["inputs"]["premium_source"], "option chain")
        self.assertEqual(result["inputs"]["chain_iv_pct"], 11.5)

    def test_custom_premium_and_spot_override_the_chain(self):
        result = analyze_payload({"option_type": "PE", "strike": 24900, "key_level": 24800, "premium": 95, "spot": 24980, "now": THURSDAY_CLOSE.isoformat(), "option_chain": chain()})
        self.assertEqual((result["inputs"]["premium"], result["inputs"]["spot"]), (95, 24980))
        self.assertEqual(result["inputs"]["premium_source"], "your input")
        self.assertGreater(result["estimate"], analyze_payload({"option_type": "PE", "strike": 24900, "key_level": 24800, "now": THURSDAY_CLOSE.isoformat(), "option_chain": chain()})["estimate"])

    def test_missing_premium_without_a_chain_row(self):
        result = analyze_payload({"option_type": "PE", "strike": 24000, "key_level": 24800, "spot": 25000, "now": THURSDAY_CLOSE.isoformat()})
        self.assertEqual(result["status"], "ERROR")


if __name__ == "__main__":
    unittest.main()
