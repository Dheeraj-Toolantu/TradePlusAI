"""trader-budget in India mode: NSE, IST, rupees, charges-aware sizing and the Groww legs."""

import io
import json
import os
import re
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr

from _load import load, ROOT, FIX

size = load("trader-budget", "size", market="IN")

CFG_PATH = os.path.join(ROOT, "trader-budget", "config.example.json")
US_CFG_PATH = os.path.join(ROOT, "trader-budget", "config.us.example.json")
TARGETS_IN = os.path.join(ROOT, "trader-budget", "targets.in.example.json")
PLAN_PATH = os.path.join(FIX, "trader-budget-in", "plan-reliance-synthetic.json")
ORDERS_FIX = os.path.join(FIX, "trader-risk-in", "orders-reliance-synthetic.json")
NOW = "2026-11-02 09:46"
TODAY = "2026-11-02"
REF_ID = re.compile(r"^[A-Za-z0-9-]{8,20}$")


def cfg(**over):
    with open(CFG_PATH) as fh:
        c = json.load(fh)
    c.update(over)
    return c


def plan(**over):
    with open(PLAN_PATH) as fh:
        p = json.load(fh)
    p.update(over)
    return p


def run(argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = size.main(argv)
    return code, out.getvalue(), err.getvalue()


class Config(unittest.TestCase):
    def test_india_example_config(self):
        with open(CFG_PATH) as fh:
            c = json.load(fh)
        self.assertEqual((c["market"], c["broker"], c["product"]), ("IN", "groww", "MIS"))
        self.assertIs(c["paper"], True)
        self.assertEqual((c["budget"], c["max_loss_per_trade_inr"], c["max_daily_loss_inr"], c["max_order_inr"],
                          c["min_order_inr"]), (100000, 500, 1500, 80000, 100))
        self.assertEqual((c["max_trades_per_day"], c["min_reward_risk"]), (3, 1.5))
        self.assertEqual((c["no_entries_before"], c["no_entries_after"], c["flat_by"]), ("09:30", "14:45", "15:10"))
        self.assertIs(c["include_charges"], True)
        self.assertEqual(c["charges"], {})
        for k in ("allow_short", "allow_margin", "allow_options"):
            self.assertIs(c[k], False, k)
        self.assertIs(c["require_stop"], True)
        self.assertNotIn("sec_user_agent", c)
        self.assertFalse([k for k in c if k.endswith("_usd")])

    def test_inr_keys_reach_the_internal_usd_names(self):
        c = size.load_config(CFG_PATH)
        self.assertEqual((c["max_loss_per_trade_usd"], c["max_order_usd"], c["min_order_usd"]), (500, 80000, 100))

    def test_us_example_is_the_upstream_contract(self):
        with open(US_CFG_PATH) as fh:
            c = json.load(fh)
        self.assertEqual((c["broker"], c["max_loss_per_trade_usd"], c["flat_by"]), ("alpaca", 50, "15:55"))

    def test_india_defaults(self):
        self.assertEqual(size.MK.code, "IN")
        self.assertEqual(size.DEFAULTS["flat_by"], "15:10")
        self.assertEqual(size.DEFAULTS["no_entries_before"], "09:30")
        self.assertEqual(size.DEFAULTS["broker"], "groww")


class ClockMoneyTicks(unittest.TestCase):
    def test_ist_clock(self):
        utc = size.parse_now(NOW)
        self.assertEqual(utc.strftime("%H:%M"), "04:16")
        self.assertEqual(size.to_eastern(utc).strftime("%H:%M"), "09:46")
        self.assertEqual(size.eastern_offset(utc), 5.5)

    def test_rupees(self):
        self.assertEqual(size.money(100000), "₹1,00,000")
        self.assertEqual(size.money(60733.2), "₹60,733.20")

    def test_nse_ticks(self):
        self.assertEqual(size.round_price(1412.43), 1412.4)
        self.assertEqual(size.round_price(612.33, "down"), 612.3)
        s = size.size_trade(plan(stop=1402.44, target=1432.47), cfg(), today=TODAY)
        self.assertEqual((s["stop"], s["target"]), (1402.4, 1432.4))   # both rounded down to the 0.10 tick

    def test_symbols_with_or_without_ns(self):
        s = size.size_trade(plan(symbol="reliance.ns"), cfg(), today=TODAY)
        self.assertEqual(s["symbol"], "RELIANCE")
        self.assertEqual(size.bracket_order(s)["groww"]["entry"]["trading_symbol"], "RELIANCE")


class Sizing(unittest.TestCase):
    def test_charges_decide_the_size(self):
        s = size.size_trade(plan(), cfg(), today=TODAY)
        # 50 shares would lose exactly 500 before charges; with charges only 43 fit
        self.assertEqual(s["qty"], 43)
        self.assertEqual(s["bound_by"], "max loss")
        self.assertEqual((s["loss_gross"], s["charges_at_stop"], s["max_loss"]), (430.0, 68.6, 498.6))
        self.assertLessEqual(s["max_loss"], 500)
        more = size.charges(44, 1412.4, 1402.4, cfg())["total"] + 440
        self.assertGreater(more, 500)
        self.assertEqual([(l["name"], l["shares"]) for l in s["limits"]],
                         [("max loss", 43), ("position cap", 56), ("max order", 56), ("cash", 63)])
        self.assertEqual(s["reward_risk"], 2.0)
        self.assertEqual(s["reward_risk_net"], 1.59)
        self.assertIsNone(s["refusal"])

    def test_without_charges_it_is_the_plain_division(self):
        s = size.size_trade(plan(), cfg(include_charges=False), today=TODAY)
        self.assertEqual(s["qty"], 50)
        self.assertEqual(s["max_loss"], 500.0)
        self.assertIsNone(s["reward_risk_net"])

    def test_charge_overrides(self):
        s = size.size_trade(plan(), cfg(charges={"brokerage_max": 0, "brokerage_min": 0, "brokerage_pct": 0}),
                            today=TODAY)
        self.assertGreater(s["qty"], 43)

    def test_cash_cap_has_no_mis_leverage(self):
        s = size.size_trade(plan(stop=1411.40, target=1414.40), cfg(min_reward_risk=0, budget=20000, max_position_pct=100,
                                                                     max_order_inr=None, max_order_usd=None),
                            today=TODAY)
        # 18,000 of cash after the buffer: 12 shares, never the 5x an MIS margin would allow
        self.assertEqual(s["bound_by"], "cash")
        self.assertEqual(s["qty"], 12)
        self.assertIn("no MIS leverage", [l for l in s["limits"] if l["name"] == "cash"][0]["how"])

    def test_net_reward_risk_refusal(self):
        # 1.6R gross is fine without charges, but the charges take it under 1.5
        s = size.size_trade(plan(target=1428.40), cfg(), today=TODAY)
        self.assertEqual(s["reward_risk"], 1.6)
        self.assertIsNotNone(s["refusal"])
        self.assertIn("net reward:risk", s["refusal"])
        self.assertIsNone(size.bracket_order(s))

    def test_a_stop_too_far_away_even_for_one_share(self):
        s = size.size_trade(plan(stop=900.0, target=2500.0), cfg(), today=TODAY)
        self.assertEqual(s["qty"], 0)
        self.assertIn("No order", s["refusal"])

    def test_one_share_that_only_charges_push_over(self):
        s = size.size_trade(plan(stop=1412.40 - 495.0, target=2900.0), cfg(), today=TODAY)
        self.assertEqual(s["qty"], 0)
        self.assertIn("charges", s["refusal"])

    def test_a_plan_for_another_day_is_refused_in_ist(self):
        with self.assertRaises(size.SizeError) as e:
            size.size_trade(plan(), cfg(), today="2026-11-03")
        self.assertIn("IST", str(e.exception))


class GrowwLegs(unittest.TestCase):
    def order(self, **cfg_over):
        return size.bracket_order(size.size_trade(plan(), cfg(**cfg_over), today=TODAY))

    def test_upstream_fields_stay(self):
        o = self.order()
        for k, v in (("symbol", "RELIANCE"), ("side", "buy"), ("qty", "43"), ("type", "limit"),
                     ("limit_price", "1412.40"), ("time_in_force", "day"), ("order_class", "bracket"),
                     ("stop_loss_stop_price", "1402.40"), ("take_profit_limit_price", "1432.40"),
                     ("product", "MIS"), ("market", "IN"), ("currency", "INR")):
            self.assertEqual(o[k], v, k)
        self.assertEqual(o["plan"]["max_loss"], 498.6)
        self.assertEqual(o["plan"]["charges_at_stop"], 68.6)

    def test_entry_is_a_limit_buy(self):
        e = self.order()["groww"]["entry"]
        self.assertEqual(e, {"trading_symbol": "RELIANCE", "quantity": 43, "price": 1412.4, "validity": "DAY",
                             "exchange": "NSE", "segment": "CASH", "product": "MIS", "order_type": "LIMIT",
                             "transaction_type": "BUY", "order_reference_id": e["order_reference_id"]})
        self.assertRegex(e["order_reference_id"], REF_ID)
        self.assertLessEqual(e["order_reference_id"].count("-"), 2)

    def test_stop_is_an_sl_m_sell_after_the_fill_and_the_target_is_not_resting(self):
        g = self.order()["groww"]
        sl = g["stop_loss"]
        self.assertEqual((sl["order_type"], sl["transaction_type"], sl["trigger_price"], sl["quantity"]),
                         ("SL_M", "SELL", 1402.4, 43))
        self.assertNotIn("price", sl)
        self.assertIn("after the entry fills", g["stop_loss_when"])
        self.assertIs(g["target"]["resting_order"], False)
        self.assertIn("trader-alerts", g["target"]["how"])
        self.assertNotEqual(sl["order_reference_id"], g["entry"]["order_reference_id"])

    def test_the_reference_id_is_stable(self):
        self.assertEqual(self.order()["groww"], self.order()["groww"])

    def test_market_order_flag(self):
        s = size.size_trade(plan(), cfg(), today=TODAY, market_order=True)
        o = size.bracket_order(s)
        self.assertEqual(o["type"], "market")
        self.assertNotIn("limit_price", o)
        self.assertEqual(o["groww"]["entry"]["order_type"], "MARKET")
        self.assertNotIn("price", o["groww"]["entry"])


class Cli(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.d)

    def test_report_names_the_deciding_limit_and_the_charges(self):
        out_path = os.path.join(self.d, "orders.json")
        code, out, err = run(["--plan", PLAN_PATH, "--config", CFG_PATH, "--now", NOW, "--portfolio",
                              os.path.join(self.d, "none"), "--market", "IN", "--write", out_path])
        self.assertEqual(code, 0, err)
        self.assertIn("Decided by: max loss", out)
        self.assertIn("₹68.60 charges", out)
        self.assertIn("1.59 net of charges", out)
        self.assertIn("SL-M trigger 1402.40", out)
        self.assertIn("NOT a resting order", out)
        self.assertIn("Flat by 15:10 IST", out)
        self.assertNotIn("$", out)
        self.assertNotIn("New York", out)
        with open(out_path) as fh:
            doc = json.load(fh)
        with open(ORDERS_FIX) as fh:
            fix = json.load(fh)
        self.assertEqual(doc["orders"], fix["orders"])
        self.assertEqual((doc["market"], doc["currency"], doc["broker"]), ("IN", "INR", "groww"))
        self.assertIn("Claude never places a live Groww order", doc["note"])

    def test_fresh_ns_price_above_the_entry(self):
        pp = os.path.join(self.d, "prices.json")
        with open(pp, "w") as fh:
            json.dump({"as_of": "2026-11-02T04:15:30Z", "prices": {"RELIANCE.NS": 1414.43},
                       "detail": {"RELIANCE.NS": {"time": "2026-11-02T04:15:30Z"}}}, fh)
        cp = os.path.join(self.d, "config.json")
        with open(cp, "w") as fh:
            json.dump(cfg(min_reward_risk=1.0), fh)
        code, out, err = run(["--plan", PLAN_PATH, "--config", cp, "--now", NOW, "--prices", pp,
                              "--portfolio", os.path.join(self.d, "none"), "--json"])
        self.assertEqual(code, 0, err)
        res = json.loads(out)
        self.assertEqual(res["sizing"]["entry"], 1414.4)       # on the 0.10 tick
        self.assertEqual(res["sizing"]["entry_from"], "price")
        self.assertIn("IST", res["notes"][0])

    def test_market_flag_us_gives_the_upstream_report(self):
        us_plan = os.path.join(FIX, "trader-budget", "plan-tsla.json")
        code, out, err = run(["--plan", us_plan, "--config", US_CFG_PATH, "--now", "2026-10-19 10:15",
                              "--portfolio", os.path.join(self.d, "none"), "--market", "US"])
        self.assertEqual(code, 0, err)
        self.assertIn("Max loss at the stop: 8 x 5.86 = $46.88", out)
        self.assertIn("New York", out)
        run(["--market", "IN", "--plan", os.path.join(self.d, "none")])   # back to India for the other tests

    def test_unknown_market_is_one_line(self):
        code, out, err = run(["--market", "XX", "--plan", PLAN_PATH, "--config", CFG_PATH])
        self.assertEqual(code, 1)
        self.assertIn("unknown market", err)
        size.apply_market(size.market.get("IN"))


class Weights(unittest.TestCase):
    def test_india_split_is_whole_shares_cnc(self):
        with open(TARGETS_IN) as fh:
            rows = size.parse_weights(json.load(fh))
        prices = {"RELIANCE": 1412.4, "HDFCBANK": 1650.0, "TCS": 3095.0, "INFY": 1496.5, "M&M": 3010.0}
        c = dict(size.DEFAULTS, budget=100000, max_position_pct=30, fractional=True)
        r = size.size(rows, c, prices=prices)
        self.assertTrue(r["whole_shares"])       # NSE: never fractional, whatever the config says
        orders = size.orders_from(r)
        self.assertTrue(orders)
        for o in orders:
            self.assertIn("qty", o)
            self.assertNotIn("notional", o)
            self.assertEqual(o["product"], "CNC")
            g = o["groww"]["entry"]
            self.assertEqual((g["product"], g["order_type"], g["segment"]), ("CNC", "MARKET", "CASH"))
            self.assertRegex(g["order_reference_id"], REF_ID)
        self.assertIn("M&M", [o["symbol"] for o in orders])
        self.assertIn("₹", size.report(r, orders))


if __name__ == "__main__":
    unittest.main()
