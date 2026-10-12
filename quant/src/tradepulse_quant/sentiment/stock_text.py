"""Company-level sentiment scoring: the finance lexicon plus phrases specific to single stocks."""
from __future__ import annotations

import math
import re

from .lexicon import score_text

# Company-level language the index lexicon does not carry.
STOCK_PHRASES: dict[str, float] = {
    "order win": 1.2, "bags order": 1.2, "wins order": 1.2, "secures order": 1.2, "bags contract": 1.2, "wins contract": 1.2,
    "target raised": 1.2, "raises target": 1.2, "raise target": 1.2, "upgrades": 1.0, "downgrades": -1.0, "hikes target": 1.2, "target cut": -1.2, "cuts target": -1.2, "lowers target": -1.2,
    "buy rating": 1.0, "sell rating": -1.0, "overweight": 0.8, "underweight": -0.8, "reiterates buy": 1.0,
    "margin expansion": 1.0, "margins expand": 1.0, "margin pressure": -1.0, "margins contract": -1.0, "raises guidance": 1.5,
    "guidance cut": -1.5, "cuts guidance": -1.5, "beats": 1.0, "misses": -1.0, "profit jumps": 1.5, "profit falls": -1.5,
    "profit declines": -1.5, "record profit": 1.5, "raid": -1.5, "probe": -1.2, "penalty": -1.0, "fraud": -2.0, "resigns": -1.0,
    "stake sale": -0.6, "pledge": -0.8, "npa": -0.8, "slippages": -1.0, "buyback": 1.0, "dividend": 0.4, "expansion": 0.6,
    "acquisition": 0.4, "ban": -1.0, "recall": -1.0, "strike": -0.8, "fii stake": 0.4, "promoter buying": 1.2, "promoter selling": -1.2,
}


def score_stock_text(text: str) -> float:
    """Lexicon compound plus company-level phrases, combined so the result stays in [-1, 1]."""
    base = score_text(text)
    lowered = f" {text.lower()} "
    total = sum(weight * len(re.findall(rf"\b{re.escape(phrase)}\b", lowered)) for phrase, weight in STOCK_PHRASES.items())
    extra = total / math.sqrt(total * total + 15.0) if total else 0.0
    return (base + extra) / (1.0 + abs(base * extra))
