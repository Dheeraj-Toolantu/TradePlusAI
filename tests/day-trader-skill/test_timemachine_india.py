"""trader-timemachine on the Indian market (NSE, IST, INR).

Fixture: fixtures/trader-timemachine-in/RELIANCE.NS-60d5m-synthetic.json.gz, SYNTHETIC
five-minute bars (not market data) in Yahoo chart JSON v8 shape (range=60d interval=5m):
60 NSE sessions from 2026-08-04 to 2026-10-30, NSE holidays skipped, 75 bars a day from
03:45Z (9:15 IST), 2026-10-16 cut to 72 bars. Made by make_synthetic.py in that folder.
"""

import copy
import gzip
import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr

from _load import load, FIX

tm = load("trader-timemachine", "timemachine", market="IN")

GZ = os.path.join(FIX, "trader-timemachine-in", "RELIANCE.NS-60d5m-synthetic.json.gz")
with gzip.open(GZ, "rt", encoding="utf-8") as _fh:
    TEXT = _fh.read()
NOW = tm.parse_now("2026-10-30 15:40")
PLAN = {"created_by": "trader-exit", "symbol": "RELIANCE", "side": "buy", "date": "2026-10-30", "setup": "orb",
        "entry": 1415.3, "entry_time": "9:50 AM", "entry_bar": 6, "interval": "5m",
        "opening_range": {"high": 1412.0, "low": 1398.0, "minutes": 15},
        "stop": 1405.0, "stop_rule": "or_mid", "target": 1435.9, "target_r": 2.0,
        "risk_per_share": 10.3, "reward_risk": 2.0, "flat_by": "15:10", "market": "IN", "currency": "INR",
        "charges_ref": {"qty": 70}}


def machine(raw=None, text=TEXT, now=NOW, **kw):
    kw.setdefault("replays", 2000)
    return tm.time_machine(text, tm.normalize_plan(dict(raw or PLAN)), now, **kw)


def run(argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = tm.main(argv)
    return code, out.getvalue(), err.getvalue()


class Session(unittest.TestCase):
    def test_nse_session_shape(self):
        self.assertEqual(tm.MK.code, "IN")
        self.assertEqual((tm.SESSION_BARS, tm.OPEN_MIN, tm.CLOSE_MIN), (75, 9 * 60 + 15, 15 * 60 + 30))
        self.assertEqual(tm.to_eastern(tm.utc_of(1793331900)).strftime("%H:%M"), "09:15")
        self.assertEqual(tm.parse_now("2026-10-30 09:50 IST"), tm.parse_now("2026-10-30T04:20:00Z"))

    def test_buckets_by_ist_time_of_day(self):
        meta, bars, dropped = tm.parse_bars(tm.chart_result(TEXT, "RELIANCE"), NOW)
        self.assertEqual(meta["exchangeTimezoneName"], "Asia/Kolkata")
        self.assertEqual(bars[0]["start"], "09:15")
        self.assertEqual(bars[0]["slot"], 0)
        self.assertEqual(max(b["slot"] for b in bars), 74)
        self.assertEqual(sum(dropped.values()), 0)
        days = tm.split_sessions(bars)
        self.assertEqual(len(days), 60)
        full, short = tm.full_sessions(days, "2026-10-30")
        self.assertEqual(len(full), 58)
        self.assertEqual(short, [{"date": "2026-10-16", "bars": 72}])
        for hol in ("2026-08-15", "2026-09-14", "2026-10-02", "2026-10-20"):
            self.assertNotIn(hol, days)

    def test_a_holiday_session_is_left_out(self):
        """Bars on a non-trading day (say a Muhurat evening) never enter the pool."""
        meta, bars, _ = tm.parse_bars(tm.chart_result(TEXT, "RELIANCE"), NOW)
        days = tm.split_sessions(bars)
        days["2026-10-20"] = days["2026-10-19"]          # Dussehra, an NSE holiday
        full, short = tm.full_sessions(days, "2026-10-30")
        self.assertNotIn("2026-10-20", [d for d, _ in full])
        self.assertIn("Dussehra", [x for x in short if x["date"] == "2026-10-20"][0]["reason"])


class Run(unittest.TestCase):
    def test_replays_to_flat_by_and_reports_in_rupees(self):
        doc = machine()
        m = doc["mc"]
        self.assertEqual(m["until"], "15:10")
        self.assertEqual(m["bars_left"], 70 - 6)                  # the 15:05 bar closes at 15:10
        self.assertEqual(m["band_times"][0], "09:50")
        self.assertEqual(m["band_times"][-1], "15:10")
        self.assertEqual(m["pool_sessions"], 58)
        self.assertEqual(doc["market"], "IN")
        self.assertEqual(doc["data"]["last_bar"], "2026-10-30 15:25 IST")
        text = "\n".join(tm.report(doc))
        self.assertIn("entry ₹1,415.30 at 9:50 AM IST (bar 6), stop ₹1,405.00", text)
        self.assertIn("still open at 3:10 PM", text)
        self.assertIn("Price at 3:10 PM: median ₹", text)
        self.assertIn("Average R after charges", text)
        self.assertEqual(doc["history"]["rule"]["stop_rule"], "or_mid")

    def test_net_r_is_gross_minus_charges(self):
        doc = machine()
        m, h, ch = doc["mc"], doc["history"], doc["charges"]
        self.assertEqual(ch["qty"], 70)
        self.assertIn("charges_ref", ch["basis"])
        self.assertLess(m["avg_R_net"], m["avg_R"])
        # every replay pays about Rs 82 on 70 shares, about 0.114R of the Rs 721 risk
        self.assertAlmostEqual(m["avg_R"] - m["avg_R_net"], ch["at_stop"] / (70 * 10.3), delta=0.003)
        self.assertLess(h["avg_R_net"], h["avg_R"])
        for t in h["trades"]:
            self.assertLess(t["R_net"], t["R"] + 0.005)
            self.assertAlmostEqual(t["stop"] * 10 % 1, 0, places=6)   # history stops on the 0.10 tick
        # without charges_ref the reference is Rs 1 lakh worth
        raw = dict(PLAN)
        del raw["charges_ref"]
        self.assertEqual(machine(raw, replays=50)["charges"]["qty"], 70)
        self.assertEqual(machine(dict(raw, qty=5), replays=50)["charges"]["qty"], 5)

    def test_same_seed_same_numbers_and_until(self):
        a, b = machine(replays=500), machine(replays=500)
        self.assertEqual(a["mc"], b["mc"])
        doc = machine(until="15:30", replays=200)
        self.assertEqual(doc["mc"]["until"], "15:30")
        doc = machine(dict(PLAN, flat_by="14:00"), replays=200)
        self.assertEqual(doc["mc"]["until"], "14:00")
        with self.assertRaises(tm.TMError):
            machine(until="15:35", replays=10)

    def test_refusals(self):
        with self.assertRaises(tm.TMError) as cm:
            machine(dict(PLAN, entry_time="3:30 PM", entry_bar=None))
        self.assertIn("between 9:20 AM and 3:25 PM", str(cm.exception))
        with self.assertRaises(tm.TMError) as cm:
            machine(dict(PLAN, market="US"))
        self.assertIn("--market US", str(cm.exception))
        with self.assertRaises(tm.TMError) as cm:
            machine(dict(PLAN, symbol="TCS"))
        self.assertIn("RELIANCE.NS but the plan is for TCS", str(cm.exception))
        with self.assertRaises(tm.TMError):
            machine(now=tm.parse_now("2026-10-30 09:40"))           # the entry bar has not closed yet
        self.assertEqual(tm.normalize_plan(dict(PLAN, symbol="M&M"))["symbol"], "M&M")
        self.assertEqual(tm.normalize_plan(dict(PLAN, symbol="reliance.ns"))["symbol"], "RELIANCE")
        self.assertIn("/chart/M%26M.NS?", tm.chart_url("M&M"))


class Cli(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.cwd = os.getcwd()
        os.chdir(self.d)
        os.mkdir("trader")
        with open(os.path.join("trader", "plan.json"), "w") as fh:
            json.dump(PLAN, fh)

    def tearDown(self):
        os.chdir(self.cwd)
        shutil.rmtree(self.d)

    def test_run_write_and_chart(self):
        code, text, err = run(["run", "--market", "IN", "--offline", GZ, "--now", "2026-10-30 15:40 IST",
                               "--replays", "500", "--write"])
        self.assertEqual(code, 0, err)
        self.assertIn("/trader-budget", text)
        with open(os.path.join("trader", "timemachine.json")) as fh:
            doc = json.load(fh)
        self.assertEqual((doc["mc"]["until"], doc["currency"]), ("15:10", "INR"))
        os.mkdir("charts")
        shutil.copy(GZ, os.path.join("charts", "RELIANCE-60d5m.json.gz"))
        code, text, err = run(["chart", "--market", "IN", "--offline", "charts", "--now", "2026-10-30 15:40",
                               "--replays", "200"])
        self.assertEqual(code, 0, err)
        self.assertIn("3:10", text)

    def test_flags_plan_and_charge_overrides(self):
        with open(os.path.join("trader", "config.json"), "w") as fh:
            json.dump({"market": "IN", "charges": {"brokerage_max": 0, "brokerage_min": 0}}, fh)
        code, text, err = run(["run", "--offline", GZ, "--now", "2026-10-30 15:40", "--replays", "300", "--json",
                               "--symbol", "RELIANCE", "--date", "2026-10-30", "--entry", "1415.3", "--stop", "1405",
                               "--target", "1435.9", "--entry-time", "9:50 AM"])
        self.assertEqual(code, 0, err)
        doc = json.loads(text)
        self.assertEqual(doc["charges"]["qty"], 70)
        cheap = doc["charges"]["at_target"]
        os.remove(os.path.join("trader", "config.json"))
        code, text, _ = run(["run", "--market", "IN", "--offline", GZ, "--now", "2026-10-30 15:40", "--replays", "300",
                             "--json"])
        self.assertLess(cheap, json.loads(text)["charges"]["at_target"])


if __name__ == "__main__":
    unittest.main()
