"""Constituent-weighted sentiment for NIFTY 50, BANK NIFTY and SENSEX.

stdin/stdout JSON entry point: ``python -m tradepulse_quant.sentiment.index_engine``.

Every constituent gets a -100..+100 score from four lenses, read the way a Dalal Street desk
reads a stock:

- PRICE (35%): the day's move, 5-day momentum and distance from the 20-day average, each
  scaled by the stock's own volatility (a 1% move in ITC is not a 1% move in Adani Ent).
- VOLUME (15%): who is in control. Close location in the day's range plus the direction,
  multiplied by relative volume (session-time adjusted). Up on heavy volume = accumulation,
  down on heavy volume = distribution, any move on thin volume = low conviction.
- NEWS (30%): Google News per company, Indian and global editions, plus the mainstream feeds
  already scanned by the market sentiment engine, scored with the finance lexicon.
- SOCIAL (20%): Indian and global retail forums (Reddit, ValuePickr). Extremes are treated as
  contrarian: a euphoric crowd on a stock is damped, not rewarded.

Missing lenses drop out and the weights renormalise. The index score is the free-float-weight
average of its constituents, blended 80/20 with the macro backdrop (VIX, FII flows, global
cues) when the caller passes it. Psychology notes explain what the reading means for trading.

Payload keys (all optional): ``now`` (ISO), ``indices`` (subset of ids), ``market_context``
({overall_score, india_score, global_score, retail_score}), ``fixtures`` ({charts: {symbol: raw},
news: {"SYMBOL:INDIA"|"SYMBOL:GLOBAL": raw rss}, forums: {source_id: raw}}) so tests never touch
the network, ``cache_dir`` for the last-good cache.
"""
from __future__ import annotations

import json
import math
import os
import re
import statistics
import sys
import tempfile
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from .constituents import STOCKS, configured_indices, yahoo_symbol
from .engine import _fetch, fetch_reddit, load_cache, parse_reddit, parse_rss, save_cache
from .factors import BROWSER_UA
from .lexicon import score_text
from .sources import DEFAULT_SOURCES

IST = timezone(timedelta(hours=5, minutes=30))
CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=3mo"
NEWS_URLS = {
    "INDIA": "https://news.google.com/rss/search?q={query}&hl=en-IN&gl=IN&ceid=IN:en",
    "GLOBAL": "https://news.google.com/rss/search?q={query}&hl=en-US&gl=US&ceid=US:en",
}
# One request each, instead of a Reddit search per stock (anonymous bursts get blocked).
FORUM_SOURCES = [
    {"id": "idx_india_forums", "name": "Indian retail forums (Reddit)", "kind": "reddit", "region": "INDIA", "audience": "RETAIL",
     "url": "https://www.reddit.com/r/IndianStreetBets+IndiaInvestments+StockMarketIndia+DalalStreetTalks+IndianStockMarket/new.json?limit=100"},
    {"id": "idx_global_forums", "name": "Global retail forums (Reddit)", "kind": "reddit", "region": "GLOBAL", "audience": "RETAIL",
     "url": "https://www.reddit.com/r/wallstreetbets+stocks+investing+emergingmarkets/new.json?limit=100"},
]
COMPONENT_WEIGHTS = {"price": 0.35, "volume": 0.15, "news": 0.30, "social": 0.20}
NEWS_HALF_LIFE_HOURS = 18.0
SOCIAL_HALF_LIFE_HOURS = 12.0
MAX_AGE_HOURS = 72.0
POLAR = 0.15
FETCH_WORKERS = 12
FETCH_BUDGET_SECONDS = 40.0
MACRO_BLEND = 0.2
HEAVYWEIGHTS = 5

# Company-level language the index lexicon does not carry.
STOCK_PHRASES: dict[str, float] = {
    "order win": 1.2, "bags order": 1.2, "wins order": 1.2, "secures order": 1.2, "bags contract": 1.2, "wins contract": 1.2,
    "target raised": 1.2, "raises target": 1.2, "raise target": 1.2, "upgrades": 1.0, "downgrades": -1.0, "hikes target": 1.2, "target cut": -1.2, "cuts target": -1.2, "lowers target": -1.2,
    "buy rating": 1.0, "sell rating": -1.0, "overweight": 0.8, "underweight": -0.8, "reiterates buy": 1.0,
    "margin expansion": 1.0, "margins expand": 1.0, "margin pressure": -1.0, "margins contract": -1.0, "raises guidance": 1.5,
    "guidance cut": -1.5, "cuts guidance": -1.5, "beats": 1.0, "misses": -1.0, "profit jumps": 1.5, "profit falls": -1.5,
    "profit declines": -1.5, "record profit": 1.5, "raid": -1.5, "probe": -1.2, "penalty": -1.0, "fraud": -2.0, "resigns": -1.0,
    "stake sale": -0.6, "pledge": -0.8, "npa": -0.8, "slippages": -1.0, "buyback": 1.0, "dividend": 0.4, "expansion": 0.6,
    "acquisition": 0.4, "ban": -1.0, "recall": -1.0, "strike": -0.8, "fii stake": 0.4, "promoter buying": 1.2, "promoter selling": -1.2,
}


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


def score_stock_text(text: str) -> float:
    """Lexicon compound plus company-level phrases, combined so the result stays in [-1, 1]."""
    base = score_text(text)
    lowered = f" {text.lower()} "
    total = sum(weight * len(re.findall(rf"\b{re.escape(phrase)}\b", lowered)) for phrase, weight in STOCK_PHRASES.items())
    extra = total / math.sqrt(total * total + 15.0) if total else 0.0
    return (base + extra) / (1.0 + abs(base * extra))


def alias_patterns(symbol: str) -> list[re.Pattern]:
    aliases = STOCKS.get(symbol, (symbol, "Other", (re.escape(symbol.lower()),)))[2]
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


# ---------- text ----------

def net_tone(items: list[dict], min_polar: int = 2) -> float | None:
    """Weighted net tone of opinionated items with a 1.0 'no opinion' prior; None when too thin."""
    polar = [item for item in items if abs(item["score"]) >= POLAR]
    if len(polar) < min_polar:
        return None
    weight = sum(item["weight"] for item in polar)
    return round(_clamp(100 * sum(item["weight"] * item["score"] for item in polar) / (weight + 1.0)), 1)


def text_items(raw_items: list[dict], patterns: list[re.Pattern], now: datetime, *, half_life: float, require_mention: bool, region_weight: float = 1.0) -> list[dict]:
    seen: set[str] = set()
    items = []
    for item in raw_items:
        title = item.get("title") or ""
        text = f"{title}. {item.get('body') or ''}"
        in_title = mentions(title, patterns)
        if not in_title and (require_mention and not mentions(text, patterns)):
            continue
        key = re.sub(r"[^a-z0-9]", "", title.lower())[:90]
        if not key or key in seen:
            continue
        seen.add(key)
        published = item.get("published") or now
        age = max((now - published).total_seconds() / 3600.0, 0.0)
        if age > MAX_AGE_HOURS:
            continue
        score = score_stock_text(title) * 0.75 + score_stock_text(item["body"]) * 0.25 if item.get("body") else score_stock_text(title)
        engagement = 1.0 + math.log1p(item.get("engagement") or 0) / 3.0
        items.append({
            "title": title[:200], "link": item.get("link", ""), "source": item.get("source", ""), "region": item.get("region", ""),
            "age_hours": round(age, 1), "score": round(score, 3),
            "weight": 0.5 ** (age / half_life) * (1.0 if in_title else 0.4) * engagement * region_weight,
        })
    return items


# ---------- collection ----------

def _news_query(symbol: str) -> str:
    name = STOCKS.get(symbol, (symbol,))[0].split(" (")[0]
    return urllib.parse.quote_plus(f'"{name}" (share OR stock OR shares) when:3d')


def collect(symbols: list[str], index_tickers: dict[str, str], fixtures: dict | None, cache_dir: str | None, now: datetime) -> tuple[dict, dict, list[dict], list[dict], list[dict]]:
    """charts {symbol: chart}, news {symbol: [raw items]}, forum items, feed items, health rows."""
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
        if fixtures is not None:
            raw = (fixtures.get("news") or {}).get(f"{symbol}:{region}")
            parsed = parse_rss(raw) if raw else []
            note(f"news_{region.lower()}", bool(parsed))
            return symbol, [{**item, "source": item.get("source") or f"Google News ({region.title()})", "region": region} for item in parsed]
        error = "time budget used"
        if time.monotonic() <= deadline:
            try:
                parsed = parse_rss(_fetch(NEWS_URLS[region].format(query=_news_query(symbol))))
                if parsed:
                    save_cache(cache_dir, cache_id, parsed, now)
                    note(f"news_{region.lower()}", True)
                    return symbol, [{**item, "source": f"Google News ({region.title()})", "region": region} for item in parsed]
                error = "no items"
            except Exception as failure:  # noqa: BLE001
                error = f"{type(failure).__name__}"
        cached = load_cache(cache_dir, cache_id, now)
        note(f"news_{region.lower()}", bool(cached), f"{symbol}: {error}", cached=bool(cached))
        return symbol, [{**item, "source": f"Google News ({region.title()}, cached)", "region": region} for item in (cached[0] if cached else [])]

    def forum(source: dict) -> list[dict]:
        if fixtures is not None:
            raw = (fixtures.get("forums") or {}).get(source["id"])
            parsed = (parse_reddit(raw) if source["kind"] == "reddit" else parse_rss(raw)) if raw else []
            note("forums", bool(parsed))
        else:
            parsed = []
            try:
                parsed = fetch_reddit(source["url"], deadline)
                save_cache(cache_dir, source["id"], parsed, now)
            except Exception as error:  # noqa: BLE001
                cached = load_cache(cache_dir, source["id"], now)
                parsed = cached[0] if cached else []
                note("forums", bool(parsed), f"{source['name']}: {type(error).__name__}", cached=bool(parsed))
            else:
                note("forums", True)
        return [{**item, "source": source["name"], "region": source["region"]} for item in parsed]

    with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
        chart_jobs = [pool.submit(chart, symbol, yahoo_symbol(symbol)) for symbol in symbols]
        chart_jobs += [pool.submit(chart, index_id, ticker) for index_id, ticker in index_tickers.items()]
        news_jobs = [pool.submit(news, symbol, region) for symbol in symbols for region in ("INDIA", "GLOBAL")]
        forum_jobs = [pool.submit(forum, source) for source in FORUM_SOURCES]
        charts = dict(job.result() for job in chart_jobs)
        news_items: dict[str, list[dict]] = {}
        for job in news_jobs:
            symbol, items = job.result()
            news_items.setdefault(symbol, []).extend(items)
        forum_items = [item for job in forum_jobs for item in job.result()]

    # Reuse the market sentiment engine's last scan (its cache) for mainstream feeds and forums.
    feed_news: list[dict] = []
    if fixtures is None:
        for source in DEFAULT_SOURCES:
            cached = load_cache(cache_dir, source["id"], now)
            if not cached:
                continue
            rows = [{**item, "source": source["name"], "region": source["region"]} for item in cached[0]]
            (forum_items if source["audience"] == "RETAIL" else feed_news).extend(rows)
    else:
        for source in DEFAULT_SOURCES:
            raw = (fixtures.get("feeds") or {}).get(source["id"])
            if raw:
                rows = parse_reddit(raw) if source["kind"] == "reddit" else parse_rss(raw)
                (forum_items if source["audience"] == "RETAIL" else feed_news).extend({**item, "source": source["name"], "region": source["region"]} for item in rows)

    labels = {"market_data": "Yahoo Finance prices & volume", "news_india": "Google News India (per stock)", "news_global": "Google News global (per stock)", "forums": "Retail forums (Reddit, ValuePickr)"}
    health_rows = [{"id": key, "name": labels.get(key, key), **{k: v for k, v in row.items() if k != "id"}} for key, row in health.items()]
    return charts, news_items, forum_items, feed_news, health_rows


# ---------- scoring ----------

def score_stock(symbol: str, chart: dict | None, news_raw: list[dict], feed_news: list[dict], forums: list[dict], now: datetime) -> dict:
    name, sector, _ = STOCKS.get(symbol, (symbol, "Other", ()))
    patterns = alias_patterns(symbol)
    market = market_lenses(chart, now) if chart else None

    news = text_items(news_raw, patterns, now, half_life=NEWS_HALF_LIFE_HOURS, require_mention=False)
    news = [{**item, "weight": item["weight"] * (0.8 if item["region"] == "GLOBAL" else 1.0)} for item in news]
    news += text_items(feed_news, patterns, now, half_life=NEWS_HALF_LIFE_HOURS, require_mention=True)
    social = text_items(forums, patterns, now, half_life=SOCIAL_HALF_LIFE_HOURS, require_mention=True)
    news_score = net_tone(news)
    social_score = net_tone(social)

    notes: list[str] = []
    social_used = social_score
    if social_score is not None and len(social) >= 8 and abs(social_score) >= 55:
        social_used = round(social_score * 0.6, 1)
        notes.append("Crowded long on retail forums: euphoria is a contrarian warning, don't chase." if social_score > 0
                     else "Retail capitulation on forums: panic often marks short-term lows.")
    components = {
        "price": market["price_score"] if market else None,
        "volume": market["volume_score"] if market else None,
        "news": news_score,
        "social": social_used,
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

    ranked = sorted(news + social, key=lambda item: item["weight"] * abs(item["score"]), reverse=True)
    return {
        "symbol": symbol, "name": name, "sector": sector, "score": score, "label": _label(score),
        "confidence": "HIGH" if weight >= 0.8 else "MEDIUM" if weight >= 0.5 else "LOW" if weight else "NONE",
        "components": components, "social_raw": social_score,
        "price": market["price"] if market else None, "change_pct": market["change_pct"] if market else None,
        "five_day_pct": market["five_day_pct"] if market else None, "vs_20dma_pct": market["vs_20dma_pct"] if market else None,
        "volume_ratio": market["volume_ratio"] if market else None,
        "news_count": len(news), "social_count": len(social), "notes": notes,
        "headlines": [{"title": item["title"], "link": item["link"], "source": item["source"], "score": round(item["score"] * 100), "age_hours": item["age_hours"]} for item in ranked[:4]],
    }


def _weighted(rows: list[tuple[float, float]]) -> float | None:
    total = sum(weight for weight, _ in rows)
    return round(sum(weight * value for weight, value in rows) / total, 1) if total else None


def psychology(index_id: str, name: str, score: float | None, stocks: list[dict], weights: dict[str, float], parts: dict, macro: float | None, sectors: list[dict], breadth: dict) -> tuple[list[str], str]:
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


def analyze_index(index_id: str, spec: dict, stock_rows: dict[str, dict], index_chart: dict | None, macro: float | None, now: datetime) -> dict:
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
        "constituents": constituent_score, "price": lens("price", stocks), "volume": lens("volume", stocks), "news": lens("news", stocks),
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
    notes, bias = psychology(index_id, spec["name"], score, stocks, weights, parts, macro, sectors, breadth)

    quote = None
    if index_chart:
        rows = index_chart["rows"]
        quote = {"price": round(rows[-1]["close"], 2), "change_pct": round((rows[-1]["close"] / rows[-2]["close"] - 1) * 100, 2) if rows[-2]["close"] else None}
    return {
        "id": index_id, "name": spec["name"], "score": score, "label": _label(score), "zone": _zone(score), "bias": bias,
        "constituent_score": constituent_score, "macro_score": macro, "lenses": parts, "breadth": breadth, "sectors": sectors,
        "drivers": {"positive": [pick(s) for s in reversed(contributions) if s["contribution"] > 0][:5], "negative": [pick(s) for s in contributions if s["contribution"] < 0][:5]},
        "psychology": notes, "quote": quote,
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
    charts, news_items, forum_items, feed_news, health = collect(symbols, {key: table[key]["yahoo"] for key in wanted if table[key].get("yahoo")}, fixtures, cache_dir, now)
    stock_rows = {symbol: score_stock(symbol, charts.get(symbol), news_items.get(symbol, []), feed_news, forum_items, now) for symbol in symbols}
    return {
        "generated_at": now.isoformat(),
        "indices": [analyze_index(key, table[key], stock_rows, charts.get(key), macro, now) for key in wanted],
        "market_context": context or None,
        "sources": health,
        "method": "Each constituent is scored -100..+100 from price action (35%: day move, 5-day momentum and distance from the 20-DMA, scaled by the stock's own volatility), "
                  "volume (15%: close location and direction times session-adjusted relative volume, i.e. accumulation vs distribution), news (30%: Google News India + global editions "
                  "per company and the mainstream market feeds, finance lexicon, 18 h recency half-life) and social (20%: Indian and global retail forums, 12 h half-life, extremes damped "
                  "as contrarian). Missing lenses drop out. The index score is the free-float-weighted average of its constituents, blended 80/20 with the macro backdrop (India VIX, "
                  "FII/DII flows, global cues, retail mood) when available. Weights are approximate and normalised; scores are a reading of sentiment, not a trade signal.",
    }


def main() -> None:
    raw = sys.stdin.read()
    payload = json.loads(raw) if raw.strip() else {}
    print(json.dumps(analyze_indices(payload), default=str))


if __name__ == "__main__":
    main()
