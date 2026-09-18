"""V5 regime classification with deterministic ADX hysteresis."""
from __future__ import annotations

from typing import Literal

from .configuration import StrategyConfiguration

Regime = Literal["UNKNOWN", "TRENDING_BULL", "TRENDING_BEAR", "RANGE", "CHOP"]


def classify_regime(
    adx_value: float | None,
    close: float | None,
    vwap_value: float | None,
    ema_fast: float | None,
    ema_slow: float | None,
    trend_15m: Literal["BULL", "BEAR", "UNKNOWN"] = "UNKNOWN",
    previous: Regime = "UNKNOWN",
    vwap_crosses: int = 0,
    gap_state: str = "NORMAL_DAY",
    config: StrategyConfiguration | None = None,
) -> Regime:
    cfg = config or StrategyConfiguration()
    if None in {adx_value, close, vwap_value, ema_fast, ema_slow}:
        return "UNKNOWN"
    if gap_state not in {"NORMAL_DAY", "GAP_HOLD_CONFIRMED", "GAP_FILL_CONFIRMED"}:
        return "CHOP"
    bullish = close > vwap_value and ema_fast > ema_slow and trend_15m == "BULL"
    bearish = close < vwap_value and ema_fast < ema_slow and trend_15m == "BEAR"
    if (previous == "TRENDING_BULL" and bullish and adx_value >= cfg.adx_exit_threshold):
        return "TRENDING_BULL"
    if (previous == "TRENDING_BEAR" and bearish and adx_value >= cfg.adx_exit_threshold):
        return "TRENDING_BEAR"
    if adx_value >= cfg.adx_entry_threshold:
        if bullish:
            return "TRENDING_BULL"
        if bearish:
            return "TRENDING_BEAR"
        return "CHOP"
    if adx_value < cfg.adx_range_threshold and vwap_crosses >= 2:
        return "RANGE"
    return "CHOP"