"""Option calls posted on Telegram channels: parse, group into consensus calls and rank.

Tip channels post option trades as "BUY NIFTY 24500 CE @120 TGT 150/180 SL 90" or
"BANKNIFTY 54000 PE ABOVE 250 TARGET 300 STOPLOSS 220". This module extracts every such call in
the freshness window, groups identical contracts across channels and ranks them by consensus:
distinct channels first, then mentions, then recency.

Consensus is how *crowded* a call is, not how likely it is to work. Two honest probability
measures are attached instead:

- plan odds: with no edge (a driftless premium), the chance the premium reaches the target before
  the stop loss is (entry - SL) / (target - SL). A call with a wide stop and a near target has high
  odds and a poor payoff, and the reverse; the product is ~0 before costs either way.
- market-implied chance of finishing in the money: the option's delta, added live by the web app
  from the option chain (with current premium, target-hit / SL-hit status).

SEBI's studies of the F&O segment found roughly nine in ten individual traders lose money; heavy
one-sided option buying by the Telegram crowd is read on the contrarian desk as well.
"""
from __future__ import annotations

import re
from datetime import datetime

from .constituents import STOCKS

INDEX_NAMES = [
    (re.compile(r"\bbank\s*nifty\b|\bbanknifty\b|\bnifty\s*bank\b|\bbnf\b"), "BANKNIFTY"),
    (re.compile(r"\bfin\s*nifty\b|\bfinnifty\b"), "FINNIFTY"),
    (re.compile(r"\bmidcp\s*nifty\b|\bmidcpnifty\b|\bmidcap\s*nifty\b"), "MIDCPNIFTY"),
    (re.compile(r"\bsensex\b"), "SENSEX"),
    (re.compile(r"\bnifty\s*50\b|\bnifty\b"), "NIFTY"),
]
# <underlying words> [expiry like "23 oct" / "oct"] <strike> <CE|PE|CALL|PUT>
CONTRACT = re.compile(
    r"([a-z&\-]+(?:\s+[a-z&\-]+){0,2})?\s*(?:\d{1,2}(?:st|nd|rd|th)?\s*[a-z]{3,9}\s+|[a-z]{3}\s+)?(\d{3,6}(?:\.\d+)?)\s*(ce|pe|call|put)\b")
ENTRY = re.compile(r"(?:above|@|\bat\b|cmp|entry|near|around|buy\s+(?:above|at|around|near)?|range)\s*:?\s*(?:rs\.?\s*)?(\d+(?:\.\d+)?)")
TARGET = re.compile(r"(?:tgt|target|tg|t1|targets?)\s*s?\s*:?\s*(?:rs\.?\s*)?(\d+(?:\.\d+)?)")
STOP = re.compile(r"(?:\bsl\b|stop\s*loss|stoploss)\s*:?\s*(?:rs\.?\s*)?(\d+(?:\.\d+)?)")
SELL_WORDS = re.compile(r"\b(sell|short|write|writing)\b")
STEP = {"NIFTY": 50, "BANKNIFTY": 100, "SENSEX": 100, "FINNIFTY": 50, "MIDCPNIFTY": 25}


def _underlying(words: str | None, text_before: str) -> str | None:
    lowered = (words or "").strip()
    for pattern, name in INDEX_NAMES:
        if pattern.search(lowered):
            return name
    token = lowered.replace(" ", "").upper()
    for symbol in STOCKS:
        if token.endswith(symbol.replace("&", "").replace("-", "")) and len(symbol) >= 3:
            return symbol
    # "BUY 24500 CE" right after a line that named the index.
    last = None
    for pattern, name in INDEX_NAMES:
        for match in pattern.finditer(text_before):
            if last is None or match.start() > last[0]:
                last = (match.start(), name)
    return last[1] if last else None


def parse_option_calls(text: str) -> list[dict]:
    """Every option contract called in a post, with side, entry, first target and stop loss."""
    lowered = text.lower().replace(",", "")
    calls = []
    for match in CONTRACT.finditer(lowered):
        underlying = _underlying(match.group(1), lowered[:match.start()])
        if not underlying:
            continue
        strike = float(match.group(2))
        kind = "CE" if match.group(3) in ("ce", "call") else "PE"
        # Levels belong to this contract: read from here to the next contract (or 160 chars).
        following = CONTRACT.search(lowered, match.end())
        tail = lowered[match.end(): following.start() if following else match.end() + 160]
        head = lowered[max(0, match.start() - 25): match.start()]
        number = lambda pattern: (float(found.group(1)) if (found := pattern.search(tail)) else None)
        entry, target, stop = number(ENTRY), number(TARGET), number(STOP)
        side = "SELL" if SELL_WORDS.search(f"{head} {match.group(1) or ''}") or SELL_WORDS.search(tail[:20]) else "BUY"
        calls.append({"underlying": underlying, "strike": strike, "type": kind, "side": side, "entry": entry, "target": target, "stop": stop})
    return calls


def plan_odds(side: str, entry: float | None, target: float | None, stop: float | None) -> float | None:
    """Chance (0..1) a driftless premium hits target before stop: (entry - SL) / (target - SL)."""
    if entry is None or target is None or stop is None:
        return None
    if side == "BUY" and stop < entry < target:
        return round((entry - stop) / (target - stop), 3)
    if side == "SELL" and target < entry < stop:
        return round((stop - entry) / (stop - target), 3)
    return None


def _median(values: list[float]) -> float | None:
    values = sorted(values)
    if not values:
        return None
    middle = len(values) // 2
    return values[middle] if len(values) % 2 else round((values[middle - 1] + values[middle]) / 2, 2)


def consensus(items: list[dict], now: datetime, max_age_hours: float, spots: dict[str, float], full: bool = False) -> dict:
    """Group option calls from Telegram items into ranked consensus calls.

    ``full`` adds ``all`` (every ranked call, with ``channel_mentions`` per channel) for the channel analysis.
    """
    groups: dict[tuple, dict] = {}
    channels: dict[str, dict] = {}
    seen: set[tuple] = set()
    parsed = scanned = 0
    for item in items:
        if not item.get("telegram") or not item.get("published"):
            continue
        age = (now - item["published"]).total_seconds() / 3600.0
        if age < 0 or age > max_age_hours:
            continue
        scanned += 1
        channel = item["source"].removeprefix("Telegram @")
        row = channels.setdefault(channel, {"channel": channel, "posts": 0, "option_calls": 0})
        row["posts"] += 1
        text = item.get("body") or item["title"]
        for call in parse_option_calls(text):
            spot = spots.get(call["underlying"])
            if spot and abs(call["strike"] / spot - 1) > 0.10:
                continue  # a 10%+ away strike is a parsing error or a lottery ticket nobody should rank
            key = (call["underlying"], call["strike"], call["type"], call["side"])
            if (key, channel, item.get("link")) in seen:
                continue
            seen.add((key, channel, item.get("link")))
            parsed += 1
            row["option_calls"] += 1
            group = groups.setdefault(key, {"underlying": key[0], "strike": key[1], "type": key[2], "side": key[3], "mentions": 0, "channels": set(), "channel_mentions": {},
                                            "entries": [], "targets": [], "stops": [], "latest_age_hours": age, "posts": [], "views": 0})
            group["mentions"] += 1
            group["channels"].add(channel)
            group["channel_mentions"][channel] = group["channel_mentions"].get(channel, 0) + 1
            group["views"] += (item.get("engagement") or 0) * 200
            group["latest_age_hours"] = min(group["latest_age_hours"], age)
            for field, value in (("entries", call["entry"]), ("targets", call["target"]), ("stops", call["stop"])):
                if value is not None:
                    group[field].append(value)
            group["posts"].append({"channel": channel, "text": text[:160], "link": item.get("link", ""), "age_hours": round(age, 1)})

    ranked = []
    for group in groups.values():
        entry, target, stop = _median(group["entries"]), _median(group["targets"]), _median(group["stops"])
        spot = spots.get(group["underlying"])
        moneyness = round((group["strike"] / spot - 1) * 100, 2) if spot else None
        otm = None if moneyness is None else (moneyness > 0 if group["type"] == "CE" else moneyness < 0)
        score = 10 * len(group["channels"]) + 3 * group["mentions"] + max(0.0, 6 - group["latest_age_hours"])
        ranked.append({
            "underlying": group["underlying"], "strike": group["strike"], "type": group["type"], "side": group["side"],
            "contract": f"{group['underlying']} {group['strike']:g} {group['type']}", "mentions": group["mentions"], "channels": sorted(group["channels"]),
            "channel_count": len(group["channels"]), "consensus_score": round(score, 1), "entry": entry, "target": target, "stop": stop,
            "plan_odds": plan_odds(group["side"], entry, target, stop), "reward_risk": round((target - entry) / (entry - stop), 2) if entry and target and stop and entry > stop and target > entry else None,
            "spot": spot, "moneyness_pct": moneyness, "otm": otm, "far_otm": bool(otm and moneyness is not None and abs(moneyness) > 2.5),
            "latest_age_hours": round(group["latest_age_hours"], 1), "views": group["views"], "posts": sorted(group["posts"], key=lambda p: p["age_hours"])[:4],
            **({"channel_mentions": group["channel_mentions"]} if full else {}),
        })
    ranked.sort(key=lambda row: (-row["channel_count"], -row["mentions"], row["latest_age_hours"]))

    by_underlying: dict[str, dict] = {}
    for row in ranked:
        bucket = by_underlying.setdefault(row["underlying"], {"underlying": row["underlying"], "ce_buys": 0, "pe_buys": 0, "ce_sells": 0, "pe_sells": 0})
        bucket[f"{row['type'].lower()}_{'buys' if row['side'] == 'BUY' else 'sells'}"] += row["mentions"]
    for bucket in by_underlying.values():
        bullish = bucket["ce_buys"] + bucket["pe_sells"]
        bearish = bucket["pe_buys"] + bucket["ce_sells"]
        bucket["bullish_pct"] = round(100 * bullish / (bullish + bearish), 1) if bullish + bearish else None
        bucket["bias"] = "BULLISH" if bucket["bullish_pct"] is not None and bucket["bullish_pct"] >= 65 else "BEARISH" if bucket["bullish_pct"] is not None and bucket["bullish_pct"] <= 35 else "MIXED"

    notes = []
    for bucket in sorted(by_underlying.values(), key=lambda b: -(b["ce_buys"] + b["pe_buys"] + b["ce_sells"] + b["pe_sells"])):
        total = bucket["ce_buys"] + bucket["pe_buys"] + bucket["ce_sells"] + bucket["pe_sells"]
        if total >= 6 and bucket["bias"] != "MIXED":
            notes.append(f"Telegram crowd is {bucket['bullish_pct']:.0f}% bullish on {bucket['underlying']} options ({bucket['ce_buys']} CE / {bucket['pe_buys']} PE buy calls). "
                         f"When option buyers crowd one side, writers on the other side usually collect the premium; treat it as a contrarian tell.")
    top = next((row for row in ranked if row["channel_count"] >= 2), ranked[0] if ranked else None)
    extra = {"all": ranked} if full else {}
    return {
        **extra,
        "window_hours": max_age_hours, "posts_scanned": scanned, "calls_parsed": parsed, "consensus": ranked[:15], "top_pick": top,
        "by_underlying": sorted(by_underlying.values(), key=lambda b: b["underlying"]),
        "channels": sorted(channels.values(), key=lambda c: -c["option_calls"]), "notes": notes,
        "method": "Option calls are parsed from posts (underlying, strike, CE/PE, buy/sell, entry, first target, stop loss) and grouped by contract across channels. "
                  "Ranking = distinct channels, then mentions, then recency: it measures how crowded a call is, not whether it will work. Plan odds = (entry - SL) / "
                  "(target - SL), the chance a premium with no edge reaches the target before the stop; delta (live, from the option chain) approximates the market-implied "
                  "chance of finishing in the money. Strikes more than 10% from spot are ignored.",
    }
