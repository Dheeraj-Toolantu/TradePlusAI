import json
import unittest

from tradepulse_quant.sentiment.engine import analyze_sentiment, parse_reddit, parse_rss
from tradepulse_quant.sentiment.lexicon import event_flags, relevance, score_text

NOW = "2026-09-28T06:00:00+00:00"


def rss(*titles, date="Mon, 28 Sep 2026 05:00:00 GMT"):
    items = "".join(f"<item><title>{title}</title><link>https://example.com/{index}</link><pubDate>{date}</pubDate><description>&lt;p&gt;{title}&lt;/p&gt;</description></item>" for index, title in enumerate(titles))
    return f"<?xml version='1.0'?><rss version='2.0'><channel><title>t</title>{items}</channel></rss>"


def reddit(*posts):
    return json.dumps({"data": {"children": [{"data": {"title": title, "selftext": "", "permalink": f"/r/x/{index}", "created_utc": 1790575200 + index, "score": score, "num_comments": comments}} for index, (title, score, comments) in enumerate(posts)]}})


SOURCES = [
    {"id": "news", "name": "News", "kind": "rss", "region": "INDIA", "audience": "NEWS", "url": "x"},
    {"id": "forum", "name": "Forum", "kind": "reddit", "region": "INDIA", "audience": "RETAIL", "url": "x"},
    {"id": "global", "name": "Global", "kind": "rss", "region": "GLOBAL", "audience": "NEWS", "url": "x"},
    {"id": "down", "name": "Down", "kind": "rss", "region": "GLOBAL", "audience": "NEWS", "url": "x"},
]


class LexiconTests(unittest.TestCase):
    def test_market_phrases_and_slang(self):
        self.assertGreater(score_text("Nifty hits all-time high as FII buying continues 🚀"), 0.5)
        self.assertLess(score_text("Bloodbath on Dalal Street, Sensex crashes; puts printing"), -0.5)
        self.assertLess(score_text("Stop loss hit again, account wiped 😭"), -0.4)

    def test_negation_flips_polarity(self):
        self.assertLess(score_text("market is not bullish"), 0)
        self.assertGreater(score_text("no crash expected"), 0)

    def test_neutral_text_scores_zero(self):
        self.assertEqual(score_text("Quarterly results schedule announced"), 0)

    def test_relevance_and_events(self):
        self.assertEqual(relevance("Bank Nifty options expiry")[0], "INDEX")
        self.assertEqual(relevance("RBI keeps repo rate unchanged")[0], "INDIA_MACRO")
        self.assertEqual(relevance("Powell signals patience")[0], "GLOBAL_MACRO")
        self.assertIn("RBI policy", event_flags("All eyes on RBI policy tomorrow"))
        self.assertEqual(event_flags("New software award for fintech"), [])


class ParserTests(unittest.TestCase):
    def test_rss_and_atom(self):
        self.assertEqual(parse_rss(rss("Sensex rallies"))[0]["title"], "Sensex rallies")
        atom = "<feed xmlns='http://www.w3.org/2005/Atom'><entry><title>Nifty slips</title><link href='https://x/1'/><updated>2026-09-28T05:00:00Z</updated></entry></feed>"
        item = parse_rss(atom)[0]
        self.assertEqual((item["title"], item["link"]), ("Nifty slips", "https://x/1"))
        self.assertEqual(parse_rss("not xml"), [])

    def test_reddit_skips_stickied(self):
        raw = json.dumps({"data": {"children": [{"data": {"title": "Daily thread", "stickied": True}}, {"data": {"title": "Nifty to 26k", "score": 10, "num_comments": 5, "created_utc": 1790575200, "permalink": "/r/x/1"}}]}})
        items = parse_reddit(raw)
        self.assertEqual([item["title"] for item in items], ["Nifty to 26k"])
        self.assertEqual(items[0]["engagement"], 20)


class AggregationTests(unittest.TestCase):
    def run_with(self, news, forum, global_feed="", now=NOW):
        return analyze_sentiment({"now": now, "sources": SOURCES, "fixtures": {"news": news, "forum": forum, "global": global_feed or rss("Wall Street rallies on Fed rate cut hopes", "Nasdaq jumps", "Dow gains", "S&amp;P 500 record high", "Treasury yields fall")}})

    def test_bullish_retail_and_news(self):
        result = self.run_with(
            rss("Nifty surges to record high", "Sensex rallies 600 points as FIIs buy", "Bank Nifty breaks out", "Dalal Street optimism grows", "Nifty gains for fifth day"),
            reddit(("Nifty calls printing 🚀", 120, 40), ("Bulls in control, buy the dip", 50, 10), ("Bank Nifty to the moon", 80, 30), ("Nifty breakout confirmed", 20, 3), ("Green candle again, strong rally", 15, 2)),
        )
        self.assertEqual(result["summary"]["india"]["label"], "VERY_BULLISH")
        self.assertGreater(result["summary"]["india_retail"]["score"], 0)
        self.assertGreater(result["summary"]["global"]["score"], 0)
        self.assertTrue(result["top_bullish"])
        self.assertEqual(result["sources_ok"], 3)
        failed = next(source for source in result["sources"] if source["id"] == "down")
        self.assertFalse(failed["ok"])

    def test_divergence_between_retail_and_news(self):
        result = self.run_with(
            rss("Nifty plunges as FII selling deepens", "Sensex crashes 900 points", "Market sell-off widens", "Bank Nifty slumps", "Fear grips Dalal Street"),
            reddit(("Buy the dip, Nifty rally coming 🚀", 90, 20), ("Bullish on Bank Nifty", 40, 5), ("Calls printing tomorrow", 30, 5), ("Nifty to the moon", 20, 1), ("Strong support, bulls in control", 10, 1)),
        )
        self.assertIsNotNone(result["divergence"])

    def test_contrarian_warning_on_euphoric_crowd(self):
        posts = [(f"Nifty calls printing, bulls in control 🚀 #{index}", 50, 10) for index in range(20)]
        result = self.run_with(rss("Nifty flat"), reddit(*posts))
        self.assertIn("euphoric", result["contrarian_note"])

    def test_old_items_are_dropped_and_duplicates_merged(self):
        stale = rss("Nifty crashes", date="Mon, 21 Sep 2026 05:00:00 GMT")
        result = self.run_with(stale + "", reddit(("Nifty rally", 1, 0), ("Nifty rally", 1, 0)))
        self.assertEqual(result["summary"]["india_news"]["items"], 0)
        self.assertEqual(result["summary"]["india_retail"]["items"], 1)
        self.assertEqual(result["summary"]["india"]["label"], "INSUFFICIENT_DATA")

    def test_event_risk_needs_repeated_mentions(self):
        result = self.run_with(rss("RBI policy decision today; Nifty cautious", "Markets await RBI policy outcome", "Sensex flat"), reddit(("Nifty view", 1, 0)))
        self.assertEqual(result["event_risk"][0]["event"], "RBI policy")
        self.assertEqual(result["event_risk"][0]["mentions"], 2)


class ReviewRegressionTests(unittest.TestCase):
    """Defects seen on a live 700-point Sensex fall that the panel reported as neutral (-11)."""

    def test_direction_qualified_breakouts_score_bearish(self):
        self.assertLess(score_text("Titan Company Faces Downward Price Breakout"), 0)
        self.assertLess(score_text("Negative Breakout: These 10 stocks cross below their 200 DMAs"), 0)
        self.assertGreater(score_text("Nifty breakout confirmed"), 0)

    def test_short_tokens_need_word_boundaries(self):
        self.assertNotEqual(relevance("Company response to licence expense query")[0], "INDEX")
        self.assertEqual(relevance("NSE extends trading hours")[0], "INDEX")

    def test_single_stock_items_are_down_weighted(self):
        self.assertEqual(relevance("Prasol Chemicals standalone net profit rises 150.70% in the June 2026 quarter"), ("STOCK", 0.15))
        self.assertEqual(relevance("Nifty falls; Titan share price slips")[0], "INDEX")

    def test_google_news_publisher_suffix_is_not_scored(self):
        feed = ("<rss><channel><item><title>Stock Market Today: Five Key Factors For Sensex - NDTV Profit</title><link>https://x/1</link>"
                "<pubDate>Mon, 28 Sep 2026 05:00:00 GMT</pubDate><description>Stock Market Today: Five Key Factors For Sensex NDTV Profit</description>"
                "<source url='https://ndtvprofit.com'>NDTV Profit</source></item></channel></rss>")
        item = parse_rss(feed)[0]
        self.assertEqual(item["title"], "Stock Market Today: Five Key Factors For Sensex")
        self.assertEqual(score_text(item["title"]), 0)

    def test_neutral_headlines_do_not_dilute_a_clear_selloff(self):
        bearish = ["Stock Market Crash: Nifty breaches 22,600, Sensex slumps 700 points", "Nifty slumps below 23,000 as selling intensifies", "Sensex falls over 700 points, Nifty trades below 22,600", "Gift Nifty down 25 points; Sensex, Nifty eye weak start"]
        bullish = ["Nifty Pharma rises 1%"]
        neutral = [f"Sensex, Nifty: key factors to watch today #{index}" for index in range(8)]
        stocks = [f"Company {index} standalone net profit rises 20% in the June quarter" for index in range(6)]
        result = analyze_sentiment({"now": NOW, "sources": SOURCES[:1], "fixtures": {"news": rss(*(bearish + bullish + neutral + stocks))}})
        self.assertIn(result["summary"]["india"]["label"], ("BEARISH", "VERY_BEARISH"))
        self.assertTrue(all("net profit" not in item["title"] for item in result["top_bullish"][:1]))

    def test_reddit_rss_fallback_url(self):
        from tradepulse_quant.sentiment.engine import reddit_rss_url
        self.assertEqual(reddit_rss_url("https://www.reddit.com/r/IndianStreetBets/new.json?limit=75"), "https://www.reddit.com/r/IndianStreetBets/new/.rss?limit=75")


if __name__ == "__main__":
    unittest.main()
