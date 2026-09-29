"""Finance-specific sentiment scoring, including Indian retail-trader slang.

A generic sentiment model reads "shorts crushed" or "puts printing" wrong; this lexicon is
built for market text. Phrases are matched before single words; negators within three
tokens flip polarity; intensifiers scale it. The compound score is normalised to [-1, 1]
the same way VADER does (x / sqrt(x^2 + alpha)).
"""
from __future__ import annotations

import math
import re

PHRASES: dict[str, float] = {
    # Direction-qualified breakouts must be matched before the bare (bullish) "breakout".
    "downward price breakout": -1.5, "downward breakout": -1.5, "downside breakout": -1.5, "negative breakout": -1.5, "bearish breakout": -1.5,
    "upward price breakout": 1.5, "upward breakout": 1.5, "upside breakout": 1.5, "positive breakout": 1.5, "bullish breakout": 1.5,
    "false breakout": -1.0, "failed breakout": -1.0,
    "cross below": -1.2, "crosses below": -1.2, "crossed below": -1.2, "slips below": -1.2, "falls below": -1.2, "breaches below": -1.2,
    "cross above": 1.2, "crosses above": 1.2, "crossed above": 1.2, "climbs above": 1.2, "reclaims": 1.0,
    "selling pressure": -1.5, "selling intensifies": -1.8, "weak start": -1.0, "weak opening": -1.0, "strong start": 1.0, "strong opening": 1.0,
    "all time high": 2.0, "all-time high": 2.0, "record high": 2.0, "fresh high": 1.5, "52 week high": 1.5, "52-week high": 1.5,
    "short covering": 1.2, "rate cut": 1.2, "fii buying": 1.5, "fiis buy": 1.5, "fpi inflows": 1.5, "dii buying": 1.0,
    "gap up": 1.2, "breaks out": 1.5, "break out": 1.2, "calls printing": 2.0, "to the moon": 2.0, "buy the dip": 1.0,
    "green candle": 1.0, "bulls in control": 2.0, "strong support": 0.8, "beats estimates": 1.5, "upgrade": 1.0,
    "all time low": -2.0, "record low": -2.0, "52 week low": -1.5, "52-week low": -1.5, "sell-off": -1.8, "selloff": -1.8, "sell off": -1.8,
    "profit booking": -0.8, "profit taking": -0.8, "rate hike": -1.2, "fii selling": -1.5, "fiis sell": -1.5, "fpi outflows": -1.5,
    "gap down": -1.2, "breaks down": -1.5, "puts printing": -2.0, "circuit breaker": -1.5, "lower circuit": -1.8, "upper circuit": 1.5,
    "red candle": -1.0, "bears in control": -2.0, "blood bath": -2.5, "bloodbath": -2.5, "black monday": -2.5, "misses estimates": -1.5,
    "margin call": -1.5, "stop loss hit": -1.2, "sl hit": -1.2, "lost everything": -2.0, "account wiped": -2.5, "capital wiped": -2.5,
    "trade war": -1.5, "war fears": -2.0, "recession fears": -2.0, "vix spikes": -1.5, "vix jumps": -1.5, "vix falls": 0.8, "vix cools": 0.8,
}

WORDS: dict[str, float] = {
    "bullish": 2.0, "bull": 1.0, "bulls": 1.0, "rally": 1.8, "rallies": 1.8, "rallied": 1.8, "surge": 1.8, "surges": 1.8, "surged": 1.8,
    "soar": 2.0, "soars": 2.0, "jump": 1.2, "jumps": 1.2, "gain": 1.0, "gains": 1.0, "gained": 1.0, "rise": 0.9, "rises": 0.9, "rose": 0.9,
    "climb": 1.0, "climbs": 1.0, "up": 0.3, "higher": 0.8, "high": 0.4, "rebound": 1.3, "rebounds": 1.3, "recovery": 1.2, "recovers": 1.2,
    "breakout": 1.5, "breakdown": -1.5, "buy": 0.8, "buying": 0.8, "long": 0.5, "calls": 0.4, "moon": 1.8, "rocket": 1.8, "green": 0.8, "strong": 0.8,
    "optimism": 1.3, "optimistic": 1.3, "upbeat": 1.3, "boost": 1.0, "boosts": 1.0, "outperform": 1.2, "record": 0.8, "profit": 0.8,
    "bearish": -2.0, "bear": -1.0, "bears": -1.0, "crash": -2.5, "crashes": -2.5, "crashed": -2.5, "plunge": -2.2, "plunges": -2.2,
    "plunged": -2.2, "tank": -2.0, "tanks": -2.0, "tanked": -2.0, "slump": -1.8, "slumps": -1.8, "fall": -1.0, "falls": -1.0, "fell": -1.0,
    "drop": -1.0, "drops": -1.0, "dropped": -1.0, "decline": -1.0, "declines": -1.0, "slide": -1.2, "slides": -1.2, "down": -0.3,
    "lower": -0.8, "low": -0.4, "weak": -0.9, "weakness": -0.9, "sell": -0.8, "selling": -0.9, "short": -0.5, "puts": -0.4, "red": -0.8,
    "fear": -1.5, "fears": -1.5, "panic": -2.2, "worry": -1.2, "worries": -1.2, "concern": -0.8, "concerns": -0.8, "risk": -0.5,
    "loss": -1.0, "losses": -1.0, "rekt": -2.0, "trapped": -1.5, "bleeding": -1.8, "dump": -1.5, "dumped": -1.5, "volatile": -0.5,
    "recession": -2.0, "inflation": -0.8, "downgrade": -1.2, "underperform": -1.2, "war": -1.5, "tariff": -1.0, "tariffs": -1.0,
}

EMOJI: dict[str, float] = {"🚀": 1.8, "📈": 1.5, "🐂": 1.5, "💰": 0.8, "🟢": 0.8, "📉": -1.5, "🐻": -1.5, "🩸": -2.0, "💀": -1.5, "🔴": -0.8, "😭": -1.0, "🔥": 0.4}
NEGATORS = {"not", "no", "never", "isn't", "wasn't", "don't", "doesn't", "didn't", "won't", "cannot", "can't", "without", "hardly"}
INTENSIFIERS = {"very": 1.3, "extremely": 1.6, "huge": 1.4, "massive": 1.5, "sharp": 1.3, "sharply": 1.3, "big": 1.2, "heavy": 1.3, "strongly": 1.3, "slightly": 0.6, "marginally": 0.5}
TOKEN = re.compile(r"[a-z0-9']+(?:-[a-z0-9]+)?|[\U0001F300-\U0001FAFF]")

INDEX_TERMS = ("nifty", "sensex", "bank nifty", "banknifty", "finnifty", "midcap", "india vix", "dalal street", "nse", "bse", "gift nifty", "indian equities", "indian stock market", "indian markets")
# Single-company items (results boilerplate, stock tips, dividend alerts) say little about the
# index; on a 700-point crash day they were diluting the index reading towards neutral.
STOCK_TERMS = ("standalone net profit", "consolidated net profit", "net profit rises", "net profit falls", "net loss", "quarterly results", "q1 results", "q2 results", "q3 results", "q4 results",
               "share price", "shares of", "stock alert", "stocks to buy", "stocks to watch", "dividend", "record date", "bonus issue", "stock split", "ipo", "target price", "block deal")
INDIA_MACRO = ("rbi", "rupee", "fii", "fpi", "dii", "sebi", "india", "indian", "gst", "repo rate", "budget")
GLOBAL_TERMS = ("fed", "fomc", "powell", "s&p", "nasdaq", "dow", "wall street", "treasury", "crude", "brent", "dollar", "china", "ecb", "boj", "bond yields")
EVENT_TERMS = {
    "RBI policy": ("rbi policy", "monetary policy committee", "mpc meeting", "repo rate decision", "rbi governor"),
    "US Fed": ("fomc", "fed meeting", "fed decision", "powell", "rate decision"),
    "Inflation data": ("cpi data", "cpi inflation", "inflation data", "wpi"),
    "Union Budget": ("union budget", "budget 20", "finance minister"),
    "Elections": ("election result", "exit poll", "counting day"),
    "Geopolitics": ("war", "missile", "attack", "sanctions", "border tension"),
    "Index expiry": ("expiry day", "weekly expiry", "monthly expiry"),
}


def score_text(text: str) -> float:
    """Compound sentiment in [-1, 1]."""
    lowered = f" {text.lower()} "
    total = 0.0
    consumed = lowered
    for phrase, weight in PHRASES.items():
        occurrences = consumed.count(phrase)
        if occurrences:
            total += weight * occurrences
            consumed = consumed.replace(phrase, " ")
    tokens = TOKEN.findall(consumed)
    for index, token in enumerate(tokens):
        weight = WORDS.get(token, EMOJI.get(token))
        if weight is None:
            continue
        window = tokens[max(0, index - 3):index]
        if any(word in NEGATORS for word in window):
            weight = -weight * 0.74
        for word in window[-1:]:
            weight *= INTENSIFIERS.get(word, 1.0)
        total += weight
    return total / math.sqrt(total * total + 15.0) if total else 0.0


def _mentions(lowered: str, terms: tuple[str, ...]) -> bool:
    # Word boundaries: "nse" must not match "response" or "licence expense".
    return any(re.search(rf"\b{re.escape(term)}\b", lowered) for term in terms)


def relevance(text: str) -> tuple[str, float]:
    lowered = text.lower()
    if _mentions(lowered, INDEX_TERMS):
        return "INDEX", 1.0
    if _mentions(lowered, STOCK_TERMS):
        return "STOCK", 0.15
    if any(re.search(rf"\b{re.escape(term)}\b", lowered) for term in INDIA_MACRO):
        return "INDIA_MACRO", 0.7
    if any(re.search(rf"\b{re.escape(term)}\b", lowered) for term in GLOBAL_TERMS):
        return "GLOBAL_MACRO", 0.6
    return "GENERAL", 0.35


def event_flags(text: str) -> list[str]:
    lowered = text.lower()
    return [name for name, terms in EVENT_TERMS.items() if any(re.search(rf"\b{re.escape(term)}\b", lowered) for term in terms)]
