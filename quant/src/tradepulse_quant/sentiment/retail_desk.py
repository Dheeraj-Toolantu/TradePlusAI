"""Retail crowd positioning and the contrarian read on it.

Retail traders as a group are late and over-leveraged at turning points: they buy calls after a
rally, pile into puts after a fall and add to losing index futures longs. This module measures
how stretched the crowd is and what the opposite side of it implies. It only reads public data:

- NSE participant-wise open interest (``fao_participant_oi_DDMMYYYY.csv``, published each
  evening): index futures and index options positions of Client (mostly retail), Pro, FII and
  DII. This is what retail actually holds, not what it says.
- Retail forum mood per index (from the index sentiment scan) and Tickertape's Market Mood Index.
- Per-stock crowding: names retail discusses heavily where its tone disagrees with what volume,
  delivery and the order book say institutions are doing.

The contrarian bias is only given at extremes; a mildly bullish crowd carries no edge. Positioning
is end-of-day (T-1 during market hours) and is a context for sizing and timing, not a signal by itself.
"""
from __future__ import annotations

import csv
import io
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from .factors import BROWSER_UA

IST = timezone(timedelta(hours=5, minutes=30))
PARTICIPANT_OI_URL = "https://archives.nseindia.com/content/nsccl/fao_participant_oi_{date}.csv"
LOOKBACK_DAYS = 8
STRETCHED = 30.0
EXTREME = 55.0
# Futures say more about conviction (margin at risk) than option longs, which are often lottery tickets.
CROWD_WEIGHTS = {"client_futures": 0.35, "client_options": 0.15, "forums": 0.30, "mmi": 0.20}


def _number(value: str) -> float | None:
    try:
        return float(str(value).replace(",", "").strip())
    except ValueError:
        return None


def parse_participant_oi(raw: str) -> dict | None:
    """NSE participant OI CSV -> {participant: {column: contracts}} (title line and spacing tolerated)."""
    lines = [line for line in (raw or "").lstrip("﻿").splitlines() if line.strip()]
    start = next((index for index, line in enumerate(lines) if line.lower().replace('"', "").strip().startswith("client type")), None)
    if start is None:
        return None
    reader = csv.reader(io.StringIO("\n".join(lines[start:])))
    header = [cell.strip().lower() for cell in next(reader)]
    rows: dict[str, dict[str, float]] = {}
    for row in reader:
        if not row or not row[0].strip():
            continue
        values = {header[i]: _number(cell) for i, cell in enumerate(row[1:], start=1) if i < len(header)}
        rows[row[0].strip().upper()] = {key: value for key, value in values.items() if value is not None}
    return rows if "CLIENT" in rows and "FII" in rows else None


def positioning(row: dict[str, float]) -> dict:
    """Index futures long share and net index-options direction for one participant (-100..+100)."""
    futures_long, futures_short = row.get("future index long", 0.0), row.get("future index short", 0.0)
    futures_long_pct = 100 * futures_long / (futures_long + futures_short) if futures_long + futures_short else None
    call_long, put_long = row.get("option index call long", 0.0), row.get("option index put long", 0.0)
    call_short, put_short = row.get("option index call short", 0.0), row.get("option index put short", 0.0)
    bullish, bearish = call_long + put_short, put_long + call_short
    options_net = 100 * (bullish - bearish) / (bullish + bearish) if bullish + bearish else None
    return {
        "futures_long": futures_long, "futures_short": futures_short,
        "futures_long_pct": round(futures_long_pct, 1) if futures_long_pct is not None else None,
        "futures_score": round(2 * (futures_long_pct - 50), 1) if futures_long_pct is not None else None,
        "options_net": round(options_net, 1) if options_net is not None else None,
        "call_long": call_long, "put_long": put_long, "call_short": call_short, "put_short": put_short,
    }


def fetch_participant_oi(now: datetime, fixtures: dict | None) -> tuple[list[tuple[str, dict]], str | None]:
    """The two most recent published files as [(date, rows)], newest first."""
    if fixtures is not None:
        files = fixtures.get("participant_oi") or {}
        parsed = [(date, parse_participant_oi(raw)) for date, raw in sorted(files.items(), reverse=True)]
        found = [(date, rows) for date, rows in parsed if rows]
        return found[:2], None if found else "No participant OI fixture"
    today = now.astimezone(IST).date()
    dates = [today - timedelta(days=offset) for offset in range(LOOKBACK_DAYS) if (today - timedelta(days=offset)).weekday() < 5]

    def one(day) -> tuple[str, dict | None]:
        url = PARTICIPANT_OI_URL.format(date=day.strftime("%d%m%Y"))
        try:
            request = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA, "Accept": "text/csv,*/*", "Referer": "https://www.nseindia.com/"})
            with urllib.request.urlopen(request, timeout=8) as response:  # noqa: S310 - NSE public archive
                return day.isoformat(), parse_participant_oi(response.read(200_000).decode("utf-8", errors="replace"))
        except Exception:  # noqa: BLE001 - holidays and not-yet-published days simply 404
            return day.isoformat(), None

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = [row for row in pool.map(one, dates) if row[1]]
    return results[:2], None if results else "NSE participant OI archive unreachable"


def _weighted(parts: list[tuple[float, float | None]]) -> float | None:
    live = [(weight, value) for weight, value in parts if value is not None]
    total = sum(weight for weight, _ in live)
    return round(sum(weight * value for weight, value in live) / total, 1) if total else None


def crowd_label(score: float | None) -> str:
    if score is None:
        return "UNKNOWN"
    if score >= EXTREME:
        return "EUPHORIC"
    if score >= STRETCHED:
        return "STRETCHED_LONG"
    if score <= -EXTREME:
        return "PANIC"
    if score <= -STRETCHED:
        return "STRETCHED_SHORT"
    return "BALANCED"


def contrarian(score: float | None, name: str) -> dict:
    """The opposite side of a stretched crowd. No call when the crowd is balanced."""
    if score is None:
        return {"bias": "NO_DATA", "strength": 0, "action": f"Not enough retail data on {name}."}
    strength = round(min(100.0, max(0.0, (abs(score) - STRETCHED) / (100 - STRETCHED) * 100)))
    if score >= EXTREME:
        return {"bias": "BEARISH", "strength": strength, "action": f"Retail is all-in long on {name}. Fade strength: sell rallies or buy puts into euphoria, stop above the recent high. Wait for the first lower high; euphoria can last longer than expected."}
    if score >= STRETCHED:
        return {"bias": "LEAN_BEARISH", "strength": strength, "action": f"Retail leans long on {name}. Don't chase calls; prefer selling call premium above resistance or booking longs into strength."}
    if score <= -EXTREME:
        return {"bias": "BULLISH", "strength": strength, "action": f"Retail is panicking on {name}. Accumulate in tranches against the panic: buy dips or sell put premium, stop below the capitulation low. Confirm with a higher low."}
    if score <= -STRETCHED:
        return {"bias": "LEAN_BULLISH", "strength": strength, "action": f"Retail leans short on {name}. Don't chase puts; prefer selling put premium below support or adding longs on weakness."}
    return {"bias": "NONE", "strength": 0, "action": f"Retail is not stretched on {name}: no contrarian edge. Trade the trend, not the crowd."}


def crowded_stocks(stocks: list[dict]) -> list[dict]:
    """Names retail talks about where its tone fights what institutional footprints show."""
    rows = []
    for stock in stocks:
        retail = stock.get("retail") or {}
        posts, mood = retail.get("posts", 0), stock.get("social_raw")
        if posts < 3 or mood is None or abs(mood) < 30:
            continue
        components = stock.get("components") or {}
        smart = _weighted([(0.5, components.get("volume")), (0.5, components.get("orderflow"))])
        delivery = (stock.get("orderflow") or {}).get("delivery_pct")
        diverges = smart is not None and abs(smart) >= 15 and (smart > 0) != (mood > 0)
        rows.append({
            "symbol": stock["symbol"], "name": stock["name"], "posts": posts, "retail_mood": mood,
            "institutional_footprint": smart, "delivery_pct": delivery, "change_pct": stock.get("change_pct"),
            "divergence": diverges, "telegram": retail.get("telegram"),
            "read": (f"Retail bullish ({mood:+.0f}) while volume/order book show distribution ({smart:+.0f}): crowd is buying what strong hands sell." if diverges and mood > 0
                     else f"Retail bearish ({mood:+.0f}) while volume/order book show accumulation ({smart:+.0f}): strong hands are absorbing retail selling." if diverges
                     else f"Retail {'bullish' if mood > 0 else 'bearish'} ({mood:+.0f}) and price action agrees: crowded but not yet wrong; wait for the footprint to turn."),
        })
    for row in rows:
        tg = row["telegram"] or {}
        if tg.get("buy_calls", 0) >= 4 and tg.get("hype_posts", 0) >= 2:
            row["read"] += f" Telegram: {tg['buy_calls']} buy calls with hype across {tg['channels']} channel(s), a classic pump pattern."
    return sorted(rows, key=lambda row: (not row["divergence"], -row["posts"] * abs(row["retail_mood"])))[:10]


def retail_desk(indices: list[dict], context: dict, now: datetime, fixtures: dict | None = None, prefetched: tuple[list, str | None] | None = None) -> dict:
    files, error = prefetched if prefetched is not None else fetch_participant_oi(now, fixtures)
    participants = None
    notes: list[str] = []
    client_futures = client_options = None
    if files:
        date, rows = files[0]
        participants = {name: positioning(rows[name]) for name in ("CLIENT", "PRO", "FII", "DII") if name in rows}
        client = participants["CLIENT"]
        client_futures, client_options = client["futures_score"], client["options_net"]
        fii = participants.get("FII")
        if len(files) > 1 and "CLIENT" in files[1][1]:
            previous = positioning(files[1][1]["CLIENT"])
            client["futures_long_change"] = round(client["futures_long"] - previous["futures_long"])
            client["futures_short_change"] = round(client["futures_short"] - previous["futures_short"])
            client["previous_date"] = files[1][0]
        participants_date = date
        if fii and fii["futures_long_pct"] is not None and client["futures_long_pct"] is not None:
            gap = client["futures_long_pct"] - fii["futures_long_pct"]
            if gap >= 25:
                notes.append(f"Retail holds {client['futures_long_pct']:.0f}% longs in index futures while FIIs hold {fii['futures_long_pct']:.0f}%: retail is long against foreign money. Historically the FII side wins this.")
            elif gap <= -25:
                notes.append(f"Retail is short ({client['futures_long_pct']:.0f}% long) while FIIs are long ({fii['futures_long_pct']:.0f}%): short-covering fuel if the index rises.")
        if client.get("futures_long_change") is not None:
            added_longs, added_shorts = client["futures_long_change"], client["futures_short_change"]
            if added_longs > 0 and added_shorts < 0:
                notes.append(f"Retail added {added_longs:,.0f} index futures longs and cut {abs(added_shorts):,.0f} shorts since {client['previous_date']}: the crowd is getting more bullish.")
            elif added_shorts > 0 and added_longs < 0:
                notes.append(f"Retail added {added_shorts:,.0f} index futures shorts and cut {abs(added_longs):,.0f} longs since {client['previous_date']}: the crowd is getting more bearish.")
        if client["put_long"] and client["call_long"]:
            ratio = client["call_long"] / client["put_long"]
            client["call_put_long_ratio"] = round(ratio, 2)
            if ratio >= 1.5:
                notes.append(f"Retail owns {ratio:.1f} index calls for every put: lottery-ticket buying. Option writers (the other side) collect the decay if the index stalls.")
            elif ratio <= 0.67:
                notes.append(f"Retail owns {1 / ratio:.1f} index puts for every call: fear hedging, which often marks short-term lows.")
    else:
        participants_date = None

    mmi = context.get("mmi_score")
    mmi = float(mmi) if isinstance(mmi, (int, float)) else None
    readings = []
    for index in indices:
        retail = index.get("retail") or {}
        forum = retail.get("mood")
        # Participant OI is market-wide index positioning; apply it to the F&O indices only.
        uses_oi = index["id"] in ("NIFTY", "BANKNIFTY", "SENSEX")
        score = _weighted([
            (CROWD_WEIGHTS["client_futures"], client_futures if uses_oi else None),
            (CROWD_WEIGHTS["client_options"], client_options if uses_oi else None),
            (CROWD_WEIGHTS["forums"], forum),
            (CROWD_WEIGHTS["mmi"], mmi),
        ])
        inputs = sum(1 for value in (client_futures, client_options, forum, mmi) if value is not None)
        readings.append({
            "id": index["id"], "name": index["name"], "crowd_score": score, "crowd": crowd_label(score),
            "inputs": inputs, "forum_mood": forum, "posts": retail.get("posts", 0),
            "bullish_pct": retail.get("bullish_pct"), "index_sentiment": index.get("score"),
            "contrarian": contrarian(score if inputs >= 2 else None, index["name"]),
        })
    for reading in readings:
        sentiment = reading["index_sentiment"]
        if reading["crowd_score"] is not None and sentiment is not None and abs(reading["crowd_score"]) >= STRETCHED and abs(sentiment) >= 15 and (reading["crowd_score"] > 0) != (sentiment > 0):
            notes.append(f"{reading['name']}: retail is {crowd_label(reading['crowd_score']).lower().replace('_', ' ')} while the constituents read {sentiment:+.0f}. The crowd is fighting the tape: the contrarian side has the trend with it.")

    all_stocks = {stock["symbol"]: stock for index in indices for stock in index.get("constituents", [])}
    return {
        "generated_at": now.isoformat(),
        "participants": participants, "participants_date": participants_date, "participants_error": error,
        "mmi_score": mmi, "mmi_value": context.get("mmi_value"),
        "indices": readings, "crowded_stocks": crowded_stocks(list(all_stocks.values())), "notes": notes,
        "method": "Crowd score (-100 all-in short .. +100 all-in long) = 35% retail (Client) index futures long share, 15% Client net index-option direction "
                  "(call longs + put shorts vs put longs + call shorts), 30% retail forum mood on the index constituents, 20% Tickertape Market Mood Index; "
                  f"missing inputs drop out and at least two are needed. Beyond ±{STRETCHED:.0f} the crowd is stretched and beyond ±{EXTREME:.0f} extreme; the contrarian "
                  "bias is the opposite side, with strength scaled from the stretch. Participant OI is NSE end-of-day data (previous session during market hours). "
                  "Crowds can stay stretched for days: use this for timing and sizing alongside price confirmation, not as a stand-alone signal.",
    }
