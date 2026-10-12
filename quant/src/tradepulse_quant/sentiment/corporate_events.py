"""Corporate events per stock: block/bulk deals, results, corporate actions, filings and headlines.

Price and chatter tell you how people feel; events tell you why. A Dalal Street desk reads them so:

- BLOCK / BULK DEALS: who is on each side matters more than the size. Mutual funds, insurers and
  marquee foreign funds buying a block = sticky demand (bullish). Promoters, PE funds and strategic
  holders selling = supply overhang for weeks (bearish), unless the block is absorbed by quality
  institutions without a discount. Both sides of a block are reported, so the reading is net of who.
- RESULTS: the tone of the results coverage (beat/miss, margin, guidance) plus how the stock
  reacted. A miss that the stock shrugs off is read by the price lens, not here.
- CORPORATE ACTIONS: buyback (+), bonus/split (mild +), dividend (small +), rights issue, QIP, OFS
  and promoter pledges (dilution or supply, -).
- FILINGS (NSE announcements): order wins, rating changes, acquisitions, management exits,
  auditor resignations, regulatory action and litigation, each with a prior and the text tone.
- UPCOMING (event calendar): results or board meetings within ten days are not directional; they
  are flagged as event risk (implied volatility rises into them and collapses after).

Data: NSE public APIs (large-deal snapshot, historical block/bulk deals, corporate announcements,
corporate actions, event calendar) when reachable, and headlines from the news scan classified into
the same event types, so the lens still works when NSE blocks the network.
"""
from __future__ import annotations

import json
import math
import re
from datetime import datetime, timedelta, timezone

from .stock_text import score_stock_text

IST = timezone(timedelta(hours=5, minutes=30))
NSE_ENDPOINTS = {
    "large_deals": "https://www.nseindia.com/api/snapshot-capital-market-largedeal",
    "block": "https://www.nseindia.com/api/historical/block-deals?from={start}&to={end}",
    "bulk": "https://www.nseindia.com/api/historical/bulk-deals?from={start}&to={end}",
    "announcements": "https://www.nseindia.com/api/corporate-announcements?index=equities&from_date={start_ann}&to_date={end}",
    "actions": "https://www.nseindia.com/api/corporates-corporateActions?index=equities&from_date={start_ann}&to_date={ahead}",
    "calendar": "https://www.nseindia.com/api/event-calendar?index=equities",
}
DEAL_DAYS = 7
DEAL_HALF_LIFE_HOURS = 60.0
FILING_HOURS = 72.0
FILING_HALF_LIFE_HOURS = 24.0
UPCOMING_DAYS = 10

INSTITUTION = re.compile(r"mutual fund|\bmf\b|insurance|\blic\b|life insurance|pension|provident|sovereign|government of singapore|\bgic\b|abu dhabi|\badia\b|norges|"
                         r"vanguard|blackrock|fidelity|goldman|morgan stanley|nomura|societe generale|bnp|citigroup|jp ?morgan|hsbc|ubs|kotak|hdfc|icici prudential|"
                         r"sbi funds|nippon|axis mutual|aditya birla|dsp|mirae|motilal|ishares|smallcap world|capital group|government pension|fund\b|funds\b|trust\b")
STRATEGIC = re.compile(r"promoter|holdings?\b|\bpte\b|mauritius|ventures|private equity|partners\b|\blp\b|investment(s)? (ltd|limited|pte)|\bbv\b|sarl|cayman|singapore")

# Headline/announcement category -> (regex, prior impact -100..100, use text tone)
CATEGORIES: list[tuple[str, re.Pattern, float]] = [
    ("REGULATORY", re.compile(r"\b(sebi|rbi|cci|enforcement directorate|income tax|gst)\b.*\b(order|penalty|notice|probe|raid|action|ban|fine)|\b(penalty|show cause|raid|probe|fraud|forensic audit|insider trading)\b"), -45.0),
    ("AUDITOR_EXIT", re.compile(r"auditor\w* (resign|quit|steps down)|resignation of (the )?(statutory )?auditor"), -60.0),
    ("BLOCK_DEAL", re.compile(r"\b(block deal|bulk deal|block trade|stake sale|offloads?|sells? (\d+(\.\d+)?% )?stake|buys? (\d+(\.\d+)?% )?stake|picks? up (\d+(\.\d+)?% )?stake|acquires? (\d+(\.\d+)?% )?stake)\b"), -5.0),
    ("RESULTS", re.compile(r"\b(q[1-4](fy\d+)?|quarterly|quarter|results?|earnings|net profit|net loss|ebitda|revenue|topline|bottomline|pat)\b"), 0.0),
    ("ORDER_WIN", re.compile(r"\b(bags?|wins?|secures?|bagged|won|secured|receives?|received|bagging)\b.{0,40}\b(orders?|contracts?|deal)\b|order (win|inflow)|letter of award"), 35.0),
    ("RATING", re.compile(r"\b(upgrades?|upgraded|downgrades?|downgraded|target price|price target|initiates coverage|overweight|underweight|credit rating|outlook (revised|to))\b"), 0.0),
    ("BUYBACK", re.compile(r"\bbuy[- ]?back\b"), 45.0),
    ("DILUTION", re.compile(r"\b(rights issue|qip|qualified institutions? placement|ofs|offer for sale|fund ?raise|preferential issue|pledge(d)? (shares|stake))\b"), -30.0),
    ("BONUS_SPLIT", re.compile(r"\b(bonus (issue|shares)|stock split|sub-?division)\b"), 20.0),
    ("DIVIDEND", re.compile(r"\b(dividend|record date)\b"), 8.0),
    ("M_AND_A", re.compile(r"\b(merger|amalgamation|acquisition|acquires?|demerger|takeover|scheme of arrangement)\b"), 8.0),
    ("MANAGEMENT", re.compile(r"\b(resigns?|resignation|steps down|quits)\b.*\b(ceo|md|cfo|chairman|director|managing director)|\b(ceo|md|cfo|chairman) (resigns?|quits|steps down)\b"), -25.0),
]
LABELS = {
    "REGULATORY": "Regulatory action", "AUDITOR_EXIT": "Auditor exit", "BLOCK_DEAL": "Block / bulk deal", "RESULTS": "Results", "ORDER_WIN": "Order win",
    "RATING": "Rating / target change", "BUYBACK": "Buyback", "DILUTION": "Dilution / supply", "BONUS_SPLIT": "Bonus / split", "DIVIDEND": "Dividend",
    "M_AND_A": "M&A", "MANAGEMENT": "Management change", "DEALS": "Block / bulk deals (NSE)", "UPCOMING": "Upcoming",
}
# NSE announcement categories that carry no information for sentiment.
NOISE = re.compile(r"trading window|newspaper|certificate|reg\.? 74|regulation 74|investor meet|analysts?/institutional|con\.? call|shareholders? meeting|agm|"
                   r"loss of share|duplicate share|updates?$|general updates|change in registrar|esop|esos|allotment of securities|record date for interest", re.I)
EVENT_WEIGHTS = {"DEALS": 1.3, "RESULTS": 1.4, "REGULATORY": 1.3, "AUDITOR_EXIT": 1.3, "ORDER_WIN": 0.9, "RATING": 0.9, "BUYBACK": 1.0, "DILUTION": 1.0,
                 "BONUS_SPLIT": 0.6, "DIVIDEND": 0.4, "M_AND_A": 0.7, "MANAGEMENT": 0.9, "BLOCK_DEAL": 0.9}


def _clamp(value: float) -> float:
    return max(-100.0, min(100.0, value))


def _rows(raw: str | None) -> list | dict | None:
    if not raw:
        return None
    try:
        body = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return body


def _number(value) -> float | None:
    try:
        return float(str(value).replace(",", "")) if value not in (None, "", "-") else None
    except ValueError:
        return None


def _date(value, end_of_day: bool = False) -> datetime | None:
    """NSE dates come as '12-Oct-2026', '12-OCT-2026 14:30:00', '12-10-2026' or ISO."""
    if not value:
        return None
    text = str(value).strip()
    for fmt in ("%d-%b-%Y %H:%M:%S", "%d-%b-%Y %H:%M", "%d-%b-%Y", "%d-%m-%Y %H:%M:%S", "%d-%m-%Y", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            parsed = datetime.strptime(text.title() if "%b" in fmt else text, fmt)
        except ValueError:
            continue
        if fmt.endswith("%Y") and end_of_day:
            parsed = parsed.replace(hour=15, minute=30)
        return parsed.replace(tzinfo=IST)
    return None


# ---------- parsers ----------

def parse_deals(raw: str | None, kind: str) -> list[dict]:
    """Large-deal snapshot ({BULK_DEALS_DATA, BLOCK_DEALS_DATA}) or historical ({data: [BD_* fields]})."""
    body = _rows(raw)
    if body is None:
        return []
    groups: list[tuple[str, list]] = []
    if isinstance(body, dict) and any(key.endswith("_DEALS_DATA") for key in body):
        groups = [("BLOCK", body.get("BLOCK_DEALS_DATA") or []), ("BULK", body.get("BULK_DEALS_DATA") or [])]
    elif isinstance(body, dict):
        groups = [(kind, body.get("data") or [])]
    elif isinstance(body, list):
        groups = [(kind, body)]
    deals = []
    for deal_kind, rows in groups:
        for row in rows:
            if not isinstance(row, dict):
                continue
            get = lambda *keys: next((row[key] for key in keys if row.get(key) not in (None, "")), None)
            symbol = get("symbol", "BD_SYMBOL")
            side = str(get("buySell", "BD_BUY_SELL") or "").upper()
            qty, price = _number(get("qty", "BD_QTY_TRD", "quantity")), _number(get("watp", "BD_TP_WATP", "price"))
            if not symbol or side not in ("BUY", "SELL") or not qty or not price:
                continue
            deals.append({"symbol": str(symbol).upper(), "kind": deal_kind, "client": str(get("clientName", "BD_CLIENT_NAME") or "").strip(),
                          "side": side, "qty": qty, "price": price, "value_cr": round(qty * price / 1e7, 2),
                          "date": _date(get("date", "BD_DT_DATE"), end_of_day=True)})
    return deals


def parse_announcements(raw: str | None) -> list[dict]:
    body = _rows(raw)
    rows = body.get("data") if isinstance(body, dict) else body
    out = []
    for row in rows or []:
        if not isinstance(row, dict) or not row.get("symbol"):
            continue
        out.append({"symbol": str(row["symbol"]).upper(), "category": str(row.get("desc") or "").strip(), "text": str(row.get("attchmntText") or "").strip()[:500],
                    "time": _date(row.get("an_dt") or row.get("sort_date") or row.get("dt")), "link": row.get("attchmntFile") or ""})
    return out


def parse_actions(raw: str | None) -> list[dict]:
    body = _rows(raw)
    rows = body.get("data") if isinstance(body, dict) else body
    return [{"symbol": str(row["symbol"]).upper(), "subject": str(row.get("subject") or "").strip(), "ex_date": _date(row.get("exDate"), end_of_day=False)}
            for row in rows or [] if isinstance(row, dict) and row.get("symbol")]


def parse_calendar(raw: str | None) -> list[dict]:
    body = _rows(raw)
    rows = body.get("data") if isinstance(body, dict) else body
    return [{"symbol": str(row["symbol"]).upper(), "purpose": str(row.get("purpose") or "").strip(), "detail": str(row.get("bm_desc") or "").strip()[:200],
             "date": _date(row.get("date"))} for row in rows or [] if isinstance(row, dict) and row.get("symbol")]


def parse_nse_events(raws: dict[str, str | None]) -> dict:
    deals = parse_deals(raws.get("large_deals"), "BLOCK") + parse_deals(raws.get("block"), "BLOCK") + parse_deals(raws.get("bulk"), "BULK")
    unique = {(d["symbol"], d["kind"], d["client"], d["side"], d["qty"], d["date"].date() if d["date"] else None): d for d in deals}
    return {"deals": list(unique.values()), "announcements": parse_announcements(raws.get("announcements")),
            "actions": parse_actions(raws.get("actions")), "calendar": parse_calendar(raws.get("calendar"))}


def nse_urls(now: datetime) -> dict[str, str]:
    today = now.astimezone(IST).date()
    fmt = lambda day: day.strftime("%d-%m-%Y")
    values = {"start": fmt(today - timedelta(days=DEAL_DAYS)), "start_ann": fmt(today - timedelta(days=3)), "end": fmt(today), "ahead": fmt(today + timedelta(days=UPCOMING_DAYS))}
    return {key: url.format(**values) for key, url in NSE_ENDPOINTS.items()}


# ---------- classification ----------

def classify(text: str) -> str | None:
    lowered = text.lower()
    for name, pattern, _ in CATEGORIES:
        if pattern.search(lowered):
            return name
    return None


def _prior(category: str) -> float:
    return next((prior for name, _, prior in CATEGORIES if name == category), 0.0)


def event_impact(category: str, text: str) -> float:
    """Prior for the event type plus the text tone (results and ratings are all tone)."""
    tone = score_stock_text(text) * 100
    if category in ("RESULTS", "RATING"):
        return round(_clamp(tone), 1)
    if category == "BLOCK_DEAL":
        return round(_clamp(_prior(category) + 0.8 * tone), 1)
    return round(_clamp(_prior(category) + 0.5 * tone), 1)


def client_class(client: str, company: str) -> str:
    name = client.lower()
    first = re.sub(r"[^a-z]", " ", company.lower()).split()
    if first and len(first[0]) > 3 and first[0] in name and not INSTITUTION.search(name):
        return "PROMOTER"
    if INSTITUTION.search(name):
        return "INSTITUTION"
    if STRATEGIC.search(name):
        return "STRATEGIC"
    return "OTHER"


CLASS_WEIGHT = {"INSTITUTION": 1.0, "PROMOTER": 1.3, "STRATEGIC": 1.0, "OTHER": 0.4}


def deals_reading(deals: list[dict], company: str, last_price: float | None, now: datetime) -> dict | None:
    if not deals:
        return None
    signed = total = 0.0
    rows = []
    for deal in deals:
        age = max((now - deal["date"]).total_seconds() / 3600.0, 0.0) if deal["date"] else 24.0
        recency = 0.5 ** (age / DEAL_HALF_LIFE_HOURS)
        klass = client_class(deal["client"], company)
        weight = CLASS_WEIGHT[klass] * deal["value_cr"] * recency
        signed += weight * (1 if deal["side"] == "BUY" else -1)
        total += CLASS_WEIGHT[klass] * deal["value_cr"] * recency
        discount = round((deal["price"] / last_price - 1) * 100, 2) if last_price else None
        rows.append({**deal, "class": klass, "age_hours": round(age, 1), "vs_price_pct": discount, "date": deal["date"].isoformat() if deal["date"] else None})
    score = 100 * math.tanh(1.5 * signed / total) if total else 0.0
    sells = [row for row in rows if row["side"] == "SELL"]
    # A block sold well below the market is a distress/urgent exit.
    if sells and last_price and min(row["price"] for row in sells) < last_price * 0.96:
        score -= 15
    buy_value = sum(row["value_cr"] for row in rows if row["side"] == "BUY")
    sell_value = sum(row["value_cr"] for row in rows if row["side"] == "SELL")
    by_class = lambda side, klass: round(sum(row["value_cr"] for row in rows if row["side"] == side and row["class"] == klass), 2)
    return {
        "score": round(_clamp(score), 1), "count": len(rows), "buy_value_cr": round(buy_value, 2), "sell_value_cr": round(sell_value, 2),
        "institution_buy_cr": by_class("BUY", "INSTITUTION"), "institution_sell_cr": by_class("SELL", "INSTITUTION"),
        "promoter_sell_cr": round(by_class("SELL", "PROMOTER") + by_class("SELL", "STRATEGIC"), 2),
        "deals": sorted(rows, key=lambda row: -row["value_cr"])[:6],
    }


def stock_events(symbol: str, company: str, nse: dict | None, headline_events: list[dict], last_price: float | None, now: datetime) -> dict:
    """Events lens for one stock: scored events, deals summary and upcoming event risk."""
    nse = nse or {}
    events: list[dict] = []
    deals = deals_reading([deal for deal in nse.get("deals", []) if deal["symbol"] == symbol], company, last_price, now)
    if deals:
        clients = ", ".join(sorted({f"{row['client'][:28]} ({row['side'].lower()})" for row in deals["deals"][:3]}))
        events.append({"type": "DEALS", "label": LABELS["DEALS"], "title": f"{deals['count']} deals: buy ₹{deals['buy_value_cr']:.0f} Cr / sell ₹{deals['sell_value_cr']:.0f} Cr — {clients}",
                       "source": f"NSE, last {DEAL_DAYS} days", "age_hours": None, "impact": deals["score"], "link": "", "weight": EVENT_WEIGHTS["DEALS"]})
    for row in nse.get("announcements", []):
        if row["symbol"] != symbol or not row["time"]:
            continue
        age = (now - row["time"]).total_seconds() / 3600.0
        text = f"{row['category']}. {row['text']}"
        if age < 0 or age > FILING_HOURS or (NOISE.search(row["category"]) and not classify(row["text"])):
            continue
        category = classify(text) or ("RESULTS" if "financial result" in row["category"].lower() else None)
        if category is None:
            continue
        events.append({"type": category, "label": LABELS[category], "title": (row["text"] or row["category"])[:200], "source": "NSE filing",
                       "age_hours": round(age, 1), "impact": event_impact(category, text), "link": row["link"],
                       "weight": EVENT_WEIGHTS.get(category, 0.7) * 0.5 ** (age / FILING_HALF_LIFE_HOURS)})
    for row in nse.get("actions", []):
        if row["symbol"] != symbol:
            continue
        category = classify(row["subject"])
        if category not in ("BUYBACK", "BONUS_SPLIT", "DIVIDEND", "DILUTION"):
            continue
        days = (row["ex_date"] - now).total_seconds() / 86400 if row["ex_date"] else None
        events.append({"type": category, "label": LABELS[category], "title": f"{row['subject']}" + (f" (ex-date {row['ex_date'].date().isoformat()})" if row["ex_date"] else ""),
                       "source": "NSE corporate action", "age_hours": round(-days * 24, 1) if days is not None else None, "impact": event_impact(category, row["subject"]), "link": "",
                       "weight": EVENT_WEIGHTS.get(category, 0.5) * (0.6 if days is not None and days < -3 else 1.0)})
    for item in headline_events:
        events.append({"type": item["category"], "label": LABELS[item["category"]], "title": item["title"], "source": item["source"], "age_hours": item["age_hours"],
                       "impact": event_impact(item["category"], item["title"]), "link": item["link"], "weight": EVENT_WEIGHTS.get(item["category"], 0.7) * item["weight"]})

    upcoming = []
    for row in nse.get("calendar", []):
        if row["symbol"] != symbol or not row["date"]:
            continue
        days = (row["date"].date() - now.astimezone(IST).date()).days
        if 0 <= days <= UPCOMING_DAYS:
            upcoming.append({"date": row["date"].date().isoformat(), "days": days, "purpose": row["purpose"], "detail": row["detail"],
                             "is_results": bool(re.search(r"financial result|results", f"{row['purpose']} {row['detail']}", re.I))})
    upcoming.sort(key=lambda row: row["days"])

    scored = [event for event in events if abs(event["impact"]) >= 5]
    weight = sum(event["weight"] for event in scored)
    score = round(_clamp(sum(event["weight"] * event["impact"] for event in scored) / (weight + 0.3)), 1) if scored else None
    notes = []
    if deals and deals["promoter_sell_cr"] >= 100:
        notes.append(f"Promoter / strategic holders sold ₹{deals['promoter_sell_cr']:.0f} Cr in block/bulk deals: supply overhang until the paper is absorbed.")
    if deals and deals["institution_buy_cr"] >= 100:
        notes.append(f"Institutions bought ₹{deals['institution_buy_cr']:.0f} Cr in block/bulk deals: quality demand under the stock.")
    results = next((row for row in upcoming if row["is_results"]), None)
    if results:
        notes.append(f"Results due {results['date']} ({results['days']} day{'s' if results['days'] != 1 else ''}): binary event; option premiums inflate into it and crush after.")
    return {
        "score": score, "count": len(events), "deals": deals, "upcoming": upcoming[:3],
        "events": [{key: value for key, value in event.items() if key != "weight"} for event in sorted(events, key=lambda e: -(e["weight"] * abs(e["impact"])))[:6]],
        "notes": notes,
    }


def split_event_headlines(items: list[dict]) -> tuple[list[dict], list[dict]]:
    """(plain news, event headlines with category). Event headlines are scored once, by the events lens."""
    news, events = [], []
    for item in items:
        category = classify(item["title"])
        (events if category else news).append({**item, "category": category} if category else item)
    return news, events

