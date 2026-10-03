"""Market factors behind the sentiment composites: what prices, flows and crowd indices say.

News and forum tone alone misses what the market is actually doing. This module adds hard
data and folds everything into three composites plus an overall reading (-100..+100):

- INDIAN MARKET: NIFTY and BANK NIFTY trend (day change + distance from the 20-day average),
  India VIX (level vs its 3-month median, and the day's change), FII/DII cash flows and
  NIFTY 500 breadth (NSE), plus the India news tone.
- GLOBAL MARKET: the global macro score (crude, dollar, rupee, US yields, US futures, Asia; see
  ``market_intel.macro``), the CBOE VIX, and the global news tone.
- RETAIL MOOD: India forum tone, Tickertape's Market Mood Index (India), CNN Fear & Greed and
  StockTwits bull/bear tags (US), and global forum tone. Extremes here are contrarian warnings.

Every factor is fetched independently: a blocked source is reported with its reason and drops
out of the weights, it never fails the scan. Weights are starting values, not backtested.
"""
from __future__ import annotations

import http.cookiejar
import json
import math
import statistics
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from ..market_intel import macro

BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
TIMEOUT_SECONDS = 8
YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=3mo"
NSE_HOME = "https://www.nseindia.com/"
NSE_FII_DII = "https://www.nseindia.com/api/fiidiiTradeReact"
NSE_ALL_INDICES = "https://www.nseindia.com/api/allIndices"
TICKERTAPE_MMI = "https://api.tickertape.in/mmi/now"
CNN_FEAR_GREED = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata"
STOCKTWITS_SPY = "https://api.stocktwits.com/api/2/streams/symbol/SPY.json"

# id -> (group, weight). Text factors come from the news/forum scan in engine.py.
WEIGHTS: dict[str, tuple[str, float]] = {
    "nifty_trend": ("INDIA", 1.5), "banknifty_trend": ("INDIA", 0.75), "india_vix": ("INDIA", 1.0),
    "fii_dii": ("INDIA", 1.0), "breadth": ("INDIA", 0.75), "india_news": ("INDIA", 1.0),
    "global_macro": ("GLOBAL", 1.5), "cboe_vix": ("GLOBAL", 0.75), "global_news": ("GLOBAL", 1.0),
    "india_forums": ("RETAIL", 1.0), "tickertape_mmi": ("RETAIL", 1.25), "cnn_fear_greed": ("RETAIL", 0.75),
    "stocktwits": ("RETAIL", 0.5), "global_forums": ("RETAIL", 0.5),
}
# Overall = what matters for trading Indian index options today.
OVERALL_WEIGHTS = {"INDIA": 0.5, "GLOBAL": 0.3, "RETAIL": 0.2}


def _clamp(value: float) -> float:
    return max(-100.0, min(100.0, value))


def _squash(x: float) -> float:
    """Map an unbounded signal to -100..+100 smoothly (|x| = 1 -> ~76)."""
    return 100.0 * math.tanh(x)


def _get(url: str, opener: urllib.request.OpenerDirector | None = None, headers: dict | None = None) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA, "Accept": "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9", **(headers or {})})
    open_url = opener.open if opener else urllib.request.urlopen
    with open_url(request, timeout=TIMEOUT_SECONDS) as response:  # noqa: S310 - fixed public data URLs
        return response.read(2_000_000).decode("utf-8", errors="replace")


# ---------- parsers (pure; tested with recorded payloads) ----------

def parse_closes(raw: str) -> dict | None:
    """Yahoo v8 chart JSON -> {price, previous_close, closes}."""
    try:
        result = json.loads(raw)["chart"]["result"][0]
    except (KeyError, IndexError, TypeError, ValueError):
        return None
    closes = [float(c) for c in (((result.get("indicators") or {}).get("quote") or [{}])[0].get("close") or []) if isinstance(c, (int, float))]
    meta = result.get("meta") or {}
    price = meta.get("regularMarketPrice")
    price = float(price) if isinstance(price, (int, float)) else (closes[-1] if closes else None)
    if price is None or len(closes) < 2:
        return None
    previous = meta.get("previousClose") or meta.get("chartPreviousClose")
    # When the last close is today's bar, the previous close is the one before it.
    previous = float(previous) if isinstance(previous, (int, float)) and previous > 0 else (closes[-2] if abs(closes[-1] - price) < 1e-9 else closes[-1])
    return {"price": price, "previous_close": previous, "closes": closes}


def score_index_trend(quote: dict, name: str) -> dict:
    """Day change (vs a ~1% normal day) and distance from the 20-day average (vs ~2%)."""
    closes = quote["closes"]
    change = (quote["price"] / quote["previous_close"] - 1.0) * 100.0
    sma20 = statistics.fmean(closes[-20:])
    vs_sma = (quote["price"] / sma20 - 1.0) * 100.0
    score = _squash(0.5 * change / 1.0 + 0.5 * vs_sma / 2.0)
    trend = "above" if vs_sma >= 0 else "below"
    return {"score": round(score, 1), "value": f"{quote['price']:,.0f} ({change:+.2f}% today, {abs(vs_sma):.1f}% {trend} 20-day avg)"}


def score_volatility(quote: dict, name: str) -> dict:
    """Fear gauge: high vs its 3-month median and rising today are bearish for equities."""
    closes = quote["closes"]
    median = statistics.median(closes[-63:])
    level = quote["price"] / median - 1.0
    change = (quote["price"] / quote["previous_close"] - 1.0) * 100.0
    score = _squash(-(level / 0.25) * 0.6 - (change / 8.0) * 0.6)
    return {"score": round(score, 1), "value": f"{quote['price']:.2f} ({change:+.1f}% today; 3-month median {median:.2f})"}


def parse_fii_dii(raw: str) -> dict | None:
    """NSE fiidiiTradeReact -> net cash-market flows in ₹ crore."""
    try:
        rows = json.loads(raw)
    except ValueError:
        return None
    if isinstance(rows, dict):
        rows = rows.get("data") or []
    out: dict = {}
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        category = str(row.get("category", "")).upper()
        try:
            net = float(str(row.get("netValue", "")).replace(",", ""))
        except ValueError:
            continue
        if "FII" in category or "FPI" in category:
            out["fii"] = net
        elif "DII" in category:
            out["dii"] = net
        out.setdefault("date", row.get("date"))
    return out if "fii" in out else None


def score_fii_dii(flows: dict) -> dict:
    """FIIs move the index; domestic institutions often absorb FII selling, so they count half."""
    net = flows["fii"] + 0.5 * flows.get("dii", 0.0)
    score = _squash(net / 3000.0)
    dii = f", DII {flows['dii']:+,.0f}" if "dii" in flows else ""
    return {"score": round(score, 1), "value": f"FII {flows['fii']:+,.0f} cr{dii} cr ({flows.get('date') or 'latest session'})"}


def parse_breadth(raw: str) -> dict | None:
    """NSE allIndices -> advances/declines of NIFTY 500 (or NIFTY 50 if 500 is missing)."""
    try:
        data = json.loads(raw).get("data") or []
    except (ValueError, AttributeError):
        return None
    by_name = {str(row.get("index", "")).upper(): row for row in data if isinstance(row, dict)}
    for name in ("NIFTY 500", "NIFTY 50"):
        row = by_name.get(name)
        if not row:
            continue
        try:
            advances, declines = int(float(row.get("advances", 0))), int(float(row.get("declines", 0)))
        except (TypeError, ValueError):
            continue
        if advances + declines > 0:
            return {"index": name, "advances": advances, "declines": declines}
    return None


def score_breadth(breadth: dict) -> dict:
    ratio = (breadth["advances"] - breadth["declines"]) / (breadth["advances"] + breadth["declines"])
    return {"score": round(_clamp(100.0 * ratio * 1.25), 1), "value": f"{breadth['index']}: {breadth['advances']} up / {breadth['declines']} down"}


def parse_mmi(raw: str) -> float | None:
    """Tickertape Market Mood Index (0 = extreme fear, 100 = extreme greed)."""
    try:
        body = json.loads(raw)
    except ValueError:
        return None
    data = body.get("data", body) if isinstance(body, dict) else {}
    for key in ("indicator", "currentValue", "value", "mmi"):
        value = data.get(key) if isinstance(data, dict) else None
        if isinstance(value, (int, float)) and 0 <= value <= 100:
            return float(value)
    return None


def parse_fear_greed(raw: str) -> dict | None:
    try:
        block = json.loads(raw)["fear_and_greed"]
        score = float(block["score"])
    except (KeyError, TypeError, ValueError):
        return None
    return {"score": score, "rating": str(block.get("rating", ""))} if 0 <= score <= 100 else None


def score_mood_index(value: float, name: str) -> dict:
    zone = "extreme fear" if value < 25 else "fear" if value < 45 else "neutral" if value <= 55 else "greed" if value <= 75 else "extreme greed"
    return {"score": round((value - 50.0) * 2.0, 1), "value": f"{value:.1f} / 100 ({zone})"}


def parse_stocktwits(raw: str) -> dict | None:
    """Bullish/Bearish tags that StockTwits users attach to their own messages."""
    try:
        messages = json.loads(raw)["messages"]
    except (KeyError, TypeError, ValueError):
        return None
    tags = [((m.get("entities") or {}).get("sentiment") or {}).get("basic") for m in messages if isinstance(m, dict)]
    bull, bear = tags.count("Bullish"), tags.count("Bearish")
    return {"bullish": bull, "bearish": bear, "messages": len(messages)} if bull + bear >= 5 else None


def score_stocktwits(tags: dict) -> dict:
    ratio = (tags["bullish"] - tags["bearish"]) / (tags["bullish"] + tags["bearish"] + 2)
    return {"score": round(_clamp(100.0 * ratio), 1), "value": f"SPY: {tags['bullish']} bullish / {tags['bearish']} bearish of {tags['messages']} messages"}


# ---------- fetching ----------

def _nse_opener() -> urllib.request.OpenerDirector:
    """NSE APIs need the cookies its home page sets; fetch it once per scan."""
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    _get(NSE_HOME, opener, {"Accept": "text/html"})
    return opener


def fetch_raw(fixtures: dict | None) -> dict[str, tuple[str | None, str | None]]:
    """{key: (raw, error)}. With fixtures, nothing touches the network."""
    yahoo = {"nifty": "^NSEI", "banknifty": "^NSEBANK", "india_vix": "^INDIAVIX", "cboe_vix": "^VIX"}
    if fixtures is not None:
        keys = [*yahoo, "fii_dii", "breadth", "tickertape_mmi", "cnn_fear_greed", "stocktwits"]
        return {key: (fixtures.get(key), None if key in fixtures else "No fixture supplied") for key in keys}

    def guarded(fn):
        try:
            return fn(), None
        except Exception as error:  # noqa: BLE001 - every source fails on its own
            return None, f"{type(error).__name__}: {str(error)[:100]}"

    def nse_pair():
        try:
            opener = _nse_opener()
        except Exception as error:  # noqa: BLE001
            reason = f"{type(error).__name__}: {str(error)[:100]}"
            return {"fii_dii": (None, reason), "breadth": (None, reason)}
        headers = {"Referer": NSE_HOME}
        return {"fii_dii": guarded(lambda: _get(NSE_FII_DII, opener, headers)), "breadth": guarded(lambda: _get(NSE_ALL_INDICES, opener, headers))}

    jobs = {key: (lambda symbol=symbol: _get(YAHOO_CHART.format(symbol=urllib.parse.quote(symbol, safe="")))) for key, symbol in yahoo.items()}
    jobs["tickertape_mmi"] = lambda: _get(TICKERTAPE_MMI)
    jobs["cnn_fear_greed"] = lambda: _get(CNN_FEAR_GREED, headers={"Referer": "https://edition.cnn.com/", "Origin": "https://edition.cnn.com"})
    jobs["stocktwits"] = lambda: _get(STOCKTWITS_SPY)
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {key: pool.submit(guarded, fn) for key, fn in jobs.items()}
        nse = pool.submit(nse_pair)
        out = {key: future.result() for key, future in futures.items()}
        out.update(nse.result())
    return out


def _factor(fid: str, name: str, why: str, raw_error: tuple[str | None, str | None], parse, score) -> dict:
    group, weight = WEIGHTS[fid]
    base = {"id": fid, "name": name, "group": group, "weight": weight, "why": why, "ok": False, "score": None, "value": None, "error": None}
    raw, error = raw_error
    if raw is None:
        return {**base, "error": error or "unavailable"}
    parsed = parse(raw)
    if parsed is None:
        return {**base, "error": "Unexpected response format"}
    return {**base, "ok": True, **score(parsed)}


def market_factors(fixtures: dict | None = None, macro_quotes: dict | None = None) -> list[dict]:
    raw = fetch_raw(fixtures)
    quotes = macro_quotes if macro_quotes is not None else (macro.fetch_quotes(fixtures.get("macro")) if fixtures is not None and "macro" in fixtures else ({} if fixtures is not None else macro.fetch_quotes()))
    global_macro = macro.score_macro(quotes)
    factors = [
        _factor("nifty_trend", "NIFTY trend", "Where the index is going: today's move and its position vs the 20-day average.", raw["nifty"], parse_closes, lambda q: score_index_trend(q, "NIFTY")),
        _factor("banknifty_trend", "BANK NIFTY trend", "Banks are ~35% of NIFTY and lead its big moves.", raw["banknifty"], parse_closes, lambda q: score_index_trend(q, "BANK NIFTY")),
        _factor("india_vix", "India VIX", "Option-implied fear. High or rising VIX = traders paying up for protection (bearish tilt, bigger swings).", raw["india_vix"], parse_closes, lambda q: score_volatility(q, "India VIX")),
        _factor("fii_dii", "FII / DII flows", "Foreign institutions move the index; domestic funds often absorb their selling (counted half).", raw["fii_dii"], parse_fii_dii, score_fii_dii),
        _factor("breadth", "Market breadth", "How many stocks are rising vs falling: a rally on poor breadth is fragile.", raw["breadth"], parse_breadth, score_breadth),
        _factor("cboe_vix", "CBOE VIX (US)", "Global risk appetite: a US volatility spike usually means FII selling in emerging markets.", raw["cboe_vix"], parse_closes, lambda q: score_volatility(q, "VIX")),
        _factor("tickertape_mmi", "Tickertape Market Mood Index", "India investor mood from FII activity, volatility, momentum, breadth and gold demand (0–100).", raw["tickertape_mmi"], parse_mmi, lambda v: score_mood_index(v, "MMI")),
        _factor("cnn_fear_greed", "CNN Fear & Greed (US)", "US market mood from seven indicators (0–100); extremes are contrarian.", raw["cnn_fear_greed"], parse_fear_greed, lambda v: {**score_mood_index(v["score"], "F&G"), "value": f"{v['score']:.0f} / 100 ({v['rating'] or 'n/a'})"}),
        _factor("stocktwits", "StockTwits bull/bear tags", "Retail traders tag their own posts Bullish or Bearish.", raw["stocktwits"], parse_stocktwits, score_stocktwits),
    ]
    group, weight = WEIGHTS["global_macro"]
    factors.insert(5, {"id": "global_macro", "name": "Global macro (crude, dollar, rupee, yields, US futures, Asia)", "group": group, "weight": weight,
                       "why": "Overnight global cues that set FII flows into Indian equities.", "ok": bool(global_macro.get("available")),
                       "score": global_macro.get("score") if global_macro.get("available") else None,
                       "value": f"{global_macro.get('label', '').replace('_', ' ').lower()} ({global_macro.get('coverage', '0')} instruments)" if global_macro.get("available") else None,
                       "error": None if global_macro.get("available") else global_macro.get("reason")})
    return factors


def text_factors(summary: dict) -> list[dict]:
    """News and forum tone from the feed scan, as factors in the same composites."""
    spec = [("india_news", "India news tone", "india_news", "What Indian financial media is saying."),
            ("global_news", "Global news tone", "global_news", "What global financial media is saying."),
            ("india_forums", "India forum tone", "india_retail", "What Indian retail traders post (r/IndianStreetBets, ValuePickr, …)."),
            ("global_forums", "Global forum tone", "global_retail", "What global retail traders post (r/wallstreetbets, r/stocks).")]
    out = []
    for fid, name, key, why in spec:
        group, weight = WEIGHTS[fid]
        agg = summary.get(key) or {}
        ok = agg.get("label") not in (None, "INSUFFICIENT_DATA")
        out.append({"id": fid, "name": name, "group": group, "weight": weight, "why": why, "ok": ok, "score": agg.get("score") if ok else None,
                    "value": f"{agg.get('items', 0)} items, {agg.get('bullish_pct', 0):.0f}% bull / {agg.get('bearish_pct', 0):.0f}% bear" if ok else None,
                    "error": None if ok else f"Not enough opinionated items ({agg.get('items', 0)})"})
    return out


def _label(score: float) -> str:
    return "VERY_BULLISH" if score >= 40 else "BULLISH" if score >= 12 else "VERY_BEARISH" if score <= -40 else "BEARISH" if score <= -12 else "NEUTRAL"


def composites(factors: list[dict]) -> dict:
    out: dict = {}
    for group in ("INDIA", "GLOBAL", "RETAIL"):
        members = [f for f in factors if f["group"] == group]
        live = [f for f in members if f["ok"] and isinstance(f["score"], (int, float))]
        weight = sum(f["weight"] for f in live)
        if len(live) < 2 or weight <= 0:
            out[group.lower()] = {"score": None, "label": "INSUFFICIENT_DATA", "coverage": f"{len(live)}/{len(members)}"}
            continue
        score = sum(f["score"] * f["weight"] for f in live) / weight
        out[group.lower()] = {"score": round(score, 1), "label": _label(score), "coverage": f"{len(live)}/{len(members)}"}
    parts = [(OVERALL_WEIGHTS[g], out[g.lower()]["score"]) for g in OVERALL_WEIGHTS if out[g.lower()]["score"] is not None]
    if out["india"]["score"] is not None:
        score = sum(w * s for w, s in parts) / sum(w for w, _ in parts)
        out["overall"] = {"score": round(score, 1), "label": _label(score), "coverage": f"{len(parts)}/3 groups"}
    else:
        out["overall"] = {"score": None, "label": "INSUFFICIENT_DATA", "coverage": f"{len(parts)}/3 groups"}
    notes = []
    mmi = next((f for f in factors if f["id"] == "tickertape_mmi" and f["ok"]), None)
    if mmi and mmi["score"] is not None and abs(mmi["score"]) >= 50:
        notes.append("Market Mood Index in extreme greed: late-rally risk, avoid chasing calls." if mmi["score"] > 0 else "Market Mood Index in extreme fear: often near short-term lows, avoid chasing puts.")
    vix = next((f for f in factors if f["id"] == "india_vix" and f["ok"]), None)
    if vix and vix["score"] is not None and vix["score"] <= -60:
        notes.append("India VIX is high and rising: expect wider swings; size down and widen stops.")
    out["notes"] = notes
    return out
