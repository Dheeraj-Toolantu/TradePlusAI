import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from tradepulse_quant.sentiment.index_engine import alias_patterns
from tradepulse_quant.sentiment.telegram_source import call_direction, configured_channels, oldest_id, parse_preview, telegram_stats, to_items

NOW = datetime(2026, 10, 12, 10, 0, tzinfo=timezone.utc)


def preview(channel, posts):
    """Minimal copy of the t.me/s/<channel> markup: one wrap per message."""
    blocks = []
    for number, (text, hours_ago, views) in enumerate(posts, start=100):
        stamp = (NOW - timedelta(hours=hours_ago)).isoformat()
        blocks.append(
            f'<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="{channel}/{number}">'
            f'<div class="tgme_widget_message_text js-message_text" dir="auto">{text}</div>'
            f'<div class="tgme_widget_message_footer"><span class="tgme_widget_message_views">{views}</span>'
            f'<a class="tgme_widget_message_date" href="https://t.me/{channel}/{number}"><time datetime="{stamp}" class="time">10:00</time></a></div></div></div>')
    return "<html><body><section class=\"tgme_channel_history\">" + "".join(blocks) + "</section></body></html>"


class ParseTests(unittest.TestCase):
    def test_parses_public_preview_markup(self):
        raw = preview("demo_calls", [("🔥 <b>BUY TATASTEEL</b><br/>CMP 152 TGT 160 SL 148", 1, "12.4K"), ("Market update: Nifty flat &amp; range-bound", 2, "980")])
        posts = parse_preview(raw)
        self.assertEqual(len(posts), 2)
        self.assertEqual(posts[0]["id"], "demo_calls/100")
        self.assertIn("BUY TATASTEEL\nCMP 152", posts[0]["text"])
        self.assertEqual(posts[0]["views"], 12400)
        self.assertEqual(posts[1]["text"], "Market update: Nifty flat & range-bound")
        self.assertEqual(posts[0]["published"], NOW - timedelta(hours=1))
        self.assertEqual(oldest_id(posts), 100)
        self.assertEqual(parse_preview("<html>blocked</html>"), [])

    def test_channel_config(self):
        with mock.patch.dict(os.environ, {"TELEGRAM_CHANNELS": "@chan_one, https://t.me/s/chan_two ,t.me/chan_three,bad name,chan_one"}):
            self.assertEqual(configured_channels(), ["chan_one", "chan_two", "chan_three"])
        with mock.patch.dict(os.environ, {"TELEGRAM_CHANNELS": ""}):
            self.assertEqual(configured_channels(), [])


class CallTests(unittest.TestCase):
    def test_explicit_calls_on_the_stock(self):
        steel = alias_patterns("TATASTEEL")
        self.assertEqual(call_direction("BUY TATASTEEL CMP 152 TGT 160 SL 148", steel), 1)
        self.assertEqual(call_direction("Sell Tata Steel fut below 150, target 140", steel), -1)
        self.assertEqual(call_direction("SHORT TATASTEEL @151", steel), -1)
        self.assertEqual(call_direction("BUY JSWSTEEL CMP 900", steel), 0)
        self.assertEqual(call_direction("Tata Steel results today", steel), 0)

    def test_stats_count_calls_hype_and_channels(self):
        steel = alias_patterns("TATASTEEL")
        items = to_items("a", parse_preview(preview("a", [("JACKPOT 🚀 BUY TATASTEEL CMP 152 TGT 175 operator stock", 1, "50K"), ("BUY TATASTEEL above 153 SL 149", 2, "20K")])))
        items += to_items("b", parse_preview(preview("b", [("SELL TATASTEEL tgt 145", 1, "5K")])))
        stats = telegram_stats(items, steel)
        self.assertEqual((stats["buy_calls"], stats["sell_calls"], stats["hype_posts"], stats["channels"]), (2, 1, 1, 2))


if __name__ == "__main__":
    unittest.main()
