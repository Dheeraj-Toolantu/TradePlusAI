from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Literal


@dataclass(frozen=True)
class StrategyConfiguration:
    mode: Literal["BACKTEST", "PAPER", "LIVE_DISABLED", "LIVE"] = "PAPER"
    strategy_name: str = "NIFTY_OPTIONS_V5"
    version: str = "0.1.0"
    timezone: str = "Asia/Kolkata"
    trading_windows: dict[str, int] = field(default_factory=lambda: {
        "market_open": 9 * 60 + 15,
        "or_complete": 9 * 60 + 30,
        "entry_start": 9 * 60 + 35,
        "entry_end": 14 * 60 + 45,
        "mandatory_square_off": 15 * 60 + 15,
    })
    orb_duration_minutes: int = 15
    gap_day_or_duration_minutes: int = 30
    gap_threshold_atr_multiplier: float = 0.5
    adx_entry_threshold: float = 22.0
    adx_exit_threshold: float = 16.0
    adx_range_threshold: float = 18.0
    adx_chop_lower: float = 16.0
    adx_chop_upper: float = 22.0
    atr_period: int = 14
    atr_buffer_multiplier: float = 0.2
    ema_fast_period: int = 20
    ema_slow_period: int = 50
    volume_multiplier: float = 1.5
    ors_thresholds: dict[str, float] = field(default_factory=lambda: {"strong": 1.3, "normal": 1.0, "underperform": 0.8, "abnormal_spread": 0.2})
    oipcr_thresholds: dict[str, float] = field(default_factory=lambda: {"strong_min": 0.85, "strong_max": 1.15, "supportive_direction": 0.5})
    vix_percentile_thresholds: dict[str, float] = field(default_factory=lambda: {"low_upper": 20.0, "normal_upper": 80.0, "high_upper": 95.0})
    liquidity_thresholds: dict[str, float] = field(default_factory=lambda: {"minimum_score": 2.0, "spread_pct_max": 0.10})
    score_thresholds: dict[str, float] = field(default_factory=lambda: {"minimum_trade_score": 8.0, "maximum_score": 10.0})
    rr_minimum: float = 2.0
    risk_per_trade_pct: float = 0.5
    max_normal_risk_pct: float = 0.75
    exceptional_risk_pct: float = 1.0
    daily_loss_limit_pct: float = 2.0
    max_trades_per_day: int = 3
    max_consecutive_losses: int = 2
    cooldown_minutes_after_loss_1: int = 15
    cooldown_minutes_after_loss_2: int = 9999
    profit_lock_pct: float = 1.5
    stop_buffer_atr_multiplier: float = 0.2
    trail_parameters: dict[str, float] = field(default_factory=lambda: {"breakeven_r_multiple": 1.0, "trailing_r_multiple": 1.5, "partial_exit_r_multiple": 2.0, "partial_exit_fraction": 0.5})
    entry_timeout_seconds: int = 3
    max_slippage_pct: float = 0.05
    max_data_age_seconds: float = 1.5
    option_quote_stale_seconds: float = 1.5
    max_timestamp_mismatch_seconds: float = 1.5
    expiry_day_adjustments: dict[str, float] = field(default_factory=lambda: {"minimum_score_increase": 1.0, "risk_multiplier": 0.5, "entry_cutoff_minutes": 15})
    decimals: dict[str, int] = field(default_factory=lambda: {"currency": 2, "quantity": 0})
    cache_ttl_seconds: int = 30
    enable_vwap_reversal: bool = False
    enable_range_strategy: bool = False

    def __post_init__(self) -> None:
        if self.atr_period <= 0 or self.ema_fast_period <= 0 or self.ema_slow_period <= 0:
            raise ValueError("indicator periods must be positive")
        if self.volume_multiplier <= 0 or self.score_thresholds["minimum_trade_score"] <= 0:
            raise ValueError("indicator and score thresholds must be positive")
        if self.risk_per_trade_pct <= 0 or self.daily_loss_limit_pct <= 0 or self.rr_minimum < 0:
            raise ValueError("risk and reward configuration is invalid")
        if self.trading_windows["market_open"] >= self.trading_windows["or_complete"]:
            raise ValueError("market open must be before OR completion")
        if self.trading_windows["entry_start"] <= self.trading_windows["or_complete"]:
            raise ValueError("entry start must occur after OR completion")
        if self.max_data_age_seconds <= 0 or self.option_quote_stale_seconds <= 0 or self.max_timestamp_mismatch_seconds <= 0:
            raise ValueError("data quality thresholds must be positive")

    @property
    def minimum_rr(self) -> float:
        return float(self.rr_minimum)

    @property
    def minimum_confidence(self) -> int:
        return int(round(self.score_thresholds["minimum_trade_score"] * 10.0))

    def risk_budget_for(self, capital: Decimal) -> Decimal:
        return (capital * Decimal(str(self.risk_per_trade_pct))) / Decimal("100")
