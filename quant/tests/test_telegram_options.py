import unittest
from datetime import datetime, timedelta, timezone

from tradepulse_quant.sentiment.telegram_options import consensus, parse_option_calls, plan_odds

NOW = datetime(2026, 10, 12, 5, 0, tzinfo=timezone.utc)  # 10:30 IST


def post(channel, text, hours_ago=1.0, number=1):
    return {"telegram": True, "source": f"Telegram @{channel}", "title": text.split("\n")[0], "body": text, "published": NOW - timedelta(hours=hours_ago),
            "link": f"https://t.me/{channel}/{number}", "engagement": 50}


class ParseTests(unittest.TestCase):
    def test_common_call_formats(self):
        cases = {
            "BUY NIFTY 24500 CE @120 TGT 150/180 SL 90": ("NIFTY", 24500, "CE", "BUY", 120, 150, 90),
            "BANKNIFTY 54000 PE ABOVE 250 TARGET 300 STOPLOSS 220": ("BANKNIFTY", 54000, "PE", "BUY", 250, 300, 220),
            "Nifty 23 Oct 25000 call buy above 85 tgt 110 sl 70": ("NIFTY", 25000, "CE", "BUY", 85, 110, 70),
            "SELL BANK NIFTY 55000 CE at 140 target 90 sl 170": ("BANKNIFTY", 55000, "CE", "SELL", 140, 90, 170),
            "NIFTY\nBUY 24600 PE @ 95 TGT 130 SL 75": ("NIFTY", 24600, "PE", "BUY", 95, 130, 75),
            "RELIANCE 3000 CE buy above 42 tgt 55 sl 35": ("RELIANCE", 3000, "CE", "BUY", 42, 55, 35),
            "Sensex 81000CE @ 210 tgt 260 sl 180": ("SENSEX", 81000, "CE", "BUY", 210, 260, 180),
        }
        for text, expected in cases.items():
            call = parse_option_calls(text)[0]
            self.assertEqual((call["underlying"], call["strike"], call["type"], call["side"], call["entry"], call["target"], call["stop"]), expected, text)
        self.assertEqual(parse_option_calls("Nifty closed at 24500, good day"), [])

    def test_plan_odds(self):
        self.assertEqual(plan_odds("BUY", 120, 150, 90), 0.5)
        self.assertEqual(plan_odds("BUY", 100, 200, 90), round(10 / 110, 3))  # far target, tight stop: low odds
        self.assertEqual(plan_odds("SELL", 140, 90, 170), 0.375)
        self.assertIsNone(plan_odds("BUY", 120, None, 90))
        self.assertIsNone(plan_odds("BUY", 120, 110, 90))  # inconsistent levels


class ConsensusTests(unittest.TestCase):
    def test_ranks_by_channels_then_mentions(self):
        items = [
            post("chan_a", "BUY NIFTY 24500 CE @120 TGT 150 SL 90", 1, 1),
            post("chan_b", "Nifty 24500 call buy above 118 target 160 sl 95", 2, 2),
            post("chan_c", "NIFTY 24500 CE @ 125 tgt 150 sl 100", 0.5, 3),
            post("chan_a", "BANKNIFTY 54000 PE ABOVE 250 TARGET 300 STOPLOSS 220", 1, 4),
            post("chan_a", "BANKNIFTY 54000 PE @ 255 TGT 320 SL 225", 0.2, 5),
            post("chan_d", "NIFTY 24400 PE @ 80 TGT 120 SL 60", 1, 6),
            post("chan_d", "Old call NIFTY 24000 CE @ 300 tgt 350 sl 260", 30, 7),
            post("chan_e", "NIFTY 30000 CE @ 1 target 10", 1, 8),
            post("chan_a", "BUY NIFTY 24500 CE @120 TGT 150 SL 90", 1, 1),  # same post seen twice
        ]
        result = consensus(items, NOW, 8.0, {"NIFTY": 24480.0, "BANKNIFTY": 54300.0})
        top = result["top_pick"]
        self.assertEqual(top["contract"], "NIFTY 24500 CE")
        self.assertEqual((top["channel_count"], top["mentions"]), (3, 3))
        self.assertEqual((top["entry"], top["target"], top["stop"]), (120.0, 150.0, 95.0))  # medians
        self.assertAlmostEqual(top["plan_odds"], round(25 / 55, 3))
        self.assertTrue(top["otm"])
        self.assertEqual([row["contract"] for row in result["consensus"]], ["NIFTY 24500 CE", "BANKNIFTY 54000 PE", "NIFTY 24400 PE"])
        self.assertEqual(result["posts_scanned"], 8)  # the 30 h-old post is outside the window
        nifty = next(row for row in result["by_underlying"] if row["underlying"] == "NIFTY")
        self.assertEqual((nifty["ce_buys"], nifty["pe_buys"]), (3, 1))
        self.assertEqual(result["channels"][0]["channel"], "chan_a")

    def test_crowded_side_note(self):
        items = [post(f"c{i}", f"BUY NIFTY {24500 + 50 * (i % 3)} CE @ 100 TGT 140 SL 80", 1, i) for i in range(7)]
        result = consensus(items, NOW, 8.0, {"NIFTY": 24480.0})
        self.assertTrue(any("100% bullish on NIFTY" in note for note in result["notes"]))


if __name__ == "__main__":
    unittest.main()
