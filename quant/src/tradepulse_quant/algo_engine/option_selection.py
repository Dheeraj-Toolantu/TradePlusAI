"""Strike-selection helpers shared by the option strategies (next-day planner, VWAP-EMA scalper).

These lived in the retired intrinsic-value module; the next-day planner still uses them.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, datetime

STRIKE_STEP = {"NIFTY": 50.0, "BANKNIFTY": 100.0, "SENSEX": 100.0}
ROUND_STEP = {"NIFTY": 100.0, "BANKNIFTY": 500.0, "SENSEX": 500.0}


@dataclass(frozen=True)
class OptionSelectionConfig:
    min_premium: float = 5.0
    min_delta: float = 0.12  # far-OTM lottery strikes are never selected
    min_value_gain: float = 0.5  # premium at the target level must be >= 1.5x today's
    residual_time_value: float = 0.5  # share of today's premium assumed left at the target level
    max_stop_pct: float = 0.35  # a premium stop deeper than 35% of the entry is refused


def normal_cdf(value: float) -> float:
    return 0.5 * (1.0 + math.erf(value / math.sqrt(2.0)))


def years_to_expiry(expiry: object, now: datetime) -> float | None:
    """Years from ``now`` to 15:30 IST on the expiry day (at least half an hour)."""
    try:
        day = date.fromisoformat(str(expiry)[:10])
    except ValueError:
        return None
    close = datetime(day.year, day.month, day.day, 15, 30, tzinfo=now.tzinfo)
    return max((close - now).total_seconds(), 1800.0) / (365.0 * 86400.0)


def market_itm_odds(row: dict, spot: float, option_type: str, now: datetime) -> float | None:
    """|delta| is the market's own ITM odds; without Greeks fall back to a lognormal estimate."""
    delta = abs(float(row.get("delta") or 0))
    if 0 < delta < 1:
        return delta
    iv = float(row.get("iv") or 0) / 100.0
    years = years_to_expiry(row.get("expiry"), now)
    if iv <= 0 or years is None or spot <= 0:
        return None
    d2 = (math.log(spot / float(row["strike"])) - 0.5 * iv * iv * years) / (iv * math.sqrt(years))
    return normal_cdf(d2) if option_type == "CE" else normal_cdf(-d2)


def liquidity_score(row: dict, config: OptionSelectionConfig | None = None) -> int:
    """0-3: premium above the floor, open interest present, traded today."""
    floor = (config or OptionSelectionConfig()).min_premium
    return int(float(row.get("premium") or 0) >= floor) + int(float(row.get("openInterest") or 0) > 0) + int(float(row.get("volume") or 0) > 0)
