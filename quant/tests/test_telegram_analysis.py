import unittest
from datetime import datetime, timezone

from test_telegram_source import preview
from tradepulse_quant.sentiment.telegram_analysis import analyse
from tradepulse_quant.sentiment.telegram_source import normalize_channels

NOW = datetime(2026, 10, 12, 10, 0, tzinfo=timezone.utc)


def fixtures():
    return {"telegram": {
        "chan_a": preview("chan_a", [("BUY NIFTY 24500 CE @120 TGT 150 SL 90", 1, "40K"), ("BUY BANKNIFTY 54000 PE @250 TGT 300 SL 220", 3, "5K"),
                                     ("BUY NIFTY 24400 PE @90 TGT 120 SL 70", 11, "2K")]),
        "chan_b": preview("chan_b", [("Nifty 24500 call buy above 118 target 160 sl 95", 0.5, "15K"), ("BUY NIFTY 24600 CE @80", 6, "3K"),
                                     ("Old: BUY NIFTY 24000 CE", 14, "1K")]),
        "chan_dead": "<html>This channel can't be displayed</html>",
    }}


class TelegramAnalysisTests(unittest.TestCase):
    def test_counts_puts_and_calls_in_the_window_and_ranks_top_five(self):
        result = analyse({"now": NOW.isoformat(), "channels": ["@chan_a", "https://t.me/chan_b", "chan_dead"], "spots": {"NIFTY": 24480, "BANKNIFTY": 54100}, "fixtures": fixtures()})
        self.assertEqual(result["window_hours"], 12)
        self.assertEqual((result["channels_requested"], result["channels_read"]), (3, 2))
        # 14 h-old call is outside the 12 h window.
        self.assertEqual(result["totals"]["calls"], 3)
        self.assertEqual(result["totals"]["puts"], 2)
        self.assertEqual(result["totals"]["put_call_ratio"], 0.67)
        self.assertEqual(result["top"][0]["contract"], "NIFTY 24500 CE")
        self.assertEqual(result["top"][0]["channel_count"], 2)
        self.assertLessEqual(len(result["top"]), 5)
        self.assertNotIn("channel_mentions", result["top"][0])
        self.assertEqual([row["type"] for row in result["top_puts"]], ["PE", "PE"])
        chan_a = next(row for row in result["channels"] if row["channel"] == "chan_a")
        self.assertEqual((chan_a["calls"], chan_a["puts"]), (1, 2))
        dead = next(row for row in result["channels"] if row["channel"] == "chan_dead")
        self.assertFalse(dead["ok"])

    def test_window_is_configurable(self):
        result = analyse({"now": NOW.isoformat(), "channels": ["chan_a", "chan_b"], "window_hours": 4, "fixtures": fixtures()})
        self.assertEqual((result["totals"]["calls"], result["totals"]["puts"]), (2, 1))

    def test_requires_channels(self):
        with self.assertRaises(ValueError):
            analyse({"channels": ["", "bad name!"]})

    def test_normalizes_channel_names(self):
        self.assertEqual(normalize_channels(["@Chan_A", "t.me/s/chan_a", "https://t.me/OtherOne/", "x"]), ["Chan_A", "OtherOne"])


if __name__ == "__main__":
    unittest.main()
