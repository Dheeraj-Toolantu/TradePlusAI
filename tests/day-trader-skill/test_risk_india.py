"""trader-risk in India mode: rupees, charges in the loss and in net reward:risk, IST window, NSE
holidays, MIS/CNC, no leverage, no PDT rule, Groww block checks, and exits never blocked."""

import copy
import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr

from _load import load, ROOT, FIX

check = load("trader-risk", "check", market="IN")

CFG_PATH = os.path.join(ROOT, "trader-budget", "config.example.json")
ORDERS_PATH = os.path.join(FIX, "trader-risk-in", "orders-reliance-synthetic.json")
STATE_PATH = os.path.join(FIX, "trader-broker-in", "broker-state-synthetic.json")
TODAY = "2026-11-02"


def at(text):
    return check.parse_now(text)


def cfg(**over):
    with open(CFG_PATH) as fh:
        c = json.load(fh)
    c.update(over)
    return c


def rel(**over):
    with open(ORDERS_PATH) as fh:
        o = json.load(fh)["orders"][0]
    o.update(over)
    return o


def state():
    with open(STATE_PATH) as fh:
        return json.load(fh)


def one(orders, c=None, now="2026-11-02 09:46", **kw):
    return check.check(orders if isinstance(orders, list) else [orders], c or cfg(), now=at(now), **kw)


def reasons(res, i=0):
    return res["results"][i]["reasons"]


class Clock(unittest.TestCase):
    def test_ist(self):
        self.assertEqual(at("2026-11-02 09:15").strftime("%Y-%m-%d %H:%M"), "2026-11-02 03:45")
        self.assertEqual(check.to_eastern(at("2026-11-02 09:15")).strftime("%H:%M"), "09:15")
        self.assertEqual((check.OPEN.strftime("%H:%M"), check.CLOSE.strftime("%H:%M")), ("09:15", "15:30"))

    def test_nse_holidays(self):
        self.assertEqual(check.trading_day(check.datetime.date(2026, 11, 10)),
                         (False, "NSE holiday: Diwali Balipratipada"))
        self.assertTrue(check.trading_day(check.datetime.date(2026, 11, 9))[0])

    def test_money_in_rupees(self):
        self.assertEqual(check.money(150000), "₹1,50,000")
        self.assertEqual(check.money(498.6), "₹498.60")


class Reliance(unittest.TestCase):
    def test_the_synthetic_order_passes(self):
        res = one(rel())
        r = res["results"][0]
        self.assertEqual(r["verdict"], "PASS", r["reasons"])
        self.assertEqual((r["max_loss"], r["reward_risk"]), (498.6, 1.59))
        text = "\n".join(r["info"])
        self.assertIn("incl. ₹68.60 charges", text)
        self.assertIn("1.59 net", text)
        self.assertEqual((res["market"], res["currency"], res["tz"]), ("IN", "INR", "IST"))
        self.assertNotIn("$", check.report(res))
        self.assertIn("IST", check.report(res))

    def test_charges_push_one_more_share_over_the_max_loss(self):
        o = rel(qty="44")
        o["groww"] = copy.deepcopy(o["groww"])
        o["groww"]["entry"]["quantity"] = 44
        o["groww"]["stop_loss"]["quantity"] = 44
        res = one(o)
        self.assertEqual(len(reasons(res)), 1, reasons(res))
        self.assertIn("charges", reasons(res)[0])
        self.assertTrue(reasons(res)[0].startswith("loss: 44 shares x 10.00 risk a share = ₹440 + "))
        self.assertIn("over your ₹500 max loss", reasons(res)[0])
        # without charges the same 44 shares fit (440 <= 500)
        self.assertEqual(one(o, cfg(include_charges=False))["results"][0]["verdict"], "PASS")

    def test_net_reward_risk(self):
        o = rel(take_profit_limit_price="1428.40")
        o["groww"] = dict(o["groww"], target=dict(o["groww"]["target"], price=1428.4))
        res = one(o)
        self.assertTrue(any(x.startswith("reward:risk:") and "net of charges" in x and "1.60 gross" in x
                            for x in reasons(res)), reasons(res))
        self.assertEqual(one(o, cfg(include_charges=False))["results"][0]["verdict"], "PASS")

    def test_daily_loss_and_trades_in_rupees(self):
        res = one(rel(), state=state())
        r = res["results"][0]
        self.assertEqual(r["verdict"], "PASS", r["reasons"])     # 997.20 + 498.60 = 1,495.80 <= 1,500
        self.assertIn("2 of 3 trades, ₹997.20 of ₹1,500 daily loss", "\n".join(r["info"]))
        res = one(rel(), cfg(max_daily_loss_inr=1400), state=state())
        self.assertTrue(any("daily loss: ₹997.20 already at risk today" in x for x in reasons(res)))
        res = one(rel(), cfg(max_trades_per_day=2), state=state())
        self.assertTrue(any(x.startswith("trades: 2 entries") for x in reasons(res)))


class Window(unittest.TestCase):
    def blocked(self, now):
        return [x for x in reasons(one(rel(), now=now)) if x.startswith("window")]

    def test_entry_window_in_ist(self):
        self.assertEqual(self.blocked("2026-11-02 09:46"), [])
        self.assertIn("no new entries before 09:30 IST", self.blocked("2026-11-02 09:20")[0])
        self.assertIn("no new entries after 14:45 IST", self.blocked("2026-11-02 14:50")[0])
        self.assertIn("the market is closed (", self.blocked("2026-11-02 09:05")[0])
        self.assertIn("09:15 to 15:30", self.blocked("2026-11-02 15:31")[0])

    def test_holiday_and_weekend(self):
        self.assertIn("NSE holiday: Diwali Balipratipada", self.blocked("2026-11-10 10:00")[0])
        self.assertIn("weekend", self.blocked("2026-11-07 10:00")[0])

    def test_2027_warns_to_check_nse(self):
        res = one(rel(), now="2027-01-04 10:00")
        self.assertTrue(any("nseindia.com" in w for w in res["warnings"]), res["warnings"])


class IndiaRules(unittest.TestCase):
    def test_pdt_guard_is_skipped_with_a_note(self):
        res = one(rel(), cfg(pdt_guard=True), state=state())
        self.assertEqual(res["results"][0]["verdict"], "PASS")
        self.assertTrue(any("no Indian pattern-day-trader rule" in w for w in res["warnings"]))
        self.assertIsNone(res["today"]["day_trades_5d"])

    def test_product_mis_for_a_day_trade(self):
        res = one(rel(product="CNC"))
        self.assertTrue(any(x.startswith("product: CNC") and "use MIS" in x for x in reasons(res)), reasons(res))
        res = one(rel(product="NRML"))
        self.assertTrue(any(x.startswith("product: NRML is not allowed") for x in reasons(res)))

    def test_cnc_when_flat_by_is_off(self):
        o = rel(product="CNC")
        self.assertFalse([x for x in reasons(one(o, cfg(flat_by=None))) if x.startswith("product")])
        self.assertTrue([x for x in reasons(one(rel(), cfg(flat_by=None))) if x.startswith("product")])

    def test_no_mis_leverage(self):
        res = one(rel(), cfg(budget=50000))
        lev = [x for x in reasons(res) if x.startswith("leverage")]
        self.assertEqual(len(lev), 1, reasons(res))
        self.assertIn("MIS leverage is off", lev[0])
        self.assertFalse([x for x in reasons(res) if x.startswith("cash: needs")])
        res = one(rel(), cfg(budget=50000, allow_margin=True))
        self.assertFalse([x for x in reasons(res) if x.startswith("leverage")])
        self.assertTrue(any(w.startswith("leverage") for w in res["results"][0]["warnings"]))

    def test_whole_shares_no_notional(self):
        o = {"symbol": "TCS", "side": "buy", "notional": "5000", "type": "market", "time_in_force": "day"}
        self.assertTrue(any("NSE takes whole shares only" in x for x in reasons(one(o, cfg(require_stop=False)))))

    def test_nse_symbols_and_fno(self):
        ok = {"symbol": "M&M", "side": "buy", "qty": "1", "type": "limit", "limit_price": "3010.00",
              "time_in_force": "day", "product": "MIS"}
        c = cfg(require_stop=False, min_reward_risk=0)
        self.assertFalse([x for x in reasons(one(ok, c)) if x.startswith("asset")])
        for sym in ("BAJAJ-AUTO", "RELIANCE.NS", "3MINDIA"):
            self.assertFalse([x for x in reasons(one(dict(ok, symbol=sym), c)) if x.startswith("asset")], sym)
        for sym in ("NIFTY26NOV24000CE", "RELIANCE26NOVFUT", "BANKNIFTY26NOV52000PE"):
            r = reasons(one(dict(ok, symbol=sym), c))
            self.assertTrue(any("F&O contract" in x for x in r), (sym, r))
        self.assertTrue(any("NSE equity symbol" in x for x in reasons(one(dict(ok, symbol="BTC/INR"), c))))

    def test_groww_block_must_match_the_order(self):
        o = rel()
        o["groww"] = copy.deepcopy(o["groww"])
        o["groww"]["entry"]["quantity"] = 99
        o["groww"]["stop_loss"]["trigger_price"] = 1390.0
        o["groww"]["target"]["resting_order"] = True
        r = reasons(one(o))
        self.assertTrue(any("groww quantity 99" in x for x in r))
        self.assertTrue(any("stop_loss trigger 1390.0" in x for x in r))
        self.assertTrue(any("must not be a resting sell" in x for x in r))
        o = rel()
        o["groww"] = copy.deepcopy(o["groww"])
        o["groww"]["entry"]["order_reference_id"] = "a-b-c-d"
        self.assertTrue(any("order_reference_id" in x for x in reasons(one(o))))

    def test_the_groww_block_is_in_the_fingerprint(self):
        o = rel()
        p = copy.deepcopy(o)
        p["groww"]["entry"]["product"] = "CNC"
        self.assertNotEqual(check.fingerprint(o), check.fingerprint(p))


class GettingOut(unittest.TestCase):
    def test_the_flatten_sell_is_never_blocked_by_day_limits(self):
        pf = {"cash": 39266.8, "positions": [{"ticker": "RELIANCE", "shares": 43, "lots": [
            {"id": "RELIANCE-1", "date": TODAY, "shares": 43, "cost": 60733.2}]}]}
        sell = {"symbol": "RELIANCE", "side": "sell", "qty": "43", "type": "market", "time_in_force": "day",
                "product": "CNC"}
        res = one(sell, cfg(max_trades_per_day=1), now="2026-11-02 15:10", portfolio=pf, state=state(),
                  prices={"RELIANCE": 1420.0})
        r = res["results"][0]
        self.assertEqual((r["verdict"], r["kind"]), ("PASS", "exit"), r["reasons"])
        self.assertTrue(any(w.startswith("exit, not blocked: product") for w in r["warnings"]))
        self.assertEqual(r["reasons"], [])   # after 14:45 and over the trade count: an exit still passes


class Cli(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.d)

    def test_cli_in_ist_and_records_the_verdict(self):
        out = os.path.join(self.d, "risk.json")
        none = os.path.join(self.d, "none")
        buf, err = io.StringIO(), io.StringIO()
        with redirect_stdout(buf), redirect_stderr(err):
            code = check.main(["--orders", ORDERS_PATH, "--config", CFG_PATH, "--portfolio", none, "--prices", none,
                               "--state", none, "--now", "2026-11-02 09:46", "--out", out, "--market", "IN"])
        self.assertEqual(code, 0, err.getvalue() + buf.getvalue())
        self.assertIn("1 passed, 0 blocked at 2026-11-02 09:46 IST", buf.getvalue())
        with open(out) as fh:
            rec = json.load(fh)
        self.assertEqual(rec["date"], TODAY)
        self.assertEqual(rec["market"], "IN")

    def test_prices_with_ns_keys(self):
        pp = os.path.join(self.d, "prices.json")
        with open(pp, "w") as fh:
            json.dump({"as_of": "2026-11-02T04:15:00Z", "prices": {"RELIANCE.NS": 1415.0},
                       "detail": {"RELIANCE.NS": {"time": "2026-11-02T04:15:00Z"}}}, fh)
        with open(pp) as fh:
            prices, times = check.load_prices(json.load(fh))
        self.assertEqual(prices, {"RELIANCE": 1415.0})
        self.assertIsNotNone(times["RELIANCE"])


if __name__ == "__main__":
    unittest.main()
