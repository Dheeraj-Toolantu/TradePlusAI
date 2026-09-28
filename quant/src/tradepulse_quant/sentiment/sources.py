"""Default public sources. Override with SENTIMENT_SOURCES_JSON (a JSON list or a file path).

Every entry is a public feed intended for programmatic reading (RSS/Atom, Reddit .json).
Feed URLs change over time; a failing source is reported per-source and never blocks others.
"""
from __future__ import annotations

import json
import os

DEFAULT_SOURCES: list[dict] = [
    # India: news media
    {"id": "et_markets", "name": "Economic Times Markets", "kind": "rss", "region": "INDIA", "audience": "NEWS", "url": "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms"},
    {"id": "moneycontrol", "name": "Moneycontrol Market Reports", "kind": "rss", "region": "INDIA", "audience": "NEWS", "url": "https://www.moneycontrol.com/rss/marketreports.xml"},
    {"id": "business_standard", "name": "Business Standard Markets", "kind": "rss", "region": "INDIA", "audience": "NEWS", "url": "https://www.business-standard.com/rss/markets-106.rss"},
    {"id": "livemint", "name": "Mint Markets", "kind": "rss", "region": "INDIA", "audience": "NEWS", "url": "https://www.livemint.com/rss/markets"},
    {"id": "cnbctv18", "name": "CNBC-TV18 Markets", "kind": "rss", "region": "INDIA", "audience": "NEWS", "url": "https://www.cnbctv18.com/commonfeeds/v1/cne/rss/market.xml"},
    {"id": "gnews_india", "name": "Google News: Nifty/Sensex", "kind": "rss", "region": "INDIA", "audience": "NEWS", "url": "https://news.google.com/rss/search?q=nifty+OR+sensex+OR+%22bank+nifty%22&hl=en-IN&gl=IN&ceid=IN:en"},
    # India: retail forums
    {"id": "r_indianstreetbets", "name": "r/IndianStreetBets", "kind": "reddit", "region": "INDIA", "audience": "RETAIL", "url": "https://www.reddit.com/r/IndianStreetBets/new.json?limit=75"},
    {"id": "r_indiainvestments", "name": "r/IndiaInvestments", "kind": "reddit", "region": "INDIA", "audience": "RETAIL", "url": "https://www.reddit.com/r/IndiaInvestments/new.json?limit=50"},
    {"id": "r_stockmarketindia", "name": "r/StockMarketIndia", "kind": "reddit", "region": "INDIA", "audience": "RETAIL", "url": "https://www.reddit.com/r/StockMarketIndia/new.json?limit=50"},
    {"id": "r_dalalstreettalks", "name": "r/DalalStreetTalks", "kind": "reddit", "region": "INDIA", "audience": "RETAIL", "url": "https://www.reddit.com/r/DalalStreetTalks/new.json?limit=50"},
    # Global: news media
    {"id": "cnbc_markets", "name": "CNBC Markets", "kind": "rss", "region": "GLOBAL", "audience": "NEWS", "url": "https://www.cnbc.com/id/100003114/device/rss/rss.html"},
    {"id": "yahoo_finance", "name": "Yahoo Finance", "kind": "rss", "region": "GLOBAL", "audience": "NEWS", "url": "https://finance.yahoo.com/news/rssindex"},
    {"id": "gnews_global", "name": "Google News: global markets", "kind": "rss", "region": "GLOBAL", "audience": "NEWS", "url": "https://news.google.com/rss/search?q=%22stock+market%22+OR+%22wall+street%22+OR+fed&hl=en-US&gl=US&ceid=US:en"},
    # Global: retail forums
    {"id": "r_wallstreetbets", "name": "r/wallstreetbets", "kind": "reddit", "region": "GLOBAL", "audience": "RETAIL", "url": "https://www.reddit.com/r/wallstreetbets/new.json?limit=75"},
    {"id": "r_stocks", "name": "r/stocks", "kind": "reddit", "region": "GLOBAL", "audience": "RETAIL", "url": "https://www.reddit.com/r/stocks/new.json?limit=50"},
]


def configured_sources() -> list[dict]:
    raw = os.environ.get("SENTIMENT_SOURCES_JSON", "").strip()
    if not raw:
        return DEFAULT_SOURCES
    try:
        if not raw.startswith("["):
            with open(raw, encoding="utf-8") as handle:
                raw = handle.read()
        sources = json.loads(raw)
    except (OSError, ValueError):
        return DEFAULT_SOURCES
    valid = [s for s in sources if isinstance(s, dict) and {"id", "kind", "url", "region", "audience"} <= s.keys() and s["kind"] in {"rss", "reddit"}]
    return valid or DEFAULT_SOURCES
