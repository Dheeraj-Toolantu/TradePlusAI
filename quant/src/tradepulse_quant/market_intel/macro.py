"""Global macro & commodity backdrop for Indian index options.

India imports ~85% of its crude, so oil, the dollar and the rupee move FII flows into
NIFTY/BANKNIFTY/SENSEX before the open; US index futures and Asian markets set the
overnight risk tone. Each instrument's day change is normalised by its typical daily
move, signed by its historical impact on Indian equities and weighted, giving a
-100 (headwind) .. +100 (tailwind) score. Weights are initial values to be backtested.

stdin/stdout JSON entry point: ``python -m tradepulse_quant.market_intel.macro``.
Payload keys (optional): ``fixtures`` ({yahoo_symbol: raw chart JSON}) so tests and
offline runs never touch the network.
"""
from __future__ import annotations

import json
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

USER_AGENT = "Mozilla/5.0 (TradePulseMacro/1.0; market research)"
TIMEOUT_SECONDS = 6
CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=5d"

# impact: +1 = rising helps Indian equities, -1 = rising hurts. scale = a "normal" daily % move.
INSTRUMENTS: list[dict] = [
    {"id": "brent", "name": "Brent crude", "symbol": "BZ=F", "impact": -1, "weight": 1.5, "scale": 2.0, "why": "India imports most of its oil: costlier crude widens the deficit, lifts inflation and hurts OMCs, paints and airlines."},
    {"id": "wti", "name": "WTI crude", "symbol": "CL=F", "impact": -1, "weight": 0.5, "scale": 2.0, "why": "Confirms the Brent move."},
    {"id": "usdinr", "name": "USD/INR", "symbol": "INR=X", "impact": -1, "weight": 1.25, "scale": 0.35, "why": "A weaker rupee makes foreign investors (FIIs) sell Indian equities."},
    {"id": "dxy", "name": "US Dollar index", "symbol": "DX-Y.NYB", "impact": -1, "weight": 0.75, "scale": 0.5, "why": "A strong dollar pulls money out of emerging markets."},
    {"id": "us10y", "name": "US 10Y yield", "symbol": "^TNX", "impact": -1, "weight": 0.75, "scale": 2.0, "why": "Higher US yields make Indian equities less attractive to FIIs."},
    {"id": "spx_fut", "name": "S&P 500 futures", "symbol": "ES=F", "impact": 1, "weight": 1.25, "scale": 1.0, "why": "Global risk appetite; GIFT Nifty tracks it overnight."},
    {"id": "ndx_fut", "name": "Nasdaq futures", "symbol": "NQ=F", "impact": 1, "weight": 0.5, "scale": 1.3, "why": "Drives Indian IT stocks."},
    {"id": "nikkei", "name": "Nikkei 225", "symbol": "^N225", "impact": 1, "weight": 0.5, "scale": 1.2, "why": "Asian session tone before and during Indian hours."},
    {"id": "hangseng", "name": "Hang Seng", "symbol": "^HSI", "impact": 1, "weight": 0.5, "scale": 1.5, "why": "China/Asia risk tone; metals follow it."},
    {"id": "gold", "name": "Gold", "symbol": "GC=F", "impact": -1, "weight": 0.5, "scale": 1.0, "why": "A sharp gold rally signals risk-off (safe-haven demand)."},
    {"id": "copper", "name": "Copper", "symbol": "HG=F", "impact": 1, "weight": 0.25, "scale": 1.5, "why": "Global growth proxy; helps metal stocks."},
]


def _fetch(symbol: str) -> str:
    url = CHART_URL.format(symbol=urllib.parse.quote(symbol, safe=""))
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:  # noqa: S310 - fixed public quote URL
        return response.read(1_000_000).decode("utf-8", errors="replace")


def parse_chart(raw: str) -> dict | None:
    """Yahoo v8 chart JSON -> {price, previous_close, change_pct}. None when unusable."""
    try:
        result = json.loads(raw)["chart"]["result"][0]
    except (KeyError, IndexError, TypeError, ValueError):
        return None
    meta = result.get("meta") or {}
    closes = [c for c in ((result.get("indicators") or {}).get("quote") or [{}])[0].get("close") or [] if isinstance(c, (int, float))]
    price = meta.get("regularMarketPrice")
    if not isinstance(price, (int, float)):
        price = closes[-1] if closes else None
    previous = meta.get("previousClose")
    if not isinstance(previous, (int, float)):
        previous = closes[-2] if len(closes) >= 2 else meta.get("chartPreviousClose")
    if not isinstance(price, (int, float)) or not isinstance(previous, (int, float)) or price <= 0 or previous <= 0:
        return None
    return {"price": float(price), "previous_close": float(previous), "change_pct": (float(price) / float(previous) - 1.0) * 100.0}


def fetch_quotes(fixtures: dict[str, str] | None = None) -> dict[str, dict]:
    def load(item: dict) -> tuple[str, dict | None]:
        try:
            raw = fixtures[item["symbol"]] if fixtures is not None else _fetch(item["symbol"])
        except Exception:  # noqa: BLE001 - one dead feed must not sink the scan
            return item["id"], None
        return item["id"], parse_chart(raw)

    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(load, INSTRUMENTS))
    return {key: quote for key, quote in results if quote is not None}


def score_macro(quotes: object) -> dict:
    """Score already-fetched quotes ({id: {price, change_pct}}). Missing instruments are skipped."""
    if not isinstance(quotes, dict) or not quotes:
        return {"available": False, "reason": "Global market quotes unavailable", "score": 0.0, "label": "UNAVAILABLE", "drivers": []}
    drivers: list[dict] = []
    total = weight_sum = 0.0
    for item in INSTRUMENTS:
        quote = quotes.get(item["id"])
        if not isinstance(quote, dict):
            continue
        try:
            change = float(quote["change_pct"])
        except (KeyError, TypeError, ValueError):
            continue
        if change != change:
            continue
        normalised = max(-1.0, min(1.0, change / item["scale"]))
        contribution = item["impact"] * normalised * item["weight"]
        total += contribution
        weight_sum += item["weight"]
        effect = "TAILWIND" if contribution > 0.05 * item["weight"] else "HEADWIND" if contribution < -0.05 * item["weight"] else "NEUTRAL"
        drivers.append({"id": item["id"], "name": item["name"], "price": quote.get("price"), "change_pct": round(change, 2), "effect": effect, "contribution": round(contribution, 3), "why": item["why"]})
    if not drivers:
        return {"available": False, "reason": "Global market quotes unavailable", "score": 0.0, "label": "UNAVAILABLE", "drivers": []}
    # Normalise by the full weight so a half-loaded scan cannot produce an extreme score.
    full_weight = sum(item["weight"] for item in INSTRUMENTS)
    score = 100.0 * total / max(full_weight * 0.6, weight_sum)
    score = max(-100.0, min(100.0, score))
    label = "STRONG_TAILWIND" if score >= 35 else "TAILWIND" if score >= 12 else "STRONG_HEADWIND" if score <= -35 else "HEADWIND" if score <= -12 else "NEUTRAL"
    drivers.sort(key=lambda d: abs(d["contribution"]), reverse=True)
    crude = next((d for d in drivers if d["id"] == "brent"), None)
    notes = []
    if crude and abs(crude["change_pct"]) >= 2.0:
        notes.append(f"Brent {crude['change_pct']:+.1f}%: {'oil shock, bearish for India' if crude['change_pct'] > 0 else 'oil relief, bullish for India'}.")
    rupee = next((d for d in drivers if d["id"] == "usdinr"), None)
    if rupee and abs(rupee["change_pct"]) >= 0.3:
        notes.append(f"Rupee {'weakening' if rupee['change_pct'] > 0 else 'strengthening'} ({rupee['change_pct']:+.2f}% USD/INR): expect FII {'selling' if rupee['change_pct'] > 0 else 'buying'}.")
    return {"available": True, "score": round(score, 1), "label": label, "drivers": drivers, "notes": notes, "coverage": f"{len(drivers)}/{len(INSTRUMENTS)}"}


def main() -> None:
    raw = sys.stdin.read()
    payload = json.loads(raw) if raw.strip() else {}
    quotes = fetch_quotes(payload.get("fixtures"))
    print(json.dumps({"quotes": quotes, **score_macro(quotes)}))


if __name__ == "__main__":
    main()
