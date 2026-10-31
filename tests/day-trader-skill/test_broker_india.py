"""trader-broker in India mode: Groww tickets, paper fills simulated in the local ledger, the live
ticket that the user places (never Claude), the yes recorded word for word, and flatten."""

import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr

from _load import load, ROOT, FIX

ticket = load("trader-broker", "ticket", market="IN")
check = load("trader-risk", "check", market="IN")

CFG_PATH = os.path.join(ROOT, "trader-budget", "config.example.json")
ORDERS_PATH = os.path.join(FIX, "trader-risk-in", "orders-reliance-synthetic.json")
PLAN_PATH = os.path.join(FIX, "trader-budget-in", "plan-reliance-synthetic.json")
NOW = "2026-11-02 09:46"
TODAY = "2026-11-02"


def rel(**over):
    with open(ORDERS_PATH) as fh:
        o = json.load(fh)["orders"][0]
    o.update(over)
    return o


def run(argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = ticket.main(argv)
    return code, out.getvalue(), err.getvalue()


class Basics(unittest.TestCase):
    def test_ist_timestamps(self):
        self.assertEqual(ticket.ny_iso(ticket.parse_now(NOW)), "2026-11-02T09:46:00+05:30")

    def test_rupees_and_symbols(self):
        self.assertEqual(ticket._money(60733.2), "₹60,733.20")
        self.assertEqual(ticket._money(1500), "₹1,500")
        self.assertEqual(ticket._sym("reliance.ns"), "RELIANCE")

    def test_fingerprint_matches_risk(self):
        self.assertEqual(ticket.fingerprint(rel()), check.fingerprint(rel()))

    def test_plain_words_show_the_legs(self):
        text = ticket.plain(rel())
        self.assertIn("BUY 43 RELIANCE, limit 1412.40, good for today, NSE MIS", text)
        self.assertIn("SL-M sell 43 at trigger 1402.40", text)
        self.assertIn("target 1432.40 is watched by trader-alerts, not a resting order", text)
        self.assertIn("max loss about ₹498.60 incl. ₹68.60 charges", text)

    def test_yes_for_nse_symbols(self):
        o = rel()
        batch = ["RELIANCE", "TCS", "M&M"]
        for r in ("yes", "yes 43 RELIANCE", "yes RELIANCE.NS", "yes 1402.40", "yes max loss 498.60"):
            self.assertTrue(ticket.parse_yes(r, o, batch)[0], r)
        for r in ("yes TCS", "yes M&M", "yes 50", "sure", "yes to all", "yes?"):
            self.assertFalse(ticket.parse_yes(r, o, batch)[0], r)


class Flow(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.orders = os.path.join(self.d, "orders.json")
        shutil.copy(ORDERS_PATH, self.orders)
        self.cfg = os.path.join(self.d, "config.json")
        shutil.copy(CFG_PATH, self.cfg)
        self.risk = os.path.join(self.d, "state", "risk.json")
        self.state = os.path.join(self.d, "state", "broker.json")
        self.pf = os.path.join(self.d, "portfolio.json")
        self.none = os.path.join(self.d, "none")

    def tearDown(self):
        shutil.rmtree(self.d)

    def common(self, now=NOW):
        return ["--orders", self.orders, "--config", self.cfg, "--risk", self.risk, "--state", self.state,
                "--now", now]

    def risk_check(self, now=NOW, portfolio=None):
        buf = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(io.StringIO()):
            return check.main(["--orders", self.orders, "--config", self.cfg, "--portfolio", portfolio or self.none,
                               "--prices", self.none, "--state", self.state, "--now", now, "--out", self.risk])

    def live(self):
        with open(self.cfg) as fh:
            c = json.load(fh)
        c["paper"] = False
        with open(self.cfg, "w") as fh:
            json.dump(c, fh)

    def test_paper_ticket_and_simulated_fill(self):
        code, out, _ = run(["show"] + self.common())
        self.assertEqual(code, 1)
        self.assertIn("NOT READY", out)
        self.assertEqual(self.risk_check(), 0)
        code, out, _ = run(["show"] + self.common())
        self.assertEqual(code, 0)
        self.assertIn("PAPER (simulated fills in your local ledger; Groww has no paper account), Groww", out)
        self.assertIn('"order_type": "LIMIT"', out)
        self.assertIn('"order_type": "SL_M"', out)
        self.assertIn("only after step 1 fills", out)
        self.assertIn("NOT placed as a second sell", out)
        self.assertNotIn("place_stock_order", out)
        self.assertNotIn("$", out)

        code, out, _ = run(["simulate", "--index", "1", "--portfolio", self.pf] + self.common())
        self.assertEqual(code, 1)       # no yes yet
        code, out, _ = run(["approve", "--index", "1", "--reply", "sure"] + self.common())
        self.assertEqual(code, 1)
        self.assertIn("Not recorded", out)
        code, out, _ = run(["approve", "--index", "1", "--reply", "Yes, 43 RELIANCE"] + self.common())
        self.assertEqual(code, 0, out)
        self.assertIn("ticket.py simulate --index 1", out)
        code, out, err = run(["simulate", "--index", "1", "--portfolio", self.pf] + self.common("2026-11-02 09:47"))
        self.assertEqual(code, 0, err)
        self.assertIn("Simulated (paper): BUY 43 RELIANCE filled at 1412.40", out)
        self.assertIn("Nothing was sent to a broker", out)
        with open(self.pf) as fh:
            pf = json.load(fh)
        self.assertEqual(pf["cash"], 100000 - 60733.2)
        self.assertEqual(pf["positions"][0]["ticker"], "RELIANCE")
        with open(self.state) as fh:
            recs = json.load(fh)["orders"]
        self.assertEqual([r["status"] for r in recs], ["approved", "placed", "filled"])
        self.assertEqual(recs[0]["reply"], "Yes, 43 RELIANCE")        # word for word
        self.assertTrue(recs[1]["simulated"])
        self.assertEqual(recs[1]["broker"], "groww-paper")
        self.assertEqual(recs[1]["max_loss"], 498.6)
        self.assertTrue(recs[1]["broker_order_id"].startswith("PAPER-TPE-"))
        self.assertTrue(recs[0]["at"].endswith("+05:30"))
        # the next trade sees this one in the daily loss
        self.assertEqual(self.risk_check("2026-11-02 09:50", self.pf), 1)   # duplicate buy RELIANCE today
        code, out, _ = run(["log", "--state", self.state, "--config", self.cfg, "--now", "2026-11-02 10:00"])
        self.assertIn("max loss ₹498.60", out)
        self.assertIn("1 placed today", out)

    def test_live_ticket_is_placed_by_the_user_not_claude(self):
        self.live()
        self.assertEqual(self.risk_check(), 0)
        code, out, _ = run(["show"] + self.common())
        self.assertEqual(code, 0)
        self.assertIn("LIVE, REAL MONEY, you place it", out)
        self.assertIn("Claude does not place it", out)
        self.assertIn("GROWW_API_KEY / GROWW_API_SECRET", out)
        self.assertIn("services/execution", out)
        self.assertIn("LIVE_TRADING_PIN", out)
        code, out, _ = run(["show", "--index", "1", "--json"] + self.common())
        t = json.loads(out)
        self.assertIn("never by Claude", t["tool"])
        self.assertEqual(t["tool_input"], rel()["groww"]["entry"])
        code, out, _ = run(["approve", "--index", "1", "--reply", "yes"] + self.common())
        self.assertEqual(code, 0)
        self.assertIn('"order_reference_id": "TPE-261102-', out)
        self.assertIn("Step 2, only after step 1 fills", out)
        code, out, _ = run(["simulate", "--index", "1", "--portfolio", self.pf] + self.common())
        self.assertEqual(code, 1)        # no simulated fills on a live config
        code, out, _ = run(["result", "--index", "1", "--status", "placed", "--broker-id", "GMK39038RDT490CCVRO",
                            "--portfolio", self.pf] + self.common())
        self.assertEqual(code, 0)
        self.assertIn('"order_type": "SL_M"', out)
        self.assertIn("trader-alerts", out)

    def test_flatten_writes_a_groww_market_sell(self):
        with open(self.pf, "w") as fh:
            json.dump({"cash": 39266.8, "positions": [{"ticker": "RELIANCE", "shares": 43, "lots": [
                {"id": "RELIANCE-1", "date": TODAY, "shares": 43, "cost": 60733.2}]}]}, fh)
        code, out, err = run(["flatten", "--symbol", "reliance.ns", "--orders", self.orders, "--portfolio", self.pf,
                              "--plan", PLAN_PATH, "--config", self.cfg, "--now", "2026-11-02 15:10"])
        self.assertEqual(code, 0, err)
        self.assertIn("flat by 15:10 IST", out)
        self.assertIn("Cancel (or modify) the open SL-M sell on Groww FIRST", out)
        with open(self.orders) as fh:
            o = json.load(fh)["orders"][0]
        self.assertEqual((o["symbol"], o["side"], o["qty"], o["product"]), ("RELIANCE", "sell", "43", "MIS"))
        g = o["groww"]["entry"]
        self.assertEqual((g["order_type"], g["transaction_type"], g["quantity"]), ("MARKET", "SELL", 43))
        self.assertLessEqual(len(g["order_reference_id"]), 20)
        # after the 14:45 cutoff, the exit still passes the risk check
        self.assertEqual(self.risk_check("2026-11-02 15:10", self.pf), 0)

    def test_market_us_keeps_the_alpaca_ticket(self):
        us_cfg = os.path.join(ROOT, "trader-budget", "config.us.example.json")
        tsla = os.path.join(FIX, "trader-risk", "orders-tsla.json")
        code, out, _ = run(["show", "--orders", tsla, "--config", us_cfg, "--risk", self.none, "--state", self.state,
                            "--now", "2026-10-19 10:15", "--market", "US"])
        self.assertIn("PAPER account, Alpaca", out)
        self.assertIn("place_stock_order", out)
        ticket.apply_market(ticket.market.get("IN"))


class Docs(unittest.TestCase):
    def test_skill_md_is_india_first(self):
        for name in ("trader-budget", "trader-risk", "trader-broker"):
            with open(os.path.join(ROOT, name, "SKILL.md"), encoding="utf-8") as fh:
                text = fh.read()
            self.assertTrue(text.startswith("---\nname: %s\n" % name))
            self.assertGreater(len(text.splitlines()), 60)
            low = " ".join(text.lower().split())
            for must in ("not financial advice", "--market us", "groww", "ist", "₹"):
                self.assertIn(must, low, (name, must))
            self.assertNotIn("—", text)
        with open(os.path.join(ROOT, "trader-broker", "SKILL.md"), encoding="utf-8") as fh:
            low = " ".join(fh.read().lower().split())
        for must in ("groww_api_key", "groww_api_secret", "never in the chat", "auto square-off", "t+1", "stt",
                     "claude never places a live groww order", "sl-m"):
            self.assertIn(must, low, must)


if __name__ == "__main__":
    unittest.main()
