"""Public Telegram stock channels, read through Telegram's web preview (https://t.me/s/<channel>).

Indian retail trades on Telegram far more than on Reddit: tip channels post calls such as
"BUY TATASTEEL CMP 152 TGT 160 SL 148" to tens of thousands of followers. Read as a crowd
indicator, not as advice: heavy one-sided calls and hype words ("jackpot", "operator", "100%
sure", "multibagger") on a stock are a retail-euphoria (or pump) warning.

Only public channels are read, through the same preview page anyone sees without logging in; no
account, API key, private group or bot is involved. Channels: ``DEFAULT_CHANNELS`` unless
``TELEGRAM_CHANNELS`` (comma-separated usernames, with or without @ / t.me/) replaces them.
Each scan reads the latest page plus up to ``TELEGRAM_PAGES`` older pages per channel, so a
channel is a few requests per scan.

Many Indian tip channels are not SEBI-registered advisers; their calls are counted as crowd
mood only, never as signals to follow.
"""
from __future__ import annotations

import html
import os
import re
from datetime import datetime, timezone

MESSAGE = re.compile(r'<div class="tgme_widget_message[^"]*"[^>]*data-post="([^"]+)"(.*?)(?=<div class="tgme_widget_message_wrap|\Z)', re.S)
TEXT = re.compile(r'<div class="tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>', re.S)
TIME = re.compile(r'<time[^>]*datetime="([^"]+)"')
VIEWS = re.compile(r'<span class="tgme_widget_message_views">([^<]+)</span>')
TAG = re.compile(r"<[^>]+>")
PREVIEW_URL = "https://t.me/s/{channel}"

# "BUY RELIANCE", "Buy: TATA STEEL", "SELL HDFCBANK FUT", "SHORT INFY": the stock must follow the verb directly.
CALL = re.compile(r"\b(buy|sell|short|long|accumulate|add)\b[\s:\-]*(?:in\s+|on\s+)?", re.I)
LEVELS = re.compile(r"\b(tgt|target|sl|stop ?loss|cmp|entry)\b", re.I)
HYPE = re.compile(r"jackpot|operator|100 ?% ?(sure|profit|accuracy)|multibagger|sure ?shot|rocket|bumper|don'?t miss|guaranteed|upper circuit|blast|breakout stock|hero ?zero|zero ?hero", re.I)


# Public Indian index/options tip channels chosen by the operator; TELEGRAM_CHANNELS replaces the list.
DEFAULT_CHANNELS = [
    "nifty50dominator", "TradeOps_Intraday_Options_Nifty", "Stockgainerss", "PowerOfStocks", "Nifty",
    "rvsoption", "stockpro_online", "OptionsTrading_Stocks_Index", "stockmantraindex", "Stock_guru123",
]


def configured_channels() -> list[str]:
    raw = os.environ.get("TELEGRAM_CHANNELS")
    if raw is None or not raw.strip():
        return list(DEFAULT_CHANNELS)
    names = []
    for part in raw.split(","):
        name = part.strip().removeprefix("https://").removeprefix("http://").removeprefix("t.me/s/").removeprefix("t.me/").lstrip("@").strip("/")
        if re.fullmatch(r"[A-Za-z0-9_]{4,64}", name):  # Telegram usernames are 5-32 chars; be lenient
            names.append(name)
    return list(dict.fromkeys(names))


def pages() -> int:
    try:
        return max(1, min(5, int(os.environ.get("TELEGRAM_PAGES", "2"))))
    except ValueError:
        return 2


def _views(text: str | None) -> int:
    if not text:
        return 0
    value = text.strip().upper().replace(",", "")
    scale = 1_000_000 if value.endswith("M") else 1_000 if value.endswith("K") else 1
    try:
        return int(float(value.rstrip("MK")) * scale)
    except ValueError:
        return 0


def _clean(fragment: str) -> str:
    text = re.sub(r"[ \t]+", " ", html.unescape(TAG.sub(" ", re.sub(r"<br\s*/?>", "\n", fragment))))
    return re.sub(r" *\n *", "\n", text).strip()


def parse_preview(raw: str) -> list[dict]:
    """t.me/s/<channel> HTML -> [{id, text, published, views, link}] (oldest first, as the page lists them)."""
    posts = []
    for post_id, block in MESSAGE.findall(raw or ""):
        text_match, time_match = TEXT.search(block), TIME.search(block)
        if not text_match:
            continue
        text = _clean(text_match.group(1))
        try:
            published = datetime.fromisoformat(time_match.group(1).replace("Z", "+00:00")) if time_match else None
        except ValueError:
            published = None
        if published and published.tzinfo is None:
            published = published.replace(tzinfo=timezone.utc)
        posts.append({"id": post_id, "text": text, "published": published, "views": _views((VIEWS.search(block) or [None, None])[1] if VIEWS.search(block) else None),
                      "link": f"https://t.me/{post_id}"})
    return posts


def oldest_id(posts: list[dict]) -> int | None:
    ids = [int(post["id"].rsplit("/", 1)[-1]) for post in posts if post["id"].rsplit("/", 1)[-1].isdigit()]
    return min(ids) if ids else None


def to_items(channel: str, posts: list[dict]) -> list[dict]:
    """Forum-shaped items for the sentiment engine (engagement from views, scaled like upvotes)."""
    items = []
    for post in posts:
        first_line = post["text"].split("\n", 1)[0]
        items.append({
            "title": first_line[:200] or post["text"][:200], "body": post["text"][:600], "link": post["link"], "published": post["published"],
            "engagement": post["views"] // 200, "source": f"Telegram @{channel}", "region": "INDIA", "telegram": True, "tier": "TELEGRAM",
        })
    return items


def call_direction(text: str, patterns: list[re.Pattern]) -> int:
    """+1 for a buy/long call on the stock, -1 for sell/short, 0 if no explicit call names it."""
    lowered = text.lower()
    for match in CALL.finditer(lowered):
        window = lowered[match.end():match.end() + 40]
        if any((found := pattern.search(window)) and found.start() <= 1 for pattern in patterns):
            return -1 if match.group(1).lower() in ("sell", "short") else 1
    return 0


def telegram_stats(items: list[dict], patterns: list[re.Pattern]) -> dict:
    """Calls, hype and reach for one stock from the Telegram items that mention it."""
    buy = sell = hype = 0
    channels: set[str] = set()
    views = 0
    for item in items:
        if not item.get("telegram"):
            continue
        text = f"{item['title']}\n{item.get('body') or ''}"
        direction = call_direction(text, patterns)
        has_levels = bool(LEVELS.search(text))
        buy += direction > 0
        sell += direction < 0
        hype += bool(HYPE.search(text)) and direction >= 0
        channels.add(item["source"])
        views += (item.get("engagement") or 0) * 200
        item["call"] = direction
        item["has_levels"] = has_levels
    return {"posts": sum(1 for item in items if item.get("telegram")), "buy_calls": buy, "sell_calls": sell, "hype_posts": hype, "channels": len(channels), "views": views}
