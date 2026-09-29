"""Fetch public feeds concurrently, score items, and aggregate retail vs. media sentiment.

stdin/stdout JSON entry point: ``python -m tradepulse_quant.sentiment.engine``.
Payload keys (all optional): ``now`` (ISO), ``sources`` (override list), ``fixtures``
({source_id: raw feed text}) so tests and offline runs never touch the network.
"""
from __future__ import annotations

import html
import json
import math
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

from .lexicon import event_flags, relevance, score_text
from .sources import configured_sources

USER_AGENT = "TradePulseSentiment/1.0 (+market research; contact: operator)"
TIMEOUT_SECONDS = 8
MAX_BYTES = 3_000_000
HALF_LIFE_HOURS = 6.0
MAX_AGE_HOURS = 36.0
TAG = re.compile(r"<[^>]+>")
POLAR_THRESHOLD = 0.15
# Pseudo-weight of "no opinion" that a handful of opinionated items must outweigh before the
# score moves far from zero; with dozens of items it is negligible.
PRIOR_WEIGHT = 1.0


def _strip_publisher(title: str, publisher: str | None) -> str:
    """Google News titles end in " - Publisher"; names like "NDTV Profit" were being scored."""
    if publisher and title.endswith(f" - {publisher}"):
        return title[: -len(publisher) - 3].strip()
    return title


def _fetch(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/xml, application/json;q=0.9, */*;q=0.5"})
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:  # noqa: S310 - fixed public feed URLs
        return response.read(MAX_BYTES).decode("utf-8", errors="replace")


def _clean(text: str | None) -> str:
    return re.sub(r"\s+", " ", html.unescape(TAG.sub(" ", text or ""))).strip()


def _parse_date(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def parse_rss(raw: str) -> list[dict]:
    """RSS 2.0 and Atom. Namespaces are stripped so both shapes read the same."""
    try:
        root = ET.fromstring(raw.lstrip("﻿").strip())
    except ET.ParseError:
        return []
    for element in root.iter():
        if isinstance(element.tag, str) and "}" in element.tag:
            element.tag = element.tag.split("}", 1)[1]
    items = []
    for node in list(root.iter("item")) + list(root.iter("entry")):
        link_node = node.find("link")
        link = (link_node.text or link_node.get("href") or "") if link_node is not None else ""
        publisher = _clean(node.findtext("source")) or None
        title = _clean(node.findtext("title"))
        body = _clean(node.findtext("description") or node.findtext("summary") or node.findtext("content"))
        items.append({
            "title": _strip_publisher(title, publisher),
            # Google News descriptions only repeat the headline and publisher; score the title alone.
            "body": "" if publisher and body.startswith(title[:40]) else body[:600],
            "link": link.strip(),
            "published": _parse_date(node.findtext("pubDate") or node.findtext("published") or node.findtext("updated")),
            "engagement": 0,
        })
    return [item for item in items if item["title"]]


def parse_reddit(raw: str) -> list[dict]:
    try:
        children = json.loads(raw)["data"]["children"]
    except (ValueError, KeyError, TypeError):
        return []
    items = []
    for child in children:
        data = child.get("data", {}) if isinstance(child, dict) else {}
        if data.get("stickied") or data.get("over_18"):
            continue
        created = data.get("created_utc")
        items.append({
            "title": _clean(data.get("title")),
            "body": _clean(data.get("selftext"))[:600],
            "link": f"https://www.reddit.com{data.get('permalink', '')}",
            "published": datetime.fromtimestamp(float(created), tz=timezone.utc) if created else None,
            "engagement": max(int(data.get("score") or 0), 0) + 2 * max(int(data.get("num_comments") or 0), 0),
        })
    return [item for item in items if item["title"]]


def reddit_rss_url(url: str) -> str:
    """https://www.reddit.com/r/X/new.json?limit=50 -> https://www.reddit.com/r/X/new/.rss?limit=50"""
    base, _, query = url.partition("?")
    base = base[:-5] if base.endswith(".json") else base
    return f"{base.rstrip('/')}/.rss" + (f"?{query}" if query else "")


def collect(sources: list[dict], fixtures: dict[str, str] | None) -> tuple[list[dict], list[dict]]:
    def load(source: dict) -> tuple[dict, list[dict], str | None]:
        try:
            raw = fixtures[source["id"]] if fixtures is not None and source["id"] in fixtures else (None if fixtures is not None else _fetch(source["url"]))
            if raw is None:
                return source, [], "No fixture supplied"
            parsed = parse_reddit(raw) if source["kind"] == "reddit" else parse_rss(raw)
            return source, parsed, None if parsed else "Feed returned no readable items"
        except Exception as error:  # network, TLS, HTTP errors: reported per source, never fatal
            if source["kind"] == "reddit" and fixtures is None:
                # Reddit often refuses unauthenticated .json; its public Atom feed usually still works.
                try:
                    parsed = parse_rss(_fetch(reddit_rss_url(source["url"])))
                    if parsed:
                        return source, parsed, None
                except Exception:  # noqa: BLE001 - report the original error below
                    pass
            return source, [], f"{type(error).__name__}: {str(error)[:120]}"

    items: list[dict] = []
    health: list[dict] = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for source, parsed, error in pool.map(load, sources):
            health.append({"id": source["id"], "name": source.get("name", source["id"]), "region": source["region"], "audience": source["audience"], "ok": error is None, "items": len(parsed), "error": error})
            for item in parsed:
                items.append({**item, "source": source.get("name", source["id"]), "region": source["region"], "audience": source["audience"]})
    return items, health


def _label(score: float) -> str:
    if score >= 40:
        return "VERY_BULLISH"
    if score >= 12:
        return "BULLISH"
    if score <= -40:
        return "VERY_BEARISH"
    if score <= -12:
        return "BEARISH"
    return "NEUTRAL"


def aggregate(items: list[dict]) -> dict:
    """Net tone of the opinionated items, relevance- and recency-weighted.

    Averaging over every item let the ~60% of purely factual headlines (score 0) drag the
    reading to "neutral": a 700-point Sensex fall with 31% bearish vs 12% bullish items showed
    -11. The score now averages only items that express a direction, with a small prior so a
    few posts cannot swing it to an extreme; the counts show how many items were neutral.
    """
    total_weight = polar_weight = weighted = bull_weight = bear_weight = 0.0
    polar_items = 0
    for item in items:
        total_weight += item["weight"]
        if abs(item["score"]) < POLAR_THRESHOLD:
            continue
        polar_items += 1
        polar_weight += item["weight"]
        weighted += item["weight"] * item["score"]
        if item["score"] > 0:
            bull_weight += item["weight"]
        else:
            bear_weight += item["weight"]
    score = round(100 * weighted / (polar_weight + PRIOR_WEIGHT), 1) if polar_weight else 0.0
    count = len(items)
    # Shares are relevance/recency weighted like the score, so a pile of single-stock
    # "profit rises" items cannot show "38% bull" beside a bearish index reading.
    return {
        "score": score,
        "label": _label(score) if count >= 5 and polar_items >= 3 else "INSUFFICIENT_DATA",
        "items": count,
        "bullish_pct": round(100 * bull_weight / total_weight, 1) if total_weight else 0.0,
        "bearish_pct": round(100 * bear_weight / total_weight, 1) if total_weight else 0.0,
    }


def analyze_sentiment(payload: dict | None = None) -> dict:
    payload = payload or {}
    try:
        now = datetime.fromisoformat(str(payload["now"]).replace("Z", "+00:00")) if payload.get("now") else datetime.now(timezone.utc)
    except ValueError:
        now = datetime.now(timezone.utc)
    sources = payload.get("sources") or configured_sources()
    raw_items, health = collect(sources, payload.get("fixtures"))

    seen: set[str] = set()
    scored: list[dict] = []
    for item in raw_items:
        key = re.sub(r"[^a-z0-9]", "", item["title"].lower())[:90]
        if key in seen:
            continue
        seen.add(key)
        published = item["published"] or now
        age_hours = max((now - published).total_seconds() / 3600.0, 0.0)
        if age_hours > MAX_AGE_HOURS:
            continue
        text = f"{item['title']}. {item['body']}"
        topic, topic_weight = relevance(text)
        score = score_text(item["title"]) * 0.7 + score_text(item["body"]) * 0.3 if item["body"] else score_text(item["title"])
        recency = 0.5 ** (age_hours / HALF_LIFE_HOURS)
        engagement = 1.0 + math.log1p(item["engagement"]) / 3.0 if item["audience"] == "RETAIL" else 1.0
        scored.append({
            "title": item["title"][:220], "link": item["link"], "source": item["source"], "region": item["region"], "audience": item["audience"],
            "published": published.isoformat(), "age_hours": round(age_hours, 1), "score": round(score, 3), "topic": topic,
            "weight": recency * engagement * topic_weight, "events": event_flags(text),
        })

    def subset(**filters: str) -> list[dict]:
        return [item for item in scored if all(item[key] == value for key, value in filters.items())]

    india = subset(region="INDIA")
    india_retail = subset(region="INDIA", audience="RETAIL")
    india_news = subset(region="INDIA", audience="NEWS")
    global_items = subset(region="GLOBAL")
    summary = {
        "india": aggregate(india),
        "india_retail": aggregate(india_retail),
        "india_news": aggregate(india_news),
        "global": aggregate(global_items),
        "global_retail": aggregate(subset(region="GLOBAL", audience="RETAIL")),
        "global_news": aggregate(subset(region="GLOBAL", audience="NEWS")),
    }
    retail = summary["india_retail"]
    contrarian = None
    if retail["items"] >= 15 and retail["score"] >= 45 and retail["bullish_pct"] >= 70:
        contrarian = "Retail crowd is euphoric. Historically a late-rally warning: tighten stops, avoid chasing calls."
    elif retail["items"] >= 15 and retail["score"] <= -45 and retail["bearish_pct"] >= 70:
        contrarian = "Retail crowd is panicking. Capitulation often marks short-term lows: avoid chasing puts."
    divergence = None
    if summary["india_retail"]["label"] not in ("INSUFFICIENT_DATA", "NEUTRAL") and summary["india_news"]["label"] not in ("INSUFFICIENT_DATA", "NEUTRAL") and (summary["india_retail"]["score"] > 0) != (summary["india_news"]["score"] > 0):
        divergence = f"Retail forums are {summary['india_retail']['label'].lower().replace('_', ' ')} while news media is {summary['india_news']['label'].lower().replace('_', ' ')}."

    events: dict[str, dict] = {}
    for item in sorted(scored, key=lambda entry: entry["age_hours"]):
        if item["age_hours"] > 18:
            continue
        for name in item["events"]:
            events.setdefault(name, {"event": name, "mentions": 0, "latest": item["title"], "link": item["link"], "age_hours": item["age_hours"]})
            events[name]["mentions"] += 1
    event_risk = sorted((event for event in events.values() if event["mentions"] >= 2), key=lambda event: -event["mentions"])

    ranked = sorted((item for item in india if abs(item["score"]) >= 0.2), key=lambda item: item["weight"] * abs(item["score"]), reverse=True)
    public = lambda item: {key: item[key] for key in ("title", "link", "source", "audience", "published", "age_hours", "score", "topic")}
    return {
        "generated_at": now.isoformat(),
        "summary": summary,
        "contrarian_note": contrarian,
        "divergence": divergence,
        "event_risk": event_risk[:5],
        "top_bullish": [public(item) for item in ranked if item["score"] > 0][:5],
        "top_bearish": [public(item) for item in ranked if item["score"] < 0][:5],
        "global_headlines": [public(item) for item in sorted(global_items, key=lambda item: item["weight"] * abs(item["score"]), reverse=True)][:5],
        "sources": health,
        "sources_ok": sum(1 for source in health if source["ok"]),
        "sources_total": len(health),
        "method": "Finance lexicon scoring (incl. Indian retail slang), 6-hour recency half-life, engagement-weighted forums and relevance weighting (index news 1.0, India macro 0.7, global macro 0.6, other 0.35, single-stock items 0.15). The score is the weighted net tone of items that express a direction; neutral headlines are counted but do not dilute it. Scores range -100 (max bearish) to +100.",
    }


def main() -> None:
    raw = sys.stdin.read()
    payload = json.loads(raw) if raw.strip() else {}
    print(json.dumps(analyze_sentiment(payload), default=str))


if __name__ == "__main__":
    main()
