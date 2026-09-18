"""Explicit gap-day classification for the V5 entry gate."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Sequence

from .configuration import StrategyConfiguration

GapState = Literal[
    "NORMAL_DAY", "GAP_UP_UNRESOLVED", "GAP_DOWN_UNRESOLVED", "GAP_HOLD_CONFIRMED", "GAP_FILL_CONFIRMED", "GAP_INVALIDATED",
]


@dataclass(frozen=True)
class GapResult:
    state: GapState
    is_gap_day: bool
    required_or_duration_minutes: int
    first_trade_risk_multiplier: float


def evaluate_gap_day(
    opening_price: float,
    previous_high: float,
    previous_low: float,
    atr_value: float,
    post_opening_lows: Sequence[float] = (),
    post_opening_highs: Sequence[float] = (),
    config: StrategyConfiguration | None = None,
) -> GapResult:
    cfg = config or StrategyConfiguration()
    threshold = atr_value * cfg.gap_threshold_atr_multiplier
    gap_up = opening_price > previous_high + threshold
    gap_down = opening_price < previous_low - threshold
    if not gap_up and not gap_down:
        return GapResult("NORMAL_DAY", False, cfg.orb_duration_minutes, 1.0)
    if gap_up:
        if any(low <= previous_high for low in post_opening_lows):
            return GapResult("GAP_FILL_CONFIRMED", True, cfg.gap_day_or_duration_minutes, 0.5)
        if post_opening_lows:
            return GapResult("GAP_HOLD_CONFIRMED", True, cfg.gap_day_or_duration_minutes, 0.5)
        return GapResult("GAP_UP_UNRESOLVED", True, cfg.gap_day_or_duration_minutes, 0.5)
    if any(high >= previous_low for high in post_opening_highs):
        return GapResult("GAP_FILL_CONFIRMED", True, cfg.gap_day_or_duration_minutes, 0.5)
    if post_opening_highs:
        return GapResult("GAP_HOLD_CONFIRMED", True, cfg.gap_day_or_duration_minutes, 0.5)
    return GapResult("GAP_DOWN_UNRESOLVED", True, cfg.gap_day_or_duration_minutes, 0.5)