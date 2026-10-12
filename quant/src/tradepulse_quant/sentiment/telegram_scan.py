"""Fast Telegram-only scan for live updates: channels, option-call consensus and per-stock calls.

stdin/stdout JSON entry point: ``python -m tradepulse_quant.sentiment.telegram_scan``.

The full index scan reads ~150 sources and runs every 10 minutes; Telegram tip channels move
minute by minute. This reads only the configured channels (one or two preview pages each, a few
seconds in total) so the web app can push fresh calls over WebSocket about once a minute. The full
scan then reuses these channel reads instead of fetching them again.

Payload keys (all optional): ``now`` (ISO), ``spots`` ({underlying or symbol: last price}, for
moneyness), ``channels`` (override list), ``fixtures`` ({telegram: {channel: raw page(s)}}),
``cache_dir``.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from .constituents import STOCKS
from .index_engine import MAX_AGE_HOURS, SOCIAL_HALF_LIFE_HOURS, alias_patterns, net_tone, text_items
from .telegram_options import consensus, parse_option_calls
from .telegram_source import configured_channels, fetch_channel, telegram_stats

BUDGET_SECONDS = 25.0
FEED_SIZE = 40


def scan(payload: dict | None = None) -> dict:
    payload = payload or {}
    try:
        now = datetime.fromisoformat(str(payload["now"]).replace("Z", "+00:00")) if payload.get("now") else datetime.now(timezone.utc)
    except ValueError:
        now = datetime.now(timezone.utc)
    fixtures = payload.get("fixtures")
    channels = payload.get("channels") or (list((fixtures.get("telegram") or {}).keys()) if fixtures is not None else configured_channels())
    cache_dir = payload.get("cache_dir") or (None if fixtures is not None else os.environ.get("SENTIMENT_CACHE_DIR") or os.path.join(tempfile.gettempdir(), "tradepulse-sentiment"))
    spots = {key: float(value) for key, value in (payload.get("spots") or {}).items() if isinstance(value, (int, float)) and value > 0}
    deadline = time.monotonic() + BUDGET_SECONDS

    def one(channel: str):
        raws = ((fixtures.get("telegram") or {}).get(channel) or []) if fixtures is not None else None
        return channel, fetch_channel(channel, now, cache_dir=cache_dir, max_age_hours=MAX_AGE_HOURS, deadline=deadline, raws=raws)

    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(one, channels))
    items = [item for _, (channel_items, _) in results for item in channel_items]
    health = [{"id": channel, **row} for channel, (_, row) in results]

    stocks = {}
    mentions_by_link: dict[str, list[str]] = {}
    for symbol in STOCKS:
        patterns = alias_patterns(symbol)
        matched = text_items(items, patterns, now, half_life=SOCIAL_HALF_LIFE_HOURS, require_mention=True)
        if not matched:
            continue
        stats = telegram_stats(matched, patterns)
        for item in matched:
            if item.get("call"):
                item["score"] = round(0.7 * item["call"] + 0.3 * item["score"], 3)
            mentions_by_link.setdefault(item["link"], []).append(symbol)
        stocks[symbol] = {**stats, "mood": net_tone(matched)}

    fresh = [item for item in items if item.get("published") and 0 <= (now - item["published"]).total_seconds() <= MAX_AGE_HOURS * 3600]
    fresh.sort(key=lambda item: item["published"], reverse=True)
    feed = [{
        "channel": item["source"].removeprefix("Telegram @"), "text": (item.get("body") or item["title"])[:280], "link": item["link"],
        "published": item["published"].isoformat(), "age_hours": round((now - item["published"]).total_seconds() / 3600.0, 2),
        "views": (item.get("engagement") or 0) * 200, "stocks": mentions_by_link.get(item["link"], [])[:4],
        "options": [f"{call['side']} {call['underlying']} {call['strike']:g} {call['type']}" for call in parse_option_calls(item.get("body") or item["title"])][:3],
    } for item in fresh[:FEED_SIZE]]
    # New posts and edited posts (channels often edit a call to add "target hit") both change it.
    signature = hashlib.sha1(json.dumps([[post["link"], post["text"]] for post in feed] + [row["ok"] for row in health]).encode()).hexdigest()[:16]
    return {
        "generated_at": now.isoformat(), "signature": signature, "window_hours": MAX_AGE_HOURS,
        "options": consensus(items, now, MAX_AGE_HOURS, spots), "stocks": stocks, "feed": feed, "channels": health,
    }


def main() -> None:
    raw = sys.stdin.read()
    print(json.dumps(scan(json.loads(raw) if raw.strip() else {}), default=str))


if __name__ == "__main__":
    main()
