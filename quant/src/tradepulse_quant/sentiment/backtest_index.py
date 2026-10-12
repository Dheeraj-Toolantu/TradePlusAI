"""Point-in-time validation of the index sentiment scanner.

For every trading day D in the window the scanner is replayed *as of 09:00 IST on D* (before the
open) using only information published before that moment, and its reading is compared with what
the market did on D:

- prices/volume: daily bars up to the close of D-1 (D's bar is used only as the outcome);
- news: Google News headlines per company published in the lookback window before 09:00 IST
  (default: since the previous close, ~18 h; the live scanner's 8 h window leaves almost nothing
  pre-market);
- events: NSE historical block/bulk deals dated before D, plus event headlines;
- retail positioning: NSE participant OI from the last file published before D (D's own file is
  only published that evening).

Not replayable, so excluded: the live order book, forum posts (Reddit has no history API),
Tickertape MMI, filings/calendar and the macro composite. The validated scanner is therefore
price + volume + news + events (+ participant OI for the contrarian desk); the report says so.

Metrics per index: directional hit rate of |score| >= 12 calls vs the day's return (close D-1 to
close D) and vs the open-to-close move, exact binomial p-value against a coin flip, Pearson and
Spearman correlation of score and return, average return after bullish vs bearish calls, and the
naive baselines (always up, yesterday's direction, opposite of yesterday). Cross-sectional: daily
Spearman rank IC between stock scores and stock returns (overall and per lens) and the top-minus-
bottom quintile return spread. Contrarian desk: hit rate of its calls when it made one.

stdin JSON payload (all optional): ``days`` (trading days, default 22), ``end`` (YYYY-MM-DD, last
day to test; default the last completed session), ``indices``, ``lookback_hours`` (default 18),
``news`` (bool, default true), ``fixtures`` ({charts: {symbol: raw}, news: {symbol: raw rss},
participant_oi: {YYYY-MM-DD: raw csv}, deals: {block|bulk: raw}}). ``--report PATH`` also writes a
Markdown report.
"""
from __future__ import annotations

import json
import math
import statistics
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, time as dtime, timedelta, timezone

from . import index_engine
from .constituents import STOCKS, configured_indices, yahoo_symbol
from .corporate_events import parse_deals
from .engine import _fetch, parse_rss
from .factors import BROWSER_UA, NSE_HOME
from .index_engine import _nse_opener, analyze_index, parse_chart, score_stock
from .retail_desk import PARTICIPANT_OI_URL, parse_participant_oi, retail_desk

IST = timezone(timedelta(hours=5, minutes=30))
CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=6mo"
NEWS_URL = "https://news.google.com/rss/search?q={query}&hl=en-IN&gl=IN&ceid=IN:en"
DEALS_URL = "https://www.nseindia.com/api/historical/{kind}-deals?from={start}&to={end}"
CALL = 12.0
LENSES = ("price", "volume", "news", "events")


# ---------- data ----------

def _bars_by_day(chart: dict) -> dict[date, dict]:
    return {datetime.fromtimestamp(row["t"], tz=timezone.utc).astimezone(IST).date(): row for row in chart["rows"]}


def fetch_history(symbols: list[str], index_tickers: dict[str, str], start: date, end: date, lookback_hours: float, with_news: bool, fixtures: dict | None) -> dict:
    errors: list[str] = []

    def chart(key: str, ticker: str):
        try:
            raw = (fixtures.get("charts") or {}).get(key) if fixtures is not None else _fetch(CHART_URL.format(symbol=urllib.parse.quote(ticker)), BROWSER_UA)
            return key, parse_chart(raw) if raw else None
        except Exception as error:  # noqa: BLE001
            errors.append(f"chart {key}: {type(error).__name__}")
            return key, None

    def news(symbol: str):
        if not with_news:
            return symbol, []
        try:
            if fixtures is not None:
                raw = (fixtures.get("news") or {}).get(symbol)
            else:
                name = STOCKS.get(symbol, (symbol,))[0].split(" (")[0]
                after, before = start - timedelta(days=2), end + timedelta(days=1)
                query = urllib.parse.quote_plus(f'"{name}" (share OR stock OR shares OR results) after:{after.isoformat()} before:{before.isoformat()}')
                raw = _fetch(NEWS_URL.format(query=query))
            items = parse_rss(raw) if raw else []
            return symbol, [{**item, "source": item.get("publisher") or "Google News", "region": "INDIA"} for item in items]
        except Exception as error:  # noqa: BLE001
            errors.append(f"news {symbol}: {type(error).__name__}")
            return symbol, []

    def participant(day: date):
        try:
            raw = (fixtures.get("participant_oi") or {}).get(day.isoformat()) if fixtures is not None else _fetch(PARTICIPANT_OI_URL.format(date=day.strftime("%d%m%Y")), BROWSER_UA)
            return day, parse_participant_oi(raw) if raw else None
        except Exception:  # noqa: BLE001 - holidays 404
            return day, None

    days = [start - timedelta(days=offset) for offset in range(1, 6)] + [start + timedelta(days=offset) for offset in range((end - start).days + 1)]
    with ThreadPoolExecutor(max_workers=10) as pool:
        chart_jobs = [pool.submit(chart, symbol, yahoo_symbol(symbol)) for symbol in symbols] + [pool.submit(chart, key, ticker) for key, ticker in index_tickers.items()]
        news_jobs = [pool.submit(news, symbol) for symbol in symbols]
        oi_jobs = [pool.submit(participant, day) for day in days if day.weekday() < 5]
        charts = {key: value for key, value in (job.result() for job in chart_jobs) if value}
        news_items = dict(job.result() for job in news_jobs)
        participants = {day: rows for day, rows in (job.result() for job in oi_jobs) if rows}

    deals: list[dict] = []
    if fixtures is not None:
        for kind in ("block", "bulk"):
            deals += parse_deals((fixtures.get("deals") or {}).get(kind), kind.upper())
    else:
        try:
            opener = _nse_opener()
            for kind in ("block", "bulk"):
                url = DEALS_URL.format(kind=kind, start=(start - timedelta(days=10)).strftime("%d-%m-%Y"), end=end.strftime("%d-%m-%Y"))
                request = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA, "Accept": "application/json", "Referer": NSE_HOME})
                with opener.open(request, timeout=15) as response:  # noqa: S310 - NSE public API
                    deals += parse_deals(response.read(8_000_000).decode("utf-8", errors="replace"), kind.upper())
        except Exception as error:  # noqa: BLE001
            errors.append(f"NSE deals: {type(error).__name__}")
    return {"charts": charts, "news": news_items, "participants": participants, "deals": deals, "errors": errors}


# ---------- replay ----------

def truncate(chart: dict, day: date) -> dict | None:
    rows = [row for row in chart["rows"] if datetime.fromtimestamp(row["t"], tz=timezone.utc).astimezone(IST).date() < day]
    return {"rows": rows} if len(rows) >= 6 else None


def replay_day(day: date, table: dict, wanted: list[str], data: dict, lookback_hours: float) -> dict:
    as_of = datetime.combine(day, dtime(9, 0), tzinfo=IST).astimezone(timezone.utc)
    window_start = as_of - timedelta(hours=lookback_hours)
    symbols = sorted({symbol for key in wanted for symbol in table[key]["weights"]})
    deals = [deal for deal in data["deals"] if deal["date"] and deal["date"] < as_of]
    nse = {"deals": deals, "announcements": [], "actions": [], "calendar": []}
    rows = {}
    for symbol in symbols:
        chart = data["charts"].get(symbol)
        news = [item for item in data["news"].get(symbol, []) if item.get("published") and window_start <= item["published"] < as_of]
        rows[symbol] = score_stock(symbol, truncate(chart, day) if chart else None, news, [], [], None, as_of, nse)
    indices = []
    for key in wanted:
        chart = data["charts"].get(key)
        indices.append(analyze_index(key, table[key], rows, truncate(chart, day) if chart else None, None, as_of, {}))
    published = sorted((d, r) for d, r in data["participants"].items() if d < day)[-2:][::-1]
    desk = retail_desk(indices, {}, as_of, None, ([(d.isoformat(), r) for d, r in published], None if published else "no participant OI before this day"))
    return {"indices": indices, "desk": desk, "stocks": rows}


def outcome(chart: dict | None, day: date) -> dict | None:
    if not chart:
        return None
    bars = _bars_by_day(chart)
    previous = [d for d in bars if d < day]
    if day not in bars or not previous:
        return None
    today, before = bars[day], bars[max(previous)]
    return {"day": (today["close"] / before["close"] - 1) * 100, "intraday": (today["close"] / today["open"] - 1) * 100 if today["open"] else None,
            "gap": (today["open"] / before["close"] - 1) * 100}


# ---------- statistics ----------

def _ranks(values: list[float]) -> list[float]:
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        for k in range(i, j + 1):
            ranks[order[k]] = (i + j) / 2 + 1
        i = j + 1
    return ranks


def pearson(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 3 or statistics.pstdev(xs) == 0 or statistics.pstdev(ys) == 0:
        return None
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    return cov / math.sqrt(sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in ys))


def spearman(xs: list[float], ys: list[float]) -> float | None:
    return pearson(_ranks(xs), _ranks(ys)) if len(xs) >= 3 else None


def binomial_p(hits: int, n: int) -> float | None:
    """Exact two-sided p-value of `hits` successes in `n` fair coin flips."""
    if n == 0:
        return None
    probability = lambda k: math.comb(n, k) / 2 ** n
    observed = probability(hits)
    return min(1.0, sum(probability(k) for k in range(n + 1) if probability(k) <= observed + 1e-12))


def directional(pairs: list[tuple[float, float]]) -> dict:
    """pairs of (signal, return); a call is |signal| >= CALL, flat days (|ret| < 0.05%) are skipped."""
    calls = [(s, r) for s, r in pairs if abs(s) >= CALL and abs(r) >= 0.05]
    hits = sum(1 for s, r in calls if (s > 0) == (r > 0))
    bull = [r for s, r in calls if s > 0]
    bear = [r for s, r in calls if s < 0]
    return {"calls": len(calls), "hits": hits, "hit_rate": round(100 * hits / len(calls), 1) if calls else None, "p_value": round(binomial_p(hits, len(calls)), 3) if calls else None,
            "avg_return_after_bullish": round(statistics.fmean(bull), 3) if bull else None, "avg_return_after_bearish": round(statistics.fmean(bear), 3) if bear else None,
            "bullish_calls": len(bull), "bearish_calls": len(bear)}


def _r(value: float | None, digits: int = 3) -> float | None:
    return round(value, digits) if value is not None else None


# ---------- run ----------

def trading_days(chart: dict, end: date | None, days: int) -> list[date]:
    available = sorted(_bars_by_day(chart))
    if end:
        available = [d for d in available if d <= end]
    return available[-days:]


def run(payload: dict | None = None) -> dict:
    payload = payload or {}
    table = configured_indices()
    wanted = [key for key in (payload.get("indices") or list(table)) if key in table]
    days = int(payload.get("days") or 22)
    lookback = float(payload.get("lookback_hours") or 18.0)
    end = date.fromisoformat(payload["end"]) if payload.get("end") else None
    fixtures = payload.get("fixtures")
    symbols = sorted({symbol for key in wanted for symbol in table[key]["weights"]})
    tickers = {key: table[key]["yahoo"] for key in wanted}

    # Probe the first index for the trading calendar, then fetch everything for that window.
    anchor_end = end or datetime.now(IST).date()
    data = fetch_history(symbols, tickers, anchor_end - timedelta(days=int(days * 1.6) + 10), anchor_end, lookback, payload.get("news", True), fixtures)
    reference = next((data["charts"].get(key) for key in wanted if data["charts"].get(key)), None)
    if reference is None:
        return {"ok": False, "error": "No index price history: market data unreachable", "fetch_errors": data["errors"][:20]}
    test_days = trading_days(reference, end, days)

    saved = index_engine.MAX_AGE_HOURS
    index_engine.MAX_AGE_HOURS = lookback  # replay window, not the live 8 h freshness window
    try:
        replays = {day: replay_day(day, table, wanted, data, lookback) for day in test_days}
    finally:
        index_engine.MAX_AGE_HOURS = saved

    report: dict = {"ok": True, "days": [d.isoformat() for d in test_days], "lookback_hours": lookback, "indices": {}, "fetch_errors": data["errors"][:20],
                    "coverage": {"charts": len(data["charts"]), "symbols": len(symbols), "news_items": sum(len(v) for v in data["news"].values()),
                                 "participant_oi_days": len(data["participants"]), "deals": len(data["deals"])}}
    for key in wanted:
        chart = data["charts"].get(key)
        rows, ics, lens_ics, spreads = [], [], {lens: [] for lens in LENSES}, []
        previous_return = None
        for day in test_days:
            reading = next(index for index in replays[day]["indices"] if index["id"] == key)
            result = outcome(chart, day)
            if result is None or reading["score"] is None:
                continue
            desk = next((row for row in replays[day]["desk"]["indices"] if row["id"] == key), None)
            rows.append({"date": day.isoformat(), "score": reading["score"], "zone": reading["zone"], "label": reading["label"], "day_return": _r(result["day"]),
                         "intraday_return": _r(result["intraday"]), "gap": _r(result["gap"]), "previous_return": _r(previous_return),
                         "contrarian": desk["contrarian"]["bias"] if desk else None, "crowd_score": desk["crowd_score"] if desk else None,
                         "lenses": {lens: reading["lenses"].get(lens) for lens in LENSES}})
            previous_return = result["day"]
            # Cross-section: stock score vs stock return on D.
            pairs = []
            for stock in reading["constituents"]:
                stock_result = outcome(data["charts"].get(stock["symbol"]), day)
                if stock_result is not None and stock["score"] is not None:
                    pairs.append((stock, stock_result["day"]))
            if len(pairs) >= 8:
                ic = spearman([s["score"] for s, _ in pairs], [r for _, r in pairs])
                if ic is not None:
                    ics.append(ic)
                for lens in LENSES:
                    live = [(s["components"][lens], r) for s, r in pairs if s["components"].get(lens) is not None]
                    if len(live) >= 8:
                        value = spearman([x for x, _ in live], [r for _, r in live])
                        if value is not None:
                            lens_ics[lens].append(value)
                ranked = sorted(pairs, key=lambda pair: pair[0]["score"])
                quint = max(1, len(ranked) // 5)
                spreads.append(statistics.fmean(r for _, r in ranked[-quint:]) - statistics.fmean(r for _, r in ranked[:quint]))
        scores = [row["score"] for row in rows]
        returns = [row["day_return"] for row in rows]
        contrarian_pairs = [((1 if "BULLISH" in row["contrarian"] else -1) * 100, row["day_return"]) for row in rows if row["contrarian"] and row["contrarian"] not in ("NONE", "NO_DATA")]
        mean_ic = statistics.fmean(ics) if ics else None
        ic_t = mean_ic / (statistics.stdev(ics) / math.sqrt(len(ics))) if len(ics) >= 3 and statistics.stdev(ics) > 0 else None
        report["indices"][key] = {
            "name": table[key]["name"], "days_scored": len(rows),
            "scanner_vs_day": directional(list(zip(scores, returns))),
            "scanner_vs_open_to_close": directional([(row["score"], row["intraday_return"]) for row in rows if row["intraday_return"] is not None]),
            "pearson": _r(pearson(scores, returns)), "spearman": _r(spearman(scores, returns)),
            "baselines": {
                "always_up": directional([(100.0, r) for r in returns]),
                "yesterday_direction": directional([(100.0 if row["previous_return"] > 0 else -100.0, row["day_return"]) for row in rows if row["previous_return"] is not None]),
                "opposite_of_yesterday": directional([(-100.0 if row["previous_return"] > 0 else 100.0, row["day_return"]) for row in rows if row["previous_return"] is not None]),
            },
            "lens_vs_day": {lens: {"spearman": _r(spearman([row["lenses"][lens] for row in rows if row["lenses"][lens] is not None], [row["day_return"] for row in rows if row["lenses"][lens] is not None]))} for lens in LENSES},
            "cross_section": {"days": len(ics), "mean_rank_ic": _r(mean_ic), "ic_t_stat": _r(ic_t, 2), "positive_ic_days": sum(1 for ic in ics if ic > 0),
                              "lens_mean_ic": {lens: _r(statistics.fmean(values)) if values else None for lens, values in lens_ics.items()},
                              "top_minus_bottom_quintile_pct": _r(statistics.fmean(spreads)) if spreads else None},
            "contrarian_desk": directional(contrarian_pairs),
            "daily": rows,
        }
    return report


def markdown(report: dict) -> str:
    if not report.get("ok"):
        return f"# Sentiment scanner validation\n\nNot run: {report.get('error')}\n"
    pct = lambda value: "--" if value is None else f"{value:.1f}%"
    num = lambda value, digits=2: "--" if value is None else f"{value:+.{digits}f}"
    lines = [f"# Sentiment scanner validation ({report['days'][0]} to {report['days'][-1]})", "",
             f"Replayed at 09:00 IST each day with a {report['lookback_hours']:.0f} h news lookback. Coverage: {report['coverage']}.", ""]
    for key, item in report["indices"].items():
        scan, base = item["scanner_vs_day"], item["baselines"]
        cs = item["cross_section"]
        lines += [f"## {item['name']} ({item['days_scored']} days)", "",
                  "| Signal | Calls | Hit rate | p-value | Avg return after bullish / bearish |", "|---|---|---|---|---|",
                  f"| Scanner (close-to-close) | {scan['calls']} | {pct(scan['hit_rate'])} | {scan['p_value']} | {num(scan['avg_return_after_bullish'])}% / {num(scan['avg_return_after_bearish'])}% |",
                  f"| Scanner (open-to-close) | {item['scanner_vs_open_to_close']['calls']} | {pct(item['scanner_vs_open_to_close']['hit_rate'])} | {item['scanner_vs_open_to_close']['p_value']} | |",
                  f"| Always up | {base['always_up']['calls']} | {pct(base['always_up']['hit_rate'])} | {base['always_up']['p_value']} | |",
                  f"| Yesterday's direction | {base['yesterday_direction']['calls']} | {pct(base['yesterday_direction']['hit_rate'])} | {base['yesterday_direction']['p_value']} | |",
                  f"| Opposite of yesterday | {base['opposite_of_yesterday']['calls']} | {pct(base['opposite_of_yesterday']['hit_rate'])} | {base['opposite_of_yesterday']['p_value']} | |",
                  f"| Contrarian desk | {item['contrarian_desk']['calls']} | {pct(item['contrarian_desk']['hit_rate'])} | {item['contrarian_desk']['p_value']} | |", "",
                  f"Score vs day return: Pearson {num(item['pearson'])}, Spearman {num(item['spearman'])}. Per lens Spearman: "
                  + ", ".join(f"{lens} {num(value['spearman'])}" for lens, value in item["lens_vs_day"].items()) + ".", "",
                  f"Cross-section (stock score vs same-day stock return): mean rank IC {num(cs['mean_rank_ic'], 3)} (t {num(cs['ic_t_stat'])}, positive on {cs['positive_ic_days']}/{cs['days']} days), "
                  f"top-minus-bottom quintile {num(cs['top_minus_bottom_quintile_pct'])}% per day. Lens ICs: " + ", ".join(f"{lens} {num(value, 3)}" for lens, value in cs["lens_mean_ic"].items()) + ".", "",
                  "| Date | Score | Zone | Day % | Open-to-close % | Contrarian |", "|---|---|---|---|---|---|"]
        lines += [f"| {row['date']} | {row['score']:+.0f} | {row['zone']} | {num(row['day_return'])} | {num(row['intraday_return'])} | {row['contrarian']} |" for row in item["daily"]]
        lines.append("")
    if report["fetch_errors"]:
        lines += ["Fetch errors (first 20): " + "; ".join(report["fetch_errors"]), ""]
    return "\n".join(lines)


def main() -> None:
    raw = sys.stdin.read() if not sys.stdin.isatty() else ""
    payload = json.loads(raw) if raw.strip() else {}
    report = run(payload)
    if "--report" in sys.argv:
        with open(sys.argv[sys.argv.index("--report") + 1], "w", encoding="utf-8") as handle:
            handle.write(markdown(report))
    print(json.dumps(report, default=str))


if __name__ == "__main__":
    main()
