"""India VIX regime and the VIX-implied expected move.

Spec §10 asks for VIX *percentile*. Until a year of VIX history is wired in, the
regime uses level bands calibrated to India VIX's historical distribution
(roughly: <11.5 ≈ bottom 20%, 11.5-19 ≈ middle, 19-25 ≈ top 20%, >25 ≈ top 5%).
The response states which basis was used so the UI never over-claims.
"""
from __future__ import annotations

import math

TRADING_DAYS = 252
LEVEL_BANDS = ((11.5, "LOW"), (19.0, "NORMAL"), (25.0, "HIGH"))

GUIDANCE = {
    "LOW": "Calm market. Option premiums are cheap but moves are small; demand a clean breakout before buying.",
    "NORMAL": "Normal volatility. Standard rules and position size apply.",
    "HIGH": "Elevated fear. Premiums are expensive and swings are wide; halve the position size and prefer ATM/ITM strikes.",
    "EXTREME": "Extreme volatility. Default is NO TRADE for option buyers; premiums can collapse even when direction is right.",
}


def vix_regime(level: float) -> str:
    for upper, name in LEVEL_BANDS:
        if level < upper:
            return name
    return "EXTREME"


def analyze_volatility(vix: dict | None, spot: float, atm_iv: float | None) -> dict:
    level = change_pct = None
    basis = "India VIX level bands"
    if isinstance(vix, dict):
        try:
            level = float(vix.get("value")) if vix.get("value") is not None else None
            change_pct = float(vix.get("percent")) if vix.get("percent") is not None else None
        except (TypeError, ValueError):
            level = None
    if (level is None or level <= 0) and atm_iv:
        level, basis = float(atm_iv), "ATM implied volatility (India VIX unavailable)"
    if level is None or level <= 0 or spot <= 0:
        return {"available": False, "regime": None, "reason": "India VIX and ATM IV are unavailable"}
    regime = vix_regime(level)
    daily_move = spot * (level / 100.0) / math.sqrt(TRADING_DAYS)
    if change_pct is None:
        trend = "UNKNOWN"
    elif change_pct >= 5:
        trend = "RISING_FAST"
    elif change_pct > 0.5:
        trend = "RISING"
    elif change_pct <= -5:
        trend = "FALLING_FAST"
    elif change_pct < -0.5:
        trend = "FALLING"
    else:
        trend = "FLAT"
    return {
        "available": True,
        "value": level,
        "change_pct": change_pct,
        "trend": trend,
        "regime": regime,
        "basis": basis,
        "expected_daily_move": daily_move,
        "expected_range": {"low": spot - daily_move, "high": spot + daily_move},
        "size_multiplier": 0.5 if regime == "HIGH" else 0.0 if regime == "EXTREME" else 1.0,
        "guidance": GUIDANCE[regime],
    }
