import datetime
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout

from _load import load

M = load("trader-market", "market")
IN = M.get("IN")
US = M.get("US")


class Clock(unittest.TestCase):
    def test_ist_is_utc_plus_five_thirty_all_year(self):
        for utc in (datetime.datetime(2026, 1, 5, 3, 45), datetime.datetime(2026, 7, 6, 3, 45)):
            self.assertEqual(IN.to_local(utc).time(), datetime.time(9, 15))
        self.assertEqual(IN.local_to_utc(datetime.datetime(2026, 11, 2, 9, 15)),
                         datetime.datetime(2026, 11, 2, 3, 45))

    def test_us_clock_unchanged(self):
        self.assertEqual(US.to_local(datetime.datetime(2026, 10, 19, 14, 15)).time(), datetime.time(10, 15))
        self.assertEqual(US.to_local(datetime.datetime(2026, 12, 1, 14, 30)).time(), datetime.time(9, 30))

    def test_nse_session_is_915_to_1530(self):
        self.assertEqual(IN.session(datetime.date(2026, 11, 2)), (datetime.time(9, 15), datetime.time(15, 30)))

    def test_nse_holidays_2026(self):
        self.assertEqual(len(IN.holidays), 16)
        for d in ("2026-01-26", "2026-03-03", "2026-10-02", "2026-11-10", "2026-12-25"):
            ok, why = IN.trading_day(datetime.date.fromisoformat(d))
            self.assertFalse(ok, d)
            self.assertIn("NSE holiday", why)
        self.assertTrue(IN.trading_day(datetime.date(2026, 11, 9))[0])
        self.assertIsNone(IN.session(datetime.date(2026, 11, 7)))  # Saturday

    def test_next_open_skips_the_diwali_holiday(self):
        self.assertEqual(IN.next_open(datetime.date(2026, 11, 9)), "2026-11-11 09:15")

    def test_status_phases(self):
        at = lambda s: IN.local_to_utc(datetime.datetime.strptime(s, "%Y-%m-%d %H:%M"))
        self.assertEqual(IN.status(at("2026-11-09 09:00"))["phase"], "pre-open")
        self.assertTrue(IN.status(at("2026-11-09 10:00"))["open"])
        self.assertEqual(IN.status(at("2026-11-09 15:30"))["phase"], "closed")
        self.assertIn("special_session", IN.status(at("2026-11-08 18:00")))
        self.assertFalse(IN.status(at("2027-01-04 10:00"))["calendar_known"])


class Prices(unittest.TestCase):
    def test_nse_tick_bands(self):
        for price, tick in ((99.99, 0.01), (249.99, 0.01), (250, 0.05), (999, 0.05), (1000, 0.10),
                            (4999, 0.10), (5000, 0.50), (12000, 1.00), (25000, 5.00)):
            self.assertEqual(IN.tick(price), tick, price)

    def test_rounding_to_the_tick(self):
        self.assertEqual(IN.round_down(1234.56), 1234.5)
        self.assertEqual(IN.round_up(1234.56), 1234.6)
        self.assertEqual(IN.round_down(612.33), 612.30)
        self.assertEqual(IN.round_up(612.33), 612.35)
        self.assertEqual(IN.round_down(5003.2), 5003.0)
        self.assertEqual(US.round_down(358.326), 358.32)

    def test_coarser_tick_across_a_band_boundary(self):
        # NSE sets the tick from the band, reviewed from the close: with a ref (the entry) the
        # coarser of the two ticks is used, a multiple of the finer one, valid in either band
        self.assertEqual(IN.tick(999.27), 0.05)
        self.assertEqual(IN.tick(999.27, ref=1000.20), 0.10)
        self.assertEqual(IN.tick(1000.20, ref=999.27), 0.10)
        self.assertEqual(IN.round_down(999.27, ref=1000.20), 999.2)
        self.assertEqual(IN.round_down(999.27), 999.25)
        self.assertEqual(IN.tick(249.73, ref=250.10), 0.05)
        self.assertEqual(IN.round_down(249.73, ref=250.10), 249.7)
        self.assertEqual(IN.round_up(250.02, ref=249.99), 250.05)
        self.assertEqual(IN.round_tick(999.97, ref=1000.2), 1000.0)
        self.assertEqual(US.round_down(358.326, ref=1000), 358.32)

    def test_rupees_use_lakh_and_crore_grouping(self):
        self.assertEqual(IN.money(1234567.5), "₹12,34,567.50")
        self.assertEqual(IN.money(999), "₹999.00")
        self.assertEqual(IN.money(-50, 0), "-₹50")
        self.assertEqual(US.money(2913.44), "$2,913.44")

    def test_symbols(self):
        self.assertEqual(IN.yahoo_symbol("reliance"), "RELIANCE.NS")
        self.assertEqual(IN.yahoo_symbol("TCS.BO"), "TCS.BO")
        self.assertEqual(IN.yahoo_symbol("^NSEI"), "^NSEI")
        self.assertEqual(IN.plain_symbol("INFY.NS"), "INFY")
        self.assertEqual(US.yahoo_symbol("BRK.B"), "BRK-B")


class Charges(unittest.TestCase):
    def test_intraday_round_trip(self):
        c = IN.charges(40, 1250, 1262.5)
        # buy 50,000 and sell 50,500: brokerage capped at Rs 20 a leg
        self.assertEqual(c["brokerage"], 40.0)
        self.assertEqual(c["stt"], 12.62)
        self.assertEqual(c["stamp"], 1.5)
        self.assertAlmostEqual(c["total"], 65.07, places=2)

    def test_small_order_pays_minimum_brokerage(self):
        c = IN.charges(1, 500, 505)
        self.assertEqual(c["brokerage"], 10.0)  # Rs 5 minimum each side

    def test_overrides_from_config(self):
        c = IN.charges(40, 1250, 1262.5, {"charges": {"brokerage_max": 0, "brokerage_min": 0}})
        self.assertEqual(c["brokerage"], 0.0)

    def test_us_is_commission_free(self):
        self.assertEqual(US.charges(8, 364.18, 370.04)["total"], 0.0)


class Resolve(unittest.TestCase):
    def test_order_flag_config_env_default(self):
        old = os.environ.get("TRADER_MARKET")
        try:
            os.environ.pop("TRADER_MARKET", None)
            self.assertEqual(M.resolve().code, "IN")
            os.environ["TRADER_MARKET"] = "US"
            self.assertEqual(M.resolve().code, "US")
            self.assertEqual(M.resolve(cfg={"market": "NSE"}).code, "IN")
            self.assertEqual(M.resolve("us", {"market": "IN"}).code, "US")
        finally:
            if old is None:
                os.environ.pop("TRADER_MARKET", None)
            else:
                os.environ["TRADER_MARKET"] = old
        with self.assertRaises(M.MarketError):
            M.get("LSE")

    def test_inr_keys_alias_the_upstream_names(self):
        cfg = M.normalize_config({"max_loss_per_trade_inr": 500, "max_order_usd": 1})
        self.assertEqual(cfg["max_loss_per_trade_usd"], 500)
        self.assertEqual(cfg["max_order_usd"], 1)


class Cli(unittest.TestCase):
    def run_cli(self, *argv):
        with tempfile.TemporaryDirectory() as d:
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = M.main(["--config", os.path.join(d, "none.json"), "--market", "IN"] + list(argv))
            return rc, buf.getvalue()

    def test_status_json(self):
        rc, out = self.run_cli("--json", "status", "--at", "2026-11-10 10:00")
        self.assertEqual(rc, 0)
        res = json.loads(out)
        self.assertEqual(res["next_open"], "2026-11-11 09:15")

    def test_next_open_outside_the_holiday_list_is_flagged(self):
        rc, out = self.run_cli("status", "--at", "2026-12-31 16:00")
        self.assertIn("Next open: 2027-01-01 09:15 IST", out)
        self.assertIn("Holiday list covers 2026 only", out)
        rc, out = self.run_cli("--json", "status", "--at", "2026-12-31 16:00")
        self.assertIs(json.loads(out)["next_open_calendar_known"], False)
        rc, out = self.run_cli("status", "--at", "2026-11-10 10:00")
        self.assertNotIn("Holiday list covers", out)

    def test_charges_text(self):
        rc, out = self.run_cli("charges", "--qty", "40", "--buy", "1250", "--sell", "1262.5")
        self.assertIn("₹65.07", out)


if __name__ == "__main__":
    unittest.main()
