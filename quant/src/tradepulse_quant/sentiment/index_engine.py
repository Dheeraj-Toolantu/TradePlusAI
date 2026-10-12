"""Constituent-weighted sentiment for NIFTY 50, BANK NIFTY and SENSEX.

stdin/stdout JSON entry point: ``python -m tradepulse_quant.sentiment.index_engine``.

Every constituent gets a -100..+100 score from six lenses, read the way a Dalal Street desk
reads a stock:

- PRICE (25%): the day's move, 5-day momentum and distance from the 20-day average, each
  scaled by the stock's own volatility (a 1% move in ITC is not a 1% move in Adani Ent).
- VOLUME (10%): who is in control. Close location in the day's range plus the direction,
  multiplied by relative volume (session-time adjusted). Up on heavy volume = accumulation,
  down on heavy volume = distribution, any move on thin volume = low conviction.
- BUYERS vs SELLERS (14%): NSE order book (total pending buy vs sell quantity, live during
  market hours) and delivery % (high delivery on an up day = investors taking stock home; on a
  down day = genuine exits, not just intraday churn).
- NEWS (25%): only the last few hours. Moneycontrol, Economic Times, Mint, Business Standard,
  BusinessLine, CNBC-TV18, NDTV Profit and Financial Express pages and per-company searches
  restricted to those outlets, plus Indian market blogs and the global edition. Publishers are
  quality-tiered: wire/business dailies count fully, aggregators and blogs less.
- RETAIL (14%): Indian and global retail-trader forums (Reddit, ValuePickr) with bull/bear
  post counts. Extremes are treated as contrarian: a euphoric crowd is damped, not rewarded.
- EVENTS (12%): block/bulk deals (who bought, who sold), results, corporate actions, NSE filings
  and event headlines (order wins, rating changes, regulatory action...); see ``corporate_events``.
  Event headlines are scored here and removed from NEWS so nothing counts twice. Upcoming results
  are flagged as event risk, not scored.

Freshness: text older than ``INDEX_SENTIMENT_MAX_AGE_HOURS`` (default 8 h) is dropped, items
without a timestamp are dropped, and a 3 h half-life makes the last 4 h dominate.

Missing lenses drop out and the weights renormalise. The index score is the free-float-weight
average of its constituents, blended 80/20 with the macro backdrop (VIX, FII flows, global
cues) when the caller passes it. Psychology notes explain what the reading means for trading.

Payload keys (all optional): ``now`` (ISO), ``indices`` (subset of ids), ``market_context``
({overall_score, india_score, global_score, retail_score, mmi_score, mmi_value}), ``fixtures``
({charts: {symbol: raw}, news: {"SYMBOL:INDIA"|"SYMBOL:GLOBAL": raw rss}, feeds: {feed id: raw},
forums: {source_id: raw}, orderbook: {symbol: raw NSE trade_info}, nse_events: {large_deals|block|bulk|announcements|actions|calendar: raw}}) so tests never touch the
network, ``cache_dir`` for the last-good cache.
"""
from __future__ import annotations

import http.cookiejar
import json
import math
import os
import re
import statistics
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from .constituents import STOCKS, configured_indices, yahoo_symbol
from .engine import _fetch, fetch_reddit, load_cache, parse_reddit, parse_rss, save_cache
from .factors import BROWSER_UA, NSE_HOME
from .corporate_events import nse_urls, parse_nse_events, split_event_headlines, stock_events
from .stock_text import STOCK_PHRASES, score_stock_text  # noqa: F401 - re-exported for callers and tests
from .retail_desk import fetch_participant_oi, retail_desk
from .sources import DEFAULT_SOURCES
from .telegram_source import PREVIEW_URL, configured_channels, oldest_id, pages, parse_preview, telegram_stats, to_items

IST = timezone(timedelta(hours=5, minutes=30))
CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=3mo"
NSE_TRADE_INFO = "https://www.nseindia.com/api/quote-equity?symbol={symbol}&section=trade_info"
NEWS_URLS = {
    "INDIA": "https://news.google.com/rss/search?q={query}&hl=en-IN&gl=IN&ceid=IN:en",
    "GLOBAL": "https://news.google.com/rss/search?q={query}&hl=en-US&gl=US&ceid=US:en",
}
# Per-company India search is limited to these outlets so aggregator spam cannot set the tone.
QUALITY_SITES = ("moneycontrol.com", "economictimes.indiatimes.com", "livemint.com", "business-standard.com", "thehindubusinessline.com",
                 "cnbctv18.com", "ndtvprofit.com", "financialexpress.com", "reuters.com", "bloomberg.com")
# Indian market pages and blogs read every scan (~20 requests), matched to stocks by name.
INDEX_FEEDS = [
    {"id": "mc_buzzing", "name": "Moneycontrol Buzzing Stocks", "url": "https://www.moneycontrol.com/rss/buzzingstocks.xml", "tier": "PREMIUM"},
    {"id": "mc_latest", "name": "Moneycontrol Latest News", "url": "https://www.moneycontrol.com/rss/latestnews.xml", "tier": "PREMIUM"},
    {"id": "mc_markets", "name": "Moneycontrol Market Reports", "url": "https://www.moneycontrol.com/rss/marketreports.xml", "tier": "PREMIUM"},
    {"id": "mc_business", "name": "Moneycontrol Business", "url": "https://www.moneycontrol.com/rss/business.xml", "tier": "PREMIUM"},
    {"id": "mc_results", "name": "Moneycontrol Results", "url": "https://www.moneycontrol.com/rss/results.xml", "tier": "PREMIUM"},
    {"id": "et_stocks", "name": "Economic Times Stocks", "url": "https://economictimes.indiatimes.com/markets/stocks/news/rssfeeds/2146842.cms", "tier": "PREMIUM"},
    {"id": "et_markets_idx", "name": "Economic Times Markets", "url": "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms", "tier": "PREMIUM"},
    {"id": "et_earnings", "name": "Economic Times Earnings", "url": "https://economictimes.indiatimes.com/markets/stocks/earnings/rssfeeds/2143429.cms", "tier": "PREMIUM"},
    {"id": "et_recos", "name": "Economic Times Recos", "url": "https://economictimes.indiatimes.com/markets/stocks/recos/rssfeeds/3053611.cms", "tier": "PREMIUM"},
    {"id": "mint_markets_idx", "name": "Mint Markets", "url": "https://www.livemint.com/rss/markets", "tier": "PREMIUM"},
    {"id": "mint_companies", "name": "Mint Companies", "url": "https://www.livemint.com/rss/companies", "tier": "PREMIUM"},
    {"id": "bs_markets_idx", "name": "Business Standard Markets", "url": "https://www.business-standard.com/rss/markets-106.rss", "tier": "PREMIUM"},
    {"id": "bs_companies", "name": "Business Standard Companies", "url": "https://www.business-standard.com/rss/companies-101.rss", "tier": "PREMIUM"},
    {"id": "bl_markets_idx", "name": "BusinessLine Markets", "url": "https://www.thehindubusinessline.com/markets/feeder/default.rss", "tier": "PREMIUM"},
    {"id": "cnbctv18_idx", "name": "CNBC-TV18 Markets", "url": "https://www.cnbctv18.com/commonfeeds/v1/cne/rss/market.xml", "tier": "PREMIUM"},
    {"id": "fe_market_idx", "name": "Financial Express Market", "url": "https://www.financialexpress.com/market/feed/", "tier": "PREMIUM"},
    # Indian stock market blogs: analysis-heavy, slower, counted at a lower weight.
    {"id": "blog_tradebrains", "name": "Trade Brains blog", "url": "https://tradebrains.in/feed/", "tier": "BLOG"},
    {"id": "blog_capitalmind", "name": "Capitalmind", "url": "https://www.capitalmind.in/feed/", "tier": "BLOG"},
    {"id": "blog_elearnmarkets", "name": "Elearnmarkets blog", "url": "https://blog.elearnmarkets.com/feed/", "tier": "BLOG"},
    {"id": "blog_finshots", "name": "Finshots", "url": "https://finshots.in/rss/", "tier": "BLOG"},
]
# One request each, instead of a Reddit search per stock (anonymous bursts get blocked).
FORUM_SOURCES = [
    {"id": "idx_india_forums", "name": "Indian retail forums (Reddit)", "kind": "reddit", "region": "INDIA", "audience": "RETAIL",
     "url": "https://www.reddit.com/r/IndianStreetBets+IndiaInvestments+StockMarketIndia+DalalStreetTalks+IndianStockMarket/new.json?limit=100"},
    {"id": "idx_global_forums", "name": "Global retail forums (Reddit)", "kind": "reddit", "region": "GLOBAL", "audience": "RETAIL",
     "url": "https://www.reddit.com/r/wallstreetbets+stocks+investing+emergingmarkets/new.json?limit=100"},
    {"id": "idx_valuepickr", "name": "ValuePickr forum", "kind": "rss", "region": "INDIA", "audience": "RETAIL", "url": "https://forum.valuepickr.com/latest.rss"},
]
TIER_WEIGHTS = {"PREMIUM": 1.0, "STANDARD": 0.7, "BLOG": 0.6}
PREMIUM_PUBLISHERS = ("moneycontrol", "economic times", "economictimes", "mint", "livemint", "business standard", "business-standard", "businessline",
                      "hindu businessline", "cnbc", "ndtv profit", "financial express", "reuters", "bloomberg", "the hindu", "financial times", "wsj", "wall street journal")
COMPONENT_WEIGHTS = {"price": 0.25, "volume": 0.10, "orderflow": 0.14, "news": 0.25, "social": 0.14, "events": 0.12}


def _max_age_hours() -> float:
    try:
        return max(2.0, min(24.0, float(os.environ.get("INDEX_SENTIMENT_MAX_AGE_HOURS", "8"))))
    except ValueError:
        return 8.0


MAX_AGE_HOURS = _max_age_hours()
FRESH_HOURS = 4.0
NEWS_HALF_LIFE_HOURS = 3.0
SOCIAL_HALF_LIFE_HOURS = 3.0
POLAR = 0.15
FETCH_WORKERS = 12
NSE_WORKERS = 4
FETCH_BUDGET_SECONDS = 45.0
MACRO_BLEND = 0.2
HEAVYWEIGHTS = 5



def _clamp(value: float, low: float = -100.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def _label(score: float | None) -> str:
    if score is None:
        return "NO_DATA"
    if score >= 40:
        return "STRONG_BULLISH"
    if score >= 12:
        return "BULLISH"
    if score <= -40:
        return "STRONG_BEARISH"
    if score <= -12:
        return "BEARISH"
    return "NEUTRAL"


def _zone(score: float | None) -> str:
    if score is None:
        return "Unknown"
    if score >= 50:
        return "Extreme Greed"
    if score >= 15:
        return "Greed"
    if score <= -50:
        return "Extreme Fear"
    if score <= -15:
        return "Fear"
    return "Neutral"


def alias_patterns(symbol: str) -> list[re.Pattern]:
    aliases = STOCKS.get(symbol, (symbol, "Other", (re.escape(symbol.lower()),)))[2]
    # Tip channels write NSE symbols ("BUY TATASTEEL"); short ones (LT, ITC) are covered by their aliases.
    if len(symbol) >= 4 and symbol.isalpha() and not any(re.search(alias, symbol.lower()) for alias in aliases):
        aliases = (*aliases, re.escape(symbol.lower()))
    patterns = []
    for alias in aliases:
        if not alias.startswith(r"\b"):
            alias = r"\b" + alias
        if alias[-1].isalnum():
            alias += r"\b"
        patterns.append(re.compile(alias))
    return patterns


def mentions(text: str, patterns: list[re.Pattern]) -> bool:
    lowered = text.lower()
    return any(pattern.search(lowered) for pattern in patterns)


# ---------- market data ----------

def parse_chart(raw: str) -> dict | None:
    """Yahoo v8 daily chart -> OHLCV arrays with today's bar last."""
    try:
        result = json.loads(raw)["chart"]["result"][0]
    except (KeyError, IndexError, TypeError, ValueError):
        return None
    quote = ((result.get("indicators") or {}).get("quote") or [{}])[0]
    stamps = result.get("timestamp") or []
    series = {key: quote.get(key) or [] for key in ("open", "high", "low", "close", "volume")}

    def value(key: str, index: int) -> float | None:
        column = series[key]
        item = column[index] if index < len(column) else None
        return float(item) if isinstance(item, (int, float)) else None

    rows = []
    for index, stamp in enumerate(stamps):
        close = value("close", index)
        if close is None:
            continue
        rows.append({"t": int(stamp), "open": value("open", index) or close, "high": value("high", index) or close, "low": value("low", index) or close,
                     "close": close, "volume": value("volume", index) or 0.0})
    if len(rows) < 6:
        return None
    meta = result.get("meta") or {}
    price = meta.get("regularMarketPrice")
    if isinstance(price, (int, float)):
        rows[-1]["close"] = float(price)
        rows[-1]["high"] = max(rows[-1]["high"], float(price))
        rows[-1]["low"] = min(rows[-1]["low"], float(price))
    return {"rows": rows}


def session_elapsed(bar_time: datetime, now: datetime) -> float:
    """Share of the NSE session (09:15-15:30 IST) done when the bar is today's, else 1."""
    now_ist = now.astimezone(IST)
    if bar_time.astimezone(IST).date() != now_ist.date():
        return 1.0
    opened = now_ist.replace(hour=9, minute=15, second=0, microsecond=0)
    minutes = (now_ist - opened).total_seconds() / 60.0
    return max(0.12, min(1.0, minutes / 375.0))


def market_lenses(chart: dict, now: datetime) -> dict:
    rows = chart["rows"]
    today, closes = rows[-1], [row["close"] for row in rows]
    previous = closes[-2]
    price = today["close"]
    history = closes[-22:-1]
    returns = [(history[i] / history[i - 1] - 1) * 100 for i in range(1, len(history)) if history[i - 1]]
    sigma = max(statistics.pstdev(returns) if len(returns) >= 5 else 1.5, 0.6)
    day = (price / previous - 1) * 100 if previous else 0.0
    five = (price / closes[-6] - 1) * 100 if len(closes) >= 6 and closes[-6] else 0.0
    ma20 = statistics.fmean(history[-20:]) if history else price
    distance = (price / ma20 - 1) * 100 if ma20 else 0.0
    trend = 0.5 * day / sigma + 0.3 * five / (sigma * math.sqrt(5)) + 0.2 * distance / (sigma * math.sqrt(10))
    price_score = 100 * math.tanh(0.8 * trend)

    past_volumes = [row["volume"] for row in rows[-21:-1] if row["volume"] > 0]
    volume_score = ratio = None
    if past_volumes and today["volume"] > 0:
        elapsed = session_elapsed(datetime.fromtimestamp(today["t"], tz=timezone.utc), now)
        ratio = today["volume"] / statistics.fmean(past_volumes) / elapsed
        span = today["high"] - today["low"]
        location = ((price - today["low"]) - (today["high"] - price)) / span if span > 0 else 0.0
        pressure = 0.5 * location + 0.5 * math.tanh(day / sigma)
        conviction = max(0.25, min(2.2, ratio / 1.2))
        volume_score = 100 * math.tanh(1.3 * pressure * conviction)
    return {
        "price": round(price, 2), "change_pct": round(day, 2), "five_day_pct": round(five, 2), "vs_20dma_pct": round(distance, 2),
        "volatility_pct": round(sigma, 2), "volume_ratio": round(ratio, 2) if ratio is not None else None,
        "price_score": round(_clamp(price_score), 1), "volume_score": round(_clamp(volume_score), 1) if volume_score is not None else None,
    }


# ---------- buyers vs sellers ----------

def parse_trade_info(raw: str) -> dict | None:
    """NSE quote-equity?section=trade_info -> order-book totals, top-5 depth and delivery %."""
    try:
        body = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(body, dict):
        return None
    book = body.get("marketDeptOrderBook") or {}
    delivery = (body.get("securityWiseDP") or {}).get("deliveryToTradedQuantity")

    def number(value) -> float | None:
        try:
            return float(str(value).replace(",", "")) if value not in (None, "", "-") else None
        except ValueError:
            return None

    def orders(side: list) -> int | None:
        counts = [number(level.get("orders") or level.get("numberOfOrders")) for level in side or [] if isinstance(level, dict)]
        counts = [count for count in counts if count is not None]
        return int(sum(counts)) if counts else None

    buy, sell = number(book.get("totalBuyQuantity")), number(book.get("totalSellQuantity"))
    result = {
        "buy_qty": buy if buy else None, "sell_qty": sell if sell else None,
        "bid_orders": orders(book.get("bid")), "ask_orders": orders(book.get("ask")),
        "delivery_pct": number(delivery),
    }
    return result if any(value is not None for value in result.values()) else None


def orderflow_lens(book: dict | None, change_pct: float | None) -> dict:
    """Buy/sell pressure from pending quantity, plus who is holding: delivery % with direction."""
    empty = {"orderflow_score": None, "buy_pct": None, "buy_qty": None, "sell_qty": None, "bid_orders": None, "ask_orders": None, "delivery_pct": None}
    if not book:
        return empty
    parts: list[tuple[float, float]] = []
    buy_pct = None
    if book["buy_qty"] and book["sell_qty"]:
        buy_pct = 100 * book["buy_qty"] / (book["buy_qty"] + book["sell_qty"])
        imbalance = (book["buy_qty"] - book["sell_qty"]) / (book["buy_qty"] + book["sell_qty"])
        parts.append((0.6, 100 * math.tanh(2.0 * imbalance)))
    delivery = book["delivery_pct"]
    if delivery is not None and change_pct is not None and abs(change_pct) >= 0.1:
        # ~45% delivery is typical for large caps; conviction rises with delivery, direction from price.
        parts.append((0.4, 100 * math.tanh((delivery - 45.0) / 20.0 + 0.5) * (1 if change_pct > 0 else -1)))
    weight = sum(w for w, _ in parts)
    return {
        "orderflow_score": round(_clamp(sum(w * v for w, v in parts) / weight), 1) if weight else None,
        "buy_pct": round(buy_pct, 1) if buy_pct is not None else None,
        "buy_qty": book["buy_qty"], "sell_qty": book["sell_qty"], "bid_orders": book["bid_orders"], "ask_orders": book["ask_orders"],
        "delivery_pct": round(delivery, 1) if delivery is not None else None,
    }


# ---------- text ----------

def source_tier(item: dict) -> str:
    """PREMIUM for business dailies/wires, BLOG for market blogs, STANDARD for everything else."""
    if item.get("tier"):
        return item["tier"]
    label = f"{item.get('publisher') or ''} {item.get('source') or ''} {item.get('link') or ''}".lower()
    if any(name in label for name in PREMIUM_PUBLISHERS) or any(site in label for site in QUALITY_SITES):
        return "PREMIUM"
    return "STANDARD"


def net_tone(items: list[dict], min_polar: int = 2) -> float | None:
    """Weighted net tone of opinionated items with a 1.0 'no opinion' prior; None when too thin."""
    polar = [item for item in items if abs(item["score"]) >= POLAR]
    if len(polar) < min_polar:
        return None
    weight = sum(item["weight"] for item in polar)
    return round(_clamp(100 * sum(item["weight"] * item["score"] for item in polar) / (weight + 1.0)), 1)


def text_items(raw_items: list[dict], patterns: list[re.Pattern], now: datetime, *, half_life: float, require_mention: bool, region_weight: float = 1.0) -> list[dict]:
    """Fresh, de-duplicated items about the stock. Undated or older than MAX_AGE_HOURS are dropped."""
    seen: set[str] = set()
    items = []
    for item in raw_items:
        title = item.get("title") or ""
        text = f"{title}. {item.get('body') or ''}"
        in_title = mentions(title, patterns)
        if not in_title and (require_mention and not mentions(text, patterns)):
            continue
        key = re.sub(r"[^a-z0-9]", "", title.lower())[:90]
        if not key or key in seen or not item.get("published"):
            continue
        seen.add(key)
        age = max((now - item["published"]).total_seconds() / 3600.0, 0.0)
        if age > MAX_AGE_HOURS:
            continue
        tier = source_tier(item)
        score = score_stock_text(title) * 0.75 + score_stock_text(item["body"]) * 0.25 if item.get("body") else score_stock_text(title)
        engagement = 1.0 + math.log1p(item.get("engagement") or 0) / 3.0
        items.append({
            "title": title[:200], "link": item.get("link", ""), "source": item.get("publisher") or item.get("source", ""), "region": item.get("region", ""),
            "tier": tier, "age_hours": round(age, 1), "score": round(score, 3), "body": (item.get("body") or "")[:600], "telegram": bool(item.get("telegram")),
            "weight": 0.5 ** (age / half_life) * (1.0 if in_title else 0.4) * engagement * region_weight * TIER_WEIGHTS.get(tier, 0.7),
        })
    return items


# ---------- collection ----------

def _news_query(symbol: str, region: str) -> str:
    name = STOCKS.get(symbol, (symbol,))[0].split(" (")[0]
    if region == "INDIA":
        sites = " OR ".join(f"site:{site}" for site in QUALITY_SITES[:8])
        return urllib.parse.quote_plus(f'"{name}" ({sites}) when:1d')
    return urllib.parse.quote_plus(f'"{name}" (stock OR shares) when:1d')


def _nse_opener() -> urllib.request.OpenerDirector:
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    request = urllib.request.Request(NSE_HOME, headers={"User-Agent": BROWSER_UA, "Accept": "text/html", "Accept-Language": "en-US,en;q=0.9"})
    with opener.open(request, timeout=8) as response:  # noqa: S310 - NSE home page for session cookies
        response.read(200_000)
    return opener


def collect(symbols: list[str], index_tickers: dict[str, str], fixtures: dict | None, cache_dir: str | None, now: datetime) -> dict:
    """charts, news per symbol, forum items, feed items, order books and per-source health."""
    deadline = time.monotonic() + FETCH_BUDGET_SECONDS
    health: dict[str, dict] = {}

    def note(group: str, ok: bool, error: str | None = None, cached: bool = False) -> None:
        row = health.setdefault(group, {"id": group, "ok": 0, "failed": 0, "cached": 0, "errors": []})
        row["ok" if ok else "failed"] += 1
        row["cached"] += int(cached)
        if error and len(row["errors"]) < 3:
            row["errors"].append(error)

    def chart(key: str, ticker: str) -> tuple[str, dict | None]:
        if fixtures is not None:
            raw = (fixtures.get("charts") or {}).get(key)
            parsed = parse_chart(raw) if raw else None
            note("market_data", parsed is not None, None if parsed else f"{key}: no fixture")
            return key, parsed
        if time.monotonic() > deadline:
            note("market_data", False, f"{key}: time budget used")
            return key, None
        try:
            parsed = parse_chart(_fetch(CHART_URL.format(symbol=urllib.parse.quote(ticker)), BROWSER_UA))
            note("market_data", parsed is not None, None if parsed else f"{key}: unreadable chart")
            return key, parsed
        except Exception as error:  # noqa: BLE001 - per-stock, never fatal
            note("market_data", False, f"{key}: {type(error).__name__}")
            return key, None

    def news(symbol: str, region: str) -> tuple[str, list[dict]]:
        cache_id = f"idx_news_{symbol}_{region}"
        # The India search is restricted to QUALITY_SITES, so every hit is a top outlet.
        extra = {"tier": "PREMIUM"} if region == "INDIA" else {}
        label = f"Google News {'India (quality outlets)' if region == 'INDIA' else 'global'}"
        if fixtures is not None:
            raw = (fixtures.get("news") or {}).get(f"{symbol}:{region}")
            parsed = parse_rss(raw) if raw else []
            note(f"news_{region.lower()}", bool(parsed))
            return symbol, [{**item, "source": item.get("source") or label, "region": region, **extra} for item in parsed]
        error = "time budget used"
        if time.monotonic() <= deadline:
            try:
                parsed = parse_rss(_fetch(NEWS_URLS[region].format(query=_news_query(symbol, region))))
                if parsed:
                    save_cache(cache_dir, cache_id, parsed, now)
                    note(f"news_{region.lower()}", True)
                    return symbol, [{**item, "source": label, "region": region, **extra} for item in parsed]
                error = "no items"
            except Exception as failure:  # noqa: BLE001
                error = f"{type(failure).__name__}"
        # The cache only helps while its items are inside the freshness window (text_items enforces it).
        cached = load_cache(cache_dir, cache_id, now)
        note(f"news_{region.lower()}", bool(cached), f"{symbol}: {error}", cached=bool(cached))
        return symbol, [{**item, "source": f"{label}, cached", "region": region, **extra} for item in (cached[0] if cached else [])]

    def feed(source: dict) -> list[dict]:
        if fixtures is not None:
            raw = (fixtures.get("feeds") or {}).get(source["id"])
            parsed = parse_rss(raw) if raw else []
        else:
            parsed = []
            if time.monotonic() <= deadline:
                try:
                    parsed = parse_rss(_fetch(source["url"], BROWSER_UA))
                    if parsed:
                        save_cache(cache_dir, source["id"], parsed, now)
                except Exception:  # noqa: BLE001
                    parsed = []
            if not parsed:
                cached = load_cache(cache_dir, source["id"], now)
                parsed = cached[0] if cached else []
        fresh = sum(1 for item in parsed if item.get("published") and (now - item["published"]).total_seconds() <= MAX_AGE_HOURS * 3600)
        group = "blogs" if source["tier"] == "BLOG" else "market_pages"
        note(group, bool(parsed), None if parsed else f"{source['name']}: unavailable")
        health_rows_by_feed[source["id"]] = {"name": source["name"], "ok": bool(parsed), "items": len(parsed), "fresh": fresh}
        return [{**item, "source": source["name"], "region": "INDIA", "tier": source["tier"]} for item in parsed]

    def forum(source: dict) -> list[dict]:
        if fixtures is not None:
            raw = (fixtures.get("forums") or {}).get(source["id"])
            parsed = (parse_reddit(raw) if source["kind"] == "reddit" else parse_rss(raw)) if raw else []
            note("forums", bool(parsed))
        else:
            parsed = []
            try:
                parsed = fetch_reddit(source["url"], deadline) if source["kind"] == "reddit" else parse_rss(_fetch(source["url"]))
                save_cache(cache_dir, source["id"], parsed, now)
            except Exception as error:  # noqa: BLE001
                cached = load_cache(cache_dir, source["id"], now)
                parsed = cached[0] if cached else []
                note("forums", bool(parsed), f"{source['name']}: {type(error).__name__}", cached=bool(parsed))
            else:
                note("forums", True)
        return [{**item, "source": source["name"], "region": source["region"]} for item in parsed]

    def telegram(channel: str) -> list[dict]:
        """Latest pages of one public channel's web preview."""
        if fixtures is not None:
            raws = (fixtures.get("telegram") or {}).get(channel) or []
            posts = [post for raw in ([raws] if isinstance(raws, str) else raws) for post in parse_preview(raw)]
        else:
            posts, url = [], PREVIEW_URL.format(channel=channel)
            for _ in range(pages()):
                if time.monotonic() > deadline:
                    break
                try:
                    page = parse_preview(_fetch(url, BROWSER_UA))
                except Exception as error:  # noqa: BLE001 - one channel failing never blocks the scan
                    note("telegram", False, f"@{channel}: {type(error).__name__}")
                    break
                posts += page
                before = oldest_id(page)
                if not page or before is None or any(post["published"] and (now - post["published"]).total_seconds() > MAX_AGE_HOURS * 3600 for post in page):
                    break
                url = f"{PREVIEW_URL.format(channel=channel)}?before={before}"
            if posts:
                save_cache(cache_dir, f"telegram_{channel}", to_items(channel, posts), now)
            else:
                cached = load_cache(cache_dir, f"telegram_{channel}", now)
                if cached:
                    note("telegram", True, cached=True)
                    telegram_health[channel] = {"name": f"@{channel}", "ok": True, "items": len(cached[0]), "fresh": 0, "cached": True}
                    return cached[0]
        fresh = sum(1 for post in posts if post["published"] and (now - post["published"]).total_seconds() <= MAX_AGE_HOURS * 3600)
        note("telegram", bool(posts), None if posts else f"@{channel}: no readable posts")
        telegram_health[channel] = {"name": f"@{channel}", "ok": bool(posts), "items": len(posts), "fresh": fresh}
        return to_items(channel, posts)

    def nse_data() -> tuple[dict[str, dict], dict]:
        """Order books per stock plus deals, filings, corporate actions and the event calendar."""
        if fixtures is not None:
            books = {symbol: parse_trade_info(raw) for symbol, raw in (fixtures.get("orderbook") or {}).items()}
            for symbol in symbols:
                note("orderbook", books.get(symbol) is not None)
            raws = fixtures.get("nse_events") or {}
            for key in ("large_deals", "block", "bulk", "announcements", "actions", "calendar"):
                note("nse_events", bool(raws.get(key)))
            return {symbol: book for symbol, book in books.items() if book}, parse_nse_events(raws)
        try:
            opener = _nse_opener()
        except Exception as error:  # noqa: BLE001 - NSE blocks many cloud IPs; these lenses just drop out
            note("orderbook", False, f"NSE session: {type(error).__name__}")
            note("nse_events", False, f"NSE session: {type(error).__name__}")
            return {}, parse_nse_events({})
        headers = {"User-Agent": BROWSER_UA, "Accept": "application/json, text/plain, */*", "Referer": NSE_HOME}

        def get(key: str, url: str) -> tuple[str, str | None]:
            try:
                with opener.open(urllib.request.Request(url, headers=headers), timeout=10) as response:  # noqa: S310 - NSE public APIs
                    raw = response.read(8_000_000).decode("utf-8", errors="replace")
                note("nse_events", True)
                return key, raw
            except Exception as error:  # noqa: BLE001
                note("nse_events", False, f"{key}: {type(error).__name__}")
                return key, None

        def one(symbol: str) -> tuple[str, dict | None]:
            if time.monotonic() > deadline:
                note("orderbook", False, f"{symbol}: time budget used")
                return symbol, None
            try:
                request = urllib.request.Request(NSE_TRADE_INFO.format(symbol=urllib.parse.quote(symbol)), headers=headers)
                with opener.open(request, timeout=8) as response:  # noqa: S310 - NSE public quote API
                    book = parse_trade_info(response.read(500_000).decode("utf-8", errors="replace"))
                note("orderbook", book is not None, None if book else f"{symbol}: unreadable")
                return symbol, book
            except Exception as error:  # noqa: BLE001
                note("orderbook", False, f"{symbol}: {type(error).__name__}")
                return symbol, None

        with ThreadPoolExecutor(max_workers=NSE_WORKERS) as nse_pool:
            event_jobs = [nse_pool.submit(get, key, url) for key, url in nse_urls(now).items()]
            books = {symbol: book for symbol, book in nse_pool.map(one, symbols) if book}
            raws = dict(job.result() for job in event_jobs)
        return books, parse_nse_events(raws)

    health_rows_by_feed: dict[str, dict] = {}
    telegram_health: dict[str, dict] = {}
    channels = list((fixtures.get("telegram") or {}).keys()) if fixtures is not None else configured_channels()
    with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
        nse_job = pool.submit(nse_data)
        chart_jobs = [pool.submit(chart, symbol, yahoo_symbol(symbol)) for symbol in symbols]
        chart_jobs += [pool.submit(chart, index_id, ticker) for index_id, ticker in index_tickers.items()]
        feed_jobs = [pool.submit(feed, source) for source in INDEX_FEEDS]
        forum_jobs = [pool.submit(forum, source) for source in FORUM_SOURCES]
        telegram_jobs = [pool.submit(telegram, channel) for channel in channels]
        news_jobs = [pool.submit(news, symbol, region) for symbol in symbols for region in ("INDIA", "GLOBAL")]
        charts = dict(job.result() for job in chart_jobs)
        news_items: dict[str, list[dict]] = {}
        for job in news_jobs:
            symbol, items = job.result()
            news_items.setdefault(symbol, []).extend(items)
        feed_news = [item for job in feed_jobs for item in job.result()]
        forum_items = [item for job in forum_jobs for item in job.result()]
        forum_items += [item for job in telegram_jobs for item in job.result()]
        books, nse_events = nse_job.result()

    # Forums the market sentiment engine already read (its last-good cache) add retail coverage.
    if fixtures is None:
        for source in DEFAULT_SOURCES:
            if source["audience"] != "RETAIL" or source["id"] == "valuepickr":
                continue
            cached = load_cache(cache_dir, source["id"], now)
            if cached:
                forum_items.extend({**item, "source": source["name"], "region": source["region"]} for item in cached[0])

    labels = {"market_data": "Yahoo Finance prices & volume", "orderbook": "NSE order book & delivery", "news_india": "Google News India (quality outlets, per stock)",
              "news_global": "Google News global (per stock)", "market_pages": "Moneycontrol / ET / Mint / BS pages", "blogs": "Indian market blogs",
              "forums": "Retail trader forums (Reddit, ValuePickr)", "telegram": "Telegram stock channels", "nse_events": "NSE deals, filings, corporate actions & calendar"}
    health_rows = [{"id": key, "name": labels.get(key, key), **{k: v for k, v in row.items() if k != "id"}} for key, row in health.items()]
    feeds = [{"id": source["id"], **health_rows_by_feed[source["id"]]} for source in INDEX_FEEDS if source["id"] in health_rows_by_feed]
    feeds += [{"id": f"telegram_{channel}", **row} for channel, row in telegram_health.items()]
    if not channels:
        health_rows.append({"id": "telegram", "name": "Telegram stock channels", "ok": 0, "failed": 0, "cached": 0, "errors": ["Not configured: set TELEGRAM_CHANNELS"]})
    return {"charts": charts, "news": news_items, "forums": forum_items, "feeds": feed_news, "books": books, "nse_events": nse_events, "health": health_rows, "feed_health": feeds}


# ---------- scoring ----------

def score_stock(symbol: str, chart: dict | None, news_raw: list[dict], feed_news: list[dict], forums: list[dict], book: dict | None, now: datetime, nse_events: dict | None = None) -> dict:
    name, sector, _ = STOCKS.get(symbol, (symbol, "Other", ()))
    patterns = alias_patterns(symbol)
    market = market_lenses(chart, now) if chart else None
    flow = orderflow_lens(book, market["change_pct"] if market else None)

    news = text_items(news_raw, patterns, now, half_life=NEWS_HALF_LIFE_HOURS, require_mention=False)
    news = [{**item, "weight": item["weight"] * (0.8 if item["region"] == "GLOBAL" else 1.0)} for item in news]
    news += text_items(feed_news, patterns, now, half_life=NEWS_HALF_LIFE_HOURS, require_mention=True)
    # Results, deals, order wins, ratings, filings... are scored once, by the events lens.
    news, event_headlines = split_event_headlines(news)
    events = stock_events(symbol, name, nse_events, event_headlines, market["price"] if market else None, now)
    social = text_items(forums, patterns, now, half_life=SOCIAL_HALF_LIFE_HOURS, require_mention=True)
    telegram = telegram_stats(social, patterns)
    for item in social:
        # An explicit "BUY X tgt/sl" call says more about the poster's stance than the words around it.
        if item.get("call"):
            item["score"] = round(0.7 * item["call"] + 0.3 * item["score"], 3)
    news_score = net_tone(news)
    social_score = net_tone(social)

    notes: list[str] = []
    social_used = social_score
    if telegram["buy_calls"] >= 4 and telegram["hype_posts"] >= 2 and telegram["buy_calls"] >= 3 * max(1, telegram["sell_calls"]):
        notes.append(f"Telegram pump alert: {telegram['buy_calls']} buy calls across {telegram['channels']} channel(s) with hype language. Late retail money is being herded in; distribution risk, don't chase.")
    if social_score is not None and len(social) >= 8 and abs(social_score) >= 55:
        social_used = round(social_score * 0.6, 1)
        notes.append("Crowded long on retail forums: euphoria is a contrarian warning, don't chase." if social_score > 0
                     else "Retail capitulation on forums: panic often marks short-term lows.")
    components = {
        "price": market["price_score"] if market else None,
        "volume": market["volume_score"] if market else None,
        "orderflow": flow["orderflow_score"],
        "news": news_score,
        "social": social_used,
        "events": events["score"],
    }
    available = {key: value for key, value in components.items() if value is not None}
    weight = sum(COMPONENT_WEIGHTS[key] for key in available)
    score = round(sum(COMPONENT_WEIGHTS[key] * value for key, value in available.items()) / weight, 1) if weight else None

    if market:
        ratio = market["volume_ratio"]
        if ratio is not None and ratio >= 1.5 and market["change_pct"] > 0.5:
            notes.append(f"Accumulation: up {market['change_pct']:.1f}% on {ratio:.1f}x normal volume.")
        elif ratio is not None and ratio >= 1.5 and market["change_pct"] < -0.5:
            notes.append(f"Distribution: down {abs(market['change_pct']):.1f}% on {ratio:.1f}x normal volume.")
        elif ratio is not None and ratio < 0.6 and abs(market["change_pct"]) > 1:
            notes.append("Move on thin volume: low conviction, prone to reversal.")
        if news_score is not None and market["price_score"] >= 20 and news_score <= -20:
            notes.append("Price rising despite negative news: strong hands absorbing supply.")
        elif news_score is not None and market["price_score"] <= -20 and news_score >= 20:
            notes.append("Good news being sold: sell-on-news / distribution.")
        if flow["buy_pct"] is not None and flow["buy_pct"] >= 65 and market["change_pct"] < -0.5:
            notes.append(f"Buyers queue ({flow['buy_pct']:.0f}% of pending orders) but price falls: bottom-fishers are being absorbed, not yet a reversal.")
        elif flow["buy_pct"] is not None and flow["buy_pct"] <= 35 and market["change_pct"] > 0.5:
            notes.append(f"Price rising into a heavy sell queue ({100 - flow['buy_pct']:.0f}% of pending orders): supply overhead, watch for profit booking.")
        if flow["delivery_pct"] is not None and flow["delivery_pct"] >= 60 and abs(market["change_pct"]) >= 0.5:
            notes.append(f"High delivery ({flow['delivery_pct']:.0f}%): positional {'buying' if market['change_pct'] > 0 else 'selling'}, not intraday churn.")

    notes += events["notes"]
    ranked = sorted(news + event_headlines + social, key=lambda item: item["weight"] * abs(item["score"]), reverse=True)
    all_news = news + event_headlines
    fresh = [item for item in all_news if item["age_hours"] <= FRESH_HOURS]
    return {
        "symbol": symbol, "name": name, "sector": sector, "score": score, "label": _label(score),
        "confidence": "HIGH" if weight >= 0.8 else "MEDIUM" if weight >= 0.5 else "LOW" if weight else "NONE",
        "components": components, "social_raw": social_score,
        "price": market["price"] if market else None, "change_pct": market["change_pct"] if market else None,
        "five_day_pct": market["five_day_pct"] if market else None, "vs_20dma_pct": market["vs_20dma_pct"] if market else None,
        "volume_ratio": market["volume_ratio"] if market else None,
        "orderflow": {key: value for key, value in flow.items() if key != "orderflow_score"},
        "news_count": len(all_news), "news_fresh_count": len(fresh), "premium_news_count": sum(1 for item in all_news if item["tier"] == "PREMIUM"),
        "latest_news_age_hours": min((item["age_hours"] for item in all_news), default=None),
        "social_count": len(social),
        "events": {key: value for key, value in events.items() if key not in ("score", "notes")},
        "retail": {"posts": len(social), "bullish": sum(1 for item in social if item["score"] >= POLAR), "bearish": sum(1 for item in social if item["score"] <= -POLAR), "telegram": telegram},
        "notes": notes,
        "headlines": [{"title": item["title"], "link": item["link"], "source": item["source"], "tier": item["tier"], "score": round(item["score"] * 100), "age_hours": item["age_hours"],
                       "event": item.get("category")} for item in ranked[:5]],
    }


def _weighted(rows: list[tuple[float, float]]) -> float | None:
    total = sum(weight for weight, _ in rows)
    return round(sum(weight * value for weight, value in rows) / total, 1) if total else None


def psychology(index_id: str, name: str, score: float | None, stocks: list[dict], weights: dict[str, float], parts: dict, macro: float | None, sectors: list[dict], breadth: dict,
               orderflow: dict | None = None, retail: dict | None = None, corporate: dict | None = None) -> tuple[list[str], str]:
    notes: list[str] = []
    if score is None:
        return ["Not enough constituent data for a reading."], "No call: wait for data."
    hw, rest = parts["heavyweights"], parts["rest"]
    if hw is not None and rest is not None:
        if hw - rest >= 25:
            notes.append(f"Generals are carrying {name} while the soldiers lag (heavyweights {hw:+.0f} vs rest {rest:+.0f}). A narrow, heavyweight-led move: such rallies fade fast once the top names cool; don't chase index calls at highs.")
        elif rest - hw >= 25:
            notes.append(f"Broader constituents ({rest:+.0f}) are healthier than the heavyweights ({hw:+.0f}). The headline index understates risk appetite; dips are likely to be bought.")
    if breadth["bullish_pct"] >= 65:
        notes.append(f"Broad-based optimism: {breadth['bullish_pct']:.0f}% of index weight is bullish. Trends with this breadth tend to persist; buy dips, don't fight it.")
    elif breadth["bearish_pct"] >= 65:
        notes.append(f"Broad-based pessimism: {breadth['bearish_pct']:.0f}% of index weight is bearish. Avoid bottom-fishing until breadth stabilises.")
    elif abs(breadth["bullish_pct"] - breadth["bearish_pct"]) < 15 and abs(score) < 15:
        notes.append("Tug of war between bulls and bears: no side has control. Range-bound, premium-decay conditions.")
    price, news, volume, social = parts["price"], parts["news"], parts["volume"], parts["social"]
    if price is not None and news is not None:
        if price >= 15 and news <= -15:
            notes.append("The tape is shrugging off negative headlines: classic strong-hands absorption. If it holds, bears get trapped and short covering follows.")
        elif price <= -15 and news >= 15:
            notes.append("Good news is being sold: sell-on-news / distribution behaviour. Respect the tape over the headlines.")
    if volume is not None:
        if volume <= -30:
            notes.append("Heavy-volume selling in the heavyweights: institutions are distributing. Rallies are likely to meet supply.")
        elif volume >= 30 and (price or 0) > 0:
            notes.append("Gains are backed by above-average volume: genuine institutional accumulation, not just short covering.")
    thin = [stock for stock in stocks if stock["volume_ratio"] is not None and stock["volume_ratio"] < 0.7]
    if price is not None and abs(price) >= 20 and sum(weights[s["symbol"]] for s in thin) >= 0.5 * sum(weights.values()):
        notes.append("The move lacks participation (most of the index on below-average volume): low conviction, vulnerable to reversal.")
    if social is not None:
        if social >= 50:
            notes.append("Retail forums are euphoric on the index constituents. When the crowd is all-in, smart money sells into strength: tighten stops.")
        elif social <= -50:
            notes.append("Retail forums are in panic. Capitulation is usually near a short-term bottom: avoid chasing puts at lows.")
    corporate = corporate or {}
    reporting = corporate.get("reporting_weight_7d") or 0
    if reporting >= 15:
        names = ", ".join(row["symbol"] for row in corporate["upcoming"][:4])
        notes.append(f"Earnings week: {reporting:.0f}% of {name}'s weight reports within 7 days ({names}). Expect stock-specific gaps; index implied volatility stays bid until the heavyweights report, then crushes.")
    tone = corporate.get("results_tone")
    if tone is not None and len(corporate.get("results", [])) >= 2:
        if tone >= 20:
            notes.append(f"Results so far are beating expectations (weighted tone {tone:+.0f}): earnings support the index; dips on heavyweights are buyable.")
        elif tone <= -20:
            notes.append(f"Results so far are disappointing (weighted tone {tone:+.0f}): earnings downgrades follow misses; rallies are suspect until estimates reset.")
    deals = corporate.get("deals") or {}
    if deals.get("promoter_sell_cr", 0) >= 500:
        notes.append(f"Promoters and strategic holders sold ₹{deals['promoter_sell_cr']:,.0f} Cr in block/bulk deals across {name}: fresh supply the market has to absorb.")
    if deals.get("institution_buy_cr", 0) >= 500:
        notes.append(f"Institutions bought ₹{deals['institution_buy_cr']:,.0f} Cr in block/bulk deals across {name}: big money is using blocks to build positions.")
    negative = [row for row in corporate.get("notable", []) if row["type"] in ("REGULATORY", "AUDITOR_EXIT") and row["weight"] >= 2]
    if negative:
        notes.append(f"Governance/regulatory event in a significant constituent ({negative[0]['symbol']}: {negative[0]['label'].lower()}): such news can drag the whole sector.")
    flow_buy = (orderflow or {}).get("buy_pct")
    if flow_buy is not None:
        if flow_buy >= 60 and (price or 0) < -10:
            notes.append(f"Buyers outnumber sellers in the order book ({flow_buy:.0f}% of pending quantity) yet prices fall: bottom-fishing buyers are getting trapped. Wait for price to confirm before going long.")
        elif flow_buy >= 60:
            notes.append(f"Buyers dominate the order book ({flow_buy:.0f}% of pending quantity): demand is waiting below the market, dips should find support.")
        elif flow_buy <= 40 and (price or 0) > 10:
            notes.append(f"Price is rising into heavy pending supply ({100 - flow_buy:.0f}% sell quantity): operators may be distributing into strength; trail stops tightly.")
        elif flow_buy <= 40:
            notes.append(f"Sellers dominate the order book ({100 - flow_buy:.0f}% of pending quantity): rallies are likely to be sold.")
    if retail and retail.get("posts", 0) >= 10 and retail.get("bullish_pct") is not None:
        if retail["bullish_pct"] >= 70 and (volume or 0) <= -20:
            notes.append(f"Retail traders are {retail['bullish_pct']:.0f}% bullish while volume shows institutional distribution: classic hand-over from strong hands to retail. Be careful.")
        elif retail["bullish_pct"] <= 30 and (volume or 0) >= 20:
            notes.append(f"Retail traders are only {retail['bullish_pct']:.0f}% bullish while institutions accumulate on volume: the wall of worry that rallies climb.")
    mmi = (retail or {}).get("mmi_score")
    if isinstance(mmi, (int, float)) and abs(mmi) >= 50:
        notes.append("Market Mood Index is in extreme greed: late-rally risk, don't chase calls." if mmi > 0 else "Market Mood Index is in extreme fear: often near short-term lows, don't chase puts.")
    if macro is not None and abs(macro) >= 20 and abs(parts["constituents"] or 0) >= 20 and (macro > 0) != ((parts["constituents"] or 0) > 0):
        notes.append(f"Stock-level sentiment ({parts['constituents']:+.0f}) disagrees with the macro backdrop ({macro:+.0f}: VIX, FII flows, global cues). Expect gap risk at the open; size down.")
    if index_id == "BANKNIFTY":
        top2 = {stock["symbol"]: stock["score"] for stock in stocks if stock["symbol"] in ("HDFCBANK", "ICICIBANK") and stock["score"] is not None}
        if len(top2) == 2:
            share = (weights["HDFCBANK"] + weights["ICICIBANK"]) / sum(weights.values()) * 100
            notes.append(f"HDFC Bank ({top2['HDFCBANK']:+.0f}) and ICICI Bank ({top2['ICICIBANK']:+.0f}) are ~{share:.0f}% of BANK NIFTY: the index rarely trends against them. PSU banks reflect retail and policy sentiment.")
    if len(sectors) >= 3:
        best, worst = sectors[0], sectors[-1]
        if best["score"] is not None and worst["score"] is not None and best["score"] - worst["score"] >= 25:
            notes.append(f"Sector rotation: money favouring {best['sector']} ({best['score']:+.0f}) over {worst['sector']} ({worst['score']:+.0f}).")
    if score >= 40:
        bias = "Strong bullish: buy on dips, trail stop-losses, avoid naked short calls. Watch for euphoria near resistance."
    elif score >= 12:
        bias = "Mildly bullish: buy on dips near support, book partial profits into resistance."
    elif score > -12:
        bias = "Indecisive / range-bound: favour premium selling or wait for a breakout with volume."
    elif score > -40:
        bias = "Mildly bearish: sell on rise, avoid catching falling knives; keep longs hedged."
    else:
        bias = "Strong bearish: sell on rallies, hedge longs. Watch for a capitulation bounce if retail panic is extreme."
    return notes, bias


def events_summary(stocks: list[dict], weights: dict[str, float]) -> dict:
    """Index-wide view of results, deals, upcoming events and the most important corporate events."""
    results, upcoming, notable = [], [], []
    deal_totals = {"buy_value_cr": 0.0, "sell_value_cr": 0.0, "institution_buy_cr": 0.0, "promoter_sell_cr": 0.0, "count": 0}
    top_deals = []
    for stock in stocks:
        events = stock.get("events") or {}
        weight = weights[stock["symbol"]]
        for event in events.get("events", []):
            if event["type"] == "RESULTS":
                results.append({"symbol": stock["symbol"], "weight": round(weight, 2), "impact": event["impact"], "title": event["title"], "source": event["source"]})
            notable.append({"symbol": stock["symbol"], "weight": round(weight, 2), **event})
        for row in events.get("upcoming", []):
            upcoming.append({"symbol": stock["symbol"], "weight": round(weight, 2), **row})
        deals = events.get("deals")
        if deals:
            for key in ("buy_value_cr", "sell_value_cr", "institution_buy_cr", "promoter_sell_cr"):
                deal_totals[key] += deals[key]
            deal_totals["count"] += deals["count"]
            top_deals += [{"symbol": stock["symbol"], **deal} for deal in deals["deals"]]
    best = {}
    for row in results:  # one results reading per stock: the most impactful
        if row["symbol"] not in best or abs(row["impact"]) > abs(best[row["symbol"]]["impact"]):
            best[row["symbol"]] = row
    results = sorted(best.values(), key=lambda row: -row["weight"])
    upcoming.sort(key=lambda row: (row["days"], -row["weight"]))
    reporting = {row["symbol"]: row["weight"] for row in upcoming if row["is_results"] and row["days"] <= 7}
    total_weight = sum(row["weight"] for row in results)
    return {
        "results": results[:12],
        "results_tone": round(sum(row["weight"] * row["impact"] for row in results) / total_weight, 1) if total_weight else None,
        "upcoming": upcoming[:12],
        "reporting_weight_7d": round(sum(reporting.values()), 1),
        "deals": {**{key: round(value, 2) for key, value in deal_totals.items()}, "top": sorted(top_deals, key=lambda row: -row["value_cr"])[:8]},
        "notable": sorted(notable, key=lambda row: -(row["weight"] * abs(row["impact"])))[:10],
    }


def analyze_index(index_id: str, spec: dict, stock_rows: dict[str, dict], index_chart: dict | None, macro: float | None, now: datetime, context: dict | None = None) -> dict:
    raw_weights = {symbol: float(weight) for symbol, weight in spec["weights"].items() if symbol in stock_rows}
    total = sum(raw_weights.values()) or 1.0
    weights = {symbol: weight / total * 100 for symbol, weight in raw_weights.items()}
    stocks = [{**stock_rows[symbol], "weight": round(weights[symbol], 2)} for symbol in sorted(weights, key=lambda s: -weights[s])]
    scored = [stock for stock in stocks if stock["score"] is not None]
    constituent_score = _weighted([(weights[s["symbol"]], s["score"]) for s in scored])
    score = constituent_score
    if score is not None and macro is not None:
        score = round((1 - MACRO_BLEND) * score + MACRO_BLEND * macro, 1)

    def lens(key: str, rows: list[dict]) -> float | None:
        return _weighted([(weights[s["symbol"]], s["components"][key]) for s in rows if s["components"][key] is not None])

    heavy = stocks[:HEAVYWEIGHTS]
    social_rows = [(weights[s["symbol"]], s["social_raw"]) for s in stocks if s["social_raw"] is not None]
    parts = {
        "constituents": constituent_score, "price": lens("price", stocks), "volume": lens("volume", stocks), "orderflow": lens("orderflow", stocks),
        "news": lens("news", stocks), "events": lens("events", stocks),
        # A crowd reading on one or two names is not the index's crowd: need a quarter of the weight.
        "social": _weighted(social_rows) if sum(weight for weight, _ in social_rows) >= 25 else None,
        "heavyweights": _weighted([(weights[s["symbol"]], s["score"]) for s in heavy if s["score"] is not None]),
        "rest": _weighted([(weights[s["symbol"]], s["score"]) for s in stocks[HEAVYWEIGHTS:] if s["score"] is not None]),
    }
    scored_weight = sum(weights[s["symbol"]] for s in scored) or 1.0
    breadth = {
        "bullish_pct": round(sum(weights[s["symbol"]] for s in scored if s["score"] >= 12) / scored_weight * 100, 1),
        "bearish_pct": round(sum(weights[s["symbol"]] for s in scored if s["score"] <= -12) / scored_weight * 100, 1),
        "advances": sum(1 for s in stocks if (s["change_pct"] or 0) > 0.05),
        "declines": sum(1 for s in stocks if (s["change_pct"] or 0) < -0.05),
        "unchanged": sum(1 for s in stocks if s["change_pct"] is not None and abs(s["change_pct"]) <= 0.05),
    }
    breadth["neutral_pct"] = round(max(0.0, 100 - breadth["bullish_pct"] - breadth["bearish_pct"]), 1)
    by_sector: dict[str, list[dict]] = {}
    for stock in stocks:
        by_sector.setdefault(stock["sector"], []).append(stock)
    sectors = sorted(
        ({"sector": sector, "weight": round(sum(s["weight"] for s in rows), 1), "score": _weighted([(s["weight"], s["score"]) for s in rows if s["score"] is not None]), "stocks": len(rows)} for sector, rows in by_sector.items()),
        key=lambda row: -(row["score"] if row["score"] is not None else -999),
    )
    for stock in stocks:
        stock["contribution"] = round(stock["weight"] / 100 * stock["score"], 2) if stock["score"] is not None else None
    contributions = sorted((s for s in stocks if s["contribution"] is not None), key=lambda s: s["contribution"])
    pick = lambda s: {"symbol": s["symbol"], "name": s["name"], "score": s["score"], "weight": s["weight"], "contribution": s["contribution"]}
    with_book = [s for s in stocks if s["orderflow"]["buy_pct"] is not None]
    with_delivery = [s for s in stocks if s["orderflow"]["delivery_pct"] is not None]
    orderflow = {
        "buy_pct": _weighted([(weights[s["symbol"]], s["orderflow"]["buy_pct"]) for s in with_book]),
        "delivery_pct": _weighted([(weights[s["symbol"]], s["orderflow"]["delivery_pct"]) for s in with_delivery]),
        "buyer_dominated": sum(1 for s in with_book if s["orderflow"]["buy_pct"] >= 55),
        "seller_dominated": sum(1 for s in with_book if s["orderflow"]["buy_pct"] <= 45),
        "buy_qty": sum(s["orderflow"]["buy_qty"] or 0 for s in with_book), "sell_qty": sum(s["orderflow"]["sell_qty"] or 0 for s in with_book),
        "stocks_covered": len(with_book),
    }
    if orderflow["buy_pct"] is not None:
        orderflow["sell_pct"] = round(100 - orderflow["buy_pct"], 1)
    posts = sum(s["retail"]["posts"] for s in stocks)
    bullish, bearish = sum(s["retail"]["bullish"] for s in stocks), sum(s["retail"]["bearish"] for s in stocks)
    context = context or {}
    retail = {
        "posts": posts, "bullish": bullish, "bearish": bearish,
        "bullish_pct": round(100 * bullish / (bullish + bearish), 1) if bullish + bearish else None,
        "mood": _weighted(social_rows), "mmi_score": context.get("mmi_score"), "mmi_value": context.get("mmi_value"), "retail_market_score": context.get("retail_score"),
        "most_discussed": [{"symbol": s["symbol"], "posts": s["retail"]["posts"], "mood": s["social_raw"]} for s in sorted(stocks, key=lambda s: -s["retail"]["posts"]) if s["retail"]["posts"]][:5],
        "telegram": {
            "posts": sum(s["retail"]["telegram"]["posts"] for s in stocks), "buy_calls": sum(s["retail"]["telegram"]["buy_calls"] for s in stocks),
            "sell_calls": sum(s["retail"]["telegram"]["sell_calls"] for s in stocks), "hype_posts": sum(s["retail"]["telegram"]["hype_posts"] for s in stocks),
            "most_tipped": [{"symbol": s["symbol"], "buy_calls": s["retail"]["telegram"]["buy_calls"], "sell_calls": s["retail"]["telegram"]["sell_calls"], "hype_posts": s["retail"]["telegram"]["hype_posts"]}
                            for s in sorted(stocks, key=lambda s: -(s["retail"]["telegram"]["buy_calls"] + s["retail"]["telegram"]["sell_calls"]))
                            if s["retail"]["telegram"]["buy_calls"] + s["retail"]["telegram"]["sell_calls"]][:6],
        },
    }
    freshness = {
        "max_age_hours": MAX_AGE_HOURS, "fresh_window_hours": FRESH_HOURS,
        "news_items": sum(s["news_count"] for s in stocks), "fresh_items": sum(s["news_fresh_count"] for s in stocks),
        "premium_items": sum(s["premium_news_count"] for s in stocks),
        "latest_news_age_hours": min((s["latest_news_age_hours"] for s in stocks if s["latest_news_age_hours"] is not None), default=None),
        "stocks_with_news": sum(1 for s in stocks if s["news_count"]),
    }
    corporate = events_summary(stocks, weights)
    notes, bias = psychology(index_id, spec["name"], score, stocks, weights, parts, macro, sectors, breadth, orderflow, retail, corporate)

    quote = None
    if index_chart:
        rows = index_chart["rows"]
        quote = {"price": round(rows[-1]["close"], 2), "change_pct": round((rows[-1]["close"] / rows[-2]["close"] - 1) * 100, 2) if rows[-2]["close"] else None}
    return {
        "id": index_id, "name": spec["name"], "score": score, "label": _label(score), "zone": _zone(score), "bias": bias,
        "constituent_score": constituent_score, "macro_score": macro, "lenses": parts, "breadth": breadth, "sectors": sectors,
        "drivers": {"positive": [pick(s) for s in reversed(contributions) if s["contribution"] > 0][:5], "negative": [pick(s) for s in contributions if s["contribution"] < 0][:5]},
        "psychology": notes, "quote": quote, "orderflow": orderflow, "retail": retail, "freshness": freshness, "corporate": corporate,
        "coverage": {"stocks_scored": len(scored), "stocks_total": len(stocks), "weight_scored_pct": round(sum(weights[s["symbol"]] for s in scored), 1)},
        "constituents": stocks,
    }


def analyze_indices(payload: dict | None = None) -> dict:
    payload = payload or {}
    try:
        now = datetime.fromisoformat(str(payload["now"]).replace("Z", "+00:00")) if payload.get("now") else datetime.now(timezone.utc)
    except ValueError:
        now = datetime.now(timezone.utc)
    table = configured_indices()
    wanted = [key for key in (payload.get("indices") or list(table)) if key in table]
    fixtures = payload.get("fixtures")
    cache_dir = payload.get("cache_dir") or (None if fixtures is not None else os.environ.get("SENTIMENT_CACHE_DIR") or os.path.join(tempfile.gettempdir(), "tradepulse-sentiment"))
    context = payload.get("market_context") or {}
    macro = context.get("overall_score")
    macro = float(macro) if isinstance(macro, (int, float)) else None

    symbols = sorted({symbol for key in wanted for symbol in table[key]["weights"]})
    with ThreadPoolExecutor(max_workers=1) as side:
        positioning_job = side.submit(fetch_participant_oi, now, fixtures)
        data = collect(symbols, {key: table[key]["yahoo"] for key in wanted if table[key].get("yahoo")}, fixtures, cache_dir, now)
        positioning = positioning_job.result()
    charts = data["charts"]
    stock_rows = {symbol: score_stock(symbol, charts.get(symbol), data["news"].get(symbol, []), data["feeds"], data["forums"], data["books"].get(symbol), now, data["nse_events"]) for symbol in symbols}
    indices = [analyze_index(key, table[key], stock_rows, charts.get(key), macro, now, context) for key in wanted]
    return {
        "generated_at": now.isoformat(),
        "indices": indices,
        "retail_desk": retail_desk(indices, context, now, fixtures, positioning),
        "market_context": context or None,
        "sources": data["health"],
        "feeds": data["feed_health"],
        "freshness": {"max_age_hours": MAX_AGE_HOURS, "fresh_window_hours": FRESH_HOURS},
        "method": f"Each constituent is scored -100..+100 from price action (25%: day move, 5-day momentum and distance from the 20-DMA, scaled by the stock's own volatility), "
                  "volume (10%: close location and direction times session-adjusted relative volume, i.e. accumulation vs distribution), buyers vs sellers (14%: NSE order-book "
                  "pending buy vs sell quantity and delivery %), news (25%: Moneycontrol, Economic Times, Mint, Business Standard, BusinessLine, CNBC-TV18 and Financial Express "
                  "pages, per-company searches limited to those outlets, Indian market blogs and the global edition; premium outlets weigh 1.0, other news 0.7, blogs 0.6), "
                  f"retail traders (14%: Indian and global forums, extremes damped as contrarian) and corporate events (12%: NSE block/bulk deals weighted by who "
                  "bought and sold, results tone, corporate actions, filings and event headlines; upcoming results flagged as event risk). Only text from the last {MAX_AGE_HOURS:.0f} h is used, with a 3 h half-life so "
                  f"the last {FRESH_HOURS:.0f} h dominate; undated items are dropped. Missing lenses drop out. The index score is the free-float-weighted average of its "
                  "constituents, blended 80/20 with the macro backdrop (India VIX, FII/DII flows, global cues, retail mood) when available. Weights are approximate and "
                  "normalised; scores are a reading of sentiment, not a trade signal.",
    }


def main() -> None:
    raw = sys.stdin.read()
    payload = json.loads(raw) if raw.strip() else {}
    print(json.dumps(analyze_indices(payload), default=str))


if __name__ == "__main__":
    main()
