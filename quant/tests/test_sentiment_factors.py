import json
import os
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from unittest import mock
from urllib.error import HTTPError

from tradepulse_quant.sentiment import engine
from tradepulse_quant.sentiment.engine import analyze_sentiment, collect, reddit_candidates
from tradepulse_quant.sentiment.factors import (
    composites, market_factors, parse_breadth, parse_closes, parse_fear_greed, parse_fii_dii, parse_mmi, parse_stocktwits,
    score_breadth, score_fii_dii, score_index_trend, score_mood_index, score_volatility,
)

NOW = "2026-09-28T06:00:00+00:00"


def chart(closes, price=None, previous=None):
    """Yahoo v8 chart payload shape."""
    meta = {"regularMarketPrice": price if price is not None else closes[-1]}
    if previous is not None:
        meta["previousClose"] = previous
    return json.dumps({"chart": {"result": [{"meta": meta, "indicators": {"quote": [{"close": closes}]}}], "error": None}})


def rss(*titles, date="Mon, 28 Sep 2026 05:00:00 GMT"):
    items = "".join(f"<item><title>{t}</title><link>https://example.com/{i}</link><pubDate>{date}</pubDate></item>" for i, t in enumerate(titles))
    return f"<rss version='2.0'><channel><title>t</title>{items}</channel></rss>"


def reddit_json(*titles):
    return json.dumps({"data": {"children": [{"data": {"title": t, "selftext": "", "permalink": f"/r/x/{i}", "created_utc": 1790575200 + i, "score": 5, "num_comments": 1}} for i, t in enumerate(titles)]}})


FII_DII = json.dumps([
    {"category": "DII **", "date": "26-Sep-2026", "buyValue": "15,210.11", "sellValue": "12,010.40", "netValue": "3199.71"},
    {"category": "FII/FPI *", "date": "26-Sep-2026", "buyValue": "11,002.32", "sellValue": "16,410.02", "netValue": "-5407.70"},
])
ALL_INDICES = json.dumps({"data": [{"index": "NIFTY 50", "advances": "12", "declines": "38", "unchanged": "0"}, {"index": "NIFTY 500", "advances": "110", "declines": "385", "unchanged": "5"}]})
MMI = json.dumps({"success": True, "data": {"indicator": 22.4, "date": "2026-09-28T05:30:00.000Z"}})
FEAR_GREED = json.dumps({"fear_and_greed": {"score": 71.8, "rating": "greed", "timestamp": "2026-09-27T23:59:00+00:00", "previous_close": 69.1}})
STOCKTWITS = json.dumps({"messages": [{"entities": {"sentiment": {"basic": "Bullish"}}}] * 9 + [{"entities": {"sentiment": {"basic": "Bearish"}}}] * 3 + [{"entities": {"sentiment": None}}] * 4})


def falling_market_fixtures():
    rising_then_falling = [25_000 + 10 * i for i in range(40)] + [25_390 - 60 * i for i in range(10)]
    vix = [12.0] * 55 + [14.5, 16.8]
    return {
        "nifty": chart(rising_then_falling), "banknifty": chart([x * 2.2 for x in rising_then_falling]),
        "india_vix": chart(vix), "cboe_vix": chart([15.0] * 60 + [15.2]),
        "fii_dii": FII_DII, "breadth": ALL_INDICES, "tickertape_mmi": MMI, "cnn_fear_greed": FEAR_GREED, "stocktwits": STOCKTWITS,
    }


class ParserTests(unittest.TestCase):
    def test_yahoo_closes_and_previous_close(self):
        quote = parse_closes(chart([100.0, 101.0, 102.0], previous=101.0))
        self.assertEqual((quote["price"], quote["previous_close"]), (102.0, 101.0))
        # Without previousClose, the bar before today's close is used.
        self.assertEqual(parse_closes(chart([100.0, 101.0, 102.0]))["previous_close"], 101.0)
        self.assertIsNone(parse_closes("{}"))

    def test_index_trend_scores_direction(self):
        up = score_index_trend(parse_closes(chart([100 + i for i in range(30)])), "X")
        down = score_index_trend(parse_closes(chart([130 - i for i in range(30)])), "X")
        self.assertGreater(up["score"], 20)
        self.assertLess(down["score"], -20)

    def test_volatility_spike_is_bearish(self):
        spike = score_volatility(parse_closes(chart([12.0] * 60 + [16.0])), "VIX")
        calm = score_volatility(parse_closes(chart([16.0] * 60 + [12.0])), "VIX")
        self.assertLess(spike["score"], -50)
        self.assertGreater(calm["score"], 30)

    def test_nse_fii_dii_and_breadth(self):
        flows = parse_fii_dii(FII_DII)
        self.assertEqual((flows["fii"], flows["dii"]), (-5407.70, 3199.71))
        self.assertLess(score_fii_dii(flows)["score"], -30)  # heavy FII selling, partly absorbed by DIIs
        self.assertIn("FII -5,408 cr", score_fii_dii(flows)["value"])
        breadth = parse_breadth(ALL_INDICES)
        self.assertEqual(breadth, {"index": "NIFTY 500", "advances": 110, "declines": 385})
        self.assertLess(score_breadth(breadth)["score"], -60)
        self.assertIsNone(parse_fii_dii("<html>blocked</html>"))

    def test_mood_indices_and_stocktwits(self):
        self.assertEqual(parse_mmi(MMI), 22.4)
        self.assertIn("extreme fear", score_mood_index(22.4, "MMI")["value"])
        self.assertAlmostEqual(score_mood_index(22.4, "MMI")["score"], -55.2)
        self.assertEqual(parse_fear_greed(FEAR_GREED)["score"], 71.8)
        tags = parse_stocktwits(STOCKTWITS)
        self.assertEqual((tags["bullish"], tags["bearish"], tags["messages"]), (9, 3, 16))
        self.assertIsNone(parse_stocktwits(json.dumps({"messages": [{"entities": {}}] * 3})))  # too few tags


class CompositeTests(unittest.TestCase):
    def test_falling_market_reads_bearish_and_flags_extremes(self):
        factors = market_factors(falling_market_fixtures())
        by_id = {factor["id"]: factor for factor in factors}
        self.assertTrue(all(by_id[key]["ok"] for key in ("nifty_trend", "india_vix", "fii_dii", "breadth", "tickertape_mmi", "cnn_fear_greed", "stocktwits")))
        self.assertFalse(by_id["global_macro"]["ok"])  # no macro fixture: dropped, not zero
        result = composites(factors)
        self.assertIn(result["india"]["label"], ("BEARISH", "VERY_BEARISH"))
        self.assertEqual(result["india"]["coverage"], "5/5")
        self.assertIsNotNone(result["overall"]["score"])
        self.assertTrue(any("extreme fear" in note for note in result["notes"]))
        self.assertTrue(any("VIX" in note for note in result["notes"]))

    def test_unavailable_factors_drop_out_of_the_weights(self):
        factors = [
            {"id": "a", "group": "INDIA", "weight": 1.0, "ok": True, "score": 40.0},
            {"id": "b", "group": "INDIA", "weight": 3.0, "ok": True, "score": -20.0},
            {"id": "c", "group": "INDIA", "weight": 5.0, "ok": False, "score": None},
            {"id": "d", "group": "GLOBAL", "weight": 1.0, "ok": True, "score": 90.0},
        ]
        result = composites(factors)
        self.assertEqual(result["india"]["score"], -5.0)  # (40*1 - 20*3) / 4
        self.assertEqual(result["india"]["coverage"], "2/3")
        self.assertEqual(result["global"]["label"], "INSUFFICIENT_DATA")  # one factor is not a composite
        self.assertEqual(result["overall"]["score"], -5.0)  # only the India group is available

    def test_every_blocked_source_is_reported_not_fatal(self):
        factors = market_factors({})
        self.assertTrue(factors)
        self.assertTrue(all(not factor["ok"] and factor["error"] for factor in factors))
        self.assertEqual(composites(factors)["overall"]["label"], "INSUFFICIENT_DATA")


class RedditFetchTests(unittest.TestCase):
    URL = "https://www.reddit.com/r/StockMarketIndia/new.json?limit=50"

    def test_candidate_order(self):
        self.assertEqual(reddit_candidates(self.URL), [
            ("https://www.reddit.com/r/StockMarketIndia/new.json?limit=50", "json"),
            ("https://old.reddit.com/r/StockMarketIndia/new.json?limit=50", "json"),
            ("https://www.reddit.com/r/StockMarketIndia/new/.rss?limit=50", "rss"),
            ("https://old.reddit.com/r/StockMarketIndia/new/.rss?limit=50", "rss"),
        ])

    def test_blocked_www_falls_back_to_old_reddit(self):
        calls = []

        def fake_fetch(url, user_agent=engine.USER_AGENT, headers=None):
            calls.append((url, user_agent))
            if url.startswith("https://www.reddit.com"):
                raise HTTPError(url, 403, "Blocked", {}, None)
            return reddit_json("Nifty breakout, calls printing")

        with mock.patch.dict(os.environ, {"REDDIT_CLIENT_ID": "", "REDDIT_CLIENT_SECRET": ""}), mock.patch.object(engine, "_fetch", fake_fetch), mock.patch.object(engine.time, "sleep"):
            items = engine.fetch_reddit(self.URL)
        self.assertEqual(items[0]["title"], "Nifty breakout, calls printing")
        self.assertEqual([url.split("/r/")[0] for url, _ in calls], ["https://www.reddit.com", "https://old.reddit.com"])
        self.assertTrue(all(agent == engine.REDDIT_USER_AGENT and "tradepulse" in agent for _, agent in calls))

    def test_oauth_is_used_when_credentials_are_configured(self):
        calls = []

        def fake_fetch(url, user_agent=engine.USER_AGENT, headers=None):
            calls.append((url, headers))
            return reddit_json("Bank Nifty bulls in control")

        engine._reddit_token.clear()
        with mock.patch.dict(os.environ, {"REDDIT_CLIENT_ID": "id", "REDDIT_CLIENT_SECRET": "secret"}), mock.patch.object(engine, "_reddit_oauth_token", return_value="tok"), mock.patch.object(engine, "_fetch", fake_fetch):
            items = engine.fetch_reddit(self.URL)
        self.assertEqual(len(items), 1)
        self.assertEqual(calls[0][0], "https://oauth.reddit.com/r/StockMarketIndia/new?limit=50&raw_json=1")
        self.assertEqual(calls[0][1], {"Authorization": "bearer tok"})

    def test_subreddits_are_fetched_one_at_a_time(self):
        sources = [{"id": f"r{i}", "name": f"r/{i}", "kind": "reddit", "region": "INDIA", "audience": "RETAIL", "url": f"https://www.reddit.com/r/s{i}/new.json"} for i in range(4)]
        active = {"now": 0, "max": 0}
        lock = threading.Lock()

        def fake_reddit(url, deadline=None):
            with lock:
                active["now"] += 1
                active["max"] = max(active["max"], active["now"])
            threading.Event().wait(0.02)
            with lock:
                active["now"] -= 1
            return engine.parse_reddit(reddit_json("Nifty rally"))

        with mock.patch.object(engine, "fetch_reddit", fake_reddit), mock.patch.object(engine.time, "sleep"):
            items, health = collect(sources, None)
        self.assertEqual(active["max"], 1)
        self.assertEqual(len(items), 4)
        self.assertTrue(all(row["ok"] for row in health))


    def test_blocked_reddit_cannot_stall_the_scan(self):
        sources = [{"id": f"r{i}", "name": f"r/{i}", "kind": "reddit", "region": "INDIA", "audience": "RETAIL", "url": f"https://www.reddit.com/r/s{i}/new.json"} for i in range(6)]
        clock = {"t": 0.0}

        def blocked(url, deadline=None):
            clock["t"] += 10.0  # each blocked subreddit burns 10 s of attempts
            raise HTTPError(url, 403, "Blocked", {}, None)

        with mock.patch.object(engine, "fetch_reddit", blocked), mock.patch.object(engine.time, "sleep"), mock.patch.object(engine.time, "monotonic", lambda: clock["t"]):
            _, health = collect(sources, None)
        self.assertLessEqual(clock["t"], engine.REDDIT_BUDGET_SECONDS + 10.0)
        self.assertTrue(any("time budget" in (row["error"] or "") for row in health))
        self.assertTrue(all(not row["ok"] for row in health))


class CacheTests(unittest.TestCase):
    def test_failed_source_serves_its_last_good_scan(self):
        sources = [{"id": "news", "name": "News", "kind": "rss", "region": "INDIA", "audience": "NEWS", "url": "x"}]
        now = datetime.fromisoformat(NOW)
        with tempfile.TemporaryDirectory() as cache_dir:
            items, health = collect(sources, {"news": rss("Nifty surges to record high")}, cache_dir, now)
            self.assertEqual(len(items), 1)
            later = now.replace(hour=8)
            items, health = collect(sources, {}, cache_dir, later)  # live fetch now fails
            self.assertEqual(items[0]["title"], "Nifty surges to record high")
            self.assertTrue(health[0]["ok"])
            self.assertEqual(health[0]["cached_hours"], 2.0)
            self.assertIn("2.0 h ago", health[0]["note"])
            items, health = collect(sources, {}, cache_dir, now.replace(day=29))  # older than 12 h: dropped
            self.assertFalse(health[0]["ok"])
            self.assertEqual(items, [])


class EngineIntegrationTests(unittest.TestCase):
    def test_scan_returns_factors_and_composites(self):
        sources = [
            {"id": "news", "name": "News", "kind": "rss", "region": "INDIA", "audience": "NEWS", "url": "x"},
            {"id": "forum", "name": "Forum", "kind": "reddit", "region": "INDIA", "audience": "RETAIL", "url": "x"},
        ]
        result = analyze_sentiment({
            "now": NOW, "sources": sources,
            "fixtures": {"news": rss("Nifty plunges as FII selling deepens", "Sensex crashes 900 points", "Market sell-off widens", "Bank Nifty slumps", "Fear grips Dalal Street"),
                         "forum": reddit_json("Puts printing, Nifty crash", "Bloodbath today", "Stop loss hit again", "Bears in control", "Nifty breakdown confirmed")},
            "factor_fixtures": falling_market_fixtures(),
        })
        ids = {factor["id"] for factor in result["factors"]}
        self.assertTrue({"nifty_trend", "india_vix", "fii_dii", "breadth", "global_macro", "india_news", "india_forums", "tickertape_mmi"} <= ids)
        self.assertIn(result["composite"]["india"]["label"], ("BEARISH", "VERY_BEARISH"))
        self.assertIn(result["composite"]["retail"]["label"], ("BEARISH", "VERY_BEARISH"))
        self.assertIn(result["composite"]["overall"]["label"], ("BEARISH", "VERY_BEARISH"))
        self.assertIn("Composites add market data", result["method"])

    def test_offline_scan_without_factor_fixtures_never_touches_the_network(self):
        with mock.patch("urllib.request.urlopen", side_effect=AssertionError("network used")):
            result = analyze_sentiment({"now": NOW, "sources": [{"id": "news", "name": "News", "kind": "rss", "region": "INDIA", "audience": "NEWS", "url": "x"}], "fixtures": {"news": rss("Nifty flat")}})
        text_ids = {"india_news", "global_news", "india_forums", "global_forums"}
        market = [factor for factor in result["factors"] if factor["id"] not in text_ids]
        self.assertGreaterEqual(len(market), 10)
        self.assertTrue(all(not factor["ok"] for factor in market))


if __name__ == "__main__":
    unittest.main()
