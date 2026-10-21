"""Commodity sentiment: crude oil, natural gas, gold, silver and copper.

stdin/stdout JSON entry point: ``python -m tradepulse_quant.sentiment.commodity_engine``.

Each commodity is scored -100 (bearish for its price) .. +100 (bullish) from three lenses:

- price: today's change, normalised by the commodity's typical daily move (45%)
- trend: 5-day change and distance from the 20-day average (25%)
- news: tone of the last few hours of Google News headlines about it (30%)

Commodity news is about the price, so a headline is read by its price verbs first ("crude
surges", "gold slips") and falls back to the stock lexicon only when it has none.

``india_impact`` turns the reading into what it means for Indian equities: costlier crude and
gas hurt India (an importer), a gold rally signals risk-off, firmer copper helps metal stocks.

Payload keys (all optional): ``now`` (ISO), ``fixtures`` ({charts: {yahoo symbol: raw JSON},
news: {commodity id: raw RSS}}), ``cache_dir``.
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from .engine import _fetch, load_cache, parse_rss, save_cache
from .factors import BROWSER_UA
from .stock_text import score_stock_text

CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=1mo"
NEWS_URL = "https://news.google.com/rss/search?q={query}&hl=en-IN&gl=IN&ceid=IN:en"
MAX_AGE_HOURS = 12.0
NEWS_HALF_LIFE_HOURS = 4.0
BUDGET_SECONDS = 25.0
WEIGHTS = {"price": 0.45, "trend": 0.25, "news": 0.30}

# scale = a "normal" daily % move. india: +1 = a rising price helps Indian equities, -1 = hurts.
COMMODITIES: list[dict] = [
    {"id": "CRUDEOIL", "name": "Crude oil (Brent)", "symbol": "BZ=F", "unit": "$/bbl", "scale": 2.0, "india": -1,
     "query": '("crude oil" OR brent OR "oil prices" OR opec) when:1d', "terms": r"crude|oil|brent|wti|opec",
     "why": "India imports ~85% of its oil: costlier crude widens the deficit, lifts inflation and hurts OMCs, paints, airlines."},
    {"id": "NATURALGAS", "name": "Natural gas", "symbol": "NG=F", "unit": "$/mmBtu", "scale": 3.5, "india": -1,
     "query": '("natural gas" OR lng OR "gas prices") when:1d', "terms": r"natural gas|\bgas\b|lng|henry hub",
     "why": "Costlier gas lifts input costs for city-gas, fertiliser and power companies."},
    {"id": "GOLD", "name": "Gold", "symbol": "GC=F", "unit": "$/oz", "scale": 1.0, "india": -1,
     "query": '("gold price" OR "gold prices" OR "gold rate" OR bullion) when:1d', "terms": r"gold|bullion|yellow metal",
     "why": "A gold rally is safe-haven demand: risk-off for equities."},
    {"id": "SILVER", "name": "Silver", "symbol": "SI=F", "unit": "$/oz", "scale": 1.8, "india": -1,
     "query": '("silver price" OR "silver prices" OR "silver rate") when:1d', "terms": r"silver",
     "why": "Moves with gold (haven) and industrial demand."},
    {"id": "COPPER", "name": "Copper", "symbol": "HG=F", "unit": "$/lb", "scale": 1.5, "india": 1,
     "query": '("copper price" OR "copper prices" OR lme copper) when:1d', "terms": r"copper|base metal|\blme\b",
     "why": "A global growth gauge: firmer copper helps metal stocks."},
]

UP = re.compile(r"\b(surg\w*|soar\w*|jump\w*|climb\w*|rall(?:y|ies|ied)|rise[sn]?|rising|rose|gain\w*|advanc\w*|firm\w*|spike[sd]?|spiking|rebound\w*|recover\w*|"
                r"up\b|higher|highest|record high|\d+-(?:week|month|year) high|bull\w*|tighten\w*|supply cut\w*|output cut\w*|shortage)")
DOWN = re.compile(r"\b(slump\w*|plung\w*|tumbl\w*|fall(?:s|ing)?|fell|drop\w*|slid\w*|slip\w*|declin\w*|retreat\w*|sink\w*|sank|crash\w*|eas(?:e|es|ed|ing)|"
                  r"lower|lowest|down\b|\d+-(?:week|month|year) low|bear\w*|glut|oversuppl\w*|weak\w*|demand worr\w*|demand concern\w*)")

CAUSE = re.compile(r"\s(?:as|on|after|amid|despite|while|ahead of|due to|following|but)\s")


def _clamp(value: float, low: float = -100.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def _label(score: float | None) -> str:
    if score is None:
        return "NO_DATA"
    return "STRONG_BULLISH" if score >= 40 else "BULLISH" if score >= 12 else "STRONG_BEARISH" if score <= -40 else "BEARISH" if score <= -12 else "NEUTRAL"


def score_headline(text: str) -> float:
    """-1..+1 for the commodity's price: price verbs first, the general lexicon as a fallback."""
    lowered = text.lower()
    # "Gold slips as dollar firms": the main clause says what the commodity did, the rest says why.
    for part in (CAUSE.split(lowered, maxsplit=1)[0], lowered):
        up, down = len(UP.findall(part)), len(DOWN.findall(part))
        if up != down:
            return max(-1.0, min(1.0, 0.6 * (up - down)))
    return score_stock_text(text)


def parse_chart(raw: str) -> dict | None:
    """Yahoo v8 daily chart -> price, day change, 5-day change and distance from the 20-day average."""
    try:
        result = json.loads(raw)["chart"]["result"][0]
    except (KeyError, IndexError, TypeError, ValueError):
        return None
    meta = result.get("meta") or {}
    closes = [c for c in ((result.get("indicators") or {}).get("quote") or [{}])[0].get("close") or [] if isinstance(c, (int, float)) and c > 0]
    price = meta.get("regularMarketPrice") if isinstance(meta.get("regularMarketPrice"), (int, float)) else (closes[-1] if closes else None)
    previous = meta.get("previousClose") if isinstance(meta.get("previousClose"), (int, float)) else (closes[-2] if len(closes) >= 2 else meta.get("chartPreviousClose"))
    if not isinstance(price, (int, float)) or not isinstance(previous, (int, float)) or price <= 0 or previous <= 0:
        return None
    window = closes[-20:]
    five_ago = closes[-6] if len(closes) >= 6 else None
    return {
        "price": round(float(price), 3), "change_pct": round((price / previous - 1) * 100, 2),
        "five_day_pct": round((price / five_ago - 1) * 100, 2) if five_ago else None,
        "vs_20dma_pct": round((price / (sum(window) / len(window)) - 1) * 100, 2) if len(window) >= 10 else None,
    }


def news_tone(items: list[dict], terms: str, now: datetime) -> tuple[float | None, list[dict]]:
    """Recency-weighted tone of fresh headlines that name the commodity; None when fewer than 2 have a view."""
    pattern = re.compile(terms, re.I)
    seen: set[str] = set()
    scored = []
    for item in items:
        title = item.get("title") or ""
        key = re.sub(r"[^a-z0-9]", "", title.lower())[:90]
        if not key or key in seen or not item.get("published") or not pattern.search(title):
            continue
        seen.add(key)
        age = (now - item["published"]).total_seconds() / 3600.0
        if age < 0 or age > MAX_AGE_HOURS:
            continue
        score = score_headline(title)
        scored.append({"title": title[:200], "link": item.get("link", ""), "source": item.get("publisher") or "", "age_hours": round(age, 1),
                       "score": round(score, 2), "weight": 0.5 ** (age / NEWS_HALF_LIFE_HOURS)})
    polar = [item for item in scored if abs(item["score"]) >= 0.15]
    scored.sort(key=lambda item: item["age_hours"])
    headlines = [{key: value for key, value in item.items() if key != "weight"} for item in scored[:5]]
    if len(polar) < 2:
        return None, headlines
    weight = sum(item["weight"] for item in polar)
    return round(_clamp(100 * sum(item["weight"] * item["score"] for item in polar) / (weight + 0.5)), 1), headlines


def score_commodity(spec: dict, chart: dict | None, news: float | None) -> dict:
    lenses: dict[str, float | None] = {"price": None, "trend": None, "news": news}
    if chart:
        lenses["price"] = round(_clamp(100 * chart["change_pct"] / spec["scale"]), 1)
        trend = [value for value in ((chart["five_day_pct"] or 0) / (2.2 * spec["scale"]) if chart["five_day_pct"] is not None else None,
                                     (chart["vs_20dma_pct"] or 0) / (3.0 * spec["scale"]) if chart["vs_20dma_pct"] is not None else None) if value is not None]
        lenses["trend"] = round(_clamp(100 * sum(trend) / len(trend)), 1) if trend else None
    available = {key: value for key, value in lenses.items() if value is not None}
    score = round(sum(WEIGHTS[key] * value for key, value in available.items()) / sum(WEIGHTS[key] for key in available), 1) if available else None
    impact = None if score is None else round(spec["india"] * score, 1)
    return {
        "id": spec["id"], "name": spec["name"], "symbol": spec["symbol"], "unit": spec["unit"], "score": score, "label": _label(score),
        "price": chart["price"] if chart else None, "change_pct": chart["change_pct"] if chart else None,
        "five_day_pct": chart["five_day_pct"] if chart else None, "vs_20dma_pct": chart["vs_20dma_pct"] if chart else None,
        "lenses": lenses, "india_impact": impact, "india_label": _label(impact), "why": spec["why"],
    }


def scan(payload: dict | None = None) -> dict:
    payload = payload or {}
    try:
        now = datetime.fromisoformat(str(payload["now"]).replace("Z", "+00:00")) if payload.get("now") else datetime.now(timezone.utc)
    except ValueError:
        now = datetime.now(timezone.utc)
    fixtures = payload.get("fixtures")
    cache_dir = payload.get("cache_dir") or (None if fixtures is not None else os.environ.get("SENTIMENT_CACHE_DIR") or os.path.join(tempfile.gettempdir(), "tradepulse-sentiment"))
    deadline = time.monotonic() + BUDGET_SECONDS
    errors: list[str] = []

    def chart(spec: dict) -> dict | None:
        try:
            raw = (fixtures.get("charts") or {}).get(spec["symbol"]) if fixtures is not None else _fetch(CHART_URL.format(symbol=urllib.parse.quote(spec["symbol"], safe="")), BROWSER_UA)
            return parse_chart(raw) if raw else None
        except Exception as failure:  # noqa: BLE001 - one dead quote never sinks the scan
            errors.append(f"{spec['id']} price: {type(failure).__name__}")
            return None

    def news(spec: dict) -> list[dict]:
        cache_id = f"commodity_news_{spec['id']}"
        if fixtures is not None:
            return parse_rss((fixtures.get("news") or {}).get(spec["id"]) or "")
        if time.monotonic() > deadline:
            return (load_cache(cache_dir, cache_id, now) or ([], 0))[0]
        try:
            items = parse_rss(_fetch(NEWS_URL.format(query=urllib.parse.quote_plus(spec["query"]))))
            if items:
                save_cache(cache_dir, cache_id, items, now)
                return items
        except Exception as failure:  # noqa: BLE001 - fall back to the last good read
            errors.append(f"{spec['id']} news: {type(failure).__name__}")
        return (load_cache(cache_dir, cache_id, now) or ([], 0))[0]

    with ThreadPoolExecutor(max_workers=8) as pool:
        charts = list(pool.map(chart, COMMODITIES))
        news_items = list(pool.map(news, COMMODITIES))
    rows = []
    for spec, quote, items in zip(COMMODITIES, charts, news_items):
        tone, headlines = news_tone(items, spec["terms"], now)
        rows.append({**score_commodity(spec, quote, tone), "headlines": headlines})
    notes = []
    crude = rows[0]
    if crude["score"] is not None and abs(crude["score"]) >= 35:
        notes.append(f"Crude sentiment {crude['score']:+.0f}: {'oil strength is a headwind for India (OMCs, paints, aviation, rupee)' if crude['score'] > 0 else 'softer oil is a tailwind for India (OMCs, paints, aviation, rupee)'}.")
    gold = next(row for row in rows if row["id"] == "GOLD")
    if gold["score"] is not None and gold["score"] >= 40:
        notes.append("Gold is bid strongly: safe-haven demand, a risk-off tell for equities.")
    return {
        "generated_at": now.isoformat(), "commodities": rows, "notes": notes, "errors": errors[:10],
        "method": "Score -100..+100 for each commodity's own price: 45% today's move (vs its typical daily move), 25% 5-day and 20-day trend, 30% tone of "
                  f"the last {MAX_AGE_HOURS:g} h of headlines. India impact flips the sign where a rising price hurts Indian equities (crude, gas, gold, silver).",
    }


def main() -> None:
    raw = sys.stdin.read()
    print(json.dumps(scan(json.loads(raw) if raw.strip() else {}), default=str))


if __name__ == "__main__":
    main()
