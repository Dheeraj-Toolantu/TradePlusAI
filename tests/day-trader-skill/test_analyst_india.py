"""trader-analyst, India (NSE) mode: Yahoo fundamentals-timeseries and NSE's results RSS.

The fixtures in fixtures/trader-analyst-in/ are synthetic (see README.txt there): no network.
"""

import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

from _load import FIX, load

facts = load("trader-analyst", "facts", market="IN")
DIR = os.path.join(FIX, "trader-analyst-in")
RSS = os.path.join(DIR, "Financial_Results.xml")


def timeseries(sym):
    with open(os.path.join(DIR, "timeseries-%s.NS.json" % sym), encoding="utf-8") as fh:
        return facts.parse_timeseries(json.load(fh))


def run(args):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = facts.main(args + ["--market", "IN", "--config", "/nonexistent.json"])
    return code, out.getvalue(), err.getvalue()


class Market(unittest.TestCase):
    def test_india_is_active_when_loaded_for_in(self):
        self.assertEqual(facts.MK.code, "IN")

    def test_fiscal_labels(self):
        self.assertEqual(facts.indian_fiscal("2026-06-30"), "Q1 FY27")
        self.assertEqual(facts.indian_fiscal("2026-09-30"), "Q2 FY27")
        self.assertEqual(facts.indian_fiscal("2026-12-31"), "Q3 FY27")
        self.assertEqual(facts.indian_fiscal("2027-03-31"), "Q4 FY27")
        self.assertEqual(facts.indian_fiscal("2026-03-31"), "Q4 FY26")

    def test_crore_formatting(self):
        self.assertEqual(facts.crore(2.7e12), "₹2,70,000.0 Cr")
        self.assertEqual(facts.crore(1.059e13), "₹10,59,000.0 Cr")
        self.assertEqual(facts.crore(-5.5e8), "-₹55.0 Cr")
        self.assertEqual(facts.crore(None), "n/a")

    def test_url_uses_ns_suffix_and_quotes_ampersand(self):
        url = facts.yahoo_timeseries_url("M&M", now=1793000000)
        self.assertIn("/timeseries/M%26M.NS?symbol=M%26M.NS&type=quarterlyTotalRevenue,", url)
        self.assertIn("annualDilutedEPS&period1=", url)
        self.assertTrue(url.endswith("&period2=1793000000"))
        self.assertIn("/timeseries/RELIANCE.NS?", facts.yahoo_timeseries_url("reliance.ns", now=1))


class Timeseries(unittest.TestCase):
    def test_null_entries_are_skipped(self):
        ts = timeseries("RELIANCE")
        self.assertEqual(len(ts["quarterlyGrossProfit"]), 6)
        self.assertEqual(ts["quarterlyTotalRevenue"]["2026-09-30"], 2.7e12)
        self.assertEqual(ts["_currency"]["quarterlyTotalRevenue"], "INR")

    def test_empty_and_odd_shapes(self):
        self.assertEqual(facts.parse_timeseries({"timeseries": {"result": [], "error": None}}), {})
        self.assertEqual(facts.parse_timeseries({}), {})
        doc = {"timeseries": {"result": [{"meta": {"type": ["quarterlyNetIncome"]},
                                          "quarterlyNetIncome": [None, {"asOfDate": "2026-06-30"},
                                                                 {"asOfDate": "2026-09-30",
                                                                  "reportedValue": {"raw": 5.0}}]}]}}
        self.assertEqual(facts.parse_timeseries(doc), {"quarterlyNetIncome": {"2026-09-30": 5.0}})


class Reliance(unittest.TestCase):
    def setUp(self):
        self.r = facts.analyse_india(timeseries("RELIANCE"), quarters=8, symbol="RELIANCE")

    def test_latest_quarter_against_a_year_earlier(self):
        q = self.r["rows"][0]
        self.assertEqual((q["end"], q["fiscal"]), ("2026-09-30", "Q2 FY27"))
        self.assertEqual(q["revenue"], 2.7e12)
        self.assertEqual(q["revenue_yoy"], 5.9)       # 2,70,000 vs 2,55,000 crore
        self.assertEqual(q["net_income_yoy"], 10.1)   # 20,000 vs 18,165
        self.assertEqual(q["eps_diluted"], 14.78)
        self.assertEqual(q["eps_yoy"], 10.1)
        self.assertEqual(q["gross_margin"], 30.5)
        self.assertEqual(q["operating_margin"], 13.1)
        self.assertEqual(q["net_margin"], 7.4)

    def test_march_quarter_derived_from_the_fiscal_year(self):
        q4 = next(r for r in self.r["rows"] if r["end"] == "2026-03-31")
        self.assertTrue(q4["derived"])
        self.assertEqual(q4["fiscal"], "Q4 FY26")
        self.assertAlmostEqual(q4["revenue"], 2.74e12)    # 10,30,000 - (2,36,000 + 2,55,000 + 2,65,000)
        self.assertAlmostEqual(q4["net_income"], 1.6301e11)
        self.assertEqual(q4["eps_diluted"], 12.05)

    def test_ttm(self):
        t = self.r["ttm"]
        self.assertAlmostEqual(t["revenue"], 1.059e13)
        self.assertAlmostEqual(t["net_income"], 8.1841e11)
        self.assertEqual(t["eps_diluted"], 60.49)

    def test_what_changed_in_rupees_crore(self):
        lines = facts.changes_india(self.r)
        self.assertIn("Quarter ending 2026-09-30 (Q2 FY27): revenue ₹2,70,000.0 Cr "
                      "(+5.9% vs a year earlier)", lines[0])
        self.assertIn("diluted EPS ₹14.78 (+10.1%)", lines[0])
        self.assertNotIn("$", " ".join(lines))


class Bank(unittest.TestCase):
    def test_no_gross_profit_is_blank_and_basic_eps_fills_in(self):
        r = facts.analyse_india(timeseries("HDFCBANK"), symbol="HDFCBANK")
        q = r["rows"][0]
        self.assertIsNone(q["gross_margin"])
        self.assertIsNone(q["operating_margin"])
        self.assertEqual(q["net_margin"], 41.4)
        self.assertEqual(q["eps_diluted"], 26.7)
        self.assertEqual(r["concepts"]["eps_diluted"], ["quarterlyBasicEPS"])
        self.assertEqual(len(r["rows"]), 5)
        self.assertTrue(any("No gross profit" in l for l in facts.changes_india(r)))


class ResultsFeed(unittest.TestCase):
    def setUp(self):
        with open(RSS, "rb") as fh:
            self.items = facts.parse_results_rss(fh.read())

    def test_parse(self):
        self.assertEqual(len(self.items), 4)
        self.assertEqual(self.items[1]["title"], "Tata Consultancy Services Limited")

    def test_matching_by_symbol_and_initials(self):
        self.assertTrue(facts.name_matches("Tata Consultancy Services Limited", "TCS"))
        self.assertTrue(facts.name_matches("HDFC Bank Limited", "HDFCBANK"))
        self.assertTrue(facts.name_matches("Infosys Limited", "INFY", "Infosys"))
        self.assertFalse(facts.name_matches("Infosys Limited", "TCS"))
        hit = facts.latest_result_filing(self.items, "TCS")
        self.assertIn("SYNTHETIC_TCS", hit["link"])
        self.assertEqual(hit["also_matched"], [])

    def test_ambiguous_symbol_says_so_and_name_picks(self):
        hit = facts.latest_result_filing(self.items, "RELIANCE")
        self.assertEqual(hit["title"], "Reliance Infrastructure Limited")
        self.assertEqual(hit["also_matched"], ["Reliance Industries Limited"])
        hit = facts.latest_result_filing(self.items, "RELIANCE", "Reliance Industries")
        self.assertEqual(hit["title"], "Reliance Industries Limited")
        self.assertIsNone(facts.latest_result_filing(self.items, "INFY"))


class Cli(unittest.TestCase):
    def test_report_with_filing_link(self):
        code, out, err = run(["RELIANCE.NS", "--offline", DIR, "--name", "Reliance Industries"])
        self.assertEqual(code, 0, err)
        self.assertIn("Rupees crore except EPS", out)
        self.assertIn("2026-09-30  Q2 FY27     2,70,000    +5.9%", out)
        self.assertIn("derived", out)
        self.assertIn("Last 4 quarters: revenue ₹10,59,000.0 Cr", out)
        self.assertIn("Latest result filing on NSE: Reliance Industries Limited", out)
        self.assertIn("last 5 or so quarters", out)
        self.assertNotIn(chr(0x2014), out)

    def test_rss_file_override_and_missing_feed(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, out, err = run(["HDFCBANK", "--offline", DIR, "--rss-file", os.path.join(tmp, "x.xml")])
        self.assertEqual(code, 0, err)
        self.assertIn("NSE results feed not read", out)
        self.assertIn("Companies > Corporate Filings > Financial Results", out)
        self.assertIn("EPS is basic EPS", out)
        code, out, err = run(["TCS", "--offline", DIR, "--rss-file", RSS])
        self.assertEqual(code, 2)
        self.assertIn("no file", err)

    def test_metrics_and_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "trader", "metrics.json")
            code, out, err = run(["RELIANCE", "HDFCBANK", "NOSUCH", "--offline", DIR,
                                  "--metrics", path, "--json"])
            self.assertEqual(code, 1, err)
            self.assertIn("NOSUCH.NS", err)
            data = json.loads(out)
            with open(path) as fh:
                rows = {r["ticker"]: r for r in json.load(fh)["companies"]}
        self.assertEqual([d["ticker"] for d in data], ["RELIANCE", "HDFCBANK"])
        self.assertEqual(rows["RELIANCE"]["market"], "IN")
        self.assertEqual(rows["RELIANCE"]["currency"], "INR")
        self.assertEqual(rows["RELIANCE"]["revenue_ttm_cr"], 1059000.0)
        self.assertEqual(rows["RELIANCE"]["eps_ttm"], 60.49)
        self.assertIsNone(rows["HDFCBANK"]["gross_margin"])

    def test_cik_is_us_only_and_us_flag_keeps_sec(self):
        code, _, err = run(["--cik", "320193"])
        self.assertEqual(code, 2)
        self.assertIn("--market US", err)
        us_dir = os.path.join(FIX, "trader-analyst")
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = facts.main(["AAPL", "--offline", us_dir, "--market", "US", "--quarters", "2",
                               "--config", "/nonexistent.json"])
        self.assertEqual(code, 0, err.getvalue())
        self.assertIn("US$ millions", out.getvalue())
        facts.apply_market(facts.market.get("IN"))


class CompanyName(unittest.TestCase):
    def test_equity_list_cache_picks_the_right_reliance(self):
        with tempfile.TemporaryDirectory() as d:
            csv_path = os.path.join(d, "EQUITY_L.csv")
            with open(csv_path, "w", newline="") as fh:
                fh.write("SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING\r\n"
                         "RELINFRA,Reliance Infrastructure Limited,EQ,01-JAN-1995\r\n"
                         "RELIANCE,Reliance Industries Limited,EQ,29-NOV-1995\r\n")
            name = facts.company_name("reliance", os.path.join(d, "none.json"), csv_path)
            self.assertEqual(name, "Reliance Industries Limited")
            with open(os.path.join(DIR, "Financial_Results.xml"), "rb") as fh:
                items = facts.parse_results_rss(fh.read())
            pick = facts.latest_result_filing(items, "RELIANCE", name)
            self.assertEqual(pick["title"], "Reliance Industries Limited")

    def test_names_json_wins_and_missing_files_are_fine(self):
        with tempfile.TemporaryDirectory() as d:
            names = os.path.join(d, "names.json")
            with open(names, "w") as fh:
                json.dump({"TCS": "Tata Consultancy Services Limited"}, fh)
            self.assertEqual(facts.company_name("TCS", names, os.path.join(d, "x.csv")),
                             "Tata Consultancy Services Limited")
            self.assertIsNone(facts.company_name("INFY", names, os.path.join(d, "x.csv")))


if __name__ == "__main__":
    unittest.main()
