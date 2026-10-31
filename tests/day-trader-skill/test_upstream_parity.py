"""Parity with the upstream day-trader logic, on the Indian market.

The upstream suites (test_entry, test_exit, test_timemachine, ...) prove the US mode still reproduces
the upstream numbers. This file proves the India mode runs the SAME logic: it takes the upstream's
real TSLA 5-minute candles, moves them onto the NSE clock (US bar k of a session, 9:30 ET + 5k,
becomes NSE bar k, 9:15 IST + 5k; NSE has 75 bars, so bars 75-77 are dropped; the 60 sessions are
mapped newest first onto 60 NSE trading days), and checks that every decision matches, apart from
the differences the Indian market requires (the 0.05 tick, the 15:10 flat-by, charges).
"""

import datetime
import gzip
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

from _load import FIX, ROOT, load

M = load("trader-market", "market")
US, IN = M.get("US"), M.get("IN")
EPOCH = datetime.datetime(1970, 1, 1)
ENTRY_US = os.path.join(FIX, "trader-entry", "TSLA-2026-10-19-5m.json")
TM_US = os.path.join(FIX, "trader-timemachine", "TSLA-60d5m.json.gz")


def to_nse(doc, day_map=None):
    r = doc["chart"]["result"][0]
    q = r["indicators"]["quote"][0]
    keep = []
    for i, ts in enumerate(r["timestamp"]):
        local = US.to_local(EPOCH + datetime.timedelta(seconds=ts))
        mins = local.hour * 60 + local.minute - (9 * 60 + 30)
        if mins < 0 or mins % 5 or mins // 5 >= 75:
            continue
        day = day_map.get(local.date()) if day_map else local.date()
        if day is None:
            continue
        ist = datetime.datetime.combine(day, datetime.time(9, 15)) + datetime.timedelta(minutes=mins)
        keep.append((int((IN.local_to_utc(ist) - EPOCH).total_seconds()), i))
    out = json.loads(json.dumps(doc))
    ro = out["chart"]["result"][0]
    qo = ro["indicators"]["quote"][0]
    ro["timestamp"] = [t for t, _ in keep]
    for f in q:
        qo[f] = [q[f][i] for _, i in keep]
    ro["meta"].update(currency="INR", symbol="TSLA.NS", exchangeName="NSI", fullExchangeName="NSE",
                      gmtoffset=19800, timezone="IST", exchangeTimezoneName="Asia/Kolkata",
                      regularMarketTime=keep[-1][0] + 300)
    ro["meta"].pop("currentTradingPeriod", None)
    ro["meta"].pop("tradingPeriods", None)
    return out


def nse_day_map(doc):
    r = doc["chart"]["result"][0]
    us_days = sorted({US.to_local(EPOCH + datetime.timedelta(seconds=t)).date() for t in r["timestamp"]},
                     reverse=True)
    nse_days, d = [], datetime.date(2026, 10, 19)
    while len(nse_days) < len(us_days):
        if IN.session(d):
            nse_days.append(d)
        d -= datetime.timedelta(days=1)
    return dict(zip(us_days, nse_days))


def run(tool, args, cwd, market):
    env = dict(os.environ, TRADER_MARKET=market)
    r = subprocess.run([sys.executable, os.path.join(ROOT, tool)] + args + ["--market", market],
                       cwd=cwd, env=env, capture_output=True, text=True)
    if r.returncode != 0:
        raise AssertionError("%s failed: %s %s" % (tool, r.stdout[-800:], r.stderr[-800:]))
    return r.stdout


class IndiaRunsTheUpstreamLogic(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        with open(ENTRY_US) as fh:
            entry_doc = json.load(fh)
        with gzip.open(TM_US, "rt") as fh:
            tm_doc = json.load(fh)
        cls.entry_in = os.path.join(cls.tmp, "TSLA.NS-2026-10-19-5m.json")
        cls.tm_in = os.path.join(cls.tmp, "TSLA.NS-60d5m.json.gz")
        with open(cls.entry_in, "w") as fh:
            json.dump(to_nse(entry_doc), fh)
        with gzip.open(cls.tm_in, "wt") as fh:
            json.dump(to_nse(tm_doc, nse_day_map(tm_doc)), fh)
        # the India pipeline: entry -> exit -> time machine, at 10:00 IST (= 10:15 ET on the US clock)
        cls.india = os.path.join(cls.tmp, "in")
        os.makedirs(os.path.join(cls.india, "trader"))
        shutil.copy(os.path.join(ROOT, "trader-budget", "config.example.json"),
                    os.path.join(cls.india, "trader", "config.json"))
        now = ["--now", "2026-10-19 10:00"]
        run("trader-entry/entry.py", ["check", "TSLA", "--setup", "orb", "--offline", cls.entry_in, "--write"] + now,
            cls.india, "IN")
        run("trader-exit/exit.py", ["plan", "--stop", "or-mid", "--target", "1R", "--write"] + now, cls.india, "IN")
        run("trader-timemachine/timemachine.py", ["run", "--seed", "19", "--offline", cls.tm_in, "--write"] + now,
            cls.india, "IN")
        with open(os.path.join(cls.india, "trader", "plan.json")) as fh:
            cls.plan = json.load(fh)
        with open(os.path.join(cls.india, "trader", "timemachine.json")) as fh:
            cls.tm = json.load(fh)
        # the upstream logic (US mode, byte-identical to the original repo) on the original candles,
        # given the India plan's prices and the India flat-by (15:10 IST = 15:25 on the US bar clock)
        cls.us = os.path.join(cls.tmp, "us")
        os.makedirs(cls.us)
        out = run("trader-timemachine/timemachine.py",
                  ["run", "--symbol", "TSLA", "--side", "buy", "--date", "2026-10-19",
                   "--entry", str(cls.plan["entry"]), "--stop", str(cls.plan["stop"]),
                   "--target", str(cls.plan["target"]), "--entry-time", "10:15 AM", "--stop-rule", "or_mid",
                   "--until", "15:25", "--seed", "19", "--offline", TM_US, "--now", "2026-10-19 10:15", "--json"],
                  cls.us, "US")
        cls.tm_us = json.loads(out)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_same_opening_range_and_trigger_bar(self):
        with open(os.path.join(self.india, "trader", "entry.json")) as fh:
            e = json.load(fh)
        self.assertEqual(e["status"], "triggered")
        self.assertEqual(self.plan["entry_bar"], 8)        # upstream: the 10:10 bar, bar 8
        self.assertEqual(self.plan["entry_time"], "10:00 AM")  # upstream 10:15 AM ET -> 10:00 AM IST

    def test_same_stop_and_target_rules_on_the_nse_tick(self):
        # upstream: entry 364.18, or-mid stop 358.325 rounded down to the cent 358.32, 1R target 370.04;
        # NSE (0.05 tick): entry 364.20, stop down to 358.30, target 1R up to 370.10
        self.assertEqual((self.plan["entry"], self.plan["stop"], self.plan["target"]), (364.2, 358.3, 370.1))
        self.assertEqual(self.plan["flat_by"], "15:10")

    def test_monte_carlo_is_identical_to_the_upstream_logic(self):
        keys = ("bars_left", "p_target", "p_stop", "p_neither", "p_green", "median_close")
        a, b = self.tm["mc"], self.tm_us["mc"]
        self.assertEqual(a["replays"], 10000)
        for k in keys:
            self.assertIn(k, a, k)
            self.assertEqual(a[k], b[k], k)

    def test_history_is_the_same_trades_on_the_nse_clock(self):
        h_in = sorted(self.tm["history"]["trades"], key=lambda t: t["date"])
        h_us = sorted(self.tm_us["history"]["trades"], key=lambda t: t["date"])
        self.assertEqual(len(h_in), 33)
        self.assertEqual(len(h_us), 33)
        flips = []
        for a, b in zip(h_us, h_in):
            t_us = datetime.datetime.strptime(a["time"], "%I:%M %p")
            t_in = datetime.datetime.strptime(b["time"], "%I:%M %p")
            self.assertEqual(t_us - t_in, datetime.timedelta(minutes=15), (a, b))  # same bar
            if a["outcome"] != b["outcome"]:
                flips.append((a, b))
        # exactly one flip, and it is the tick: upstream's 322.98 target filled on a 323.00 high;
        # on NSE the target rounds up to 323.05, one tick out of reach
        self.assertEqual(len(flips), 1, flips)
        us_t, in_t = flips[0]
        self.assertEqual((us_t["target"], us_t["outcome"]), (322.98, "target"))
        self.assertEqual((in_t["target"], in_t["outcome"]), (323.05, "stop"))


if __name__ == "__main__":
    unittest.main()
