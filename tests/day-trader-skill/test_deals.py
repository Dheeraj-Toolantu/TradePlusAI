"""trader-deals: NSE bulk and block deals. Synthetic fixtures (see fixtures/trader-deals/README.txt)."""

import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

from _load import FIX, load

deals = load("trader-deals", "deals", market="IN")
DIR = os.path.join(FIX, "trader-deals")
BULK = os.path.join(DIR, "bulk-synthetic.csv")
BLOCK = os.path.join(DIR, "block-synthetic.csv")


def read(path):
    with open(path, encoding="utf-8-sig") as fh:
        return fh.read()


def run(args):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = deals.main(args)
    return code, out.getvalue(), err.getvalue()


class Parse(unittest.TestCase):
    def test_bulk_header_spaces_crlf_and_indian_commas(self):
        rows = deals.parse_deals(read(BULK), "bulk")
        self.assertEqual(len(rows), 5)
        d = rows[0]
        self.assertEqual(d["date"], "2026-10-30")
        self.assertEqual(d["symbol"], "ACMEIND")
        self.assertEqual(d["security"], "Acme Industries Limited")
        self.assertEqual(d["client"], "EXAMPLE CAPITAL FUND LP")
        self.assertEqual(d["side"], "buy")
        self.assertEqual(d["qty"], 1250000)
        self.assertEqual(d["price"], 412.35)
        self.assertEqual(d["value_cr"], 51.54)      # 12,50,000 x 412.35 = 51,54,37,500
        self.assertEqual(d["remarks"], "")
        self.assertEqual(rows[2]["symbol"], "M&M")
        self.assertEqual(rows[2]["value_cr"], 2173.85)

    def test_block_without_remarks_column(self):
        rows = deals.parse_deals(read(BLOCK), "block")
        self.assertEqual([r["symbol"] for r in rows], ["RELIANCE", "RELIANCE", "INFY"])
        self.assertEqual(rows[0]["side"], "sell")
        self.assertEqual(rows[0]["kind"], "block")
        self.assertEqual(rows[0]["value_cr"], 660.69)

    def test_no_records_bodies_are_empty(self):
        self.assertEqual(deals.parse_deals(read(os.path.join(DIR, "block-norecords-synthetic.csv"))), [])
        self.assertEqual(deals.parse_deals(read(os.path.join(DIR, "bulk-empty-synthetic.csv"))), [])
        self.assertEqual(deals.parse_deals(""), [])
        with self.assertRaises(deals.DealsError):
            deals.parse_deals("<html>Access Denied</html>")

    def test_dates(self):
        self.assertEqual(deals.iso_date("31-Oct-2026"), "2026-10-31")
        self.assertEqual(deals.iso_date("01-JAN-2027"), "2027-01-01")
        self.assertEqual(deals.iso_date("31-10-2026"), "2026-10-31")
        self.assertIsNone(deals.iso_date("someday"))

    def test_ids_are_stable_and_distinct(self):
        rows = deals.parse_deals(read(BULK), "bulk")
        ids = [r["id"] for r in rows]
        self.assertEqual(len(set(ids)), len(ids))
        self.assertEqual(ids, [r["id"] for r in deals.parse_deals(read(BULK), "bulk")])


class Filters(unittest.TestCase):
    def setUp(self):
        self.all = deals.load_deals("all", bulk_file=BULK, block_file=BLOCK)

    def test_kinds_from_file_names(self):
        self.assertEqual(len(self.all), 8)
        only_block = deals.load_deals("block", files=[BULK, BLOCK])
        self.assertEqual(set(d["kind"] for d in only_block), {"block"})
        self.assertEqual(len(deals.load_deals("all", files=[BULK, BLOCK])), 8)

    def test_symbol_client_side_value(self):
        sel = deals.select
        self.assertEqual(len(sel(self.all, symbols=["reliance.ns"])), 2)
        self.assertEqual([d["symbol"] for d in sel(self.all, client="demo")], ["M&M", "RELIANCE"])
        self.assertEqual(len(sel(self.all, side="sell")), 3)
        big = sel(self.all, min_value_cr=100)
        self.assertEqual([d["symbol"] for d in big], ["M&M", "RELIANCE", "RELIANCE", "INFY"])

    def test_holdings_and_watchlist(self):
        with tempfile.TemporaryDirectory() as tmp:
            pf = os.path.join(tmp, "portfolio.json")
            wl = os.path.join(tmp, "watchlist.json")
            with open(pf, "w") as fh:
                json.dump({"cash": 100000, "positions": [{"ticker": "RELIANCE", "shares": 10},
                                                         {"symbol": "infy.ns", "shares": 5}]}, fh)
            with open(wl, "w") as fh:
                json.dump({"hits": [{"symbol": "M&M"}, {"symbol": "INFY"}]}, fh)
            mine = deals.my_symbols(pf, wl, ["TINYCAP"])
        self.assertEqual(mine, {"RELIANCE": "held", "INFY": "held", "M&M": "watchlist",
                                "TINYCAP": "watchlist"})
        self.assertEqual(deals.my_symbols("/nonexistent", None), {})

    def test_money_in_rupees_crore(self):
        self.assertEqual(deals.crore(2173.85), "₹2,173.85 Cr")
        self.assertEqual(deals.crore(123456.5), "₹1,23,456.50 Cr")
        self.assertEqual(deals.qty_text(7000000), "70,00,000")
        self.assertEqual(deals.TZ, "IST")


class Cli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = self.tmp.name
        self.pf = os.path.join(self.d, "portfolio.json")
        with open(self.pf, "w") as fh:
            json.dump({"positions": [{"ticker": "RELIANCE", "shares": 10}]}, fh)
        self.base = ["--bulk-file", BULK, "--block-file", BLOCK, "--portfolio", self.pf,
                     "--watchlist", os.path.join(self.d, "none.json"),
                     "--out", os.path.join(self.d, "trader", "deals.json")]

    def tearDown(self):
        self.tmp.cleanup()

    def test_fetch_prints_table_and_writes_deals_json(self):
        code, out, err = run(["fetch", "--min-value-cr", "100"] + self.base)
        self.assertEqual(code, 0, err)
        self.assertIn("M&M", out)
        self.assertIn("₹2,173.85 Cr", out)
        self.assertIn("₹3,105.50", out)
        self.assertIn("<- you hold RELIANCE", out)
        self.assertIn("not a signal to copy", out)
        self.assertIn("Not financial advice", out)
        self.assertNotIn("ACMEIND", out)
        self.assertNotIn(chr(0x2014), out)
        with open(os.path.join(self.d, "trader", "deals.json"), encoding="utf-8") as fh:
            doc = json.load(fh)
        self.assertEqual((doc["market"], doc["currency"], doc["tz"]), ("IN", "INR", "IST"))
        self.assertEqual(len(doc["deals"]), 4)
        self.assertEqual(doc["deals"][1]["yours"], "held")

    def test_fetch_nothing_matches(self):
        code, out, _ = run(["fetch", "--symbol", "TCS", "--no-write"] + self.base)
        self.assertEqual(code, 1)
        self.assertIn("No deals match", out)

    def test_new_alerts_once(self):
        state = os.path.join(self.d, "state", "deals.json")
        code, out, err = run(["new", "--kind", "block", "--state", state] + self.base)
        self.assertEqual(code, 0, err)
        self.assertIn("NEW NSE deals: 3, 2 in symbols you hold", out)
        code, out, _ = run(["new", "--kind", "block", "--state", state] + self.base)
        self.assertEqual(code, 1)
        self.assertIn("Nothing new since", out)
        self.assertIn("IST", out)
        code, out, _ = run(["new", "--state", state, "--json"] + self.base)
        self.assertEqual(code, 0)
        fresh = json.loads(out)["new"]
        self.assertEqual(len(fresh), 5)
        self.assertEqual(set(d["kind"] for d in fresh), {"bulk"})
        with open(os.path.join(self.d, "trader", "deals.json"), encoding="utf-8") as fh:
            doc = json.load(fh)
        self.assertEqual(sum(1 for d in doc["deals"] if d["new"]), 5)
        self.assertEqual(len(doc["deals"]), 8)

    def test_dry_run_keeps_state(self):
        state = os.path.join(self.d, "deals-state.json")
        run(["new", "--dry-run", "--state", state, "--no-write"] + self.base)
        self.assertFalse(os.path.exists(state))

    def test_mine_only(self):
        code, out, _ = run(["fetch", "--mine", "--no-write"] + self.base)
        self.assertEqual(code, 0)
        self.assertIn("RELIANCE", out)
        self.assertNotIn("INFY", out)

    def test_us_market_is_refused(self):
        code, _, err = run(["--market", "US", "fetch"] + self.base)
        self.assertEqual(code, 2)
        self.assertIn("/trader-pelosi", err)
        code, _, err = run(["fetch", "--market", "US"] + self.base)
        self.assertEqual(code, 2)

    def test_missing_file_is_an_error(self):
        code, _, err = run(["fetch", "--file", os.path.join(self.d, "bulk.csv"), "--no-write"])
        self.assertEqual(code, 2)
        self.assertIn("deals:", err)


if __name__ == "__main__":
    unittest.main()
