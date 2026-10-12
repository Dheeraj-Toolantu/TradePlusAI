import json
import unittest
from datetime import datetime, timezone

from tradepulse_quant.sentiment.corporate_events import (classify, client_class, deals_reading, parse_deals, parse_nse_events, split_event_headlines,
                                                         stock_events)

NOW = datetime(2026, 10, 12, 10, 0, tzinfo=timezone.utc)  # 15:30 IST


def snapshot(*rows):
    return json.dumps({"BLOCK_DEALS_DATA": [dict(zip(("symbol", "clientName", "buySell", "qty", "watp", "date"), row)) for row in rows], "BULK_DEALS_DATA": []})


class ClassifyTests(unittest.TestCase):
    def test_headline_categories(self):
        self.assertEqual(classify("HDFC Bank Q2 results: net profit rises 12%"), "RESULTS")
        self.assertEqual(classify("L&T bags order worth Rs 5,000 crore"), "ORDER_WIN")
        self.assertEqual(classify("Promoter sells 2% stake in Bharti Airtel via block deal"), "BLOCK_DEAL")
        self.assertEqual(classify("SEBI imposes penalty on Adani Enterprises"), "REGULATORY")
        self.assertEqual(classify("Infosys board approves buyback of Rs 18,000 crore"), "BUYBACK")
        self.assertEqual(classify("Jefferies upgrades Tata Steel, raises target price"), "RATING")
        self.assertIsNone(classify("Nifty ends flat in choppy trade"))

    def test_split_moves_event_headlines_out_of_news(self):
        news, events = split_event_headlines([{"title": "ITC Q2 results beat estimates"}, {"title": "ITC shares rise in early trade"}])
        self.assertEqual([item["title"] for item in news], ["ITC shares rise in early trade"])
        self.assertEqual(events[0]["category"], "RESULTS")


class DealTests(unittest.TestCase):
    def test_parses_snapshot_and_historical_formats(self):
        snap = parse_deals(snapshot(("BHARTIARTL", "Bharti Telecom Ltd", "SELL", 10000000, 1900, "12-Oct-2026")), "BLOCK")
        self.assertEqual(snap[0]["value_cr"], 1900.0)
        hist = json.dumps({"data": [{"BD_SYMBOL": "ITC", "BD_CLIENT_NAME": "SBI Mutual Fund", "BD_BUY_SELL": "BUY", "BD_QTY_TRD": "5,00,000", "BD_TP_WATP": "450.5", "BD_DT_DATE": "10-OCT-2026"}]})
        self.assertEqual(parse_deals(hist, "BULK")[0]["kind"], "BULK")
        self.assertEqual(parse_deals("<html>", "BLOCK"), [])

    def test_who_is_on_each_side(self):
        self.assertEqual(client_class("Bharti Telecom Limited", "Bharti Airtel"), "PROMOTER")
        self.assertEqual(client_class("SBI Mutual Fund", "ITC"), "INSTITUTION")
        self.assertEqual(client_class("Life Insurance Corporation of India", "ITC"), "INSTITUTION")
        self.assertEqual(client_class("Elara Mauritius Holdings", "ITC"), "STRATEGIC")
        self.assertEqual(client_class("Some Trader", "ITC"), "OTHER")

    def test_promoter_selling_is_bearish_institutional_buying_bullish(self):
        sell = parse_deals(snapshot(("BHARTIARTL", "Bharti Telecom Ltd", "SELL", 10000000, 1800, "12-Oct-2026"),
                                    ("BHARTIARTL", "Some Broker", "BUY", 10000000, 1800, "12-Oct-2026")), "BLOCK")
        reading = deals_reading(sell, "Bharti Airtel", 1900.0, NOW)
        self.assertLess(reading["score"], -30)
        self.assertEqual(reading["promoter_sell_cr"], 1800.0)
        buy = parse_deals(snapshot(("ITC", "HDFC Mutual Fund", "BUY", 1000000, 450, "12-Oct-2026"), ("ITC", "Random Trader", "SELL", 1000000, 450, "12-Oct-2026")), "BLOCK")
        self.assertGreater(deals_reading(buy, "ITC", 450.0, NOW)["score"], 30)


class StockEventTests(unittest.TestCase):
    def test_filings_actions_calendar_and_headlines(self):
        raws = {
            "large_deals": snapshot(("INFY", "Nippon India Mutual Fund", "BUY", 2000000, 1500, "12-Oct-2026"), ("INFY", "Random Trader", "SELL", 2000000, 1500, "12-Oct-2026")),
            "announcements": json.dumps([
                {"symbol": "INFY", "desc": "Bagging/Receiving of orders/contracts", "attchmntText": "Infosys wins large multi-year deal from a European bank", "an_dt": "12-Oct-2026 11:00:00"},
                {"symbol": "INFY", "desc": "Trading Window", "attchmntText": "Closure of trading window", "an_dt": "12-Oct-2026 09:00:00"},
                {"symbol": "INFY", "desc": "Outcome of Board Meeting", "attchmntText": "Old outcome", "an_dt": "01-Oct-2026 09:00:00"},
            ]),
            "actions": json.dumps([{"symbol": "INFY", "subject": "Buy Back of Shares", "exDate": "20-Oct-2026"}]),
            "calendar": json.dumps([{"symbol": "INFY", "purpose": "Financial Results", "bm_desc": "To consider Q2 results", "date": "16-Oct-2026"},
                                    {"symbol": "INFY", "purpose": "Financial Results", "bm_desc": "Next quarter", "date": "15-Jan-2027"}]),
        }
        nse = parse_nse_events(raws)
        headline = [{"title": "Infosys Q2 results: net profit jumps 15%, beats estimates", "source": "Moneycontrol", "age_hours": 1.0, "link": "x", "weight": 0.9, "category": "RESULTS"}]
        reading = stock_events("INFY", "Infosys", nse, headline, 1500.0, NOW)
        types = [event["type"] for event in reading["events"]]
        self.assertIn("DEALS", types)
        self.assertIn("ORDER_WIN", types)
        self.assertIn("BUYBACK", types)
        self.assertIn("RESULTS", types)
        self.assertEqual(len(reading["events"]), 4)  # trading window noise and the 11-day-old filing are ignored
        self.assertGreater(reading["score"], 30)
        self.assertEqual([row["date"] for row in reading["upcoming"]], ["2026-10-16"])
        self.assertTrue(any("Results due 2026-10-16" in note for note in reading["notes"]))
        self.assertIsNone(stock_events("ITC", "ITC", nse, [], 450.0, NOW)["score"])


if __name__ == "__main__":
    unittest.main()
