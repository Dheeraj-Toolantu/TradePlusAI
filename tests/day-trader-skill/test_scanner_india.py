"""trader-scanner in India (NSE) mode: IST clock, rupees, .NS symbols, the NSE universe.

All data is synthetic (fixtures/trader-scanner-in/README.txt). Every main() call passes --market IN,
because _load.py sets TRADER_MARKET=US for the test process.
"""

import datetime
import io
import json
import os
import shutil
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stdout, redirect_stderr

from _load import load, FIX

scan = load("trader-scanner", "scan", market="IN")

IDIR = os.path.join(FIX, "trader-scanner-in")
EQUITY = os.path.join(IDIR, "EQUITY_L.csv")
NIFTY50 = os.path.join(IDIR, "ind_nifty50list.csv")
WALL = os.path.join(IDIR, "wall5m-synthetic-2026-10-29.json")
DAILY = os.path.join(IDIR, "daily-spark-synthetic-2026-10-28.json")
HDFC1D = os.path.join(IDIR, "HDFCBANK-1d-synthetic.json")
DT = datetime.datetime
D = datetime.date


def run(argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = scan.main(argv)
    scan.apply_market(scan.market.get("IN"))
    return code, out.getvalue(), err.getvalue()


def read_bytes(path):
    with open(path, "rb") as fh:
        return fh.read()


class Base(unittest.TestCase):
    def setUp(self):
        scan.apply_market(scan.market.get("IN"))
        self.d = tempfile.mkdtemp()
        self.t = os.path.join(self.d, "trader")
        self.wl = os.path.join(self.t, "watchlist.json")
        self.uni = os.path.join(self.t, "universe.txt")

    def tearDown(self):
        shutil.rmtree(self.d)
        scan.apply_market(scan.market.get("IN"))

    def read(self, path):
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)


class ClockAndMoney(Base):
    def test_ist_clock(self):
        self.assertEqual(scan.MK.code, "IN")
        utc = DT(2026, 10, 29, 3, 45)
        self.assertEqual(scan.eastern_offset(utc), 5.5)
        self.assertEqual(scan.to_eastern(utc), DT(2026, 10, 29, 9, 15))
        self.assertEqual(scan.ts_to_eastern(int((utc - DT(1970, 1, 1)).total_seconds())), DT(2026, 10, 29, 9, 15))
        self.assertEqual(scan.parse_now("2026-10-29 10:00"), DT(2026, 10, 29, 4, 30))
        self.assertEqual(scan.parse_now("2026-10-29T04:30:00Z"), DT(2026, 10, 29, 4, 30))
        self.assertEqual((scan.OPEN, scan.CLOSE), (datetime.time(9, 15), datetime.time(15, 30)))
        self.assertEqual(scan.session(D(2026, 10, 29)), (datetime.time(9, 15), datetime.time(15, 30)))
        self.assertEqual(scan.trading_day(D(2026, 11, 10)), (False, "NSE holiday: Diwali Balipratipada"))
        self.assertEqual(scan.DEFAULTS["no_entries_after"], "14:45")
        with self.assertRaises(scan.ScanError) as cm:
            scan.parse_hhmm("25:00")
        self.assertIn("an IST time like 10:00", str(cm.exception))

    def test_rupees_and_ticks(self):
        self.assertEqual(scan.money(1234567.5), "₹12,34,567.50")
        self.assertEqual(scan.money(1405.5), "₹1,405.50")
        self.assertEqual(scan._p(3212.4), "3,212.40")
        self.assertEqual(scan.crore(10), "₹10 crore")
        self.assertEqual(scan.MK.tick(1405.5), 0.10)
        self.assertEqual(scan.MK.round_down(1405.57), 1405.5)

    def test_floors_by_market(self):
        self.assertEqual(scan.FLOORS["daily"], (50.0, 0, 10.0))
        self.assertEqual(scan.FLOORS["orb"], (50.0, 0, 1.0))
        scan.apply_market(scan.market.get("US"))
        self.assertEqual(scan.FLOORS["daily"], (5.0, 1000000, 0.0))
        self.assertEqual(scan.money(364.18), "$364.18")
        self.assertEqual(scan.to_yahoo("BRK.B"), "BRK-B")


class Symbols(Base):
    def test_yahoo_symbols(self):
        self.assertEqual(scan.to_yahoo("reliance"), "RELIANCE.NS")
        self.assertEqual(scan.to_yahoo("RELIANCE.NS"), "RELIANCE.NS")
        self.assertEqual(scan.from_yahoo("BAJAJ-AUTO.NS"), "BAJAJ-AUTO")
        self.assertEqual(scan.plain("m&m.ns"), "M&M")
        self.assertEqual(scan.spark_path(["M&M", "BAJAJ-AUTO", "tcs"], "3mo", "1d"),
                         "/v7/finance/spark?symbols=M%26M.NS,BAJAJ-AUTO.NS,TCS.NS&range=3mo&interval=1d")
        self.assertEqual(scan.chart_path("M&M", "1d", "5m"), "/v8/finance/chart/M%26M.NS?range=1d&interval=5m")

    def test_spark_maps_back_to_plain_symbols(self):
        with open(DAILY, encoding="utf-8") as fh:
            got = scan.parse_spark(fh.read())
        self.assertEqual(sorted(got), ["HDFCBANK", "INFY", "M&M", "PENNYCO", "RELIANCE", "THINCO"])
        self.assertEqual(got["RELIANCE"]["meta"]["currency"], "INR")

    def test_symbol_files_strip_ns(self):
        p = os.path.join(self.d, "l.txt")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write("# mine\nRELIANCE.NS\nm&m|Mahindra & Mahindra Limited|Automobile\ntcs\n")
        self.assertEqual(scan.symbols_from_file(p), ["RELIANCE", "M&M", "TCS"])
        js = os.path.join(self.d, "w.json")
        with open(js, "w", encoding="utf-8") as fh:
            json.dump({"hits": [{"symbol": "INFY.NS"}, {"symbol": "hdfcbank"}]}, fh)
        self.assertEqual(scan.symbols_from_file(js), ["INFY", "HDFCBANK"])
        self.assertEqual(scan.read_universe_meta(p)["M&M"],
                         {"name": "Mahindra & Mahindra Limited", "industry": "Automobile"})


class Universe(Base):
    def test_build_keeps_eq_series_in_the_index(self):
        with open(EQUITY, encoding="utf-8") as fh:
            eq = fh.read()
        with open(NIFTY50, encoding="utf-8") as fh:
            idx = fh.read()
        kept, counts = scan.build_nse_universe(eq, None)
        self.assertEqual([k[0] for k in kept], ["BAJAJ-AUTO", "HDFCBANK", "INFY", "M&M", "PENNYCO", "RELIANCE",
                                                "TCS", "THINCO"])
        self.assertEqual((counts["series BE"], counts["series BZ"]), (1, 1))
        kept, counts = scan.build_nse_universe(eq, idx)
        self.assertEqual(len(kept), 6)
        self.assertIn(("M&M", "Mahindra & Mahindra Limited", "Automobile and Auto Components"), kept)
        self.assertEqual(counts["not EQ in EQUITY_L"], 1)    # 20MICRONS is BE today
        with self.assertRaises(scan.ScanError):
            scan.build_nse_universe("SYMBOL,FOO\nA,B\n", None)

    def test_offline_folder_writes_universe_and_raw_cache(self):
        code, text, _ = run(["universe", "--market", "IN", "--offline", IDIR, "--index", "nifty50",
                             "--out", self.uni])
        self.assertEqual(code, 0)
        self.assertIn("8 in the EQ series", text)
        self.assertIn("Kept 6 of the 7 Nifty 50 members", text)
        with open(self.uni, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
        self.assertEqual(lines[0], "BAJAJ-AUTO|Bajaj Auto Limited|Automobile and Auto Components")
        self.assertIn("RELIANCE|Reliance Industries Limited|Oil Gas & Consumable Fuels", lines)
        self.assertFalse(any(".NS" in ln for ln in lines))
        cache = os.path.join(self.t, "cache")
        self.assertEqual(read_bytes(os.path.join(cache, "EQUITY_L.csv")), read_bytes(EQUITY))   # as published
        self.assertEqual(read_bytes(os.path.join(cache, "ind_nifty50list.csv")), read_bytes(NIFTY50))

    def test_file_flags_and_all(self):
        code, text, _ = run(["universe", "--market", "IN", "--file", EQUITY, "--index-file", NIFTY50,
                             "--index", "nifty50", "--out", self.uni, "--no-write", "--json"])
        self.assertEqual(json.loads(text)["count"], 6)
        self.assertFalse(os.path.exists(self.t))               # --no-write: no universe, no cache
        code, text, _ = run(["universe", "--market", "IN", "--file", EQUITY, "--index", "all", "--out", self.uni,
                             "--json"])
        self.assertEqual(code, 0)
        out = json.loads(text)
        self.assertEqual((out["count"], out["eq"], out["index"]), (8, 8, "all"))
        self.assertTrue(os.path.exists(os.path.join(self.t, "cache", "EQUITY_L.csv")))
        code, _, err = run(["universe", "--market", "IN", "--file", EQUITY, "--index", "nifty42"])
        self.assertEqual(code, 1)
        self.assertIn("--index wants one of", err)
        code, _, err = run(["universe", "--market", "US", "--index", "nifty50"])
        self.assertEqual(code, 1)
        self.assertIn("India market", err)

    def test_network_headers_and_cache_fallback(self):
        seen = []
        with open(EQUITY, encoding="utf-8", newline="") as fh:
            eq = fh.read()
        with open(NIFTY50, encoding="utf-8", newline="") as fh:
            idx = fh.read()

        def ok(url, timeout=20, headers=None):
            seen.append((url, headers))
            return eq if url.endswith("EQUITY_L.csv") else idx

        def down(url, timeout=20, headers=None):
            raise urllib.error.HTTPError(url, 403, "Forbidden", {}, None)
        old_get, old_sleep = scan.http_get, scan.SLEEP
        scan.SLEEP = lambda s: None
        try:
            scan.http_get = ok
            code, text, _ = run(["universe", "--market", "IN", "--out", self.uni])   # default nifty500
            self.assertEqual(code, 0)
            self.assertEqual([u for u, _ in seen],
                             ["https://archives.nseindia.com/content/equities/EQUITY_L.csv",
                              "https://archives.nseindia.com/content/indices/ind_nifty500list.csv"])
            h = seen[0][1]
            self.assertTrue(h["User-Agent"].startswith("Mozilla/5.0 (Windows"))
            self.assertIn("text/csv", h["Accept"])
            self.assertTrue(os.path.exists(os.path.join(self.t, "cache", "ind_nifty500list.csv")))
            scan.http_get = down
            code, text, _ = run(["universe", "--market", "IN", "--out", self.uni])
            self.assertEqual(code, 0)
            self.assertIn("NSE could not be reached (archives.nseindia.com answered HTTP 403", text)
            self.assertIn("used the cached", text)
            os.remove(os.path.join(self.t, "cache", "EQUITY_L.csv"))
            code, _, err = run(["universe", "--market", "IN", "--out", self.uni])
            self.assertEqual(code, 1)
            self.assertIn("HTTP 403", err)
        finally:
            scan.http_get, scan.SLEEP = old_get, old_sleep


class Daily(Base):
    def test_daily_in_rupees(self):
        run(["universe", "--market", "IN", "--offline", IDIR, "--index", "all", "--out", self.uni])
        code, text, _ = run(["daily", "--market", "IN", "--offline", DAILY, "--universe", self.uni,
                             "--symbols", "RELIANCE,INFY.NS,HDFCBANK,PENNYCO,THINCO,M&M",
                             "--now", "2026-10-29 09:00", "--out", self.wl])
        self.assertEqual(code, 0)
        self.assertIn("Daily scan, Thu 2026-10-29 09:00 IST, closes through 2026-10-28", text)
        self.assertIn("4 passed the liquidity filter (₹50+ and ₹10 crore+ traded a day)", text)
        self.assertIn("RELIANCE      ₹1,402.00", text)
        doc = self.read(self.wl)
        self.assertEqual((doc["market"], doc["currency"], doc["as_of"]), ("IN", "INR", "2026-10-28 close"))
        self.assertEqual(doc["filters"], {"min_price": 50.0, "min_volume": 0, "min_value_cr": 10.0})
        self.assertEqual([h["symbol"] for h in doc["hits"]], ["HDFCBANK", "RELIANCE", "INFY", "M&M"])
        rel = doc["hits"][1]
        self.assertEqual(rel, {"symbol": "RELIANCE", "setups": ["breakout_20d"], "price": 1402.0,
                               "close_date": "2026-10-28", "rsi": 75.2, "volume": 8000000,
                               "traded_value_cr": 1121.6, "name": "Reliance Industries Limited"})
        # floors off: the Rs 40.50 and thinly traded charts come back
        code, text, _ = run(["daily", "--market", "IN", "--offline", DAILY, "--now", "2026-10-29 09:00",
                             "--min-price", "0", "--min-value-cr", "0", "--json", "--no-write"])
        self.assertEqual(json.loads(text)["scanned"], 6)

    def test_average_traded_value_from_v8_volumes(self):
        data, _ = scan.load_offline(HDFC1D)
        s = data["HDFCBANK"]
        v = scan.avg_traded_value(s, DT(2026, 10, 29, 3, 30))
        self.assertAlmostEqual(v / scan.CRORE, 660.0, places=6)   # 20 days x 40 lakh shares x ~Rs 1,650
        s2 = dict(s, v=None)
        self.assertAlmostEqual(scan.avg_traded_value(s2, DT(2026, 10, 29, 3, 30)),
                               s["meta"]["regularMarketPrice"] * s["meta"]["regularMarketVolume"])


class Orb(Base):
    def test_window_messages_in_ist(self):
        now = scan.parse_now("2026-10-29 09:32")
        with self.assertRaises(scan.ScanError) as cm:
            scan.orb_window(now, None, 15, None)
        self.assertIn("It is 9:32 AM IST: the 15-minute opening range runs 9:15 AM to 9:30 AM", str(cm.exception))
        self.assertIn("after 9:35 AM", str(cm.exception))
        day, cutoff = scan.orb_window(scan.parse_now("2026-10-29 09:35"), None, 15, None)
        self.assertEqual(cutoff, DT(2026, 10, 29, 9, 35))
        with self.assertRaises(scan.ScanError) as cm:
            scan.orb_window(scan.parse_now("2026-11-10 10:00"), None, 15, None)
        self.assertIn("NSE holiday: Diwali Balipratipada", str(cm.exception))
        with self.assertRaises(scan.ScanError) as cm:
            scan.orb_window(scan.parse_now("2026-11-08 18:00"), None, 15, None)
        self.assertIn("Muhurat trading", str(cm.exception))
        with self.assertRaises(scan.ScanError) as cm:          # after 14:45 on the day before a holiday
            scan.orb_window(scan.parse_now("2026-11-09 14:50"), None, 15, scan.parse_hhmm("14:45"))
        self.assertIn("Run orb on Wed 2026-11-11 after 9:35 AM", str(cm.exception))
        self.assertIsNone(scan.calendar_note(D(2026, 11, 2)))
        self.assertIn("Holiday list covers 2026 only", scan.calendar_note(D(2027, 1, 26)))
        with self.assertRaises(scan.ScanError) as cm:
            scan.orb_window(scan.parse_now("2026-10-29 15:31"), None, 15, None)
        self.assertIn("closed at 3:30 PM IST", str(cm.exception))
        self.assertIn("--at 10:00", str(cm.exception))

    def test_opening_range_is_the_first_three_bars(self):
        data, _ = scan.load_offline(WALL)
        day, cutoff = D(2026, 10, 29), DT(2026, 10, 29, 10, 0)
        bars = scan.session_bars(data["RELIANCE"], day, cutoff)
        self.assertEqual(bars[0]["start"], DT(2026, 10, 29, 9, 15))
        self.assertEqual(len(bars), 9)                              # 9:15 ... 9:55
        self.assertTrue(scan.usable(bars, day, cutoff, 3))
        h = scan.orb_hit(bars, 3)
        self.assertEqual((h["or_high"], h["bar_start"], h["at"], h["price"]), (1400.0, "09:40", "9:45 AM", 1405.5))
        self.assertFalse(scan.usable(scan.session_bars(data["TCS"], day, cutoff), day, cutoff, 3))

    def test_orb_offline_end_to_end(self):
        os.makedirs(self.t)
        run(["universe", "--market", "IN", "--offline", IDIR, "--index", "all", "--out", self.uni])
        code, text, _ = run(["orb", "--market", "IN", "--offline", WALL, "--now", "2026-10-29 10:00",
                             "--universe", self.uni, "--out", self.wl])
        self.assertEqual(code, 0)
        self.assertIn("Opening-range breakout scan, Thu 2026-10-29 10:00 AM IST: 15-minute range (9:15 AM to "
                      "9:30 AM)", text)
        self.assertIn("(2 under the price / traded-value floor)", text)
        self.assertIn("9:35 AM  M&M           ₹3,212.40  range 3,182.96 to 3,200.00  +0.39% over", text)
        doc = self.read(self.wl)
        self.assertEqual((doc["as_of"], doc["market"], doc["currency"], doc["universe"]),
                         ("2026-10-29 10:00 IST", "IN", "INR", 8))
        self.assertEqual([h["symbol"] for h in doc["hits"]], ["M&M", "RELIANCE"])
        self.assertEqual(doc["hits"][0]["name"], "Mahindra & Mahindra Limited")
        # no floors: PENNYCO and THINCO break out too
        code, text, _ = run(["orb", "--market", "IN", "--offline", WALL, "--at", "10:00", "--min-price", "0",
                             "--min-value-cr", "0", "--json", "--no-write"])
        self.assertEqual([h["symbol"] for h in json.loads(text)["hits"]], ["M&M", "PENNYCO", "THINCO", "RELIANCE"])

    def test_until_defaults_to_1445_ist(self):
        code, _, err = run(["orb", "--market", "IN", "--offline", WALL, "--now", "2026-10-29 14:50",
                            "--out", self.wl, "--config", os.path.join(self.d, "none.json")])
        self.assertEqual(code, 1)
        self.assertIn("after 14:45", err)
        self.assertIn("expired", err)
        self.assertFalse(os.path.exists(self.wl))

    def test_networked_path_uses_ns_symbols(self):
        with open(WALL, encoding="utf-8") as fh:
            bundle = json.load(fh)
        calls = []

        def get(path):
            calls.append(path)
            if path.startswith("/v7/finance/spark"):
                res = []
                for y in path.split("symbols=")[1].split("&")[0].split(","):
                    y = y.replace("%26", "&")
                    r = bundle[y[:-3]]["chart"]["result"]
                    res.append({"symbol": y, "response": [dict(r[0], indicators={"quote": [
                        {"close": r[0]["indicators"]["quote"][0]["close"]}]})]})
                return json.dumps({"spark": {"result": res, "error": None}})
            y = path.split("/chart/")[1].split("?")[0].replace("%26", "&")
            return json.dumps(bundle[y[:-3]])
        old_get, old_sleep, real_now = scan.yahoo_get, scan.SLEEP, scan.parse_now
        scan.yahoo_get, scan.SLEEP = get, (lambda s: None)
        scan.parse_now = lambda text: real_now(text or "2026-10-29 10:05")
        try:
            code, text, _ = run(["orb", "--market", "IN", "--symbols", "RELIANCE,M&M,BAJAJ-AUTO",
                                 "--now", "2026-10-29 10:00", "--no-write", "--json"])
        finally:
            scan.yahoo_get, scan.SLEEP, scan.parse_now = old_get, old_sleep, real_now
        self.assertEqual(code, 0)
        self.assertEqual(calls[0], "/v7/finance/spark?symbols=RELIANCE.NS,M%26M.NS,BAJAJ-AUTO.NS"
                                   "&range=1d&interval=5m")
        self.assertIn("/v8/finance/chart/M%26M.NS?range=1d&interval=5m", calls)
        self.assertEqual([h["symbol"] for h in json.loads(text)["hits"]], ["M&M", "RELIANCE"])


class MarketChoice(Base):
    def test_config_market_and_flag(self):
        cfg = os.path.join(self.d, "config.json")
        with open(cfg, "w", encoding="utf-8") as fh:
            json.dump({"market": "IN"}, fh)
        # TRADER_MARKET is US in this process: the config's "market" wins over it
        code, text, _ = run(["orb", "--config", cfg, "--offline", WALL, "--now", "2026-10-29 10:00", "--json",
                             "--no-write"])
        self.assertEqual(json.loads(text)["as_of"], "2026-10-29 10:00 IST")
        code, text, _ = run(["orb", "--market", "US", "--config", cfg, "--offline", WALL,
                             "--now", "2026-10-29 10:00", "--no-write"])
        self.assertEqual(code, 1)          # the flag wins: New York clock, and no NSE bar sits in its session
        self.assertIn("Thu 2026-10-29 10:00 AM ET", text)
        code, _, err = run(["--market", "XX", "daily", "--symbols", "TCS"])
        self.assertEqual(code, 1)
        self.assertIn("unknown market", err)


if __name__ == "__main__":
    unittest.main()
