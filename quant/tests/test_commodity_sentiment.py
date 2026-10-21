import json
import unittest
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime

from tradepulse_quant.sentiment.commodity_engine import COMMODITIES, parse_chart, scan, score_headline

NOW = datetime(2026, 10, 21, 6, 0, tzinfo=timezone.utc)


def chart(closes, price=None, previous=None):
    meta = {"regularMarketPrice": price if price is not None else closes[-1], "previousClose": previous if previous is not None else closes[-2]}
    return json.dumps({"chart": {"result": [{"meta": meta, "indicators": {"quote": [{"close": closes}]}}]}})


def rss(titles):
    items = "".join(f"<item><title>{title}</title><link>https://example.com/{index}</link><pubDate>{format_datetime(NOW - timedelta(hours=hours))}</pubDate>"
                    f"<source>Reuters</source></item>" for index, (title, hours) in enumerate(titles))
    return f"<rss><channel>{items}</channel></rss>"


class CommoditySentimentTests(unittest.TestCase):
    def test_headlines_read_by_price_verbs(self):
        self.assertGreater(score_headline("Crude rises on supply fears"), 0)
        self.assertLess(score_headline("Oil slumps on demand worries"), 0)
        self.assertGreater(score_headline("Gold hits record high"), 0)
        self.assertLess(score_headline("Natural gas futures drop 5%"), 0)
        self.assertLess(score_headline("Gold slips as dollar firms up"), 0)
        self.assertGreater(score_headline("Silver rallies despite weak demand"), 0)

    def test_parse_chart_trend(self):
        quote = parse_chart(chart([80.0] * 15 + [82, 84, 86, 88, 90], previous=88))
        self.assertAlmostEqual(quote["change_pct"], 2.27, places=2)
        self.assertGreater(quote["five_day_pct"], 0)
        self.assertGreater(quote["vs_20dma_pct"], 0)
        self.assertIsNone(parse_chart("not json"))

    def test_scan_scores_crude_rally_as_bullish_crude_and_bearish_for_india(self):
        rising = chart([80.0] * 15 + [82, 84, 86, 88, 90], previous=88)
        falling = chart([2000.0] * 15 + [1990, 1980, 1970, 1960, 1940], previous=1960)
        fixtures = {
            "charts": {"BZ=F": rising, "GC=F": falling},
            "news": {"CRUDEOIL": rss([("Crude oil surges as OPEC cuts output", 1), ("Brent climbs to $90 on supply fears", 2), ("Oil prices jump", 3), ("Crude old news falls", 20)]),
                     "GOLD": rss([("Gold slips as dollar firms up", 1), ("Gold prices fall for third day", 2)])},
        }
        result = scan({"now": NOW.isoformat(), "fixtures": fixtures})
        rows = {row["id"]: row for row in result["commodities"]}
        self.assertEqual(set(rows), {spec["id"] for spec in COMMODITIES})
        crude = rows["CRUDEOIL"]
        self.assertGreater(crude["score"], 40)
        self.assertGreater(crude["lenses"]["news"], 0)
        self.assertLess(crude["india_impact"], 0)
        self.assertEqual(len(crude["headlines"]), 3)  # the 20 h-old headline is outside the window
        self.assertLess(rows["GOLD"]["score"], 0)
        self.assertIsNone(rows["SILVER"]["score"])
        self.assertEqual(rows["SILVER"]["label"], "NO_DATA")
        self.assertTrue(result["notes"])


if __name__ == "__main__":
    unittest.main()
