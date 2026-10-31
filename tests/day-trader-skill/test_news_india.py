"""trader-news in the Indian market (Google News + NSE filings, IST, INR), on synthetic fixtures."""

import datetime
import io
import json
import os
import tempfile
import unittest
import urllib.parse
from contextlib import redirect_stderr, redirect_stdout

from _load import FIX, load

news = load("trader-news", "news", market="IN")
DIR = os.path.join(FIX, "trader-news-in")
NOW = "2026-10-30 10:50"          # IST, no offset
UTC = datetime.timezone.utc


def raw(name):
    with open(os.path.join(DIR, name), "rb") as fh:
        return fh.read()


def run(args):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = news.main(["--market", "IN"] + args)
    return code, out.getvalue(), err.getvalue()


def names():
    return news.parse_equity_list(raw("EQUITY_L.csv").decode("utf-8"))


class Basics(unittest.TestCase):
    def test_india_is_active(self):
        self.assertEqual((news.MK.code, news.TZ), ("IN", "IST"))
        self.assertIs(news.KEYWORDS, news.KEYWORDS_IN)

    def test_ist_clock(self):
        utc = datetime.datetime(2026, 10, 30, 3, 45, tzinfo=UTC)
        self.assertEqual(news.to_eastern(utc), datetime.datetime(2026, 10, 30, 9, 15))
        self.assertEqual(news.eastern_offset(datetime.datetime(2026, 7, 1)), 5.5)
        self.assertEqual(news.parse_local_now("2026-10-30 10:50"), datetime.datetime(2026, 10, 30, 5, 20, tzinfo=UTC))
        self.assertEqual(news.parse_local_now("2026-10-30T10:50:00+05:30").hour, 5)

    def test_symbols(self):
        self.assertEqual(news.plain("reliance.ns"), "RELIANCE")
        self.assertEqual(news.yahoo_symbol("RELIANCE"), "RELIANCE.NS")
        self.assertEqual(news.url_symbol("M&M"), "M%26M.NS")

    def test_google_news_url(self):
        self.assertEqual(news.gnews_query("RELIANCE", "Reliance Industries Limited"),
                         '"Reliance Industries" OR RELIANCE.NS')
        self.assertEqual(news.gnews_query("ZZZZ"), "ZZZZ.NS")
        url = news.gnews_url("M&M", "Mahindra & Mahindra Limited")
        self.assertTrue(url.startswith("https://news.google.com/rss/search?q="))
        self.assertTrue(url.endswith("&hl=en-IN&gl=IN&ceid=IN:en"))
        q = url.split("q=")[1].split("&hl=")[0]
        self.assertNotIn("&", q)
        self.assertEqual(urllib.parse.unquote(q), '"Mahindra & Mahindra" OR M&M.NS')


class Names(unittest.TestCase):
    def test_equity_list_as_published(self):
        n = names()
        self.assertEqual(n["RELIANCE"], "Reliance Industries Limited")
        self.assertEqual(n["M&M"], "Mahindra & Mahindra Limited")
        self.assertEqual(n["BAJAJ-AUTO"], "Bajaj Auto Limited")
        with self.assertRaises(news.NewsError):
            news.parse_equity_list("A,B\n1,2\n")

    def test_override_file_wins_then_watchlist_then_equity_list(self):
        with tempfile.TemporaryDirectory() as d:
            nf = os.path.join(d, "names.json")
            with open(nf, "w") as fh:
                json.dump({"tcs.ns": "TCS Override Limited"}, fh)
            watch = {"TCS": None, "RELIANCE": "Reliance (from the watchlist)", "INFY": None, "NOPE": None}
            errors = []
            f = news.Fetcher(None, offline=DIR)
            news.company_names(watch, f, nf, os.path.join(d, "none.csv"), errors)
            self.assertEqual(watch["TCS"], "TCS Override Limited")
            self.assertEqual(watch["RELIANCE"], "Reliance (from the watchlist)")
            self.assertEqual(watch["INFY"], "Infosys Limited")
            self.assertIsNone(watch["NOPE"])
            self.assertTrue(any("no company name for NOPE" in e for e in errors))

    def test_equity_list_is_fetched_and_cached_once(self):
        class Fake(news.Fetcher):
            calls = []

            def get(self, url, name, sec=False, ua=None):
                self.calls.append((url, ua))
                return raw("EQUITY_L.csv")
        with tempfile.TemporaryDirectory() as d:
            cache = os.path.join(d, "cache", "EQUITY_L.csv")
            f = Fake(None)
            self.assertEqual(news.load_equity_list(f, cache)["TCS"], "Tata Consultancy Services Limited")
            self.assertTrue(os.path.isfile(cache))
            news.load_equity_list(f, cache)
            self.assertEqual(len(Fake.calls), 1)
            self.assertEqual(Fake.calls[0][0], "https://archives.nseindia.com/content/equities/EQUITY_L.csv")
            self.assertIn("Chrome", Fake.calls[0][1])


class Feeds(unittest.TestCase):
    def test_google_news_rss(self):
        items = news.parse_gnews(raw("gnews-RELIANCE.xml"), "RELIANCE")
        self.assertEqual(len(items), 6)
        first = items[0]
        self.assertEqual(first["title"], "Synthetic: RIL shares jump 3% after Q2 numbers; brokerages raise price target")
        self.assertEqual(first["publisher"], "Moneycontrol")
        self.assertEqual(first["source"], "Google News")
        self.assertEqual(first["time"], datetime.datetime(2026, 10, 30, 4, 5, tzinfo=UTC))
        self.assertTrue(first["link"].startswith("https://news.google.com/rss/articles/"))
        self.assertEqual(first["summary"], "")

    def test_nse_feed_times_are_ist(self):
        self.assertEqual(news.parse_nse_time("29-Oct-2026 19:05:12"),
                         datetime.datetime(2026, 10, 29, 13, 35, 12, tzinfo=UTC))
        self.assertEqual(news.parse_nse_time("Thu, 29 Oct 2026 17:20:00 +0530").hour, 11)
        self.assertIsNone(news.parse_nse_time(""))
        raw_items = news.parse_nse_rss(raw("nse-announcements.xml"), "announcement")
        self.assertEqual(len(raw_items), 6)
        self.assertEqual(raw_items[0]["title"], "Reliance Industries Limited")

    def test_filings_match_by_company_name(self):
        n = names()
        watch = {t: n[t] for t in ("RELIANCE", "TCS", "M&M", "ZENTRA")}
        rawi = []
        for fname, label, _ in news.NSE_FEEDS:
            rawi += news.parse_nse_rss(raw(fname), label)
        items = news.match_filings(rawi, watch)
        got = sorted((i["ticker"], i["form"]) for i in items)
        self.assertEqual(got, [("M&M", "announcement"), ("M&M", "board meeting"),
                               ("RELIANCE", "announcement"), ("TCS", "announcement"),
                               ("TCS", "financial results"), ("ZENTRA", "announcement"),
                               ("ZENTRA", "announcement")])
        titles = [i["title"] for i in items]
        self.assertFalse(any("Transmission" in t for t in titles))        # a longer name is another company
        self.assertIn("Zentra Power Limited, announcement: Disclosure under SEBI (SAST) Regulations", titles)
        self.assertIn("Mahindra and Mahindra Ltd., board meeting: To consider a bonus issue and a stock split "
                      "(synthetic)", titles)
        rel = [i for i in items if i["ticker"] == "RELIANCE"][0]
        self.assertTrue(rel["title"].startswith("Reliance Industries Limited, announcement: Outcome of Board Meeting"))
        self.assertEqual(rel["source"], "NSE")
        self.assertTrue(rel["id"].startswith("nse:https://nsearchives.nseindia.com/corporate/"))

    def test_name_regex(self):
        rx = news.name_regex("TATAMOTORS", "Tata Motors Limited")
        self.assertTrue(rx.match("Tata Motors Limited has informed the Exchange"))
        self.assertTrue(rx.match("Tata Motors - Outcome"))
        self.assertTrue(rx.match("TATAMOTORS: Outcome"))
        self.assertFalse(rx.match("Tata Motors Finance Limited"))


class Tags(unittest.TestCase):
    def item(self, title, summary=""):
        return {"id": title, "source": "Google News", "kind": "headline", "ticker": "RELIANCE",
                "title": title, "summary": summary, "link": "", "time": None}

    def test_india_tags(self):
        cases = {
            "Board meeting outcome: Q2 results, interim dividend and 1:1 bonus": ["results", "board meeting",
                                                                                  "dividend", "bonus"],
            "Stock split and buyback approved": ["split", "buyback"],
            "Rights issue opens on Monday": ["rights issue"],
            "SEBI passes order against the company over disclosure lapses": ["sebi order", "regulatory"],
            "Promoter sells 2% stake in a block deal": ["block/bulk deal", "promoter"],
            "Promoters pledge shares": ["pledge", "promoter"],
            "ICRA upgrades the credit rating to AA+": ["credit rating"],
            "Disclosure under SEBI (PIT) regulations; trading window closed": ["insider/pit"],
            "Sensex, Nifty fall as RBI keeps the repo rate unchanged": ["macro"],
            "NCLT admits insolvency plea": ["legal"],
        }
        for title, want in cases.items():
            tags = news.tag([self.item(title)], {"RELIANCE": "Reliance Industries Limited"})[0]["tags"]
            for t in want:
                self.assertIn(t, tags, title)

    def test_touches(self):
        watch = {"RELIANCE": "Reliance Industries Limited", "TCS": "Tata Consultancy Services Limited",
                 "M&M": "Mahindra & Mahindra Limited"}
        it = news.tag([self.item("Reliance Industries and TCS lead; M&M (M&M) flat; NSE: RELIANCE")], watch)[0]
        self.assertEqual(it["touches"], ["M&M", "RELIANCE", "TCS"])
        it = news.tag([self.item("Tatas cut costs")], watch)[0]
        self.assertEqual(it["touches"], ["RELIANCE"])


class Check(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = os.path.join(self.tmp.name, "state", "news.json")
        none = os.path.join(self.tmp.name, "none.json")
        self.base = ["--offline", DIR, "--state", self.state, "--now", NOW, "--portfolio", none,
                     "--watchlist", none, "--plan", none, "--names", os.path.join(DIR, "none.json"),
                     "--equity-list", os.path.join(self.tmp.name, "EQUITY_L.csv")]

    def tearDown(self):
        self.tmp.cleanup()

    def test_morning_briefing(self):
        code, out, err = run(["--tickers", "RELIANCE.NS", "TCS", "M&M", "ZENTRA"] + self.base)
        self.assertEqual(code, 0, err)
        self.assertIn("RELIANCE ₹3,011.20 +3.30% vs yesterday's close ₹2,915.00 at 10:50 IST  MOVING", out)
        self.assertIn("TCS    ₹3,150.00 -0.94% vs yesterday's close ₹3,180.00 at 10:50 IST", out)
        self.assertIn("! 2026-10-29 19:05 IST  RELIANCE    NSE", out)
        self.assertIn("! 2026-10-29 16:45 IST  TCS         NSE           Tata Consultancy Services Limited, "
                      "financial results", out)
        self.assertIn("! 2026-10-30 09:30 IST  M&M", out)
        self.assertIn("2026-10-30 09:35 IST  RELIANCE    Google News", out)
        self.assertIn("via Moneycontrol", out)
        self.assertNotIn("afternoon trade", out)          # published after the pinned 10:50 clock
        self.assertNotIn("annual general meeting", out)   # older than 48 hours
        self.assertNotIn("Trading window", out)
        self.assertNotIn("SEC", out.replace("SEBI", ""))  # no SEC user-agent note in India
        self.assertIn("Checked 2026-10-30 10:50 IST", out)
        self.assertIn("Not financial advice", out)
        self.assertNotIn(chr(0x2014), out)
        code, out, _ = run(["--tickers", "RELIANCE", "TCS", "M&M", "ZENTRA"] + self.base)
        self.assertEqual(code, 1)
        self.assertIn("Nothing new.", out)

    def test_json_and_newest_first(self):
        code, out, err = run(["--tickers", "RELIANCE", "TCS", "--json", "--dry-run"] + self.base)
        self.assertEqual(code, 0, err)
        doc = json.loads(out)
        self.assertEqual((doc["market"], doc["tz"], doc["currency"]), ("IN", "IST", "INR"))
        self.assertEqual(doc["names"]["TCS"], "Tata Consultancy Services Limited")
        times = [i["time"] for i in doc["items"]]
        self.assertEqual(times, sorted(times, reverse=True))
        self.assertTrue(all(i["local_time"].endswith(" IST") for i in doc["items"]))
        self.assertEqual(sorted(m["ticker"] for m in doc["moves"]), ["RELIANCE", "TCS"])
        self.assertTrue([m for m in doc["moves"] if m["ticker"] == "RELIANCE"][0]["moving"])
        self.assertFalse(os.path.exists(self.state))

    def test_yahoo_dedupes_with_google_news(self):
        code, out, err = run(["--tickers", "RELIANCE", "--yahoo", "--no-filings", "--no-moves", "--json",
                              "--dry-run"] + self.base)
        self.assertEqual(code, 0, err)
        items = json.loads(out)["items"]
        q2 = [i for i in items if "Q2 results" in i["title"]]
        self.assertEqual(len(q2), 1)
        self.assertTrue(any(i["source"] == "Yahoo Finance" and "bulk deal" in i["title"] for i in items))
        self.assertFalse(any(i["source"] == "NSE" for i in items))

    def test_tickers_from_the_watchlist(self):
        wl = os.path.join(self.tmp.name, "watchlist.json")
        with open(wl, "w") as fh:
            json.dump({"created_by": "trader-scanner", "market": "IN",
                       "hits": [{"symbol": "ZENTRA.NS", "setups": ["orb"]}]}, fh)
        args = list(self.base)
        args[args.index("--watchlist") + 1] = wl
        code, out, err = run(["--json", "--dry-run"] + args)
        self.assertEqual(code, 0, err)
        doc = json.loads(out)
        self.assertEqual(doc["names"], {"ZENTRA": "Zentra Power Limited"})
        tags = [t for i in doc["items"] for t in i["tags"]]
        for t in ("sebi order", "pledge", "promoter", "insider/pit"):
            self.assertIn(t, tags)
        self.assertTrue(all(i["important"] for i in doc["items"]))

    def test_us_still_one_flag_away(self):
        try:
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = news.main(["--market", "US", "--tickers", "TSLA", "--hours", "6", "--no-sec",
                                  "--no-moves", "--dry-run", "--now", "2026-10-19T10:15:00-04:00",
                                  "--offline", os.path.join(FIX, "trader-news"),
                                  "--state", self.state])
            self.assertEqual(code, 0, err.getvalue())
            self.assertIn("2026-10-19 08:04 ET  TSLA", out.getvalue())
        finally:
            news.apply_market(news.market.get("IN"))


RW = os.path.join(DIR, "realworld")


class RealWorldVariants(unittest.TestCase):
    """Probe inputs shaped like the live Google News and NSE feeds (fixtures/trader-news-in/realworld)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = os.path.join(self.tmp.name, "news.json")
        none = os.path.join(self.tmp.name, "none.json")
        self.base = ["--offline", RW, "--state", self.state, "--now", "2026-10-31T19:00:00+05:30",
                     "--hours", "72", "--no-moves", "--portfolio", none, "--watchlist", none,
                     "--plan", none, "--names", none, "--equity-list", os.path.join(RW, "EQUITY_L.csv")]

    def tearDown(self):
        self.tmp.cleanup()

    def item(self, title):
        return {"id": title, "source": "Google News", "kind": "headline", "ticker": "RELIANCE",
                "title": title, "summary": "", "link": "", "time": None}

    def tags(self, title):
        return news.tag([self.item(title)], {"RELIANCE": "Reliance Industries Limited"})[0]["tags"]

    def test_common_words_are_not_tags(self):
        cases = {
            "As a result of the rally, Sensex hits record": "results",
            "Pat Cummins joins Jio ad campaign": "results",
            "Ambani says the deal pit stop is over": "insider/pit",
            "Reliance sets up hackathon for startups": "risk",
            "Ambani will default to growth": "risk",
            "Jio offers Diwali bonus data pack": "bonus",
            "New split screen feature on JioTV": "split",
        }
        for title, tag in cases.items():
            self.assertNotIn(tag, self.tags(title), title)

    def test_true_positives_stay(self):
        cases = {
            "Q2FY27 PAT up 9%; board recommends 1:1 bonus issue and stock split": ["results", "bonus", "split"],
            "Q2 FY27 earnings beat estimates": ["results"],
            "Quarterly results on Friday": ["results"],
            "Unit hacked in cyber attack": ["risk"],
            "Group firm defaults on loan; payment default flagged": ["risk"],
            "Data breach at the telecom arm": ["risk"],
            "Bonus shares in the ratio 1:1": ["bonus"],
            "Sub-division of equity shares approved": ["split"],
            "Disclosure under SEBI (PIT) Regulations": ["insider/pit"],
            "Insider trading probe": ["insider/pit"],
        }
        for title, want in cases.items():
            got = self.tags(title)
            for t in want:
                self.assertIn(t, got, title)

    def test_nse_times(self):
        ist = lambda s: news.parse_nse_time(s).isoformat()
        self.assertEqual(ist("2026-10-31 18:05:12"), "2026-10-31T12:35:12+00:00")
        self.assertEqual(ist("2026-10-31T18:05:12"), "2026-10-31T12:35:12+00:00")
        self.assertEqual(ist("31-Oct-2026 06:05:12 PM"), "2026-10-31T12:35:12+00:00")
        self.assertEqual(ist("31/10/2026 18:05:12"), "2026-10-31T12:35:12+00:00")
        self.assertEqual(ist("31-OCT-2026 18:05:12"), "2026-10-31T12:35:12+00:00")
        self.assertEqual(ist("Sat, 31 Oct 2026 12:35:12 GMT"), "2026-10-31T12:35:12+00:00")
        self.assertEqual(ist("2026-10-31T18:05:12+05:30"), "2026-10-31T12:35:12+00:00")

    def test_html_page_is_a_note_not_an_empty_feed(self):
        page = b"<HTML><HEAD>\n<TITLE>Access Denied</TITLE>\n</HEAD><BODY>You don't have permission</BODY></HTML>"
        with self.assertRaises(news.NewsError) as cm:
            news.parse_nse_rss(page, "announcement")
        self.assertIn("HTML page", str(cm.exception))
        self.assertEqual(news.parse_nse_rss(b'<rss version="2.0"><channel></channel></rss>', "x"), [])

    def test_lookalike_companies_and_no_repeated_name(self):
        code, out, err = run(["--tickers", "RELIANCE", "BAJAJ-AUTO", "M&M", "TCS", "--json", "--dry-run"]
                             + self.base)
        self.assertEqual(code, 0, err)
        filings = [i for i in json.loads(out)["items"] if i["source"] == "NSE"]
        self.assertEqual(sorted(i["ticker"] for i in filings), ["BAJAJ-AUTO", "M&M", "RELIANCE", "TCS"])
        titles = [i["title"] for i in filings]
        self.assertIn("Reliance Industries Limited, announcement: Analysts/Institutional Investor Meet/Con. "
                      "Call Updates", titles)
        self.assertIn("Tata Consultancy Services Limited, announcement: Buyback", titles)
        for t in titles:
            self.assertFalse(any(w in t for w in ("Infrastructure", "Power", "Finance", "Financial",
                                                  "Consumer", "Communications")), t)
            self.assertNotIn("has informed", t)

    def test_suppressed_duplicate_is_remembered_across_runs(self):
        args = ["--tickers", "RELIANCE", "--no-filings"] + self.base
        code, out, err = run(args)
        self.assertEqual(code, 0, err)
        self.assertIn("via The Economic Times", out)
        self.assertNotIn("articles/A6", out)        # the Mint copy of the same story is folded
        # next run: the ET copy has left the feed; the Mint copy must not come back as new
        alt = os.path.join(self.tmp.name, "feeds")
        os.makedirs(alt)
        for f in os.listdir(RW):
            with open(os.path.join(RW, f), encoding="utf-8") as fh:
                text = fh.read()
            if f == "gnews-RELIANCE.xml":
                text = "\n".join(l for l in text.splitlines() if "The Economic Times</title>" not in l)
            with open(os.path.join(alt, f), "w", encoding="utf-8") as fh:
                fh.write(text)
        args[args.index("--offline") + 1] = alt
        code, out, err = run(args)
        self.assertEqual(code, 1, out)
        self.assertIn("Nothing new", out)

    def test_empty_ticker_is_refused(self):
        code, out, err = run(["--tickers", ""] + self.base)
        self.assertEqual(code, 2)
        self.assertIn("empty ticker", err)


if __name__ == "__main__":
    unittest.main()
