import json
import unittest
from datetime import datetime, timedelta, timezone

from tradepulse_quant.sentiment.constituents import INDICES, STOCKS
from tradepulse_quant.sentiment.index_engine import (MAX_AGE_HOURS, alias_patterns, analyze_indices, market_lenses, mentions, orderflow_lens, parse_chart,
                                                     parse_trade_info, score_stock_text, source_tier, text_items)

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


def rss(*titles, date="Mon, 12 Oct 2026 08:00:00 GMT"):
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


def trade_info(buy, sell, delivery):
    return json.dumps({"marketDeptOrderBook": {"totalBuyQuantity": buy, "totalSellQuantity": sell,
                                               "bid": [{"price": 100, "quantity": 10, "orders": 4}], "ask": [{"price": 101, "quantity": 5, "orders": 2}]},
                       "securityWiseDP": {"deliveryToTradedQuantity": delivery}})


class FreshnessAndQualityTests(unittest.TestCase):
    def test_stale_and_undated_items_are_dropped(self):
        patterns = alias_patterns("INFY")
        raw = [
            {"title": "Infosys shares surge on deal win", "body": "", "link": "a", "published": NOW - timedelta(hours=2)},
            {"title": "Infosys rallies after upgrade", "body": "", "link": "b", "published": NOW - timedelta(hours=MAX_AGE_HOURS + 1)},
            {"title": "Infosys jumps in early trade", "body": "", "link": "c", "published": None},
        ]
        items = text_items(raw, patterns, NOW, half_life=3.0, require_mention=True)
        self.assertEqual([item["link"] for item in items], ["a"])

    def test_recent_news_outweighs_older_news(self):
        patterns = alias_patterns("INFY")
        raw = [{"title": "Infosys shares surge", "body": "", "link": "a", "published": NOW - timedelta(hours=1)},
               {"title": "Infosys shares climb higher", "body": "", "link": "b", "published": NOW - timedelta(hours=7)}]
        fresh, old = text_items(raw, patterns, NOW, half_life=3.0, require_mention=True)
        self.assertGreater(fresh["weight"], 3 * old["weight"])

    def test_publisher_quality_tiers(self):
        self.assertEqual(source_tier({"publisher": "Moneycontrol"}), "PREMIUM")
        self.assertEqual(source_tier({"link": "https://economictimes.indiatimes.com/x"}), "PREMIUM")
        self.assertEqual(source_tier({"publisher": "Random Stock Tips"}), "STANDARD")
        self.assertEqual(source_tier({"tier": "BLOG", "publisher": "Trade Brains"}), "BLOG")

    def test_order_book_buyers_vs_sellers(self):
        book = parse_trade_info(trade_info(300000, 100000, 62.0))
        self.assertEqual((book["bid_orders"], book["ask_orders"]), (4, 2))
        bullish = orderflow_lens(book, 1.2)
        self.assertEqual(bullish["buy_pct"], 75.0)
        self.assertGreater(bullish["orderflow_score"], 50)
        self.assertLess(orderflow_lens(parse_trade_info(trade_info(100000, 300000, 62.0)), -1.2)["orderflow_score"], -50)
        # Outside market hours NSE reports zero pending quantity: no reading, not a neutral one.
        self.assertIsNone(orderflow_lens(parse_trade_info(trade_info(0, 0, None)), 0.0)["orderflow_score"])
        self.assertIsNone(parse_trade_info("not json"))


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
        feeds = {"mc_buzzing": rss("Buzzing: ICICI Bank shares slide as selling pressure builds", "ITC rallies to record high"),
                 "et_stocks": rss("Old news: ITC crashes", date="Mon, 12 Oct 2026 00:30:00 GMT")}
        books = {"HDFCBANK": trade_info(150000, 450000, 58.0), "RELIANCE": trade_info(500000, 200000, 55.0)}
        base = {"now": NOW.isoformat(), "fixtures": {"charts": charts, "news": news, "forums": forums, "feeds": feeds, "orderbook": books}}
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
        self.assertEqual(hdfc["headlines"][0]["tier"], "PREMIUM")
        self.assertLess(hdfc["components"]["news"], 0)
        self.assertGreater(infy["score"], 30)
        self.assertGreater(infy["social_count"], 0)
        self.assertTrue(any("Distribution" in note for note in hdfc["notes"]))
        self.assertEqual(nifty["drivers"]["negative"][0]["symbol"], "HDFCBANK")

    def test_quality_feeds_order_book_and_retail_roll_up(self):
        result = analyze_indices(self.payload(market_context={"mmi_score": -62, "mmi_value": "19 (extreme fear)"}))
        nifty = result["indices"][0]
        rows = {stock["symbol"]: stock for stock in nifty["constituents"]}
        itc = rows["ITC"]
        # The 9.5 h-old Economic Times item is outside the window; only the fresh Moneycontrol one counts.
        self.assertEqual(itc["news_count"], 1)
        self.assertEqual(itc["headlines"][0]["tier"], "PREMIUM")
        self.assertEqual(rows["HDFCBANK"]["orderflow"]["buy_pct"], 25.0)
        self.assertLess(rows["HDFCBANK"]["components"]["orderflow"], 0)
        self.assertEqual(nifty["orderflow"]["stocks_covered"], 2)
        self.assertEqual((nifty["orderflow"]["buyer_dominated"], nifty["orderflow"]["seller_dominated"]), (1, 1))
        self.assertEqual(nifty["retail"]["posts"], 3)
        self.assertEqual(nifty["retail"]["bullish"], 3)
        self.assertEqual(nifty["retail"]["most_discussed"][0]["symbol"], "INFY")
        self.assertEqual(nifty["freshness"]["max_age_hours"], MAX_AGE_HOURS)
        self.assertGreater(nifty["freshness"]["fresh_items"], 0)
        self.assertTrue(any("Market Mood Index is in extreme fear" in note for note in nifty["psychology"]))
        self.assertEqual({feed["id"] for feed in result["feeds"]} >= {"mc_buzzing", "et_stocks"}, True)

    def test_corporate_events_roll_up_to_the_index(self):
        payload = self.payload(indices=["NIFTY"])
        payload["fixtures"]["nse_events"] = {
            "large_deals": json.dumps({"BLOCK_DEALS_DATA": [
                {"symbol": "BHARTIARTL", "clientName": "Bharti Telecom Ltd", "buySell": "SELL", "qty": 10000000, "watp": 95, "date": "12-Oct-2026"},
                {"symbol": "BHARTIARTL", "clientName": "SBI Mutual Fund", "buySell": "BUY", "qty": 10000000, "watp": 95, "date": "12-Oct-2026"}], "BULK_DEALS_DATA": []}),
            "calendar": json.dumps([{"symbol": "HDFCBANK", "purpose": "Financial Results", "bm_desc": "Q2", "date": "14-Oct-2026"},
                                    {"symbol": "RELIANCE", "purpose": "Financial Results", "bm_desc": "Q2", "date": "16-Oct-2026"}]),
        }
        payload["fixtures"]["news"]["INFY:INDIA"] = rss("Infosys Q2 results: net profit jumps, beats estimates", "Infosys raises guidance as deal wins surge")
        nifty = analyze_indices(payload)["indices"][0]
        rows = {stock["symbol"]: stock for stock in nifty["constituents"]}
        self.assertIsNotNone(rows["BHARTIARTL"]["components"]["events"])
        self.assertEqual(rows["BHARTIARTL"]["events"]["deals"]["count"], 2)
        self.assertGreater(rows["INFY"]["components"]["events"], 20)
        self.assertIn("RESULTS", [event["type"] for event in rows["INFY"]["events"]["events"]])
        corporate = nifty["corporate"]
        self.assertEqual([row["symbol"] for row in corporate["upcoming"]], ["HDFCBANK", "RELIANCE"])
        self.assertGreater(corporate["reporting_weight_7d"], 20)
        self.assertEqual(corporate["deals"]["count"], 2)
        self.assertTrue(any("Earnings week" in note for note in nifty["psychology"]))
        self.assertIsNotNone(nifty["lenses"]["events"])

    def test_telegram_channels_feed_retail_mood_and_pump_alerts(self):
        from test_telegram_source import preview

        payload = self.payload(indices=["NIFTY"])
        payload["fixtures"]["telegram"] = {
            "demo_calls": preview("demo_calls", [("JACKPOT 🚀 BUY TATASTEEL CMP 152 TGT 175 operator stock", 1, "50K"), ("BUY TATASTEEL above 153 SL 149, sure shot", 2, "20K"),
                                                 ("BUY TATASTEEL tgt 170", 3, "18K"), ("Buy Tata Steel jackpot breakout stock", 4, "9K"), ("SELL ITC tgt 400 sl 430", 1, "7K"),
                                                 ("Old: BUY TATASTEEL", 30, "1K")]),
        }
        result = analyze_indices(payload)
        nifty = result["indices"][0]
        steel = next(stock for stock in nifty["constituents"] if stock["symbol"] == "TATASTEEL")
        telegram = steel["retail"]["telegram"]
        self.assertEqual((telegram["buy_calls"], telegram["sell_calls"]), (4, 0))  # the 30 h-old post is outside the window
        self.assertGreaterEqual(telegram["hype_posts"], 2)
        self.assertGreater(steel["social_raw"], 30)
        self.assertTrue(any("Telegram pump alert" in note for note in steel["notes"]))
        self.assertEqual(nifty["retail"]["telegram"]["most_tipped"][0]["symbol"], "TATASTEEL")
        self.assertEqual(nifty["retail"]["telegram"]["sell_calls"], 1)
        self.assertIn("telegram_demo_calls", {feed["id"] for feed in result["feeds"]})
        self.assertEqual(result["telegram_options"]["posts_scanned"], 5)
        self.assertEqual(result["telegram_options"]["calls_parsed"], 0)  # stock calls, no option contracts

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
