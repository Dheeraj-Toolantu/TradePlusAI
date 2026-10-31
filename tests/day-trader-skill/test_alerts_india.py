"""trader-alerts in the Indian market (NSE, IST, INR), on synthetic fixtures."""

import datetime
import io
import json
import os
import shutil
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stdout, redirect_stderr

from _load import load, ROOT, FIX

alerts = load("trader-alerts", "alerts", market="IN")

QDIR = os.path.join(FIX, "trader-alerts-in")
PLAN = os.path.join(QDIR, "plan-RELIANCE.json")
DT = datetime.datetime


def ist(text):
    return alerts.parse_now(text)


def run(argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = alerts.main(["--market", "IN"] + argv)
    return code, out.getvalue(), err.getvalue()


def plan_rules():
    with open(PLAN) as fh:
        return alerts.rules_from_plan(json.load(fh))


class Clock(unittest.TestCase):
    def test_india_is_active(self):
        self.assertEqual((alerts.MK.code, alerts.OPEN, alerts.CLOSE), ("IN", datetime.time(9, 15),
                                                                       datetime.time(15, 30)))
        self.assertEqual(alerts.FLAT_BY, "15:10")
        self.assertEqual(alerts.EARLY_CLOSE, {})

    def test_ist_is_utc_plus_five_thirty(self):
        self.assertEqual(alerts.eastern_offset(DT(2026, 1, 5, 3, 45)), 5.5)
        self.assertEqual(alerts.eastern_offset(DT(2026, 7, 6, 3, 45)), 5.5)
        self.assertEqual(ist("2026-10-30 09:15"), DT(2026, 10, 30, 3, 45))
        self.assertEqual(ist("2026-10-30T15:30"), DT(2026, 10, 30, 10, 0))
        self.assertEqual(ist("2026-10-30T05:22:10Z"), DT(2026, 10, 30, 5, 22, 10))
        self.assertEqual(alerts.to_eastern(DT(2026, 3, 8, 7, 0)), DT(2026, 3, 8, 12, 30))  # no DST

    def test_session_bell_and_close(self):
        self.assertFalse(alerts.market_status(ist("2026-10-30 09:14"))["open"])
        self.assertEqual(alerts.market_status(ist("2026-10-30 09:14"))["next_open"], "2026-10-30 09:15")
        st = alerts.market_status(ist("2026-10-30 09:15"))
        self.assertTrue(st["open"])
        self.assertEqual((st["opens"], st["closes"], st["now_ist"], st["tz"]), ("09:15", "15:30", "2026-10-30 09:15", "IST"))
        self.assertTrue(alerts.market_status(ist("2026-10-30 15:29"))["open"])
        after = alerts.market_status(ist("2026-10-30 15:30"))
        self.assertFalse(after["open"])
        self.assertEqual(after["next_open"], "2026-11-02 09:15")   # Friday -> Monday
        pre = alerts.market_status(ist("2026-10-30 09:05"))
        self.assertIn("pre-open call auction (09:00 to 09:08 IST)", pre["reason"])

    def test_nse_holidays_and_muhurat(self):
        diwali = alerts.market_status(ist("2026-11-10 10:00"))
        self.assertFalse(diwali["open"])
        self.assertEqual(diwali["reason"], "NSE holiday: Diwali Balipratipada")
        self.assertEqual(diwali["next_open"], "2026-11-11 09:15")
        self.assertEqual(alerts.market_status(ist("2026-11-09 16:00"))["next_open"], "2026-11-11 09:15")
        dussehra = alerts.market_status(ist("2026-10-20 11:00"))
        self.assertIn("Dussehra", dussehra["reason"])
        weekend = alerts.market_status(ist("2026-11-07 10:00"))
        self.assertEqual(weekend["next_open"], "2026-11-09 09:15")
        self.assertIn("2026-11-08: Muhurat trading", weekend["special_session"])
        self.assertIn("Muhurat", alerts.market_status(ist("2026-11-08 18:00"))["special_session"])
        self.assertNotIn("special_session", alerts.market_status(ist("2026-10-30 10:00")))
        self.assertFalse(alerts.market_status(ist("2027-03-01 10:00"))["calendar_known"])

    def test_clock_cli(self):
        code, text, _ = run(["clock", "--now", "2026-11-07 10:00"])
        self.assertEqual(code, 1)
        self.assertIn("IST 2026-11-07 10:00 (Saturday): NSE closed, weekend.", text)
        self.assertIn("Next open: 2026-11-09 09:15 IST.", text)
        self.assertIn("Special session: 2026-11-08: Muhurat", text)
        code, text, _ = run(["clock", "--now", "2027-01-05 10:00"])
        self.assertIn("check nseindia.com", text)
        self.assertEqual(run(["clock", "--now", "2026-10-30 10:15"])[0], 0)


class Money(unittest.TestCase):
    def test_rupees_with_indian_grouping(self):
        self.assertEqual(alerts.px(2958.4), "₹2,958.40")
        self.assertEqual(alerts.px(1234567.5), "₹12,34,567.50")
        self.assertEqual(alerts.level(2945), "₹2,945")
        self.assertEqual(alerts.level(2985.2), "₹2,985.20")


class Quotes(unittest.TestCase):
    def test_symbols_and_urls(self):
        self.assertEqual(alerts.plain("reliance.ns"), "RELIANCE")
        self.assertEqual(alerts.yahoo_url("RELIANCE"),
                         "https://query2.finance.yahoo.com/v8/finance/chart/RELIANCE.NS?range=1d&interval=1d")
        self.assertEqual(alerts.yahoo_url("RELIANCE.NS"), alerts.yahoo_url("RELIANCE"))
        self.assertIn("/chart/M%26M.NS?", alerts.yahoo_url("M&M"))
        self.assertIn("/chart/BAJAJ-AUTO.NS?", alerts.yahoo_url("BAJAJ-AUTO"))
        self.assertIn("/chart/M%26M.BO?", alerts.yahoo_url("M&M", exchange="BSE"))
        self.assertIn("//query1.finance.yahoo.com/", alerts.yahoo_url("TCS", alerts.YAHOO_HOSTS[1]))

    def test_nse_quotes_and_bse_fallback_offline(self):
        q, errors = alerts.get_quotes(["RELIANCE.NS", "TCS", "INFY", "M&M", "ZZZZ"], "yahoo", QDIR)
        self.assertEqual(sorted(q), ["INFY", "M&M", "RELIANCE", "TCS"])
        self.assertEqual((q["RELIANCE"]["price"], q["RELIANCE"]["prev_close"]), (2958.4, 2915.0))
        self.assertEqual((q["RELIANCE"]["currency"], q["RELIANCE"]["exchange"]), ("INR", "NSE"))
        self.assertEqual((q["INFY"]["source"], q["INFY"]["exchange"]), ("yahoo-bse", "BSE"))
        self.assertIn("NSE quote failed", q["INFY"]["fallback"])
        self.assertEqual(len(errors), 1)
        self.assertIn("ZZZZ: NSE: Yahoo has no data", errors[0])
        q, _ = alerts.get_quotes(["RELIANCE"], "bse", QDIR)
        self.assertEqual(q["RELIANCE"]["price"], 2958.05)

    def test_stooq_is_refused_in_india(self):
        with self.assertRaises(alerts.AlertError) as cm:
            alerts.get_quotes(["RELIANCE"], "stooq", QDIR)
        self.assertIn("Stooq does not cover NSE", str(cm.exception))


class FakeNet(object):
    def __init__(self, codes):
        self.codes, self.urls, self.sleeps = list(codes), [], []
        with open(os.path.join(QDIR, "bse-INFY.json")) as fh:
            self.body = fh.read()

    def urlopen(self, req, timeout=None):
        self.urls.append(req.full_url)
        code = self.codes.pop(0)
        if code != 200:
            fp = io.BytesIO(b'{"chart":{"result":null,"error":{"code":"Not Found",'
                            b'"description":"No data found, symbol may be delisted"}}}' if code == 404 else b"")
            raise urllib.error.HTTPError(req.full_url, code, "x", {}, fp)
        return io.BytesIO(self.body.encode("utf-8"))


class Network(unittest.TestCase):
    def setUp(self):
        self.saved = (alerts._urlopen, alerts._sleep)

    def tearDown(self):
        alerts._urlopen, alerts._sleep = self.saved

    def test_ns_then_bse_with_a_pause(self):
        f = FakeNet([404, 200])
        alerts._urlopen, alerts._sleep = f.urlopen, f.sleeps.append
        q, errors = alerts.get_quotes(["INFY"])
        self.assertEqual((q["INFY"]["price"], q["INFY"]["exchange"], errors), (1480.25, "BSE", []))
        self.assertEqual([u.split("/chart/")[1].split("?")[0] for u in f.urls], ["INFY.NS", "INFY.BO"])
        self.assertEqual(f.sleeps, [alerts.PAUSE])

    def test_url_quoting_on_the_wire(self):
        f = FakeNet([200])
        alerts._urlopen, alerts._sleep = f.urlopen, f.sleeps.append
        alerts.get_quotes(["M&M"])
        self.assertIn("/v8/finance/chart/M%26M.NS?range=1d", f.urls[0])


class Rules(unittest.TestCase):
    def setUp(self):
        self.q, _ = alerts.get_quotes(["RELIANCE", "TCS", "INFY"], "yahoo", QDIR)

    def at(self, text, rules, state=None, quotes=None):
        now = ist(text)
        return alerts.evaluate(rules, self.q if quotes is None else quotes, alerts.market_status(now),
                               state or {}, now)

    def test_the_plan_gives_stop_target_and_flat_by_1510(self):
        rules = plan_rules()
        self.assertEqual([(r["id"], r["type"]) for r in rules],
                         [("reliance-plan-stop", "stop"), ("reliance-plan-target", "target"),
                          ("reliance-flat-by", "time")])
        self.assertEqual((rules[0]["price"], rules[1]["price"], rules[2]["at"]), (2945.0, 2985.2, "15:10"))
        self.assertTrue(all(r["date"] == "2026-10-30" for r in rules))
        self.assertEqual(alerts.rules_from_plan({"symbol": "TCS.NS", "stop": 3100, "target": 3200},
                                                "15:05")[2]["at"], "15:05")
        self.assertEqual(alerts.rules_from_plan({"symbol": "TCS.NS", "stop": 3100, "target": 3200})[0]["symbol"],
                         "TCS")

    def test_stop_target_messages_in_rupees(self):
        rules = plan_rules()
        self.assertEqual(self.at("2026-10-30 10:53", rules)[0], [])
        q = json.loads(json.dumps(self.q))
        q["RELIANCE"]["price"] = 2941.5
        rings, st = self.at("2026-10-30 11:30", rules, None, q)
        self.assertEqual([r["id"] for r in rings], ["reliance-plan-stop"])
        self.assertIn("RELIANCE is ₹2,941.50: at or below your stop ₹2,945 (plan stop: opening-range midpoint)",
                      rings[0]["message"])
        q["RELIANCE"]["price"] = 2990.0
        rings, _ = self.at("2026-10-30 12:00", rules, st, q)
        self.assertIn("at or above your target ₹2,985.20", rings[0]["message"])

    def test_bse_quote_is_named_in_the_message(self):
        rule = [{"id": "infy-stop", "symbol": "INFY", "type": "stop", "price": 1490}]
        rings, _ = self.at("2026-10-30 10:53", rule)
        self.assertIn("[BSE price: the NSE quote failed]", rings[0]["message"])

    def test_flat_by_and_bell_in_ist(self):
        rules = plan_rules()[2:]
        self.assertEqual(self.at("2026-10-30 15:09", rules)[0], [])
        rings, st = self.at("2026-10-30 15:10", rules)
        self.assertIn("Flat by close: it is 15:10 IST (set for 15:10), the market closes at 15:30",
                      rings[0]["message"])
        self.assertIn("trader-broker flatten --symbol RELIANCE", rings[0]["message"])
        self.assertEqual(self.at("2026-10-30 15:20", rules, st)[0], [])
        bell = [{"id": "bell", "type": "opening_bell"}]
        rings, st = self.at("2026-10-30 09:15", bell)
        self.assertEqual(rings[0]["message"], "Opening bell: the NSE is open (2026-10-30 09:15 IST).")
        self.assertEqual(self.at("2026-11-10 09:20", bell)[0], [])                 # Diwali holiday
        self.assertEqual(self.at("2026-11-08 18:15", bell)[0], [])                 # Muhurat: not a regular session

    def test_pct_move(self):
        rule = [{"id": "tcs-1", "symbol": "TCS", "type": "pct_move", "pct": 1.5, "direction": "down"}]
        rings, _ = self.at("2026-10-30 15:29", rule)
        self.assertIn("TCS moved -1.87% to ₹3,120.50 (from ₹3,180.00)", rings[0]["message"])

    def test_the_india_example_rules_are_valid(self):
        with open(os.path.join(ROOT, "trader-alerts", "alerts.india.example.json"), encoding="utf-8") as fh:
            doc = json.load(fh)
        for r in doc["rules"]:
            alerts.validate(r)
        self.assertEqual(doc["market"], "IN")
        self.assertEqual([r for r in doc["rules"] if r["id"].startswith("reliance-")], plan_rules())


class Cli(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.rules = os.path.join(self.d, "alerts.json")
        self.state = os.path.join(self.d, "state", "alerts.json")
        self.prices = os.path.join(self.d, "prices.json")

    def tearDown(self):
        shutil.rmtree(self.d)

    def check(self, now):
        return run(["check", "--rules", self.rules, "--state", self.state, "--prices-out", self.prices,
                    "--offline", QDIR, "--now", now])

    def test_a_reliance_day(self):
        cfg = os.path.join(self.d, "config.json")
        with open(cfg, "w") as fh:
            json.dump({"market": "IN", "flat_by": "15:05", "max_loss_per_trade_inr": 500}, fh)
        code, text, _ = run(["add", "--from-plan", "--plan", PLAN, "--rules", self.rules, "--state", self.state,
                             "--config", cfg])
        self.assertEqual(code, 0)
        with open(self.rules) as fh:
            self.assertEqual(json.load(fh)["rules"][2]["at"], "15:05")   # the config's flat_by
        code, text, _ = run(["add", "--from-plan", "--plan", PLAN, "--rules", self.rules, "--state", self.state,
                             "--config", os.path.join(self.d, "none")])
        self.assertIn("Added reliance-flat-by", text)
        self.assertEqual(run(["add", "--rules", self.rules, "--opening-bell"])[0], 0)

        code, text, _ = self.check("2026-10-30 10:52")
        self.assertEqual(code, 0)
        self.assertIn("ALERT Opening bell: the NSE is open (2026-10-30 10:52 IST)", text)
        code, text, _ = self.check("2026-10-30 10:53")
        self.assertEqual(code, 1)
        self.assertIn("NSE OPEN (2026-10-30 10:53 IST, regular session).", text)
        self.assertIn("Nothing hit. 4 rule(s) watched today, RELIANCE ₹2,958.40.", text)
        with open(self.prices, encoding="utf-8") as fh:
            doc = json.load(fh)
        self.assertEqual((doc["market"], doc["currency"], doc["prices"]), ("IN", "INR", {"RELIANCE": 2958.4}))
        self.assertEqual(doc["detail"]["RELIANCE"]["exchange"], "NSE")
        self.assertEqual(doc["detail"]["RELIANCE"]["fetched"], "2026-10-30T05:23:00Z")
        code, text, _ = self.check("2026-10-30 15:10")
        self.assertEqual(code, 0)
        self.assertIn("ALERT Flat by close: it is 15:10 IST", text)
        self.assertIn("not an order", text)

    def test_quote_write_and_symbols(self):
        code, text, _ = run(["quote", "RELIANCE.NS", "m&m", "INFY", "--offline", QDIR, "--write", self.prices,
                             "--now", "2026-10-30 10:53"])
        self.assertEqual(code, 0)
        self.assertIn("RELIANCE ₹2,958.40 (+1.49% vs prev close ₹2,915.00)  2026-10-30 10:52 IST  [yahoo]", text)
        self.assertIn("[yahoo-bse]", text)
        self.assertIn("note: NSE quote failed", text)
        with open(self.prices, encoding="utf-8") as fh:
            doc = json.load(fh)
        self.assertEqual(sorted(doc["prices"]), ["INFY", "M&M", "RELIANCE"])
        self.assertEqual(doc["detail"]["INFY"]["exchange"], "BSE")
        self.assertIn("fallback", doc["detail"]["INFY"])
        code, _, err = run(["quote", "RELIANCE", "--source", "stooq", "--offline", QDIR])
        self.assertEqual(code, 1)
        self.assertIn("Stooq does not cover NSE", err)

    def test_add_with_plain_symbols(self):
        code, _, _ = run(["add", "--rules", self.rules, "--symbol", "hdfcbank.ns", "--stop", "1650"])
        self.assertEqual(code, 0)
        with open(self.rules) as fh:
            self.assertEqual(json.load(fh)["rules"][0],
                             {"id": "hdfcbank-stop-1650", "symbol": "HDFCBANK", "type": "stop", "price": 1650.0})
        code, _, err = run(["add", "--rules", self.rules, "--at", "3pm"])
        self.assertIn("IST time like 15:10", err)

    def test_market_us_flag_switches_and_back(self):
        try:
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = alerts.main(["--market", "US", "clock", "--now", "2026-10-19 10:15"])
            self.assertEqual(code, 0)
            self.assertIn("New York 2026-10-19 10:15 (Monday): NYSE OPEN", out.getvalue())
        finally:
            alerts.apply_market(alerts.market.get("IN"))
        self.assertEqual(alerts.MK.code, "IN")


if __name__ == "__main__":
    unittest.main()
