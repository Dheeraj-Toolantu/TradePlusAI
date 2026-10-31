"""trader-exit on the Indian market (NSE, IST, INR). Bars for the ATR stop reuse the
SYNTHETIC RELIANCE.NS session in fixtures/trader-entry-in/ (see test_entry_india.py)."""

import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from decimal import Decimal

from _load import load, FIX

exitp = load("trader-exit", "exit", market="IN")
entry = load("trader-entry", "entry", market="IN")

FILE = os.path.join(FIX, "trader-entry-in", "RELIANCE.NS-2026-10-30-5m-synthetic.json")
ENTRY = {"created_by": "trader-entry", "symbol": "RELIANCE", "setup": "orb", "side": "buy", "date": "2026-10-30",
         "status": "triggered", "time": "9:50 AM", "bar_start": "09:45", "bar_index": 6, "price": 1415.3,
         "level": 1412.0, "interval": "5m", "opening_range": {"high": 1412.0, "low": 1398.0, "minutes": 15},
         "source": "yahoo", "checked_at": "2026-10-30T04:20:00Z", "market": "IN", "currency": "INR"}


def run(mod, argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = mod.main(argv)
    return code, out.getvalue(), err.getvalue()


def c(entry_px, stop, target="2R", oh=1412.0, ol=1398.0, atr=None, n=None):
    sr, sp = exitp.parse_stop(stop)
    tr, tp = exitp.parse_target(target)
    return exitp.compute(entry_px, sr, sp, tr, tp, oh, ol, atr, n)


class Ticks(unittest.TestCase):
    def test_profile(self):
        self.assertEqual(exitp.MK.code, "IN")
        self.assertEqual(exitp.DEFAULTS["flat_by"], "15:10")
        self.assertEqual(exitp.money(1415.3), "₹1,415.30")
        self.assertEqual(exitp.money(123456), "₹1,23,456.00")
        self.assertEqual(exitp.parse_now("2026-10-30 09:50 IST"), exitp.datetime.datetime(2026, 10, 30, 4, 20))

    def test_or_mid_2r_on_the_tick(self):
        p = c(1415.300048828125, "or-mid")
        self.assertEqual((p["entry"], p["stop"], p["risk"], p["target"]),
                         (Decimal("1415.30"), Decimal("1405.00"), Decimal("10.30"), Decimal("1435.90")))

    def test_stop_rounds_down_and_target_rounds_up_to_the_tick(self):
        p = c(1415.3, "price:1405.07", "price:1435.91")              # tick 0.10 above Rs 1,000
        self.assertEqual((p["stop"], p["target"]), (Decimal("1405.00"), Decimal("1436.00")))
        self.assertIn("rounded down to the 0.1 tick", p["stop_detail"])
        p = c(612.30, "pct:1", "1.5R", None, None)                   # tick 0.05 from Rs 250
        # 612.30 x 0.99 = 606.177 -> 606.15; risk 6.15; 612.30 + 9.225 = 621.525 -> 621.55
        self.assertEqual((p["stop"], p["risk"], p["target"]), (Decimal("606.15"), Decimal("6.15"), Decimal("621.55")))
        p = c(98.37, "price:97.004", "1R", None, None)               # tick 0.01 under Rs 250
        self.assertEqual((p["stop"], p["target"]), (Decimal("97.00"), Decimal("99.74")))
        p = c(6000.2, "pct:1", "2R", None, None)                     # tick 0.50 from Rs 5,000
        self.assertEqual(p["stop"] % Decimal("0.5"), 0)
        self.assertEqual(p["target"] % Decimal("0.5"), 0)
        self.assertEqual(p["entry"], Decimal("6000.00"))

    def test_too_tight_is_counted_in_ticks(self):
        # Rs 1,415.30: 5 ticks of 0.10 = 0.50, 0.05% = 0.71: the larger one decides
        with self.assertRaises(exitp.PlanError) as cm:
            c(1415.3, "price:1414.7")
        msg = str(cm.exception)
        self.assertIn("too tight to survive the spread", msg)
        self.assertIn("6 tick(s) of 0.1", msg)
        self.assertIn("₹0.71", msg)
        self.assertEqual(c(1415.3, "price:1414.5")["risk"], Decimal("0.80"))
        # Rs 98.37 (tick 0.01): 0.05% is 0.05, 5 ticks is 0.05 too
        with self.assertRaises(exitp.PlanError):
            c(98.37, "price:98.33", "2R", None, None)
        self.assertEqual(c(98.37, "price:98.32", "2R", None, None)["risk"], Decimal("0.05"))
        self.assertEqual(exitp.MIN_TICKS, 5)

    def test_rupee_prices_in_flags(self):
        self.assertEqual(exitp.parse_stop("price:₹1,405")[1], Decimal("1405"))
        self.assertEqual(exitp.parse_target("price:Rs 1,436")[1], Decimal("1436"))


class Cli(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.cwd = os.getcwd()
        os.chdir(self.d)
        os.mkdir("trader")

    def tearDown(self):
        os.chdir(self.cwd)
        shutil.rmtree(self.d)

    def write(self, path, doc):
        with open(path, "w") as fh:
            json.dump(doc, fh)

    def plan(self, *args):
        return run(exitp, ["plan", "--market", "IN", "--now", "2026-10-30 09:51"] + list(args))

    def test_entry_to_plan_with_charges(self):
        code, _, err = run(entry, ["check", "RELIANCE", "--market", "IN", "--offline", FILE,
                                   "--now", "2026-10-30 09:50", "--write"])
        self.assertEqual(code, 0, err)
        code, text, err = self.plan("--write")
        self.assertEqual(code, 0, err)
        with open(os.path.join("trader", "plan.json")) as fh:
            p = json.load(fh)
        want = {"symbol": "RELIANCE", "date": "2026-10-30", "entry": 1415.3, "entry_time": "9:50 AM", "entry_bar": 6,
                "stop": 1405.0, "target": 1435.9, "target_r": 2.0, "risk_per_share": 10.3, "reward_risk": 2.0,
                "flat_by": "15:10", "market": "IN", "currency": "INR", "tick": 0.1, "stop_rule": "or_mid"}
        for k, v in want.items():
            self.assertEqual(p[k], v, k)
        ch = p["charges_ref"]
        self.assertEqual(ch["qty"], 70)                                # whole shares in Rs 1,00,000
        self.assertEqual(ch["at_target"], exitp.MK.charges(70, 1415.3, 1435.9)["total"])
        self.assertEqual(ch["at_stop"], exitp.MK.charges(70, 1415.3, 1405.0)["total"])
        self.assertLess(ch["reward_risk_net"], 2.0)
        self.assertIn("Stop          ₹1,405.00  opening-range midpoint", text)
        self.assertIn("Target        ₹1,435.90  2R", text)
        self.assertIn("Flat by       15:10 IST", text)
        self.assertIn("Charges       about ₹", text)
        self.assertIn("information only", text)
        self.assertIn("Nothing was placed", text)
        self.assertNotIn("pro" + "fit", text.lower())
        code, text, _ = run(exitp, ["show", "--market", "IN", "--now", "2026-10-30 10:00"])
        self.assertEqual(code, 0)
        self.assertIn("₹1,435.90", text)

    def test_ref_qty_and_atr(self):
        self.write(os.path.join("trader", "entry.json"), ENTRY)
        code, text, err = self.plan("--stop", "atr:1.5", "--offline", FILE, "--ref-qty", "10", "--json")
        self.assertEqual(code, 0, err)
        p = json.loads(text)
        self.assertEqual(p["atr_bars"], 7)
        self.assertAlmostEqual(p["stop"] * 10 % 1, 0)                   # on the 0.10 tick
        self.assertEqual(p["charges_ref"]["qty"], 10)
        self.assertEqual(p["charges_ref"]["basis"], "--ref-qty")

    def test_flat_by_defaults_config_and_square_off(self):
        self.write(os.path.join("trader", "entry.json"), ENTRY)
        code, text, _ = self.plan("--flat-by", "15:20", "--json")
        self.assertEqual(code, 0)
        self.assertIn("square off intraday (MIS)", json.loads(text)["warnings"][0])
        code, _, err = self.plan("--flat-by", "15:30")
        self.assertIn("after the 3:30 PM close", err)
        self.write(os.path.join("trader", "entry.json"), dict(ENTRY, time="3:15 PM"))
        code, _, err = self.plan()
        self.assertIn("no time left to hold it", err)
        self.write(os.path.join("trader", "config.json"), {"market": "IN", "flat_by": "15:00"})
        self.write(os.path.join("trader", "entry.json"), ENTRY)
        code, text, _ = run(exitp, ["plan", "--now", "2026-10-30 09:51", "--json"])
        self.assertEqual(json.loads(text)["flat_by"], "15:00")

    def test_market_mismatch_and_us_flag(self):
        self.write(os.path.join("trader", "entry.json"), ENTRY)
        code, _, err = run(exitp, ["plan", "--market", "US", "--now", "2026-10-30 09:51"])
        self.assertEqual(code, 1)
        self.assertIn("add --market IN", err)
        code, text, _ = run(exitp, ["plan", "--market", "US", "--symbol", "TSLA", "--entry", "364.18",
                                    "--or-high", "362.18", "--or-low", "354.47", "--date", "2026-10-19",
                                    "--target", "1R", "--now", "2026-10-19 10:16"])
        self.assertEqual(code, 0)
        self.assertIn("Stop          $358.32", text)
        self.assertIn("Flat by       15:55 ET", text)
        self.assertNotIn("Charges", text)
        self.plan("--symbol", "TCS", "--entry", "3100", "--stop", "pct:1")
        self.assertEqual(exitp.MK.code, "IN")


if __name__ == "__main__":
    unittest.main()
