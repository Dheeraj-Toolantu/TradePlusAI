"""Fetch public feeds concurrently, score items, and aggregate retail vs. media sentiment.

stdin/stdout JSON entry point: ``python -m tradepulse_quant.sentiment.engine``.
Payload keys (all optional): ``now`` (ISO), ``sources`` (override list), ``fixtures``
({source_id: raw feed text}) and ``factor_fixtures`` (see ``factors.fetch_raw``) so tests and
offline runs never touch the network; ``cache_dir`` overrides the last-good feed cache location.

Reddit: with REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET set, subreddits are read through Reddit's
official OAuth API (app-only), which is not subject to the anonymous "403 Blocked" wall. Without
them, subreddits are fetched one at a time (Reddit blocks bursts of anonymous requests) with a
Reddit-style User-Agent (override: REDDIT_USER_AGENT), falling back www → old.reddit JSON → RSS.
Any source that fails serves its last good scan (up to 12 h, marked as cached) instead of nothing.
"""
from __future__ import annotations

import base64
import html
import json
import math
import os
import re
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

from .factors import composites, market_factors, text_factors
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


# Reddit asks API clients for "<platform>:<app id>:<version> (by /u/<username>)" and blocks generic agents.
REDDIT_USER_AGENT = os.environ.get("REDDIT_USER_AGENT", "").strip() or "web:tradepulse-sentiment:1.2 (market research bot)"
REDDIT_SPACING_SECONDS = 1.5
# All subreddits share this budget so a fully blocked Reddit cannot stall the scan; the rest serve their cache.
REDDIT_BUDGET_SECONDS = 25.0
CACHE_MAX_HOURS = 12.0


def _fetch(url: str, user_agent: str = USER_AGENT, headers: dict | None = None) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": user_agent, "Accept": "application/rss+xml, application/xml, application/json;q=0.9, */*;q=0.5", **(headers or {})})
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:  # noqa: S310 - fixed public feed URLs
        return response.read(MAX_BYTES).decode("utf-8", errors="replace")


_reddit_token: dict = {}


def _reddit_oauth_token() -> str | None:
    """App-only OAuth token (client_credentials) when REDDIT_CLIENT_ID/SECRET are configured."""
    client_id, secret = os.environ.get("REDDIT_CLIENT_ID", "").strip(), os.environ.get("REDDIT_CLIENT_SECRET", "").strip()
    if not client_id or not secret:
        return None
    if _reddit_token.get("expires", 0) > time.time() + 60:
        return _reddit_token["value"]
    auth = base64.b64encode(f"{client_id}:{secret}".encode()).decode()
    request = urllib.request.Request("https://www.reddit.com/api/v1/access_token", data=b"grant_type=client_credentials", method="POST",
                                     headers={"User-Agent": REDDIT_USER_AGENT, "Authorization": f"Basic {auth}", "Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:  # noqa: S310 - Reddit's token endpoint
        body = json.loads(response.read(100_000).decode("utf-8"))
    _reddit_token.update(value=body["access_token"], expires=time.time() + float(body.get("expires_in", 3600)))
    return _reddit_token["value"]


def reddit_candidates(url: str) -> list[tuple[str, str]]:
    """(url, kind) attempts for one subreddit, most reliable first."""
    base, _, query = url.partition("?")
    path = urllib.parse.urlparse(base).path  # /r/X/new.json
    json_path = path if path.endswith(".json") else f"{path.rstrip('/')}.json"
    suffix = f"?{query}" if query else ""
    return [(f"https://www.reddit.com{json_path}{suffix}", "json"), (f"https://old.reddit.com{json_path}{suffix}", "json"),
            (reddit_rss_url(f"https://www.reddit.com{json_path}{suffix}"), "rss"), (reddit_rss_url(f"https://old.reddit.com{json_path}{suffix}"), "rss")]


def fetch_reddit(url: str, deadline: float | None = None) -> list[dict]:
    """OAuth when configured, else anonymous JSON/RSS attempts. Raises the last error if all fail."""
    token = _reddit_oauth_token()
    if token:
        path = urllib.parse.urlparse(url).path.removesuffix(".json")
        query = urllib.parse.urlparse(url).query
        raw = _fetch(f"https://oauth.reddit.com{path}?{query + '&' if query else ''}raw_json=1", REDDIT_USER_AGENT, {"Authorization": f"bearer {token}"})
        return parse_reddit(raw)
    last_error: Exception | None = None
    for attempt, (candidate, kind) in enumerate(reddit_candidates(url)):
        if deadline is not None and time.monotonic() > deadline:
            break
        if attempt:
            time.sleep(0.5)
        try:
            raw = _fetch(candidate, REDDIT_USER_AGENT)
            parsed = parse_reddit(raw) if kind == "json" else parse_rss(raw)
            if parsed:
                return parsed
        except Exception as error:  # noqa: BLE001 - try the next endpoint
            last_error = error
    raise last_error or ValueError("Reddit returned no readable items")


def _cache_path(cache_dir: str, source_id: str) -> str:
    return os.path.join(cache_dir, f"{re.sub(r'[^a-z0-9_]', '_', source_id.lower())}.json")


def save_cache(cache_dir: str | None, source_id: str, items: list[dict], now: datetime) -> None:
    if not cache_dir:
        return
    try:
        os.makedirs(cache_dir, exist_ok=True)
        rows = [{**item, "published": item["published"].isoformat() if item.get("published") else None} for item in items]
        with open(_cache_path(cache_dir, source_id), "w", encoding="utf-8") as handle:
            json.dump({"saved_at": now.isoformat(), "items": rows}, handle)
    except OSError:
        pass


def load_cache(cache_dir: str | None, source_id: str, now: datetime) -> tuple[list[dict], float] | None:
    """Last good items for a source if saved within CACHE_MAX_HOURS: (items, age in hours)."""
    if not cache_dir:
        return None
    try:
        with open(_cache_path(cache_dir, source_id), encoding="utf-8") as handle:
            body = json.load(handle)
        age = (now - datetime.fromisoformat(body["saved_at"])).total_seconds() / 3600.0
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if age > CACHE_MAX_HOURS or age < 0:
        return None
    items = [{**item, "published": datetime.fromisoformat(item["published"]) if item.get("published") else None} for item in body.get("items", [])]
    return (items, age) if items else None


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


def collect(sources: list[dict], fixtures: dict[str, str] | None, cache_dir: str | None = None, now: datetime | None = None) -> tuple[list[dict], list[dict]]:
    now = now or datetime.now(timezone.utc)

    reddit_deadline = time.monotonic() + REDDIT_BUDGET_SECONDS

    def live(source: dict) -> list[dict]:
        if fixtures is not None:
            if source["id"] not in fixtures:
                raise LookupError("No fixture supplied")
            raw = fixtures[source["id"]]
            return parse_reddit(raw) if source["kind"] == "reddit" else parse_rss(raw)
        if source["kind"] == "reddit":
            if time.monotonic() > reddit_deadline:
                raise TimeoutError(f"skipped: Reddit time budget ({REDDIT_BUDGET_SECONDS:.0f} s) used up")
            return fetch_reddit(source["url"], reddit_deadline)
        return parse_rss(_fetch(source["url"]))

    def load(source: dict) -> tuple[dict, list[dict], str | None, float | None]:
        try:
            parsed = live(source)
            if parsed:
                save_cache(cache_dir, source["id"], parsed, now)
                return source, parsed, None, None
            error = "Feed returned no readable items"
        except Exception as failure:  # network, TLS, HTTP errors: reported per source, never fatal
            error = f"{type(failure).__name__}: {str(failure)[:120]}"
        cached = load_cache(cache_dir, source["id"], now)
        if cached:
            return source, cached[0], error, cached[1]
        return source, [], error, None

    def load_reddit_serially(group: list[dict]) -> list[tuple]:
        # Anonymous Reddit requests in a burst get "403 Blocked": one subreddit at a time, spaced out.
        results = []
        for index, source in enumerate(group):
            if index and fixtures is None:
                time.sleep(REDDIT_SPACING_SECONDS)
            results.append(load(source))
        return results

    reddit_sources = [source for source in sources if source["kind"] == "reddit"]
    other_sources = [source for source in sources if source["kind"] != "reddit"]
    with ThreadPoolExecutor(max_workers=8) as pool:
        reddit_job = pool.submit(load_reddit_serially, reddit_sources)
        results = list(pool.map(load, other_sources)) + reddit_job.result()
    order = {source["id"]: index for index, source in enumerate(sources)}
    results.sort(key=lambda row: order[row[0]["id"]])

    items: list[dict] = []
    health: list[dict] = []
    for source, parsed, error, cached_age in results:
        ok = bool(parsed)
        health.append({"id": source["id"], "name": source.get("name", source["id"]), "region": source["region"], "audience": source["audience"],
                       "ok": ok, "items": len(parsed), "error": error if not ok else None,
                       "cached_hours": round(cached_age, 1) if cached_age is not None else None,
                       "note": f"live fetch failed ({error}); showing the scan from {cached_age:.1f} h ago" if cached_age is not None else None})
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
    fixtures = payload.get("fixtures")
    # The last-good cache is on for live scans; tests opt in with an explicit cache_dir.
    cache_dir = payload.get("cache_dir") or (None if fixtures is not None else os.environ.get("SENTIMENT_CACHE_DIR") or os.path.join(tempfile.gettempdir(), "tradepulse-sentiment"))
    factor_fixtures = payload.get("factor_fixtures")
    with ThreadPoolExecutor(max_workers=1) as factor_pool:
        # Market data is fetched while the feeds are being read; offline runs without factor
        # fixtures skip the network entirely.
        factor_job = factor_pool.submit(market_factors, factor_fixtures if factor_fixtures is not None else ({} if fixtures is not None else None))
        raw_items, health = collect(sources, fixtures, cache_dir, now)
        try:
            market = factor_job.result()
        except Exception as error:  # noqa: BLE001 - factors are additive; the text scan still stands
            market = [{"id": "market_data", "name": "Market data", "group": "INDIA", "weight": 0.0, "why": "", "ok": False, "score": None, "value": None, "error": f"{type(error).__name__}: {str(error)[:100]}"}]

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

    factor_list = [factor for factor in market if factor["id"] != "market_data"] + text_factors(summary)
    composite = composites(factor_list)

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
        "factors": factor_list,
        "composite": composite,
        "method": "Finance lexicon scoring (incl. Indian retail slang), 6-hour recency half-life, engagement-weighted forums and relevance weighting (index news 1.0, India macro 0.7, global macro 0.6, other 0.35, single-stock items 0.15). The score is the weighted net tone of items that express a direction; neutral headlines are counted but do not dilute it. Scores range -100 (max bearish) to +100. Composites add market data: Indian market = NIFTY/BANK NIFTY trend, India VIX, FII/DII flows, breadth and India news; global market = crude, dollar, rupee, US yields and futures, Asia, CBOE VIX and global news; retail mood = India and global forums, Tickertape Market Mood Index, CNN Fear & Greed and StockTwits. Overall = 50% Indian market, 30% global, 20% retail; unavailable factors drop out of the weights.",
    }


def main() -> None:
    raw = sys.stdin.read()
    payload = json.loads(raw) if raw.strip() else {}
    print(json.dumps(analyze_sentiment(payload), default=str))


if __name__ == "__main__":
    main()
