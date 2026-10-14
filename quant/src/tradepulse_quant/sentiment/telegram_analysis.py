"""Put / call analysis of user-chosen Telegram channels.

stdin/stdout JSON entry point: ``python -m tradepulse_quant.sentiment.telegram_analysis``.

The user lists the channels to read (the configured list is not used). Every option call posted
in the last ``window_hours`` (12 by default) is parsed, counted as a call (CE) or a put (PE),
buy or sell, overall and per channel, and the five most asked contracts are ranked the same way
as the live consensus: distinct channels first, then mentions, then recency.

"Most asked" is how crowded a call is, not how likely it is to work; the same honest plan odds
and moneyness as the consensus desk are attached.

Payload keys: ``channels`` (required, usernames / @names / t.me links), ``window_hours``,
``spots`` ({underlying: last price}), ``now`` (ISO), ``fixtures`` ({telegram: {channel: raw page(s)}}),
``cache_dir``.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from .telegram_options import consensus
from .telegram_source import fetch_channel, normalize_channels

DEFAULT_WINDOW_HOURS = 12.0
MAX_CHANNELS = 25
MAX_PAGES = 5  # ~20 posts a page: enough to cover 12 h of a busy tip channel
BUDGET_SECONDS = 30.0
TOP = 5


def _sides(row: dict) -> dict:
    return {"calls": row["ce_buys"] + row["ce_sells"], "puts": row["pe_buys"] + row["pe_sells"], **row}


def analyse(payload: dict | None = None) -> dict:
    payload = payload or {}
    try:
        now = datetime.fromisoformat(str(payload["now"]).replace("Z", "+00:00")) if payload.get("now") else datetime.now(timezone.utc)
    except ValueError:
        now = datetime.now(timezone.utc)
    try:
        window = max(1.0, min(24.0, float(payload.get("window_hours") or DEFAULT_WINDOW_HOURS)))
    except (TypeError, ValueError):
        window = DEFAULT_WINDOW_HOURS
    raw_channels = payload.get("channels") or []
    channels = normalize_channels([str(name) for name in raw_channels] if isinstance(raw_channels, list) else [])[:MAX_CHANNELS]
    if not channels:
        raise ValueError("Add at least one public Telegram channel username")
    fixtures = payload.get("fixtures")
    cache_dir = payload.get("cache_dir") or (None if fixtures is not None else os.environ.get("SENTIMENT_CACHE_DIR") or os.path.join(tempfile.gettempdir(), "tradepulse-sentiment"))
    spots = {key: float(value) for key, value in (payload.get("spots") or {}).items() if isinstance(value, (int, float)) and value > 0}
    deadline = time.monotonic() + BUDGET_SECONDS

    def one(channel: str):
        raws = ((fixtures.get("telegram") or {}).get(channel) or []) if fixtures is not None else None
        return channel, fetch_channel(channel, now, cache_dir=cache_dir, max_age_hours=window, deadline=deadline, raws=raws, max_pages=MAX_PAGES)

    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(one, channels))
    items = [item for _, (channel_items, _) in results for item in channel_items]
    options = consensus(items, now, window, spots, full=True)

    # Per-channel put / call counts (consensus de-duplicates a contract repeated within one post).
    per_channel = {channel: {"channel": channel, "posts": 0, "calls": 0, "puts": 0, "buys": 0, "sells": 0} for channel in channels}
    for row in options["channels"]:
        per_channel.setdefault(row["channel"], {"channel": row["channel"], "posts": 0, "calls": 0, "puts": 0, "buys": 0, "sells": 0})["posts"] = row["posts"]
    ranked = options["all"]
    for call in ranked:
        for post in call["channel_mentions"]:
            bucket = per_channel.setdefault(post, {"channel": post, "posts": 0, "calls": 0, "puts": 0, "buys": 0, "sells": 0})
            count = call["channel_mentions"][post]
            bucket["calls" if call["type"] == "CE" else "puts"] += count
            bucket["buys" if call["side"] == "BUY" else "sells"] += count
    health = {channel: row for channel, (_, row) in results}
    channel_rows = [{**row, "ok": health.get(row["channel"], {}).get("ok", False), "cached": bool(health.get(row["channel"], {}).get("cached")),
                     "error": health.get(row["channel"], {}).get("error")} for row in per_channel.values()]

    calls = sum(row["mentions"] for row in ranked if row["type"] == "CE")
    puts = sum(row["mentions"] for row in ranked if row["type"] == "PE")
    totals = {
        "calls": calls, "puts": puts,
        "call_buys": sum(row["mentions"] for row in ranked if row["type"] == "CE" and row["side"] == "BUY"),
        "put_buys": sum(row["mentions"] for row in ranked if row["type"] == "PE" and row["side"] == "BUY"),
        "call_sells": sum(row["mentions"] for row in ranked if row["type"] == "CE" and row["side"] == "SELL"),
        "put_sells": sum(row["mentions"] for row in ranked if row["type"] == "PE" and row["side"] == "SELL"),
        "put_call_ratio": round(puts / calls, 2) if calls else None,
    }
    bullish = totals["call_buys"] + totals["put_sells"]
    bearish = totals["put_buys"] + totals["call_sells"]
    bullish_pct = round(100 * bullish / (bullish + bearish), 1) if bullish + bearish else None
    bias = "BULLISH" if bullish_pct is not None and bullish_pct >= 65 else "BEARISH" if bullish_pct is not None and bullish_pct <= 35 else "MIXED"

    strip = lambda row: {key: value for key, value in row.items() if key != "channel_mentions"}
    notes = list(options["notes"])
    read = sum(1 for row in channel_rows if row["ok"])
    if read < len(channels):
        notes.append(f"{len(channels) - read} of {len(channels)} channel(s) could not be read (private, renamed or without a public web preview).")
    if bullish_pct is not None and bias != "MIXED" and bullish + bearish >= 6:
        notes.append(f"{bullish_pct:.0f}% of the option calls across these channels are bullish. A one-sided crowd of option buyers is a contrarian tell: writers on the other side usually collect the premium.")
    return {
        "generated_at": now.isoformat(), "window_hours": window, "channels_requested": len(channels), "channels_read": read,
        "posts_scanned": options["posts_scanned"], "calls_parsed": options["calls_parsed"], "totals": totals,
        "bullish_pct": bullish_pct, "bias": bias,
        "top": [strip(row) for row in ranked[:TOP]],
        "top_calls": [strip(row) for row in ranked if row["type"] == "CE"][:TOP],
        "top_puts": [strip(row) for row in ranked if row["type"] == "PE"][:TOP],
        "by_underlying": [_sides(row) for row in options["by_underlying"]],
        "channels": sorted(channel_rows, key=lambda row: -(row["calls"] + row["puts"])), "notes": notes,
        "method": f"Each channel's public preview is read back {window:g} h. {options['method']}",
    }


def main() -> None:
    raw = sys.stdin.read()
    try:
        result = analyse(json.loads(raw) if raw.strip() else {})
    except ValueError as failure:
        result = {"error": str(failure)}
    print(json.dumps(result, default=str))


if __name__ == "__main__":
    main()
