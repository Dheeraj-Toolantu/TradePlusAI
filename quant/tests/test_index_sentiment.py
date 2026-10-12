import json
import unittest
from datetime import datetime, timedelta, timezone

from tradepulse_quant.sentiment.constituents import INDICES, STOCKS
from tradepulse_quant.sentiment.index_engine import alias_patterns, analyze_indices, market_lenses, mentions, parse_chart, score_stock_text

NOW = datetime(2026, 10, 12, 10, 0, tzinfo=timezone.utc)  # 15:30 IST: session complete


def chart(day_pct: float, volume_mult: float = 1.0, close_at_high: bool = True, base: float = 100.0):
    """30 flat-ish daily bars, then today's bar moving ``day_pct`` on ``volume_mult`` x volume."""
    stamps, closes, highs, lows, opens, volumes = [], [], [], [], [], []
    start = NOW - timedelta(days=30)
    for index in range(30):
        price = base * (1 + (0.004 if index % 2 else -0.004))
        stamps.append(int((start + timedelta(days=index)).timestamp()))
        closes.append(price), highs.append(price * 1.005), lows.append(price * 0.995), opens.append(price), volumes.append(1_000_000)
    last = closes[-1] * (1 + day_pct / 100)
    stamps.append(int(NOW.timestamp()))
    span = abs(last - closes[-1]) + 0.5
    highs.append(max(last, closes[-1]) + (0 if close_at_high else span))
    lows.append(min(last, closes[-1]) - (span if close_at_high else 0))
    closes.append(last), opens.append(closes[-2]), volumes.append(1_000_000 * volume_mult)
    return json.dumps({"chart": {"result": [{"meta": {"regularMarketPrice": last}, "timestamp": stamps,
                                             "indicators": {"quote": [{"open": opens, "high": highs, "low": lows, "close": closes, "volume": volumes}]}}]}})


def rss(*titles):
    date = "Mon, 12 Oct 2026 08:00:00 GMT"
    items = "".join(f"<item><title>{title}</title><link>https://example.com/{index}</link><pubDate>{date}</pubDate></item>" for index, title in enumerate(titles))
    return f"<?xml version='1.0'?><rss version='2.0'><channel>{items}</channel></rss>"


def reddit(*titles):
    return json.dumps({"data": {"children": [{"data": {"title": title, "selftext": "", "permalink": f"/r/x/{i}", "created_utc": NOW.timestamp() - 3600, "score": 50, "num_comments": 10}} for i, title in enumerate(titles)]}})


class ConstituentTableTests(unittest.TestCase):
    def test_every_index_member_is_described(self):
        self.assertEqual(len(INDICES["NIFTY"]["weights"]), 50)
        self.assertEqual(len(INDICES["SENSEX"]["weights"]), 30)
        for spec in INDICES.values():
            for symbol in spec["weights"]:
                self.assertIn(symbol, STOCKS)

    def test_aliases_do_not_match_sibling_companies(self):
        sbi = alias_patterns("SBIN")
        self.assertTrue(mentions("SBI shares rally after Q2 numbers", sbi))
        self.assertFalse(mentions("SBI Life premium growth slows", sbi))
        self.assertFalse(mentions("HDFC Life jumps 4%", alias_patterns("HDFCBANK")))
        self.assertTrue(mentions("Reliance Industries hits record high", alias_patterns("RELIANCE")))
        self.assertFalse(mentions("Reliance Power falls", alias_patterns("RELIANCE")))
        self.assertFalse(mentions("Titanic exhibition", alias_patterns("TITAN")))


class LensTests(unittest.TestCase):
    def test_stock_language(self):
        self.assertGreater(score_stock_text("L&T bags order worth Rs 5,000 crore, brokerages raise target"), 0.3)
        self.assertLess(score_stock_text("IndusInd Bank falls after RBI probe, slippages rise"), -0.3)

    def test_accumulation_vs_distribution(self):
        up = market_lenses(parse_chart(chart(2.5, volume_mult=2.5)), NOW)
        down = market_lenses(parse_chart(chart(-2.5, volume_mult=2.5, close_at_high=False)), NOW)
        thin = market_lenses(parse_chart(chart(2.5, volume_mult=0.4)), NOW)
        self.assertGreater(up["price_score"], 40)
        self.assertGreater(up["volume_score"], 50)
        self.assertLess(down["volume_score"], -50)
        self.assertLess(thin["volume_score"], up["volume_score"])
        self.assertAlmostEqual(up["volume_ratio"], 2.5, places=1)

    def test_partial_session_volume_is_projected(self):
        early = NOW.replace(hour=4, minute=45)  # 10:15 IST, 60 of 375 minutes done
        lenses = market_lenses(parse_chart(chart(1.0, volume_mult=0.4)), early)
        self.assertGreater(lenses["volume_ratio"], 2.0)


class IndexTests(unittest.TestCase):
    def payload(self, **overrides):
        charts = {symbol: chart(1.5, 1.8) for symbol in STOCKS}
        charts["HDFCBANK"] = chart(-3.0, 2.5, close_at_high=False)
        charts["ICICIBANK"] = chart(-2.5, 2.2, close_at_high=False)
        charts["^NSEI"] = charts["NIFTY"] = chart(0.4)
        news = {
            "HDFCBANK:INDIA": rss("HDFC Bank shares slump as margins contract", "HDFC Bank falls on weak deposit growth", "HDFC Bank sell-off deepens"),
            "INFY:GLOBAL": rss("Infosys ADR jumps after deal win", "Infosys raises guidance, shares surge"),
        }
        forums = {"idx_india_forums": reddit(*["Infosys to the moon 🚀 calls printing"] * 1, "Infy breakout, bullish", "INFY rally strong buy")}
        base = {"now": NOW.isoformat(), "fixtures": {"charts": charts, "news": news, "forums": forums}}
        base.update(overrides)
        return base

    def test_full_scan_shape_and_drill_down(self):
        result = analyze_indices(self.payload())
        self.assertEqual([index["id"] for index in result["indices"]], ["NIFTY", "BANKNIFTY", "SENSEX"])
        nifty = result["indices"][0]
        self.assertEqual(nifty["coverage"]["stocks_total"], 50)
        self.assertEqual(nifty["coverage"]["stocks_scored"], 50)
        self.assertAlmostEqual(sum(stock["weight"] for stock in nifty["constituents"]), 100, places=0)
        hdfc = next(stock for stock in nifty["constituents"] if stock["symbol"] == "HDFCBANK")
        infy = next(stock for stock in nifty["constituents"] if stock["symbol"] == "INFY")
        self.assertLess(hdfc["score"], -30)
        self.assertIsNotNone(hdfc["components"]["news"])
        self.assertLess(hdfc["components"]["news"], 0)
        self.assertGreater(infy["score"], 30)
        self.assertGreater(infy["social_count"], 0)
        self.assertTrue(any("Distribution" in note for note in hdfc["notes"]))
        self.assertEqual(nifty["drivers"]["negative"][0]["symbol"], "HDFCBANK")

    def test_bank_nifty_follows_its_heavyweights(self):
        bank = analyze_indices(self.payload(indices=["BANKNIFTY"]))["indices"][0]
        self.assertEqual(len(bank["constituents"]), 14)
        # HDFC + ICICI are > 50% of the index: their selling outweighs a green broad bank pack.
        self.assertLess(bank["lenses"]["heavyweights"], bank["lenses"]["rest"])
        self.assertTrue(any("HDFC Bank" in note for note in bank["psychology"]))
        self.assertTrue(any("Broader constituents" in note for note in bank["psychology"]))

    def test_macro_overlay_and_missing_data(self):
        payload = self.payload(indices=["SENSEX"], market_context={"overall_score": -60})
        payload["fixtures"]["charts"].pop("TCS")
        sensex = analyze_indices(payload)["indices"][0]
        tcs = next(stock for stock in sensex["constituents"] if stock["symbol"] == "TCS")
        self.assertIsNone(tcs["score"])
        self.assertEqual(sensex["coverage"]["stocks_scored"], 29)
        self.assertAlmostEqual(sensex["score"], round(0.8 * sensex["constituent_score"] - 0.2 * 60, 1), places=1)
        self.assertEqual(sensex["macro_score"], -60)


if __name__ == "__main__":
    unittest.main()
