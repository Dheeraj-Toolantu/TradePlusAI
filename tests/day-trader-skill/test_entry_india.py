"""trader-entry on the Indian market (NSE, IST, INR).

Fixture: fixtures/trader-entry-in/RELIANCE.NS-2026-10-30-5m-synthetic.json, SYNTHETIC
five-minute bars (not market data) in Yahoo chart JSON v8 shape for one NSE session,
9:15 to 15:30 IST (03:45Z to 10:00Z), made by fixtures/trader-timemachine-in/make_synthetic.py.
The opening range (9:15, 9:20, 9:25 bars) is 1398.00 to 1412.00; the 9:45 bar (bar 6)
closes 1415.30, so the breakout triggers at 9:50 AM IST.
"""

import copy
import datetime
import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr

from _load import load, FIX

entry = load("trader-entry", "entry", market="IN")

FILE = os.path.join(FIX, "trader-entry-in", "RELIANCE.NS-2026-10-30-5m-synthetic.json")
DT = datetime.datetime
OPEN_TS = 1793331900          # 2026-10-30 09:15 IST = 03:45Z


def doc():
    with open(FILE) as fh:
        return json.load(fh)


def chart(d=None):
    return entry.parse_chart(json.dumps(d if d is not None else doc()), "RELIANCE")


def at(text, d=None, **kw):
    return entry.evaluate(chart(d), entry.parse_now(text), **kw)


def shift_to(d, day):
    """The same session moved to another date (IST has no daylight time: 9:15 is always 03:45Z)."""
    d = copy.deepcopy(d)
    r = d["chart"]["result"][0]
    new_open = int((DT.combine(day, datetime.time(3, 45)) - DT(1970, 1, 1)).total_seconds())
    delta = new_open - OPEN_TS
    r["timestamp"] = [t + delta for t in r["timestamp"]]
    r["meta"]["regularMarketTime"] += delta
    return d


def no_breakout():
    d = doc()
    q = d["chart"]["result"][0]["indicators"]["quote"][0]
    for i in range(3, len(q["close"])):
        q["close"][i] = min(q["close"][i], 1411.0)
        q["high"][i] = min(q["high"][i], 1411.5)
        q["open"][i] = min(q["open"][i], 1411.0)
    return d


def run(argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = entry.main(argv)
    return code, out.getvalue(), err.getvalue()


class Market(unittest.TestCase):
    def test_profile_is_nse(self):
        self.assertEqual(entry.MK.code, "IN")
        self.assertEqual((entry.OPEN, entry.CLOSE), (datetime.time(9, 15), datetime.time(15, 30)))
        self.assertEqual(entry.DEFAULTS, {"no_entries_before": "09:30", "no_entries_after": "14:45"})

    def test_clock_is_ist(self):
        self.assertEqual(entry.parse_now("2026-10-30 09:50"), DT(2026, 10, 30, 4, 20))
        self.assertEqual(entry.parse_now("2026-10-30 09:50 IST"), DT(2026, 10, 30, 4, 20))
        self.assertEqual(entry.parse_now("2026-10-30T04:20:00Z"), DT(2026, 10, 30, 4, 20))
        self.assertEqual(entry.to_eastern(DT(2026, 1, 5, 3, 45)), DT(2026, 1, 5, 9, 15))
        self.assertEqual(entry.eastern_offset(DT(2026, 7, 1)), 5.5)
        with self.assertRaises(entry.EntryError) as cm:
            entry.parse_now("tomorrow")
        self.assertIn("IST", str(cm.exception))

    def test_symbols(self):
        self.assertEqual(entry.yahoo_symbol("reliance"), "RELIANCE.NS")
        self.assertEqual(entry.plain_symbol("RELIANCE.NS"), "RELIANCE")
        self.assertIn("/chart/M%26M.NS?", entry.chart_path("M&M", "1d", "5m"))
        self.assertIn("/chart/BAJAJ-AUTO.NS?", entry.chart_path("BAJAJ-AUTO", "1d", "5m"))
        self.assertEqual(at("2026-10-30 09:50")["symbol"], "RELIANCE")

    def test_money_and_ticks(self):
        self.assertEqual(entry.px(1415.3), "₹1,415.30")
        self.assertEqual(entry.px(123456.5), "₹1,23,456.50")
        self.assertEqual(entry.rp(1415.300048828125), 1415.3)
        self.assertEqual(entry.rp(612.33), 612.35)          # 0.05 tick from Rs 250


class Phases(unittest.TestCase):
    def test_not_open_yet(self):
        r = at("2026-10-30 09:10")
        self.assertEqual((r["status"], r["phase"]), ("waiting", "pre-open"))
        self.assertIn("the NSE opens at 9:15", r["reason"])
        self.assertIn("set at 9:30", r["reason"])

    def test_range_forming(self):
        r = at("2026-10-30 09:26")
        self.assertEqual((r["status"], r["phase"]), ("waiting", "forming"))
        self.assertEqual(r["opening_range"]["bars"], 2)
        self.assertIn("NOT OPEN YET", "\n".join(entry.describe(at("2026-10-30 09:00"))))
        self.assertIn("RANGE FORMING", "\n".join(entry.describe(r)))

    def test_waiting_then_triggered(self):
        r = at("2026-10-30 09:47")
        self.assertEqual(r["status"], "waiting")
        self.assertEqual(r["opening_range"]["high"], 1412.0)
        self.assertEqual(r["opening_range"]["low"], 1398.0)
        self.assertIn("₹0.80 under the range high ₹1,412.00", r["reason"])
        r = at("2026-10-30 09:50")
        self.assertEqual(r["status"], "triggered")
        t = r["trigger"]
        self.assertEqual((t["time"], t["bar_start"], t["bar_index"], t["price"]), ("9:50 AM", "09:45", 6, 1415.3))
        text = "\n".join(entry.describe(r))
        self.assertIn("RELIANCE  Fri 2026-10-30 09:50 IST", text)
        self.assertIn("TRIGGERED 9:50 AM IST at ₹1,415.30", text)
        self.assertIn("Opening range 9:15-9:30: high ₹1,412.00, low ₹1,398.00", text)
        self.assertIn("Nothing was placed", text)

    def test_entry_window_and_expiry(self):
        d = no_breakout()
        self.assertEqual(at("2026-10-30 14:44", d)["status"], "waiting")
        r = at("2026-10-30 14:45", d)
        self.assertEqual(r["status"], "expired")
        self.assertIn("by 14:45", r["reason"])
        self.assertEqual(r["no_entries_after"], "14:45")
        self.assertEqual(at("2026-10-30 15:35", d)["phase"], "after-close")
        # a level under the open: the first close that ends at or after 09:30 is the 9:25 bar's
        r = at("2026-10-30 10:00", setup="level", level=1300)
        self.assertEqual((r["trigger"]["time"], r["trigger"]["bar_index"]), ("9:30 AM", 2))

    def test_holidays_and_next_open(self):
        r = at("2026-11-10 10:00", shift_to(doc(), datetime.date(2026, 11, 10)))
        self.assertEqual((r["status"], r["phase"]), ("no-data", "closed"))
        self.assertIn("NSE holiday: Diwali Balipratipada", r["reason"])
        self.assertEqual(r["next_open"], "2026-11-11 09:15")
        self.assertIn("Next open: 2026-11-11 09:15 IST.", "\n".join(entry.describe(r)))
        r = at("2026-10-31 10:00")
        self.assertEqual(r["next_open"], "2026-11-02 09:15")
        r = at("2026-11-09 09:50", shift_to(doc(), datetime.date(2026, 11, 9)))
        self.assertEqual(r["trigger"]["time"], "9:50 AM")
        self.assertFalse(at("2027-02-01 10:00")["calendar_known"])
        self.assertIn("nseindia.com", "\n".join(entry.describe(at("2027-02-01 10:00"))))


class Cli(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.cwd = os.getcwd()
        os.chdir(self.d)

    def tearDown(self):
        os.chdir(self.cwd)
        shutil.rmtree(self.d)

    def test_check_writes_plain_symbol_and_market(self):
        code, text, err = run(["check", "RELIANCE.NS", "--market", "IN", "--offline", FILE,
                               "--now", "2026-10-30 09:52 IST", "--write"])
        self.assertEqual(code, 0, err)
        with open(os.path.join("trader", "entry.json")) as fh:
            e = json.load(fh)
        want = {"symbol": "RELIANCE", "status": "triggered", "time": "9:50 AM", "bar_index": 6, "price": 1415.3,
                "level": 1412.0, "opening_range": {"high": 1412.0, "low": 1398.0, "minutes": 15},
                "market": "IN", "currency": "INR", "checked_at": "2026-10-30T04:22:00Z"}
        for k, v in want.items():
            self.assertEqual(e[k], v, k)

    def test_offline_folder_with_the_plain_name_and_inr_config(self):
        os.mkdir("charts")
        shutil.copy(FILE, os.path.join("charts", "RELIANCE.json"))
        os.mkdir("trader")
        with open(os.path.join("trader", "config.json"), "w") as fh:
            json.dump({"market": "IN", "no_entries_after": "09:45", "max_loss_per_trade_inr": 500}, fh)
        code, text, _ = run(["check", "reliance", "--offline", "charts", "--now", "2026-10-30 09:52"])
        self.assertEqual(code, 1)
        self.assertIn("EXPIRED", text)

    def test_watch_and_watchlist(self):
        code, text, _ = run(["watch", "RELIANCE", "--market", "IN", "--offline", FILE, "--now", "2026-10-30 09:00",
                             "--out", "e.json"])
        self.assertEqual(code, 0)
        self.assertIn("09:00 IST  not open yet: watching from the first bar's close at 9:20.", text)
        self.assertIn(" 9:45 bar  closed ₹1,415.30  TRIGGERED", text)
        os.mkdir("charts")
        shutil.copy(FILE, os.path.join("charts", "RELIANCE.NS.json"))
        os.mkdir("trader")
        with open(os.path.join("trader", "watchlist.json"), "w") as fh:
            json.dump({"hits": [{"symbol": "RELIANCE.NS"}, {"symbol": "TCS"}]}, fh)
        code, text, _ = run(["watchlist", "--market", "IN", "--offline", "charts", "--now", "2026-10-30 10:00"])
        self.assertEqual(code, 0)
        self.assertIn("RELIANCE  triggered  9:50 AM   ₹1,415.30", text)
        self.assertIn("TCS     error: no offline file", text)

    def test_us_flag_still_gives_new_york(self):
        us = os.path.join(FIX, "trader-entry", "TSLA-2026-10-19-5m.json")
        code, text, _ = run(["check", "TSLA", "--market", "US", "--offline", us, "--now", "2026-10-19 10:15 ET"])
        self.assertEqual(code, 0)
        self.assertIn("TRIGGERED 10:15 AM at $364.18", text)
        run(["check", "RELIANCE", "--market", "IN", "--offline", FILE, "--now", "2026-10-30 09:50"])
        self.assertEqual(entry.MK.code, "IN")


if __name__ == "__main__":
    unittest.main()
