import unittest
from datetime import datetime, timedelta, timezone

from test_telegram_source import preview
from tradepulse_quant.sentiment import telegram_source
from tradepulse_quant.sentiment.telegram_scan import scan

NOW = datetime(2026, 10, 12, 10, 0, tzinfo=timezone.utc)


def fixtures():
    return {"telegram": {
        "chan_a": preview("chan_a", [("BUY NIFTY 24500 CE @120 TGT 150 SL 90", 1, "40K"), ("JACKPOT BUY TATASTEEL CMP 152 TGT 175", 2, "10K")]),
        "chan_b": preview("chan_b", [("Nifty 24500 call buy above 118 target 160 sl 95", 0.5, "15K"), ("Old: BUY NIFTY 24000 CE", 30, "1K")]),
        "chan_dead": "<html>This channel can't be displayed</html>",
    }}


class TelegramScanTests(unittest.TestCase):
    def test_fast_scan_shape(self):
        result = scan({"now": NOW.isoformat(), "spots": {"NIFTY": 24480}, "fixtures": fixtures()})
        self.assertEqual(result["options"]["top_pick"]["contract"], "NIFTY 24500 CE")
        self.assertEqual(result["options"]["top_pick"]["channel_count"], 2)
        self.assertEqual(result["stocks"]["TATASTEEL"]["buy_calls"], 1)
        self.assertEqual([post["channel"] for post in result["feed"]], ["chan_b", "chan_a", "chan_a"])  # newest first, 30 h-old dropped
        self.assertEqual(result["feed"][0]["options"], ["BUY NIFTY 24500 CE"])
        self.assertIn("TATASTEEL", result["feed"][2]["stocks"])
        dead = next(row for row in result["channels"] if row["id"] == "chan_dead")
        self.assertFalse(dead["ok"])

    def test_signature_changes_only_when_posts_change(self):
        first = scan({"now": NOW.isoformat(), "fixtures": fixtures()})["signature"]
        self.assertEqual(first, scan({"now": NOW.isoformat(), "fixtures": fixtures()})["signature"])
        more = fixtures()
        more["telegram"]["chan_c"] = preview("chan_c", [("BUY BANKNIFTY 54000 PE @250 TGT 300 SL 220", 0.1, "5K")])
        self.assertNotEqual(first, scan({"now": NOW.isoformat(), "fixtures": more})["signature"])

    def test_full_scan_reuses_a_fresh_channel_read(self):
        import tempfile

        with tempfile.TemporaryDirectory() as cache:
            items, row = telegram_source.fetch_channel("chan_a", NOW, cache_dir=cache, max_age_hours=8, raws=fixtures()["telegram"]["chan_a"])
            telegram_source.save_cache(cache, "telegram_chan_a", items, NOW)
            reused, reused_row = telegram_source.fetch_channel("chan_a", NOW + timedelta(seconds=60), cache_dir=cache, max_age_hours=8, reuse_seconds=180)
            self.assertTrue(reused_row.get("reused"))
            self.assertEqual(len(reused), len(items))


if __name__ == "__main__":
    unittest.main()
