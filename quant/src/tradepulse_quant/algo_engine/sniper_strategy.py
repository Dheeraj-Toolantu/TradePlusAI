"""NIFTY Sniper AI: rules-first intraday options-buying engine (long CE / long PE, NIFTY only).

Implements the strategy baseline of ``docs/nifty-sniper/REQUIREMENTS.md`` (v1.1) as a deterministic,
explainable, fail-closed rule set. The system is comfortable returning ``NO_TRADE``; a high score
never overrides a hard filter, and nothing here promises a 2x outcome.

Timeframes (spec 6.1)
    15-minute  regime and broader trend   resampled from completed 5-minute candles
    5-minute   setup formation            liquidity event, structure shift, displacement, FVG / OB
    1-minute   execution                  entry trigger and freshness

Candle convention (spec 5.3): a candle's timestamp is its START; intervals are left-closed /
right-open, ``[start, start + interval)``. A candle is usable only once ``start + interval <= now``
(the caller drops forming candles). 15-minute buckets are anchored on the 09:15 IST open.

No repainting (spec 6.3): a swing pivot at bar ``i`` (``left`` / ``right`` bars each side) is
confirmed only at the close of bar ``i + right``; every level, sweep, MSS, FVG and order block keeps
the bar index at which it became known and is never used before that bar has closed.

Setup families (spec 9)
    LIQUIDITY_REVERSAL   sweep of a confirmed, untaken level -> reclaim close -> displacement ->
                         MSS close beyond the protected swing -> 1m trigger.
    BREAKOUT_EXPANSION   tight 5m consolidation -> displacement close beyond the boundary on
                         relative volume -> the boundary holds -> 1m trigger, not over-extended.
    TREND_CONTINUATION   15m TREND regime + 5m HH/HL structure -> pullback into an FVG, OB, VWAP or
                         EMA20 that keeps the protected higher low -> 1m continuation trigger.

Scoring (spec 10): eight components, weights from ``SniperConfig.weights`` (default 20/15/15/15/10/10/5/10).
Missing data scores 0 with status ``UNAVAILABLE``; it is never treated as bullish or bearish.

2x feasibility (spec 12): the premium needed for 2.0x (and 1.5x) of the expected fill is mapped back
to an index move with delta + gamma + theta drag + round-trip charges, and compared with the move the
5-minute ATR plausibly delivers over the holding horizon. This is a HEURISTIC feasibility ratio, not
a probability. ``P(reach_2x_before_stop)`` stays ``UNAVAILABLE`` until a calibrated model, trained on
option-level historical samples with walk-forward validation, exists (spec 12.4).
"""
from __future__ import annotations

import hashlib
import json
import math
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Protocol

from . import premium_math
from .option_selection import years_to_expiry

STRATEGY_ID = "NIFTY_SNIPER"
STRATEGY_NAME = "NIFTY Sniper AI"
CONFIG_VERSION = "sniper-2.0.0"
SUPPORTED_UNDERLYINGS = ("NIFTY",)
FAMILIES = ("LIQUIDITY_REVERSAL", "BREAKOUT_EXPANSION", "TREND_CONTINUATION")
IST = timezone(timedelta(hours=5, minutes=30), name="Asia/Kolkata")
SESSION_OPEN_MIN = 9 * 60 + 15
SQUARE_OFF_MIN = 15 * 60 + 15
FALLBACK_LOT = 65

BULLISH_FLOW = {("PE", "SHORT_BUILDUP"), ("CE", "SHORT_COVERING"), ("CE", "LONG_BUILDUP")}
BEARISH_FLOW = {("CE", "SHORT_BUILDUP"), ("PE", "SHORT_COVERING"), ("PE", "LONG_BUILDUP")}


class CandleLike(Protocol):
    timestamp: str
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass(frozen=True)
class Bar:
    """A completed candle with its parsed start time and interval (minutes)."""
    start: datetime
    minutes: int
    open: float
    high: float
    low: float
    close: float
    volume: float

    @property
    def end(self) -> datetime:
        return self.start + timedelta(minutes=self.minutes)

    @property
    def time(self) -> str:
        return self.start.isoformat()


@dataclass(frozen=True)
class SniperConfig:
    """Versioned research defaults (spec 24). None of these values are proven: validate before use."""
    version: str = CONFIG_VERSION
    # --- structure (5m) -------------------------------------------------------------------
    atr_period: int = 14
    pivot_left: int = 2
    pivot_right: int = 2
    level_age_limit_bars: int = 150          # 5m bars (two sessions) a level stays tradable
    equal_level_tolerance_atr: float = 0.10  # equal highs / lows within this many ATR
    sweep_buffer_atr: float = 0.05           # price must trade beyond the level by this much
    minimum_sweep_depth_atr: float = 0.05
    reclaim_window_bars: int = 2             # the reclaim close must come within this many bars
    minimum_reclaim_close_atr: float = 0.02  # the reclaim close sits this far back inside the level
    volume_confirmation_threshold: float = 1.3
    setup_lookback_bars: int = 12            # a sweep older than this (1 hour) is stale
    signal_max_age_bars: int = 3             # confirmation must be within the last 3 completed 5m bars
    displacement_body_ratio: float = 0.55
    displacement_close_location: float = 0.70  # close in the top (bottom) 30% of the range
    displacement_range_atr: float = 1.10
    fvg_mitigation: str = "FIRST_TOUCH"      # FIRST_TOUCH | MIDPOINT | FULL_FILL
    breakout_range_bars: int = 6
    breakout_max_range_atr: float = 2.5
    max_extension_atr: float = 1.0           # beyond this distance from the trigger level it is a chase
    pullback_bars: int = 6
    zone_tolerance_atr: float = 0.10
    # --- regime (15m) ---------------------------------------------------------------------
    regime_ema_fast: int = 9
    regime_ema_slow: int = 20
    regime_min_bars: int = 4
    high_vol_ratio: float = 1.8              # 15m ATR vs the median true range of the last regime_baseline_bars
    low_vol_ratio: float = 0.6
    regime_baseline_bars: int = 26           # rolling baseline: ~one session of completed 15m bars
    regime_persist_bars: int = 2             # trend conditions must hold on this many completed 15m bars
    orderly_efficiency: float = 0.4          # high vol is ORDERLY when |net move| / path length >= this
    efficiency_bars: int = 4                 # ... over the last 4 completed 15m bars
    high_vol_risk_multiplier: float = 0.5    # HIGH_VOL_ORDERLY: half the rupee risk budget
    # --- 1m trigger -------------------------------------------------------------------------
    trigger_ema: int = 9
    signal_expiry_seconds: int = 180         # the 1m trigger must be this fresh
    max_feed_lag_seconds: int = 150          # last completed 1m candle must have closed this recently
    # --- session ----------------------------------------------------------------------------
    entry_start_min: int = 9 * 60 + 20       # entries from 09:20 (first completed 5m candle) ...
    entry_cutoff_min: int = 15 * 60 + 15     # ... to the 15:15 square-off; feasibility scales to the time left
    min_session_bars_5m: int = 1             # completed 5m candles today before a setup is read (09:20)
    min_minutes_to_square_off: int = 5       # never enter in the last few minutes before 15:15
    hold_minutes: float = 60.0               # intended holding horizon for the feasibility model
    # --- options ----------------------------------------------------------------------------
    preferred_delta_min: float = 0.45
    preferred_delta_max: float = 0.65
    select_delta_min: float = 0.40
    select_delta_max: float = 0.70
    max_spread_percent: float = 2.0
    max_estimated_half_spread_pct: float = 0.005  # Groww chains carry no live bid/ask
    minimum_volume: float = 1.0
    minimum_open_interest: float = 1.0
    min_premium: float = 15.0
    # --- order flow in the SELECTED option (hard filters) -----------------------------------
    # CALL: buying volume in the selected CE premium rising AND put writers' OI change rising.
    # PUT:  buying volume in the selected PE premium rising (index sellers in control) AND call
    #       writers' OI change rising.
    require_premium_volume: bool = True
    premium_volume_recent_bars: int = 5      # the last 5 completed 1m premium candles ...
    premium_volume_prior_bars: int = 20      # ... against the 20 before them
    premium_volume_min_bars: int = 10
    premium_volume_min_ratio: float = 1.2    # recent average volume >= 1.2x the prior average
    premium_buy_share_min: float = 0.55      # >= 55% of the recent volume traded on rising-premium candles
    premium_max_lag_seconds: int = 180       # the premium's last completed candle must be this fresh
    require_writer_oi: bool = True
    writer_oi_strikes: int = 3               # strikes each side of ATM whose OI is summed
    writer_oi_samples: int = 4               # the last 4 stored OI samples (3 intervals, ~9 min at 3 min)
    writer_oi_min_change_pct: float = 0.3    # net writer OI build over the window, % of the starting OI
    writer_oi_max_age_seconds: int = 600     # the newest stored OI sample must be this fresh
    # Strong move: the opposite writers must be COVERING (OI decreasing) while the supportive ones add.
    # CALL: call writers' OI falling near ATM; PUT: put writers' OI falling near ATM.
    require_opposite_covering: bool = True
    opposite_min_cover_pct: float = 0.1      # net fall over the window, % of their starting OI
    # Family-based flow: breakouts and trend continuations need the move CONFIRMED (strict checks
    # above); a liquidity reversal is bought at the turn, before writers reposition, so it only needs
    # the EARLY signs: buyers stepping into the premium over the last 3 minutes and the opposing
    # writers starting to cover.
    early_flow_families: tuple = ("LIQUIDITY_REVERSAL",)
    premium_early_bars: int = 3
    # --- implied vs realised volatility (option buyers lose to IV crush when IV is rich) ---------
    require_iv_check: bool = True
    max_iv_rv_ratio: float = 1.5             # block when the option's IV is above 1.5x realised volatility
    rich_iv_rv_ratio: float = 1.2            # 1.2-1.5x: allowed, scored lower
    rv_daily_lookback: int = 10              # realised vol from the last 10 daily closes ...
    rv_intraday_min_bars: int = 6            # ... or today's 5m bars, whichever is higher (a fast day)
    # --- feasibility / probability -----------------------------------------------------------
    target_multiple: float = 2.0
    partial_multiple: float = 1.5
    stop_percent: float = 25.0
    max_feasibility_ratio: float = 1.25      # needed 2x move / expected move over the hold
    expected_move_atr_multiple: float = 1.0
    max_cost_share: float = 0.15             # charges + slippage as a share of the 2x reward
    slippage_pct: float = 0.003
    # --- risk -------------------------------------------------------------------------------
    max_loss_per_trade: float = 1000.0       # 1% of a ₹1,00,000 reference capital
    max_lots: int = 1
    fixed_lots: int = 0                      # V1 only: the trader's chosen lots taken as they are
    max_chosen_lots: int = 0                 # V2: the trader's chosen lots are a CAP; the ₹ risk budget sizes the trade
    enabled_setups: tuple = ("A", "B", "C")  # A reversal, B breakout, C continuation (each switchable)
    feasibility_scenarios: tuple = (("CONSERVATIVE", -2.0), ("BASE", 0.0), ("FAVOURABLE", 1.0))  # IV change, vol points
    feasibility_gate_scenario: str = "BASE"
    oi_blocks_when_against: bool = True      # OI is context: only an opposing read blocks; neutral / unknown score lower
    # --- scoring ----------------------------------------------------------------------------
    minimum_sniper_score: float = 85.0       # A grade trades; 80-84 is B grade (journal only, no order)
    b_grade_score: float = 80.0
    require_oi: bool = False
    weights: dict = field(default_factory=lambda: {
        "liquidity": 15, "structure": 15, "displacement_fvg": 15, "htf_alignment": 10,
        "volume": 10, "oi": 10, "option_suitability": 10, "feasibility": 10, "entry_timing": 5,
    })
    tick: float = 0.05


SCORE_BANDS = ((85, "A_GRADE", "Tradable when every hard gate passes"), (80, "B_GRADE", "Research / journal only: no order"),
               (0, "NO_TRADE", "Reject"))

# Machine-readable rejection reasons (spec V2 section 17) for each hard gate.
REASON_CODES = {
    "SETUP_CONFIRMED": "NO_VALID_SETUP", "SIGNAL_FRESH": "STALE_DATA", "ENTRY_TRIGGER": "NO_ENTRY_TRIGGER", "NOT_CHASING": "CHASE_LIMIT",
    "ENTRY_WINDOW": "SESSION_CLOSED", "REGIME_PERMITS": "REGIME_BLOCKED", "SETUP_ENABLED": "SETUP_DISABLED", "CONTRACT_SELECTED": "NO_CONTRACT",
    "SPREAD_OK": "SPREAD_TOO_WIDE", "FEASIBILITY_2X": "FEASIBILITY_FAILED", "POSITION_SIZE": "RISK_LIMIT", "OI_AVAILABLE": "OI_UNKNOWN",
    "PREMIUM_VOLUME_RISING": "PREMIUM_MOMENTUM_WEAK", "WRITER_OI_RISING": "OI_AGAINST", "IV_NOT_RICH": "IV_TOO_HIGH", "SCORE_MINIMUM": "SCORE_BELOW_A_GRADE",
}

# Regime permissions (spec V2 5.4): which setups each 15m regime allows, and the risk multiplier.
REGIME_PERMISSIONS = {
    "TREND_UP": {"A": True, "B": True, "C": True}, "TREND_DOWN": {"A": True, "B": True, "C": True},
    "RANGE": {"A": True, "B": True, "C": False}, "LOW_VOL_COMPRESSION": {"A": True, "B": True, "C": False},
    "HIGH_VOL_ORDERLY": {"A": True, "B": True, "C": True}, "HIGH_VOL_DISORDERLY": {"A": False, "B": False, "C": False},
    "UNKNOWN": {"A": False, "B": False, "C": False},
}
SETUP_LETTER = {"LIQUIDITY_REVERSAL": "A", "BREAKOUT_EXPANSION": "B", "TREND_CONTINUATION": "C"}


def config_hash(config: "SniperConfig") -> str:
    """Short hash of every threshold, stored with each decision and trade (spec V2 19)."""
    return hashlib.sha256(json.dumps(asdict(config), sort_keys=True, default=str).encode()).hexdigest()[:12]


# ------------------------------------------------------------------------------- helpers

def _parse(value: object) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return (parsed if parsed.tzinfo else parsed.replace(tzinfo=IST)).astimezone(IST)


def _num(value: object) -> float | None:
    try:
        result = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _r(value: float | None, digits: int = 2) -> float | None:
    return None if value is None else round(float(value), digits)


def _tick(value: float, tick: float, how: str = "near") -> float:
    steps = value / tick
    steps = math.floor(steps + 1e-9) if how == "down" else math.ceil(steps - 1e-9) if how == "up" else round(steps)
    return round(steps * tick, 2)


class _CandleView:
    def __init__(self, row: dict) -> None:
        self.timestamp = row.get("timestamp") or row.get("time")
        self.open, self.high, self.low, self.close = (_num(row.get(k)) or 0.0 for k in ("open", "high", "low", "close"))
        self.volume = _num(row.get("volume")) or 0.0


def to_bars(candles: list[CandleLike] | None, minutes: int) -> list[Bar]:
    out = []
    for raw in candles or []:
        # Candle objects from the engine, or plain dicts from a direct caller.
        candle = _CandleView(raw) if isinstance(raw, dict) else raw
        start = _parse(candle.timestamp)
        if start is None or not (candle.high >= candle.low > 0):
            continue
        out.append(Bar(start, minutes, float(candle.open), float(candle.high), float(candle.low), float(candle.close), float(candle.volume or 0)))
    out.sort(key=lambda bar: bar.start)
    # Duplicate starts: keep the last (latest revision) only.
    dedup: dict[datetime, Bar] = {bar.start: bar for bar in out}
    return [dedup[key] for key in sorted(dedup)]


def resample(bars: list[Bar], minutes: int, now: datetime) -> list[Bar]:
    """Aggregate completed bars into ``minutes`` buckets anchored at 09:15 IST; only completed buckets."""
    buckets: dict[datetime, list[Bar]] = {}
    for bar in bars:
        session_minute = bar.start.hour * 60 + bar.start.minute - SESSION_OPEN_MIN
        if session_minute < 0:
            continue
        offset = session_minute // minutes * minutes
        start = bar.start.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(minutes=SESSION_OPEN_MIN + offset)
        buckets.setdefault(start, []).append(bar)
    out = []
    for start in sorted(buckets):
        rows = buckets[start]
        if start + timedelta(minutes=minutes) > now:
            continue  # still forming: never a confirmation (spec 5.3)
        out.append(Bar(start, minutes, rows[0].open, max(r.high for r in rows), min(r.low for r in rows), rows[-1].close, sum(r.volume for r in rows)))
    return out


def ema_series(values: list[float], period: int) -> list[float]:
    out: list[float] = []
    k = 2.0 / (period + 1.0)
    for index, value in enumerate(values):
        out.append(value if index == 0 else (value - out[-1]) * k + out[-1])
    return out


def atr_series(bars: list[Bar], period: int) -> list[float | None]:
    """Wilder ATR; ``None`` until ``period`` true ranges exist."""
    out: list[float | None] = []
    ranges: list[float] = []
    value: float | None = None
    for index, bar in enumerate(bars):
        tr = bar.high - bar.low if index == 0 else max(bar.high - bar.low, abs(bar.high - bars[index - 1].close), abs(bar.low - bars[index - 1].close))
        ranges.append(tr)
        if len(ranges) == period:
            value = sum(ranges) / period
        elif len(ranges) > period and value is not None:
            value = (value * (period - 1) + tr) / period
        out.append(value)
    return out


def session_vwap(bars: list[Bar]) -> tuple[float | None, bool]:
    """Volume-weighted typical price of today's session; unobservable without volume."""
    if not bars:
        return None, False
    day = bars[-1].start.date()
    session = [bar for bar in bars if bar.start.date() == day]
    volume = sum(bar.volume for bar in session)
    if volume <= 0:
        return None, False
    return sum((bar.high + bar.low + bar.close) / 3.0 * bar.volume for bar in session) / volume, True


def relative_volume(bars: list[Bar], index: int, lookback: int = 20) -> float | None:
    if index < 1 or bars[index].volume <= 0:
        return None
    prior = [bar.volume for bar in bars[max(0, index - lookback):index] if bar.volume > 0]
    if len(prior) < 5:
        return None
    return bars[index].volume / (sum(prior) / len(prior))


# ------------------------------------------------------------------------------- structure

@dataclass(frozen=True)
class Pivot:
    kind: str          # HIGH | LOW
    index: int         # pivot candle
    confirmed_index: int  # bar whose close confirms it (index + right)
    price: float
    time: str
    confirmed_at: str


def find_pivots(bars: list[Bar], left: int, right: int) -> list[Pivot]:
    """Fractal pivots, each stamped with the bar that confirms it (no look-ahead)."""
    pivots = []
    for i in range(left, len(bars) - right):
        window = bars[i - left:i + right + 1]
        others = [bar for j, bar in enumerate(window) if j != left]
        if all(bars[i].high > bar.high for bar in others):
            pivots.append(Pivot("HIGH", i, i + right, bars[i].high, bars[i].time, bars[i + right].end.isoformat()))
        if all(bars[i].low < bar.low for bar in others):
            pivots.append(Pivot("LOW", i, i + right, bars[i].low, bars[i].time, bars[i + right].end.isoformat()))
    return pivots


@dataclass(frozen=True)
class Level:
    name: str           # PDH, PDL, SWING_HIGH, EQUAL_LOWS, SESSION_HIGH ...
    side: str           # HIGH (buy-side liquidity above) | LOW (sell-side liquidity below)
    price: float
    known_index: int    # first 5m bar at whose close the level is known (-1 = before the series)
    source_timeframe: str
    created_at: str
    quality: int        # 1-5: how much resting liquidity the level is assumed to hold


def build_levels(bars: list[Bar], pivots: list[Pivot], daily: dict, config: SniperConfig, atr: float) -> list[Level]:
    levels: list[Level] = []
    if daily.get("pdh") is not None:
        levels.append(Level("PDH", "HIGH", daily["pdh"], -1, "1D", daily.get("date") or "", 5))
    if daily.get("pdl") is not None:
        levels.append(Level("PDL", "LOW", daily["pdl"], -1, "1D", daily.get("date") or "", 5))
    tolerance = config.equal_level_tolerance_atr * atr
    for kind in ("HIGH", "LOW"):
        same = [p for p in pivots if p.kind == kind]
        for n, pivot in enumerate(same):
            equal = any(abs(other.price - pivot.price) <= tolerance for other in same[:n])
            name = ("EQUAL_HIGHS" if kind == "HIGH" else "EQUAL_LOWS") if equal else ("SWING_HIGH" if kind == "HIGH" else "SWING_LOW")
            levels.append(Level(name, kind, pivot.price, pivot.confirmed_index, "5m", pivot.confirmed_at, 4 if equal else 3))
    return levels


def level_untaken(bars: list[Bar], level: Level, before: int) -> bool:
    """No bar between the level becoming known and ``before`` traded through it."""
    for bar in bars[max(level.known_index + 1, 0):before]:
        if (level.side == "LOW" and bar.low < level.price) or (level.side == "HIGH" and bar.high > level.price):
            return False
    return True


def is_displacement(bar: Bar, atr: float, direction: int, config: SniperConfig) -> bool:
    rng = bar.high - bar.low
    if rng <= 0 or atr <= 0:
        return False
    body = (bar.close - bar.open) * direction
    location = (bar.close - bar.low) / rng if direction > 0 else (bar.high - bar.close) / rng
    return body > 0 and body / rng >= config.displacement_body_ratio and location >= config.displacement_close_location and rng >= config.displacement_range_atr * atr


def displacement_metrics(bar: Bar, atr: float) -> dict:
    rng = bar.high - bar.low
    return {"time": bar.time, "body": _r(abs(bar.close - bar.open)), "range": _r(rng), "body_ratio": _r(abs(bar.close - bar.open) / rng if rng else 0, 3),
            "close_location": _r((bar.close - bar.low) / rng if rng else 0, 3), "range_atr": _r(rng / atr if atr else None, 2)}


def find_fvg(bars: list[Bar], middle: int, direction: int, last_index: int, config: SniperConfig) -> dict | None:
    """Three completed candles around ``middle``; mitigation is tracked up to ``last_index``."""
    if middle < 1 or middle + 1 > last_index:
        return None
    first, third = bars[middle - 1], bars[middle + 1]
    if direction > 0 and first.high < third.low:
        lower, upper = first.high, third.low
    elif direction < 0 and first.low > third.high:
        lower, upper = third.high, first.low
    else:
        return None
    mid = (upper + lower) / 2.0
    status = "UNMITIGATED"
    for bar in bars[middle + 2:last_index + 1]:
        if direction > 0:
            if bar.close < lower:
                status = "INVALIDATED"
                break
            touched = bar.low <= (upper if config.fvg_mitigation == "FIRST_TOUCH" else mid if config.fvg_mitigation == "MIDPOINT" else lower)
        else:
            if bar.close > upper:
                status = "INVALIDATED"
                break
            touched = bar.high >= (lower if config.fvg_mitigation == "FIRST_TOUCH" else mid if config.fvg_mitigation == "MIDPOINT" else upper)
        if touched:
            status = "MITIGATED"
    return {"direction": "BULLISH" if direction > 0 else "BEARISH", "lower": _r(lower), "upper": _r(upper), "size": _r(upper - lower),
            "timeframe": "5m", "formed_at": bars[middle + 1].end.isoformat(), "middle_index": middle, "status": status, "mitigation_rule": config.fvg_mitigation}


def find_order_block(bars: list[Bar], displacement: int, direction: int, start: int, last_index: int) -> dict | None:
    """Last opposite-colour candle before the displacement (an algorithmic zone, not verified institutional flow)."""
    for i in range(displacement - 1, max(start, 0) - 1, -1):
        bar = bars[i]
        if (bar.close - bar.open) * direction < 0:
            status = "ACTIVE"
            for later in bars[displacement + 1:last_index + 1]:
                if (direction > 0 and later.close < bar.low) or (direction < 0 and later.close > bar.high):
                    status = "INVALIDATED"
                    break
                if (direction > 0 and later.low <= bar.high) or (direction < 0 and later.high >= bar.low):
                    status = "MITIGATED"
            return {"direction": "BULLISH" if direction > 0 else "BEARISH", "lower": _r(bar.low), "upper": _r(bar.high), "source_time": bar.time,
                    "formed_at": bars[displacement].end.isoformat(), "displacement_time": bars[displacement].time, "status": status}
    return None


def structure_state(pivots: list[Pivot], upto: int) -> dict:
    """HH/HL (bullish) or LH/LL (bearish) from the last two confirmed swings of each kind."""
    highs = [p for p in pivots if p.kind == "HIGH" and p.confirmed_index <= upto]
    lows = [p for p in pivots if p.kind == "LOW" and p.confirmed_index <= upto]
    out = {"trend": "NEUTRAL", "last_high": _r(highs[-1].price) if highs else None, "last_low": _r(lows[-1].price) if lows else None}
    if len(highs) >= 2 and len(lows) >= 2:
        if highs[-1].price > highs[-2].price and lows[-1].price > lows[-2].price:
            out["trend"] = "BULLISH"
        elif highs[-1].price < highs[-2].price and lows[-1].price < lows[-2].price:
            out["trend"] = "BEARISH"
    return out


def classify_regime(bars15: list[Bar], vwap: float | None, config: SniperConfig) -> dict:
    """15m regime (spec V2 section 5): one label plus the measurements behind it.

    The volatility baseline is the median true range of the last ``regime_baseline_bars`` completed
    15m bars. High volatility is split by directional efficiency (|net move| / path length over the
    last ``efficiency_bars``): ORDERLY expansion vs DISORDERLY whipsaw. A trend needs its conditions
    on the last ``regime_persist_bars`` completed bars. Too little data is UNKNOWN.
    """
    out: dict = {"regime": "UNKNOWN", "bars": len(bars15), "confidence": 0.0}
    if len(bars15) < max(config.regime_min_bars, config.regime_persist_bars + 3):
        out["reason"] = f"Need {max(config.regime_min_bars, config.regime_persist_bars + 3)} completed 15m bars (have {len(bars15)})"
        return out
    closes = [bar.close for bar in bars15]
    fast = ema_series(closes, config.regime_ema_fast)
    slow = ema_series(closes, config.regime_ema_slow)
    atrs = atr_series(bars15, min(config.atr_period, max(2, len(bars15) - 1)))
    trs = [max(b.high - b.low, abs(b.high - bars15[i - 1].close), abs(b.low - bars15[i - 1].close)) if i else b.high - b.low for i, b in enumerate(bars15)]
    baseline = sorted(trs[-config.regime_baseline_bars:])
    median_range = baseline[len(baseline) // 2] if baseline else 0.0
    atr = atrs[-1] or 0.0
    vol_ratio = atr / median_range if median_range > 0 and atr > 0 else None
    path = closes[-(config.efficiency_bars + 1):]
    travel = sum(abs(b - a) for a, b in zip(path, path[1:]))
    efficiency = abs(path[-1] - path[0]) / travel if travel > 0 else 0.0
    close = closes[-1]

    def trend(i: int, d: int) -> bool:
        slope = slow[i] - slow[i - 3] if i >= 3 else 0.0
        return (fast[i] - slow[i]) * d > 0 and slope * d > 0 and (vwap is None or (closes[i] - vwap) * d > 0 or i < len(closes) - 1)

    persists = {d: all(trend(len(closes) - 1 - k, d) for k in range(config.regime_persist_bars)) for d in (1, -1)}
    out.update(ema_fast=_r(fast[-1]), ema_slow=_r(slow[-1]), slope=_r(slow[-1] - slow[-4]), atr=_r(atr), baseline_range=_r(median_range),
               vol_ratio=_r(vol_ratio), efficiency=_r(efficiency, 3), close=_r(close))
    if vol_ratio is not None and vol_ratio >= config.high_vol_ratio:
        orderly = efficiency >= config.orderly_efficiency
        out["regime"] = "HIGH_VOL_ORDERLY" if orderly else "HIGH_VOL_DISORDERLY"
        out["confidence"] = _r(min(1.0, efficiency / config.orderly_efficiency) if orderly else 1.0 - efficiency, 2)
    elif vol_ratio is not None and vol_ratio <= config.low_vol_ratio and abs(fast[-1] - slow[-1]) < 0.25 * atr:
        out["regime"], out["confidence"] = "LOW_VOL_COMPRESSION", 0.7
    elif persists[1]:
        out["regime"], out["confidence"] = "TREND_UP", _r(min(1.0, 0.5 + efficiency), 2)
    elif persists[-1]:
        out["regime"], out["confidence"] = "TREND_DOWN", _r(min(1.0, 0.5 + efficiency), 2)
    else:
        out["regime"], out["confidence"] = "RANGE", _r(1.0 - efficiency, 2)
    return out

def daily_reference(bars5: list[Bar], daily_candles: list[CandleLike] | None, today) -> dict:
    """PDH / PDL / PDC from the exchange daily bar when available, else from the prior 5m session."""
    best = None
    for candle in daily_candles or []:
        start = _parse(candle.timestamp)
        if start is not None and start.date() < today and candle.high > 0:
            if best is None or start.date() > best[0]:
                best = (start.date(), candle.high, candle.low, candle.close)
    if best is None:
        prior_days = sorted({bar.start.date() for bar in bars5 if bar.start.date() < today})
        if prior_days:
            rows = [bar for bar in bars5 if bar.start.date() == prior_days[-1]]
            best = (prior_days[-1], max(r.high for r in rows), min(r.low for r in rows), rows[-1].close)
    if best is None:
        return {"pdh": None, "pdl": None, "pdc": None, "date": None}
    return {"pdh": best[1], "pdl": best[2], "pdc": best[3], "date": best[0].isoformat()}


# ------------------------------------------------------------------------------- 1m trigger

def one_minute_trigger(bars1: list[Bar], direction: int, now: datetime, config: SniperConfig) -> dict:
    """The latest completed 1m candle closes in the trade direction, beyond its 9 EMA and the prior candle's extreme."""
    if len(bars1) < config.trigger_ema + 2:
        return {"ok": False, "reason": f"Need {config.trigger_ema + 2} completed 1m candles"}
    ema = ema_series([bar.close for bar in bars1], config.trigger_ema)
    last, prev = bars1[-1], bars1[-2]
    age = (now - last.end).total_seconds()
    beyond_prev = (last.close - (prev.high if direction > 0 else prev.low)) * direction > 0
    beyond_ema = (last.close - ema[-1]) * direction > 0
    coloured = (last.close - last.open) * direction > 0
    ok = beyond_prev and beyond_ema and coloured and age <= config.signal_expiry_seconds
    reasons = []
    if not coloured:
        reasons.append("1m candle is not a " + ("bull" if direction > 0 else "bear") + " candle")
    if not beyond_ema:
        reasons.append(f"1m close {'below' if direction > 0 else 'above'} the 9 EMA {ema[-1]:.2f}")
    if not beyond_prev:
        reasons.append("1m close has not taken the prior candle's " + ("high" if direction > 0 else "low"))
    if age > config.signal_expiry_seconds:
        reasons.append(f"latest 1m candle closed {age:.0f}s ago (max {config.signal_expiry_seconds}s)")
    return {"ok": ok, "time": last.time, "close": _r(last.close), "ema9": _r(ema[-1]), "age_seconds": round(age),
            "reason": "1m trigger: close beyond the 9 EMA and the prior candle" if ok else "; ".join(reasons)}


# ------------------------------------------------------------------------------- setup detectors

def _fresh(index: int, last_index: int, config: SniperConfig) -> bool:
    return last_index - index < config.signal_max_age_bars


def detect_reversal(bars: list[Bar], pivots: list[Pivot], levels: list[Level], atrs: list[float | None], direction: int, config: SniperConfig) -> dict:
    """Setup A. Bullish (direction +1) sweeps a LOW; bearish sweeps a HIGH."""
    last = len(bars) - 1
    want = "LOW" if direction > 0 else "HIGH"
    out: dict = {"family": "LIQUIDITY_REVERSAL", "direction": direction, "state": "NONE", "sweep": None, "mss": None, "displacement": None, "fvg": None, "order_block": None}
    best = None
    for j in range(max(1, last - config.setup_lookback_bars + 1), last + 1):
        atr = atrs[j - 1] or atrs[j]
        if not atr:
            continue
        bar = bars[j]
        for level in levels:
            if level.side != want or level.known_index >= j or (level.known_index >= 0 and j - level.known_index > config.level_age_limit_bars):
                continue
            if not level_untaken(bars, level, j):
                continue
            depth = (level.price - bar.low) if direction > 0 else (bar.high - level.price)
            if depth < max(config.sweep_buffer_atr, config.minimum_sweep_depth_atr) * atr:
                continue
            reclaim = None
            for k in range(j, min(j + config.reclaim_window_bars, last + 1)):
                if (bars[k].close - level.price) * direction >= config.minimum_reclaim_close_atr * atr:
                    reclaim = k
                    break
            if reclaim is None:
                continue
            candidate = {"level": level, "index": j, "reclaim_index": reclaim, "depth": depth, "atr": atr}
            if best is None or j > best["index"] or (j == best["index"] and level.quality > best["level"].quality):
                best = candidate
    if best is None:
        out["reason"] = f"No sweep of a confirmed, untaken {'low' if direction > 0 else 'high'} in the last {config.setup_lookback_bars} 5m bars"
        return out
    j, k, level, atr = best["index"], best["reclaim_index"], best["level"], best["atr"]
    extreme = bars[j].low if direction > 0 else bars[j].high
    window = bars[j:k + 1]
    out["sweep"] = {"level_name": level.name, "level": _r(level.price), "level_quality": level.quality, "level_created_at": level.created_at,
                    "sweep_time": bars[j].time, "extreme": _r(extreme), "depth": _r(best["depth"]), "depth_atr": _r(best["depth"] / atr),
                    "reclaim_time": bars[k].time, "reclaim_bars": k - j + 1, "reclaim_distance": _r((bars[k].close - level.price) * direction),
                    "volume": _r(sum(bar.volume for bar in window)), "relative_volume": _r(relative_volume(bars, j)), "confirmed_at": bars[k].end.isoformat()}
    out["state"] = "WATCH"
    # Protected level: the last swing (opposite kind) confirmed before the sweep bar.
    opposite = "HIGH" if direction > 0 else "LOW"
    swings = [p for p in pivots if p.kind == opposite and p.confirmed_index < j]
    if swings:
        protected = swings[-1].price
        protected_from = f"confirmed swing {opposite.lower()} {swings[-1].time[11:16]}"
    else:
        lookback = bars[max(0, j - 2 * config.pivot_left):j]
        if not lookback:
            out["reason"] = "Sweep found; no structure level to shift"
            return out
        protected = max(b.high for b in lookback) if direction > 0 else min(b.low for b in lookback)
        protected_from = "pre-sweep range extreme (no confirmed swing)"
    mss_index = next((m for m in range(k, min(j + config.setup_lookback_bars, last + 1)) if (bars[m].close - protected) * direction > 0), None)
    if mss_index is None:
        out["reason"] = f"{level.name} {level.price:.2f} swept and reclaimed; waiting for a close {'above' if direction > 0 else 'below'} the protected level {protected:.2f} (MSS)"
        out["protected_level"] = _r(protected)
        return out
    out["mss"] = {"type": "MSS", "level": _r(protected), "protected_from": protected_from, "time": bars[mss_index].time, "confirmed_at": bars[mss_index].end.isoformat(), "index": mss_index}
    disp_index = next((d for d in range(mss_index, j - 1, -1) if is_displacement(bars[d], atrs[d - 1] or atr, direction, config)), None)
    if disp_index is not None:
        out["displacement"] = displacement_metrics(bars[disp_index], atrs[disp_index - 1] or atr) | {"index": disp_index}
        out["fvg"] = find_fvg(bars, disp_index, direction, last, config)
        out["order_block"] = find_order_block(bars, disp_index, direction, j, last)
    out["key_index"] = disp_index if disp_index is not None else mss_index
    out["invalidation"] = _r(extreme - direction * config.sweep_buffer_atr * atr)
    out["trigger_level"] = _r(protected)
    out["structure_confirmed"] = True
    out["displacement_ok"] = disp_index is not None
    out["fresh"] = _fresh(mss_index, last, config)
    out["state"] = "CONFIRMED" if out["displacement_ok"] and out["fresh"] else "WATCH"
    out["reason"] = (f"{level.name} {level.price:.2f} swept to {extreme:.2f}, reclaimed, MSS close beyond {protected:.2f} at {bars[mss_index].time[11:16]}"
                     + ("" if out["displacement_ok"] else "; no displacement candle (stays WATCH)")
                     + ("" if out["fresh"] else f"; MSS is {last - mss_index + 1} bars old (expired)"))
    if not out["fresh"]:
        out["state"] = "EXPIRED"
    return out


def detect_breakout(bars: list[Bar], pivots: list[Pivot], atrs: list[float | None], direction: int, regime: dict, config: SniperConfig) -> dict:
    """Setup B: a completed close beyond a tight range boundary, with displacement and relative volume, that holds."""
    last = len(bars) - 1
    out: dict = {"family": "BREAKOUT_EXPANSION", "direction": direction, "state": "NONE"}
    n = config.breakout_range_bars
    for b in range(last, max(n, last - config.signal_max_age_bars), -1):
        atr = atrs[b - 1]
        if not atr or bars[b].start.date() != bars[b - n].start.date():
            continue
        base = bars[b - n:b]
        top, bottom = max(x.high for x in base), min(x.low for x in base)
        boundary = top if direction > 0 else bottom
        if (top - bottom) > config.breakout_max_range_atr * atr or (bars[b].close - boundary) * direction <= 0:
            continue
        touches = sum(1 for x in base if abs((x.high if direction > 0 else x.low) - boundary) <= config.zone_tolerance_atr * atr)
        holds = all((x.close - boundary) * direction > 0 for x in bars[b + 1:last + 1])
        rvol = relative_volume(bars, b)
        displaced = is_displacement(bars[b], atr, direction, config)
        bos_swing = any(p.kind == ("HIGH" if direction > 0 else "LOW") and p.confirmed_index < b and (bars[b].close - p.price) * direction > 0 and (boundary - p.price) * direction >= -config.zone_tolerance_atr * atr for p in pivots)
        htf_against = regime.get("regime") == ("TREND_DOWN" if direction > 0 else "TREND_UP")
        out.update({"range": {"high": _r(top), "low": _r(bottom), "height_atr": _r((top - bottom) / atr), "bars": n, "boundary_touches": touches},
                    "breakout": {"time": bars[b].time, "close": _r(bars[b].close), "confirmed_at": bars[b].end.isoformat(), "relative_volume": _r(rvol), "holds": holds},
                    "displacement": displacement_metrics(bars[b], atr) | {"index": b} if displaced else None, "bos_swing": bos_swing,
                    "fvg": find_fvg(bars, b, direction, last, config) if displaced else None, "order_block": None,
                    "key_index": b, "trigger_level": _r(boundary), "invalidation": _r((bottom if direction > 0 else top) if (top - bottom) <= atr else boundary - direction * 0.5 * atr),
                    "structure_confirmed": True, "displacement_ok": displaced, "fresh": True, "htf_against": htf_against})
        missing = []
        if not displaced:
            missing.append("no displacement on the breakout candle")
        if rvol is None:
            missing.append("relative volume unavailable")
        elif rvol < config.volume_confirmation_threshold:
            missing.append(f"relative volume {rvol:.2f}x (needs {config.volume_confirmation_threshold}x)")
        if not holds:
            missing.append("price closed back inside the range (failed breakout, not a reversal setup)")
        if htf_against:
            missing.append(f"15m regime is {regime.get('regime')}")
        # Entry mode (spec V2 7.2): a later bar that came back to the broken boundary and held is a retest.
        retest = any(((x.low if direction > 0 else x.high) - boundary) * direction <= config.zone_tolerance_atr * atr for x in bars[b + 1:last + 1])
        out["entry_mode"] = "RETEST_BREAKOUT" if retest else "MOMENTUM_BREAKOUT"
        out["state"] = "CONFIRMED" if not missing else "WATCH"
        out["reason"] = f"{'Retest' if retest else 'Momentum'} breakout: {'bull' if direction > 0 else 'bear'} close beyond the {n}-bar range {'high' if direction > 0 else 'low'} {boundary:.2f} at {bars[b].time[11:16]}" + (f"; {', '.join(missing)}" if missing else "")
        return out
    out["reason"] = f"No completed close beyond a tight {n}-bar range in the last {config.signal_max_age_bars} 5m bars"
    return out


def detect_continuation(bars: list[Bar], pivots: list[Pivot], atrs: list[float | None], direction: int, regime: dict, vwap: float | None, config: SniperConfig) -> dict:
    """Setup C: trend regime + 5m structure, a pullback into a zone that keeps the protected swing."""
    last = len(bars) - 1
    out: dict = {"family": "TREND_CONTINUATION", "direction": direction, "state": "NONE"}
    wanted = "TREND_UP" if direction > 0 else "TREND_DOWN"
    structure = structure_state(pivots, last)
    out["structure"] = structure
    if regime.get("regime") != wanted:
        out["reason"] = f"15m regime is {regime.get('regime')} (needs {wanted})"
        return out
    if structure["trend"] != ("BULLISH" if direction > 0 else "BEARISH"):
        out["reason"] = f"5m structure is {structure['trend'].lower()} (needs {'HH/HL' if direction > 0 else 'LH/LL'})"
        out["state"] = "DETECTED"
        return out
    atr = atrs[last] or 0.0
    protected = structure["last_low"] if direction > 0 else structure["last_high"]
    window = bars[max(0, last - config.pullback_bars + 1):last + 1]
    extreme = min(b.low for b in window) if direction > 0 else max(b.high for b in window)
    if protected is None or (extreme - protected) * direction <= 0:
        out.update(state="INVALIDATED", reason=f"Pullback {extreme:.2f} broke the protected {'higher low' if direction > 0 else 'lower high'} {protected}")
        return out
    ema20 = ema_series([b.close for b in bars], 20)[-1]
    zones = []
    tol = config.zone_tolerance_atr * atr
    for middle in range(max(1, last - 3 * config.pullback_bars), last):
        fvg = find_fvg(bars, middle, direction, last, config)
        if fvg and fvg["status"] != "INVALIDATED" and fvg["lower"] - tol <= extreme <= fvg["upper"] + tol:
            zones.append(("FVG", fvg))
            break
    disp = next((d for d in range(last - config.pullback_bars, max(0, last - 3 * config.pullback_bars), -1) if atrs[d - 1] and is_displacement(bars[d], atrs[d - 1], direction, config)), None)
    ob = find_order_block(bars, disp, direction, max(0, disp - 6), last) if disp is not None else None
    if ob and ob["status"] != "INVALIDATED" and ob["lower"] - tol <= extreme <= ob["upper"] + tol:
        zones.append(("ORDER_BLOCK", ob))
    if vwap is not None and abs(extreme - vwap) <= max(tol, 0.25 * atr):
        zones.append(("VWAP", {"level": _r(vwap)}))
    if abs(extreme - ema20) <= max(tol, 0.25 * atr):
        zones.append(("EMA20", {"level": _r(ema20)}))
    out.update(pullback={"extreme": _r(extreme), "protected": protected, "zones": [name for name, _ in zones]},
               fvg=next((z for name, z in zones if name == "FVG"), None), order_block=ob,
               displacement=displacement_metrics(bars[disp], atrs[disp - 1] or atr) | {"index": disp} if disp is not None else None,
               key_index=disp if disp is not None else last, trigger_level=_r(bars[last].high if direction > 0 else bars[last].low),
               invalidation=_r(protected - direction * config.sweep_buffer_atr * atr), structure_confirmed=True, displacement_ok=disp is not None, fresh=True)
    if not zones:
        out.update(state="WATCH", reason=f"Trend intact; waiting for a pullback into an FVG, order block, VWAP or EMA20 (pullback extreme {extreme:.2f})")
        return out
    # A touch of a zone is not an entry (spec V2 7.3): the last completed 5m candle must show the
    # trend side returning: a candle in the trade direction closing in its outer 40%.
    lastbar = bars[last]
    rng = lastbar.high - lastbar.low
    location = ((lastbar.close - lastbar.low) / rng if direction > 0 else (lastbar.high - lastbar.close) / rng) if rng > 0 else 0.0
    returning = (lastbar.close - lastbar.open) * direction > 0 and location >= 0.6
    out["rejection"] = {"time": lastbar.time, "close_location": _r(location, 3), "ok": returning}
    if not returning:
        out.update(state="WATCH", reason=f"Pullback into {', '.join(name for name, _ in zones)} held; waiting for {'buyers' if direction > 0 else 'sellers'} to return (a 5m {'bull' if direction > 0 else 'bear'} rejection candle)")
        return out
    out.update(state="CONFIRMED", reason=f"{wanted} regime, 5m {'HH/HL' if direction > 0 else 'LH/LL'}; pullback to {', '.join(name for name, _ in zones)} held the protected swing {protected}")
    return out


# ------------------------------------------------------------------------------- options

def select_contracts(chain: list[dict], side: str, config: SniperConfig) -> tuple[list[dict], list[dict]]:
    """Rank the trade side's contracts; return (ranked candidates, rejected with reasons)."""
    wanted = "CALL" if side == "CE" else "PUT"
    ranked, rejected = [], []
    for row in chain:
        if str(row.get("contract", "")).upper() != wanted:
            continue
        symbol = row.get("symbol")
        premium = _num(row.get("premium")) or 0.0
        delta = abs(_num(row.get("delta")) or 0.0)
        bid, ask = _num(row.get("bid")) or 0.0, _num(row.get("ask")) or 0.0
        spread_pct = (ask - bid) / premium * 100 if ask > bid > 0 and premium > 0 else None
        oi, volume = _num(row.get("openInterest")) or 0.0, _num(row.get("volume")) or 0.0
        reasons = []
        if premium < config.min_premium:
            reasons.append(f"premium ₹{premium:.2f} below ₹{config.min_premium:.0f}")
        if not (config.select_delta_min <= delta <= config.select_delta_max):
            reasons.append(f"delta {delta:.2f} outside {config.select_delta_min}-{config.select_delta_max}")
        if spread_pct is not None and spread_pct > config.max_spread_percent:
            reasons.append(f"spread {spread_pct:.1f}% above {config.max_spread_percent}%")
        if oi < config.minimum_open_interest:
            reasons.append("no open interest")
        if volume < config.minimum_volume:
            reasons.append("no traded volume")
        if not symbol or not row.get("expiry"):
            reasons.append("contract metadata incomplete")
        if reasons:
            if config.select_delta_min - 0.15 <= delta <= config.select_delta_max + 0.15:
                rejected.append({"symbol": symbol, "strike": _num(row.get("strike")), "reasons": reasons})
            continue
        ranked.append({"symbol": symbol, "strike": float(row.get("strike") or 0), "type": side, "expiry": row.get("expiry"), "premium": premium,
                       "bid": bid or None, "ask": ask or None, "delta": round(delta, 3), "iv": _num(row.get("iv")), "theta": _num(row.get("theta")),
                       "open_interest": oi, "volume": volume, "spread_pct": _r(spread_pct), "spread_source": "QUOTE" if spread_pct is not None else "UNAVAILABLE",
                       "lot_size": _num(row.get("lotSize")), "tick_size": _num(row.get("tickSize")), "freeze_quantity": _num(row.get("freezeQuantity")),
                       "liquidity_score": int(premium >= config.min_premium) + int(oi > 0) + int(volume > 0)})
    if not ranked:
        return [], rejected
    by_oi = sorted(ranked, key=lambda item: item["open_interest"])
    by_vol = sorted(ranked, key=lambda item: item["volume"])
    centre = (config.preferred_delta_min + config.preferred_delta_max) / 2.0
    half = (config.preferred_delta_max - config.preferred_delta_min) / 2.0
    for item in ranked:
        liquidity = (by_oi.index(item) + by_vol.index(item)) / max(2 * (len(ranked) - 1), 1) * 3.0
        delta_fit = 3.0 * max(0.0, 1.0 - abs(item["delta"] - centre) / max(half * 2, 1e-6))
        spread_pen = 0.0 if item["spread_pct"] is None else min(item["spread_pct"] / config.max_spread_percent, 1.0)
        item["rank_score"] = round(liquidity + delta_fit - spread_pen, 3)
    return sorted(ranked, key=lambda item: item["rank_score"], reverse=True), rejected


def feasibility(selected: dict, spot: float, atr5: float, now: datetime, symbol: str, config: SniperConfig, risk_multiplier: float = 1.0) -> dict:
    """1.5x / 2x feasibility by scenario repricing (index move needed vs the move ATR delivers) and V2 sizing."""
    side = selected["type"]
    market = float(selected["premium"])
    ask = selected["ask"] if selected.get("ask") and selected["ask"] > market * 0.9 else market
    tick = selected.get("tick_size") or config.tick
    entry = _tick(ask * (1.0 + config.slippage_pct), tick, "up")
    stop = _tick(entry * (1.0 - config.stop_percent / 100.0), tick, "near")
    target = _tick(entry * config.target_multiple, tick, "up")
    partial = _tick(entry * config.partial_multiple, tick, "up")
    lot = int(selected.get("lot_size") or FALLBACK_LOT)
    years = years_to_expiry(selected.get("expiry"), now)
    sigma = (selected.get("iv") or 0) / 100.0
    if sigma <= 0 and years:
        sigma = premium_math.implied_vol(market, spot, selected["strike"], years, side) or 0.0
    greeks = premium_math.bs_greeks(spot, selected["strike"], years, sigma, side) if years and sigma > 0 else None
    delta = abs(float(selected["delta"]))
    gamma = greeks["gamma"] if greeks else 0.0
    vega = greeks.get("vega") if greeks else None
    theta = selected.get("theta")
    theta_day = abs(float(theta)) if theta not in (None, 0) else abs(greeks["theta"]) if greeks else 0.0
    # Late in the day the trade has only until the 15:15 square-off: the hold (and so the expected
    # move and the theta drag) shrinks to the time left instead of blocking the entry outright.
    minutes_left = SQUARE_OFF_MIN - (now.hour * 60 + now.minute)
    hold = max(min(config.hold_minutes, float(minutes_left)), 1.0)
    drag = theta_day * hold / 375.0
    half_spread = min(max(((selected.get("ask") or market) - (selected.get("bid") or market)) / 2.0, 0.0), market * config.max_estimated_half_spread_pct)
    fees = premium_math.PremiumConfig(slippage_pct=0.0)
    cost_target = premium_math.round_trip_costs(entry, target, lot, 0.0, fees)["total"] + (half_spread + config.slippage_pct * target) * lot
    cost_stop = premium_math.round_trip_costs(entry, stop, lot, 0.0, fees)["total"] + (half_spread + config.slippage_pct * stop) * lot

    def move_for(level: float) -> float | None:
        gain = level - market + drag + cost_target / lot
        if gain <= 0:
            return 0.0
        if gamma <= 1e-12:
            return gain / delta if delta > 0 else None
        return (-delta + math.sqrt(delta * delta + 2.0 * gamma * gain)) / gamma

    # Scenario repricing (spec V2 11): reprice the option with the model at the market-implied vol,
    # after the hold has elapsed, under an IV change per scenario, and solve for the index move that
    # gets the exit (net of charges and exit slippage) to the level. The delta-gamma estimate above
    # is kept only as a diagnostic / fallback when the option cannot be modelled.
    d = 1 if side == "CE" else -1
    model_sigma = premium_math.implied_vol(market, spot, selected["strike"], years, side) if years else None
    model_sigma = model_sigma or sigma
    years_after = max((years or 0.0) - (hold / 375.0) / 365.0, 1e-6)

    def reprice_move(level: float, iv_shift: float) -> float | None:
        if not years or not model_sigma or model_sigma <= 0:
            return None
        vol = max(model_sigma + iv_shift / 100.0, 0.01)
        needed = level + cost_target / lot
        value = lambda m: premium_math.bs_price(spot + d * m, selected["strike"], years_after, vol, side)
        high = spot * 0.05
        if value(0.0) >= needed:
            return 0.0
        if value(high) < needed:
            return None
        low = 0.0
        for _ in range(60):
            mid = (low + high) / 2.0
            if value(mid) >= needed:
                high = mid
            else:
                low = mid
        return high

    expected = config.expected_move_atr_multiple * atr5 * math.sqrt(max(hold / 5.0, 1.0)) if atr5 > 0 else None
    scenarios = {}
    for name, shift in config.feasibility_scenarios:
        need = reprice_move(target, shift)
        scenarios[name] = {"iv_change_vol_pts": shift, "index_move_2x": _r(need), "index_move_1_5x": _r(reprice_move(partial, shift)),
                           "ratio": _r(need / expected, 3) if need is not None and expected else None}
    gate = scenarios.get(config.feasibility_gate_scenario) or {}
    modelled = gate.get("index_move_2x") is not None
    need_2x = gate["index_move_2x"] if modelled else move_for(target)
    need_15x = gate.get("index_move_1_5x") if modelled else move_for(partial)
    ratio = (need_2x / expected) if need_2x is not None and expected else None
    risk_unit = entry - stop
    planned_lot = risk_unit * lot + cost_stop
    stressed_lot = planned_lot + max(2 * tick, 0.10 * risk_unit) * lot
    # The trader's chosen lots are taken as they are (the max loss shown is what they risk); otherwise
    # size to the per-trade budget, never rounded up.
    # V2 sizing (spec 14.1): lots = floor(rupee risk budget / stressed risk per lot), capped by the
    # trader's chosen lots; below one lot there is no trade. V1's fixed lots stay available.
    budget = config.max_loss_per_trade * risk_multiplier
    if config.fixed_lots > 0:
        lots = config.fixed_lots
    else:
        cap = config.max_chosen_lots if config.max_chosen_lots > 0 else config.max_lots
        lots = min(cap, int(budget // stressed_lot)) if stressed_lot > 0 else 0
    cost_share = cost_target / ((target - entry) * lot) if target > entry else 1.0
    out = {
        "market_premium": _r(market), "entry": entry, "stop_loss": stop, "target": target, "partial_target": partial, "lot_size": lot,
        "stop_percent": config.stop_percent, "target_multiple": config.target_multiple,
        "greeks": {"delta": round(delta, 3), "gamma": round(gamma, 6), "theta_per_day": _r(theta_day), "vega": _r(vega, 3), "iv": _r(sigma * 100) if sigma else None,
                   "time_to_expiry_years": _r(years, 6), "source": "CHAIN_DELTA + BLACK_SCHOLES_GAMMA" if greeks else "CHAIN_DELTA_ONLY"},
        "theta_drag": _r(drag), "costs_per_lot": {"at_target": _r(cost_target), "at_stop": _r(cost_stop)}, "cost_share": _r(cost_share, 3),
        "index_move_needed": {"1_5x": _r(need_15x), "2x": _r(need_2x)}, "expected_move": _r(expected), "feasibility_ratio": _r(ratio, 3),
        "scenarios": scenarios, "gate_scenario": config.feasibility_gate_scenario if modelled else "DELTA_GAMMA_FALLBACK",
        "diagnostic_delta_gamma_2x": _r(move_for(target)), "risk_budget": _r(budget), "risk_multiplier": risk_multiplier,
        "hold_minutes": round(hold), "minutes_to_square_off": minutes_left,
        "risk_per_lot": _r(planned_lot), "stressed_risk_per_lot": _r(stressed_lot), "lots": lots, "quantity": lots * lot,
        "planned_max_loss": _r(planned_lot * lots), "max_loss": _r(stressed_lot * lots), "risk_reward": _r((target - entry) / risk_unit) if risk_unit > 0 else None,
        "fees_at_stop_per_lot": _r(premium_math.round_trip_costs(entry, stop, lot, 0.0, fees)["total"]), "stop_gap": _r(max(2 * tick, 0.10 * risk_unit)),
        "max_entry": _tick(entry + max(2 * tick, 0.02 * entry), tick, "down"),
        # Spec 12.4: no calibrated model exists yet, so no probability is claimed.
        "probability": {"reach_1_5x_before_stop": "UNAVAILABLE", "reach_2x_before_stop": "UNAVAILABLE", "stop_first": "UNAVAILABLE",
                        "expected_time_to_2x": "UNAVAILABLE", "reason": "No calibrated model: requires option-level historical samples and walk-forward validation"},
        "model": "BLACK_SCHOLES_SCENARIO_REPRICING_VS_ATR (scenario ranges, not a probability)" if modelled else "HEURISTIC_DELTA_GAMMA_THETA_VS_ATR (not a probability)",
        "valid": True, "reason": "",
    }
    problems = []
    if ratio is None:
        problems.append("index move for 2x is not estimable")
    elif ratio > config.max_feasibility_ratio:
        problems.append(f"2x needs {need_2x:.0f} index pts vs ~{expected:.0f} expected in {hold:.0f} min (ratio {ratio:.2f} > {config.max_feasibility_ratio})")
    if cost_share > config.max_cost_share:
        problems.append(f"charges take {cost_share * 100:.0f}% of the 2x reward (max {config.max_cost_share * 100:.0f}%)")
    if minutes_left < config.min_minutes_to_square_off:
        problems.append(f"only {minutes_left} min to the 15:15 square-off")
    out["sizing"] = {"lots": lots, "budget": _r(budget), "stressed_risk_per_lot": _r(stressed_lot), "cap": config.fixed_lots or config.max_chosen_lots or config.max_lots,
                     "mode": "FIXED_LOTS" if config.fixed_lots > 0 else "RISK_BUDGET",
                     "reason": (f"{lots} lot(s): ₹{budget:.0f} budget / ₹{stressed_lot:.0f} stressed risk per lot" if lots >= 1 else f"one lot risks ₹{stressed_lot:.0f} stressed, above the ₹{budget:.0f} per-trade risk budget")}
    if problems:
        out.update(valid=False, reason="; ".join(problems))
    return out


# ------------------------------------------------------------------------------- order flow

def premium_volume_flow(premium: dict | None, selected: dict | None, side: str, now: datetime, config: SniperConfig, early: bool = False) -> dict:
    """Is buying volume rising in the SELECTED option's own premium?

    Reads the contract's completed 1-minute candles today. Volume is rising when the last
    ``premium_volume_recent_bars`` candles average at least ``premium_volume_min_ratio`` x the
    ``premium_volume_prior_bars`` before them; it is BUYING volume when at least
    ``premium_buy_share_min`` of that recent volume traded on candles where the premium rose, and
    the premium itself is up over the window. For a PUT the rising put premium is the index
    sellers in control. Missing, foreign or stale premium candles are UNAVAILABLE (fail closed).

    ``early`` (a liquidity reversal, bought at the turn): only the last ``premium_early_bars``
    candles are read, and the premium need not be up over them yet; it is enough that volume is
    rising, buyers took most of it and the latest candle closed up (buyers stepping in).
    """
    who = "call buyers" if side == "CE" else "put buyers (index sellers)"
    base = {"key": "premium_volume", "side": side, "who": who, "symbol": (selected or {}).get("symbol"), "passed": False, "mode": "EARLY" if early else "CONFIRMED"}
    if not selected:
        return {**base, "status": "UNAVAILABLE", "reason": "no contract selected"}
    if not premium or not premium.get("candles") or str(premium.get("symbol") or "").upper() != str(selected.get("symbol") or "").upper():
        return {**base, "status": "UNAVAILABLE", "reason": f"1m premium candles for {selected.get('symbol')} unavailable"}
    bars = [b for b in to_bars(premium.get("candles"), 1) if b.start.date() == now.date() and b.end <= now]
    if len(bars) < config.premium_volume_min_bars:
        return {**base, "status": "UNAVAILABLE", "reason": f"{selected['symbol']}: {len(bars)} completed 1m premium candles today (needs {config.premium_volume_min_bars})"}
    lag = (now - bars[-1].end).total_seconds()
    if lag > config.premium_max_lag_seconds:
        return {**base, "status": "UNAVAILABLE", "reason": f"{selected['symbol']} premium candles are stale: last closed {lag:.0f}s ago"}
    window = config.premium_early_bars if early else config.premium_volume_recent_bars
    recent = bars[-window:]
    prior = [b.volume for b in bars[-(window + config.premium_volume_prior_bars):-window] if b.volume > 0]
    recent_volume = sum(b.volume for b in recent)
    if recent_volume <= 0 or not prior:
        return {**base, "status": "UNAVAILABLE", "reason": f"{selected['symbol']} premium candles carry no traded volume"}
    ratio = (recent_volume / len(recent)) / (sum(prior) / len(prior))
    first = len(bars) - len(recent)
    buy_volume = 0.0
    for offset, bar in enumerate(recent):
        prev_close = bars[first + offset - 1].close if first + offset >= 1 else bar.open
        if bar.close > bar.open or (bar.close == bar.open and bar.close > prev_close):
            buy_volume += bar.volume
    buy_share = buy_volume / recent_volume
    price_change = recent[-1].close - recent[0].open
    half = max(len(recent) // 2, 1)
    accelerating = sum(b.volume for b in recent[-half:]) >= sum(b.volume for b in recent[:half])
    rising = ratio >= config.premium_volume_min_ratio
    buying = buy_share >= config.premium_buy_share_min
    up = recent[-1].close > recent[-1].open if early else price_change > 0
    passed = rising and buying and up
    parts = [f"volume {ratio:.2f}x the prior {len(prior)}-min average ({'rising' if rising else f'needs {config.premium_volume_min_ratio}x'})",
             f"{buy_share * 100:.0f}% on rising-premium candles ({'buyers in control' if buying else f'needs {config.premium_buy_share_min * 100:.0f}%'})",
             (f"latest candle {'up: buyers stepping in' if up else 'not up yet'}" if early else f"premium {price_change:+.2f} over {len(recent)} min")]
    if early:
        parts.insert(0, f"early read for a reversal (last {len(recent)} min)")
    if accelerating:
        parts.append("still accelerating")
    return {**base, "status": "OK", "passed": passed, "relative_volume": _r(ratio), "buy_share": _r(buy_share, 3), "price_change": _r(price_change),
            "accelerating": accelerating, "recent_volume": _r(recent_volume), "as_of": bars[-1].end.isoformat(),
            "reason": f"{selected['symbol']} {who}: " + "; ".join(parts)}


def _near_strikes(strikes: list[float], spot: float, count: int) -> list[float]:
    ordered = sorted(set(strikes))
    if not ordered:
        return []
    atm = min(range(len(ordered)), key=lambda i: abs(ordered[i] - spot))
    return ordered[max(atm - count, 0):atm + count + 1]


def writer_oi_flow(history: list[dict] | None, flow: dict | None, side: str, spot: float, now: datetime, config: SniperConfig, early: bool = False) -> dict:
    """Is the supportive writers' OI rising while the opposite writers cover (a strong move)?

    CALL: put writers (PE OI near ATM) must be adding, interval after interval, AND call writers (CE
    OI near ATM) must be covering: their OI falling over the window and not rising in the latest
    interval. PUT: call writers adding AND put writers covering. Reads the server's stored 3-minute
    strike OI samples (the last ``writer_oi_samples``); without enough of them it falls back to
    market-intel's single 5-minute OI change (status SNAPSHOT). Neither: UNAVAILABLE.

    ``early`` (a liquidity reversal): the supportive writers have not repositioned yet at the turn, so
    only the opposing writers must have STARTED covering: their OI falling in the latest interval
    and not up over the window.
    """
    writer, other = ("pe", "ce") if side == "CE" else ("ce", "pe")
    who = "put writers" if side == "CE" else "call writers"
    opposite = "call writers" if side == "CE" else "put writers"
    base = {"key": "writer_oi", "side": side, "who": who, "opposite": opposite, "passed": False, "mode": "EARLY" if early else "CONFIRMED"}
    samples = []
    for row in history or []:
        stamp = _parse(row.get("at"))
        strikes = row.get("strikes") or []
        if stamp and stamp.astimezone(IST).date() == now.date() and stamp <= now and strikes:
            samples.append((stamp, strikes))
    samples.sort(key=lambda item: item[0])
    samples = samples[-config.writer_oi_samples:]
    if len(samples) >= 3 and (now - samples[-1][0]).total_seconds() <= config.writer_oi_max_age_seconds:
        near = _near_strikes([float(r.get("strike") or 0) for r in samples[-1][1]], spot, config.writer_oi_strikes)

        def total(strikes: list[dict], key: str) -> float:
            values = {float(r.get("strike") or 0): _num(r.get(f"{key}_oi")) or 0.0 for r in strikes}
            return sum(values.get(k, 0.0) for k in near)

        series = [total(rows, writer) for _, rows in samples]
        other_series = [total(rows, other) for _, rows in samples]
        changes = [b - a for a, b in zip(series, series[1:])]
        net, other_net = series[-1] - series[0], other_series[-1] - other_series[0]
        pct = net / series[0] * 100 if series[0] > 0 else None
        positive = sum(1 for c in changes if c > 0)
        building = pct is not None and pct >= config.writer_oi_min_change_pct
        latest_up = changes[-1] > 0
        steady = positive * 2 >= len(changes) + 1          # a majority of the intervals added OI
        other_changes = [b - a for a, b in zip(other_series, other_series[1:])]
        other_pct = other_net / other_series[0] * 100 if other_series[0] > 0 else None
        # Opposite writers covering: their OI fell over the window and is not rising again now.
        covering = other_pct is not None and other_pct <= -config.opposite_min_cover_pct and other_changes[-1] <= 0
        outpacing = net > other_net
        passed = building and latest_up and steady and outpacing and (covering or not config.require_opposite_covering)
        minutes = (samples[-1][0] - samples[0][0]).total_seconds() / 60
        if early:
            started = other_changes[-1] < 0 and other_net <= 0
            against_early = other_changes[-1] > 0 and other_net > 0
            return {**base, "status": "OK", "passed": started, "verdict": "SUPPORTIVE" if started else "AGAINST" if against_early else "NEUTRAL", "net_change": _r(net, 0), "change_pct": _r(pct, 3), "opposite_change": _r(other_net, 0),
                    "opposite_change_pct": _r(other_pct, 3), "opposite_interval_changes": [_r(c, 0) for c in other_changes], "opposite_covering": started,
                    "strikes": near, "samples": len(samples), "as_of": samples[-1][0].isoformat(),
                    "reason": f"early read for a reversal: {opposite} OI {other_changes[-1]:+,.0f} in the latest interval, {other_net:+,.0f} over {minutes:.0f} min "
                              f"({'started covering' if started else 'not covering yet'}); {who} {net:+,.0f} (not required at the turn)"}
        parts = [f"{who} OI {net:+,.0f} ({pct:+.2f}%) over {minutes:.0f} min near ATM" if pct is not None else f"{who} OI unavailable",
                 f"{positive}/{len(changes)} intervals adding" + ("" if steady else " (not a steady build)"),
                 f"latest interval {changes[-1]:+,.0f}" + ("" if latest_up else " (build has stalled)"),
                 (f"{opposite} OI {other_net:+,.0f} ({other_pct:+.2f}%)" if other_pct is not None else f"{opposite} OI unavailable")
                 + (", covering" if covering else f", not covering (needs a fall of {config.opposite_min_cover_pct}%+ and no fresh adding)" if other_changes[-1] <= 0 else f", adding again in the latest interval ({other_changes[-1]:+,.0f})")]
        if pct is not None and not building:
            parts.append(f"needs +{config.writer_oi_min_change_pct}%")
        if passed:
            parts.append(f"strong {'CALL' if side == 'CE' else 'PUT'} move: {who} adding while {opposite} cover")
        against = net < 0 and other_net > 0 and other_changes[-1] > 0
        return {**base, "status": "OK", "passed": passed, "verdict": "SUPPORTIVE" if passed else "AGAINST" if against else "NEUTRAL",
                "net_change": _r(net, 0), "change_pct": _r(pct, 3), "interval_changes": [_r(c, 0) for c in changes],
                "opposite_change": _r(other_net, 0), "opposite_change_pct": _r(other_pct, 3), "opposite_interval_changes": [_r(c, 0) for c in other_changes],
                "opposite_covering": covering, "strikes": near, "samples": len(samples), "as_of": samples[-1][0].isoformat(),
                "reason": "; ".join(parts)}
    rows = (flow or {}).get("strikes") or []
    changes5 = [(float(r.get("strike") or 0), _num(r.get(f"{writer}_oi_change")), _num(r.get(f"{other}_oi_change"))) for r in rows]
    changes5 = [item for item in changes5 if item[1] is not None]
    if (flow or {}).get("available", True) and changes5:
        near = set(_near_strikes([item[0] for item in changes5], spot, config.writer_oi_strikes))
        net = sum(item[1] for item in changes5 if item[0] in near)
        other_net = sum(item[2] or 0.0 for item in changes5 if item[0] in near)
        covering = other_net < 0
        passed = covering if early else net > 0 and net > other_net and (covering or not config.require_opposite_covering)
        verdict = f"strong move: {who} adding while {opposite} cover" if passed else f"{who} not adding" if net <= 0 else f"{opposite} not covering" if not covering else f"{who} not adding faster"
        against = other_net > 0 and (early or net < 0)
        return {**base, "status": "SNAPSHOT", "passed": passed, "verdict": "SUPPORTIVE" if passed else "AGAINST" if against else "NEUTRAL",
                "net_change": _r(net, 0), "opposite_change": _r(other_net, 0), "opposite_covering": covering,
                "reason": f"{who} OI {net:+,.0f}, {opposite} OI {other_net:+,.0f} in the last 5 min near ATM "
                          f"({verdict}; single 5-min reading, the 3-minute OI history is not available yet)"}
    return {**base, "status": "UNAVAILABLE", "verdict": "UNKNOWN", "reason": f"{who}' OI change unavailable (no stored OI samples and no 5-minute OI change yet)"}


def _realised_vol(closes: list[float], periods_per_year: float) -> float | None:
    returns = [math.log(b / a) for a, b in zip(closes, closes[1:]) if a > 0 and b > 0]
    if len(returns) < 2:
        return None
    mean = sum(returns) / len(returns)
    variance = sum((r - mean) ** 2 for r in returns) / (len(returns) - 1)
    return math.sqrt(variance * periods_per_year) * 100.0


def iv_check(feas: dict | None, selected: dict | None, daily_candles: list | None, bars5: list[Bar], vix: dict | None, now: datetime, config: SniperConfig) -> dict:
    """Is the option's implied volatility rich against what NIFTY is actually moving?

    Buying an option whose IV is far above realised volatility pays for movement the market is not
    delivering, and IV crush can lose the trade even when the direction is right. Realised vol is
    the higher of the last ``rv_daily_lookback`` daily closes and today's 5-minute bars (so a fast
    day is not mistaken for a quiet one). Above ``max_iv_rv_ratio`` blocks; between
    ``rich_iv_rv_ratio`` and that it passes as RICH. Without realised vol it falls back to India
    VIX (HIGH or EXTREME blocks); with neither it is UNAVAILABLE and blocks.
    """
    base = {"key": "iv", "passed": False}
    iv = _num(((feas or {}).get("greeks") or {}).get("iv")) or _num((selected or {}).get("iv"))
    daily = [b for b in to_bars(daily_candles, 24 * 60) if b.start.astimezone(IST).date() < now.date()]
    rv_daily = _realised_vol([b.close for b in daily[-(config.rv_daily_lookback + 1):]], 252.0) if len(daily) >= 3 else None
    today = [b for b in bars5 if b.start.date() == now.date()]
    rv_today = _realised_vol([b.close for b in today], 75.0 * 252.0) if len(today) >= config.rv_intraday_min_bars else None
    rv = max([v for v in (rv_daily, rv_today) if v], default=None)
    features = {"iv": _r(iv), "rv_daily": _r(rv_daily), "rv_today": _r(rv_today), "rv": _r(rv)}
    if iv and rv:
        ratio = iv / rv
        rich = ratio > config.rich_iv_rv_ratio
        passed = ratio <= config.max_iv_rv_ratio
        verdict = "too rich to buy (IV crush risk)" if not passed else "rich: allowed, scored lower" if rich else "fair to cheap"
        return {**base, "status": "OK", "passed": passed, "rich": rich, "ratio": _r(ratio), **features,
                "reason": f"IV {iv:.1f}% vs realised {rv:.1f}% ({'today' if rv == rv_today else f'{config.rv_daily_lookback}-day'}): {ratio:.2f}x, {verdict} (max {config.max_iv_rv_ratio}x)"}
    regime = (vix or {}).get("regime")
    if regime:
        # India VIX is market context, not the selected contract's IV (spec V2 11.4): it can block
        # (HIGH / EXTREME) but cannot approve on its own.
        return {**base, "status": "VIX_ONLY", "passed": False, "rich": regime in ("HIGH", "EXTREME"), **features,
                "reason": f"contract IV vs realised volatility unavailable; India VIX {regime.lower()} is context only and cannot approve the IV"}
    return {**base, "status": "UNAVAILABLE", **features, "reason": "IV check unavailable (no option IV / realised volatility and no India VIX)"}


# ------------------------------------------------------------------------------- scoring

def _component(key: str, score: float, max_score: float, status: str, reason: str, features: dict, source_timestamp: str | None) -> dict:
    return {"key": key, "score": round(max(0.0, min(score, max_score)), 2), "max_score": max_score, "status": status, "reason": reason,
            "features": features, "source_timestamp": source_timestamp}


def score_oi(flow: dict | None, side: str, spot: float, need_points: float | None, weight: float) -> dict:
    if not flow or not flow.get("available", True) or not flow.get("strikes"):
        return _component("oi", 0, weight, "UNAVAILABLE", "Option-chain OI flow unavailable: scored 0, never read as bullish or bearish", {}, None)
    d = 1 if side == "CE" else -1
    stamp = flow.get("timestamp") or flow.get("as_of")
    score_raw = _num(flow.get("oi_direction_score"))
    pcr = _num(flow.get("pcr_oi"))
    rows = flow.get("strikes") or []
    atm = next((r for r in rows if r.get("is_atm")), None) or min(rows, key=lambda r: abs(float(r.get("strike") or 0) - spot))
    acts = {("CE", atm.get("ce_activity")), ("PE", atm.get("pe_activity"))}
    favourable = BULLISH_FLOW if d > 0 else BEARISH_FLOW
    against_writing = ("CE", "SHORT_BUILDUP") in acts if d > 0 else ("PE", "SHORT_BUILDUP") in acts
    wall_key = "ce_oi" if d > 0 else "pe_oi"
    beyond = [r for r in rows if (float(r.get("strike") or 0) - spot) * d > 0 and _num(r.get(wall_key))]
    wall = max(beyond, key=lambda r: _num(r.get(wall_key)) or 0) if beyond else None
    room = abs(float(wall["strike"]) - spot) if wall else None
    pts = 0.0
    parts = []
    if score_raw is not None and score_raw * d >= 1:
        pts += weight * 7 / 15
        parts.append(f"5m OI flow {score_raw:+.0f} supports")
    else:
        parts.append(f"5m OI flow {score_raw if score_raw is not None else 'n/a'} not supportive")
    if pcr is not None and ((d > 0 and 0.8 <= pcr <= 1.6) or (d < 0 and 0.5 <= pcr <= 1.2)):
        pts += weight * 4 / 15
        parts.append(f"OI PCR {pcr:.2f} in range")
    else:
        parts.append(f"OI PCR {pcr if pcr is not None else 'n/a'} not supportive")
    if acts & favourable and not against_writing:
        pts += weight * 4 / 15
        parts.append(f"ATM {atm.get('strike')} build-up favourable")
    elif against_writing:
        parts.append(f"fresh {'call' if d > 0 else 'put'} writing at ATM {atm.get('strike')} (tentative: snapshot OI)")
    if room is not None and need_points is not None and room < need_points:
        pts = min(pts, weight * 0.5)
        parts.append(f"opposing OI wall {wall['strike']:.0f} only {room:.0f} pts away (2x needs {need_points:.0f})")
    features = {"oi_direction_score": score_raw, "pcr_oi": pcr, "pcr_definition": "OI PCR = total put OI / total call OI", "atm_strike": atm.get("strike"),
                "atm_activity": {"CE": atm.get("ce_activity"), "PE": atm.get("pe_activity")}, "wall": float(wall["strike"]) if wall else None, "room_points": _r(room),
                "interpretation": "TENTATIVE (snapshot-based; not proof of writer intent)"}
    return _component("oi", pts, weight, "OK", "; ".join(parts), features, stamp)


def band_for(score: float) -> tuple[str, str]:
    for floor, name, action in SCORE_BANDS:
        if score >= floor:
            return name, action
    return "WEAK", "Reject"


def score_setup(setup: dict, bars5: list[Bar], bars1: list[Bar], atr5: float, vwap: float | None, vwap_ok: bool, flow: dict | None, vix: dict | None,
                selected: dict | None, feas: dict | None, spot: float, config: SniperConfig, premium_flow: dict | None = None, iv_read: dict | None = None,
                writer_flow: dict | None = None, regime: dict | None = None, trigger: dict | None = None, extension: float | None = None) -> list[dict]:
    w = config.weights
    d = setup["direction"]
    side = "CE" if d > 0 else "PE"
    family = setup["family"]
    stamp5 = bars5[-1].end.isoformat() if bars5 else None
    stamp1 = bars1[-1].end.isoformat() if bars1 else None
    comps = []

    # Liquidity event quality
    if family == "LIQUIDITY_REVERSAL" and setup.get("sweep"):
        sweep = setup["sweep"]
        quality = sweep["level_quality"]  # 3 swing, 4 equal, 5 PDH/PDL
        reclaim_pts = 5 if sweep["reclaim_bars"] == 1 else 3
        pts = 10 + quality + reclaim_pts
        comps.append(_component("liquidity", pts * w["liquidity"] / 20, w["liquidity"], "OK", f"{sweep['level_name']} swept {sweep['depth_atr']} ATR deep, reclaimed in {sweep['reclaim_bars']} bar(s)", sweep, sweep["confirmed_at"]))
    elif family == "BREAKOUT_EXPANSION" and setup.get("range"):
        rng = setup["range"]
        pts = (12 if rng["boundary_touches"] >= 2 else 8) + (8 if rng["height_atr"] <= 1.5 else 4)
        comps.append(_component("liquidity", pts * w["liquidity"] / 20, w["liquidity"], "OK", f"{rng['bars']}-bar range {rng['height_atr']} ATR tall, boundary tested {rng['boundary_touches']}x", rng, stamp5))
    elif family == "TREND_CONTINUATION" and setup.get("pullback"):
        zones = setup["pullback"]["zones"]
        pts = 10 + (10 if ("FVG" in zones or "ORDER_BLOCK" in zones) else 6 if zones else 0)
        comps.append(_component("liquidity", pts * w["liquidity"] / 20, w["liquidity"], "OK", f"pullback into {', '.join(zones) or 'no zone'}", setup["pullback"], stamp5))
    else:
        comps.append(_component("liquidity", 0, w["liquidity"], "MISSING", setup.get("reason", "no liquidity event"), {}, stamp5))

    # MSS / BOS
    if family == "LIQUIDITY_REVERSAL":
        ok = bool(setup.get("mss"))
        comps.append(_component("structure", w["structure"] if ok else 0, w["structure"], "OK" if ok else "MISSING", f"MSS close beyond {setup['mss']['level']} ({setup['mss']['protected_from']})" if ok else "no MSS yet (CHOCH/sweep only stays WATCH)", setup.get("mss") or {}, stamp5))
    elif family == "BREAKOUT_EXPANSION":
        pts = w["structure"] if setup.get("bos_swing") else w["structure"] * 10 / 15
        comps.append(_component("structure", pts if setup.get("breakout") else 0, w["structure"], "OK", "BOS: close beyond the range boundary" + (" and a confirmed swing" if setup.get("bos_swing") else ""), setup.get("breakout") or {}, stamp5))
    else:
        ok = (setup.get("structure") or {}).get("trend") == ("BULLISH" if d > 0 else "BEARISH")
        comps.append(_component("structure", w["structure"] if ok else 0, w["structure"], "OK" if ok else "MISSING", f"5m structure {(setup.get('structure') or {}).get('trend', 'n/a').lower()}", setup.get("structure") or {}, stamp5))

    # Displacement + FVG
    disp = setup.get("displacement")
    fvg = setup.get("fvg")
    pts = (10 if disp else 0) + (5 if disp and fvg and fvg.get("status") != "INVALIDATED" else 0)
    comps.append(_component("displacement_fvg", pts * w["displacement_fvg"] / 15, w["displacement_fvg"], "OK" if disp else "MISSING",
                            ("displacement " + f"{disp['range_atr']} ATR, body {disp['body_ratio']}" if disp else "no displacement candle") + (f"; FVG {fvg['lower']}-{fvg['upper']} {fvg['status'].lower()}" if fvg else "; no FVG"),
                            {"displacement": disp, "fvg": fvg, "order_block": setup.get("order_block")}, stamp5))

    # OI
    need = (feas or {}).get("index_move_needed", {}).get("2x") if feas else None
    # OI context (spec V2 10): half the points from the chain picture, half from the writer read
    # (SUPPORTIVE full, NEUTRAL half, AGAINST / UNKNOWN none). Interpretations are heuristics.
    chain_part = score_oi(flow, side, spot, need, w["oi"] / 2)
    verdict = (writer_flow or {}).get("verdict", "UNKNOWN")
    writer_pts = w["oi"] / 2 * {"SUPPORTIVE": 1.0, "NEUTRAL": 0.5}.get(verdict, 0.0)
    comps.append(_component("oi", chain_part["score"] + writer_pts, w["oi"], "UNAVAILABLE" if chain_part["status"] == "UNAVAILABLE" and verdict == "UNKNOWN" else "OK",
                            f"{chain_part['reason']}; writer read {verdict.lower()} (heuristic)", {**chain_part["features"], "writer_verdict": verdict}, chain_part["source_timestamp"]))

    # Higher-timeframe alignment (spec V2 13.1): the 15m regime agrees with the trade, plus the price
    # on the right side of VWAP. EMA alignment is part of the regime, so it is not counted twice.
    label = (regime or {}).get("regime", "UNKNOWN")
    aligned = label == ("TREND_UP" if d > 0 else "TREND_DOWN")
    neutral = label in ("RANGE", "LOW_VOL_COMPRESSION", "HIGH_VOL_ORDERLY")
    last = bars1[-1].close if bars1 else (bars5[-1].close if bars5 else None)
    pts = w["htf_alignment"] * (0.7 if aligned else 0.35 if neutral else 0.0)
    parts = [f"15m regime {label.lower()}" + (" aligned" if aligned else " neutral" if neutral else " opposing / unknown")]
    if vwap_ok and vwap is not None and last is not None:
        if (last - vwap) * d > 0:
            pts += w["htf_alignment"] * 0.3
            parts.append(f"price {'above' if d > 0 else 'below'} VWAP {vwap:.2f}")
        else:
            parts.append(f"price on the wrong side of VWAP {vwap:.2f}")
    else:
        parts.append("VWAP unavailable (no volume)")
    comps.append(_component("htf_alignment", pts, w["htf_alignment"], "OK" if label != "UNKNOWN" else "UNAVAILABLE", "; ".join(parts), {"regime": label, "vwap": _r(vwap), "price": _r(last)}, stamp1))

    # Volume: the selected option's own premium volume first (index candles carry none), else futures.
    key = setup.get("key_index")
    rvol = relative_volume(bars5, key) if key is not None and 0 <= key < len(bars5) else None
    if premium_flow and premium_flow.get("status") == "OK":
        pf = premium_flow
        pts = w["volume"] if pf["passed"] else w["volume"] * 0.5 if (pf.get("relative_volume") or 0) >= config.premium_volume_min_ratio else 0
        comps.append(_component("volume", pts, w["volume"], "OK", pf["reason"], {k: pf.get(k) for k in ("symbol", "relative_volume", "buy_share", "price_change", "accelerating")}, pf.get("as_of")))
    elif rvol is None:
        comps.append(_component("volume", 0, w["volume"], "UNAVAILABLE", "relative volume unavailable (index has no volume; futures volume missing)", {}, stamp5))
    else:
        pts = w["volume"] if rvol >= 1.5 else w["volume"] * 0.6 if rvol >= 1.2 else 0
        comps.append(_component("volume", pts, w["volume"], "OK", f"key candle {rvol:.2f}x the prior 20-bar volume (futures)", {"relative_volume": _r(rvol)}, stamp5))

    # Option Greeks / IV suitability
    if selected:
        pts = 0.0
        parts = []
        if config.preferred_delta_min <= selected["delta"] <= config.preferred_delta_max:
            pts += w["option_suitability"] * 0.6
            parts.append(f"delta {selected['delta']:.2f} in {config.preferred_delta_min}-{config.preferred_delta_max}")
        else:
            parts.append(f"delta {selected['delta']:.2f} outside the preferred band")
        regime = (vix or {}).get("regime")
        value = _num((vix or {}).get("value"))
        if iv_read and iv_read.get("status") == "OK":
            # IV against realised volatility: fair or cheap scores; rich (or too rich) does not.
            if not iv_read.get("rich"):
                pts += w["option_suitability"] * 0.4
            parts.append(f"IV/RV {iv_read['ratio']}x{' (rich)' if iv_read.get('rich') else ''}")
        elif regime in ("LOW", "NORMAL", "HIGH") and (value is None or 10 <= value <= 24):
            pts += w["option_suitability"] * 0.4
            parts.append(f"India VIX {value if value is not None else ''} {regime.lower()}")
        else:
            parts.append(f"India VIX {regime or 'unavailable'}")
        comps.append(_component("option_suitability", pts, w["option_suitability"], "OK", "; ".join(parts), {"delta": selected["delta"], "iv": selected.get("iv"), "vix": vix}, stamp1))
    else:
        comps.append(_component("option_suitability", 0, w["option_suitability"], "MISSING", "no contract passed the filters", {}, stamp1))

    # 2x feasibility (heuristic)
    if feas and feas.get("feasibility_ratio") is not None:
        ratio = feas["feasibility_ratio"]
        pts = w["feasibility"] if ratio <= 0.75 else w["feasibility"] * 0.7 if ratio <= 1.0 else w["feasibility"] * 0.4 if ratio <= config.max_feasibility_ratio else 0
        comps.append(_component("feasibility", pts, w["feasibility"], "HEURISTIC", f"2x needs {feas['index_move_needed']['2x']} pts vs ~{feas['expected_move']} expected (ratio {ratio})",
                                {k: feas[k] for k in ("index_move_needed", "expected_move", "feasibility_ratio", "probability")}, stamp1))
    else:
        comps.append(_component("feasibility", 0, w["feasibility"], "UNAVAILABLE", "2x feasibility not estimable", {}, stamp1))

    # Entry timing / execution quality (spec V2 13.1): the 1m trigger, and how close to the trigger level.
    pts = (w["entry_timing"] * 0.6 if (trigger or {}).get("ok") else 0.0) + (w["entry_timing"] * 0.4 if extension is not None and extension <= config.max_extension_atr / 2 else w["entry_timing"] * 0.2 if extension is not None and extension <= config.max_extension_atr else 0.0)
    comps.append(_component("entry_timing", pts, w["entry_timing"], "OK" if trigger else "UNAVAILABLE",
                            f"1m trigger {'ok' if (trigger or {}).get('ok') else 'not yet'}; {extension:.2f} ATR from the trigger level" if extension is not None else "no trigger level", {"extension_atr": _r(extension)}, stamp1))
    return comps


# ------------------------------------------------------------------------------- main entry

def config_for(context: dict) -> SniperConfig:
    base = SniperConfig()
    loss = _num(context.get("max_loss_per_trade"))
    lots = _num(context.get("max_lots"))
    slip = _num(context.get("slippage_pct"))
    chosen = _num(context.get("sniper_lots"))
    chosen_lots = min(10, max(1, int(chosen))) if chosen and chosen >= 1 else 0
    fixed_mode = str(context.get("sniper_sizing") or "").upper() == "FIXED_LOTS"
    setups = tuple(letter for letter in "ABC" if letter in str(context.get("sniper_setups") or "ABC").upper()) or ("A", "B", "C")
    return SniperConfig(
        fixed_lots=chosen_lots if fixed_mode else 0,
        max_chosen_lots=0 if fixed_mode else chosen_lots,
        enabled_setups=setups,
        max_loss_per_trade=loss if loss and loss > 0 else base.max_loss_per_trade,
        max_lots=max(1, int(lots)) if lots and lots >= 1 else base.max_lots,
        slippage_pct=slip if slip is not None and 0 <= slip < 0.05 else base.slippage_pct,
    )


def analyze_sniper(symbol: str, candles_1m: list[CandleLike], context: dict, now: datetime, config: SniperConfig | None = None) -> dict:
    config = config or config_for(context)
    base = {"symbol": symbol, "strategy": STRATEGY_ID, "confidence": 0, "setup": None, "config_version": config.version}
    sniper: dict = {"config_version": config.version, "config": asdict(config), "lifecycle": [], "families": {}, "components": [], "selected": None,
                    "candidates": [], "rejected_contracts": [], "feasibility": None, "levels": [], "regime": None, "hard_filters": []}

    def done(decision: str, state: str, reason: str, **extra) -> dict:
        sniper["state"] = state
        sniper["lifecycle"].append({"state": state, "at": now.isoformat(), "reason": reason})
        return {**base, **extra, "decision": decision, "reason": reason, "sniper": sniper}

    if symbol not in SUPPORTED_UNDERLYINGS:
        return done("NO_TRADE", "REJECTED", f"{STRATEGY_NAME} v1 trades NIFTY only (spec 2)")
    bars1 = to_bars(candles_1m, 1)
    bars5 = to_bars(context.get("setup_candles"), 5)
    today = now.date()
    bars1 = [b for b in bars1 if b.start.date() == today and b.end <= now]
    bars5 = [b for b in bars5 if b.end <= now]
    # Data validity (spec 5.2): stale or missing mandatory data blocks entries.
    if not bars1 or not bars5:
        return done("DATA_INVALID", "DATA_INVALID", "1-minute or 5-minute candles unavailable")
    lag = (now - bars1[-1].end).total_seconds()
    minute = now.hour * 60 + now.minute
    if SESSION_OPEN_MIN + 2 <= minute < 15 * 60 + 30 and lag > config.max_feed_lag_seconds:
        return done("DATA_INVALID", "DATA_INVALID", f"1m feed is stale: last candle closed {lag:.0f}s ago (max {config.max_feed_lag_seconds}s)")
    today5 = [b for b in bars5 if b.start.date() == today]
    if len(today5) < config.min_session_bars_5m:
        return done("WAIT_FOR_CONFIRMATION", "WATCH", f"Need {config.min_session_bars_5m} completed 5m candle(s) today (have {len(today5)})")

    atrs = atr_series(bars5, config.atr_period)
    atr5 = atrs[-1] or 0.0
    if atr5 <= 0:
        return done("DATA_INVALID", "DATA_INVALID", "5m ATR not yet computable")
    bars15 = resample(today5, 15, now)
    vwap, vwap_ok = session_vwap(bars5)
    regime = classify_regime(resample(bars5, 15, now), vwap, config)
    sniper["regime"] = regime
    daily = daily_reference(bars5, context.get("daily_candles"), today)
    pivots = find_pivots(bars5, config.pivot_left, config.pivot_right)
    levels = build_levels(bars5, pivots, daily, config, atr5)
    sniper["levels"] = [{"name": lv.name, "price": _r(lv.price), "side": lv.side, "source_timeframe": lv.source_timeframe, "created_at": lv.created_at,
                         "status": "UNTAKEN" if level_untaken(bars5, lv, len(bars5)) else "TAKEN",
                         "invalidation": "traded through by a later 5m bar"} for lv in levels[-14:]]
    sniper["reference"] = {**daily, "session_high": _r(max(b.high for b in today5)), "session_low": _r(min(b.low for b in today5)), "vwap": _r(vwap),
                           "vwap_observable": vwap_ok, "atr_5m": _r(atr5), "bars_15m_today": len(bars15)}

    found = []
    for d in (1, -1):
        for setup in (detect_reversal(bars5, pivots, levels, atrs, d, config),
                      detect_breakout(bars5, pivots, atrs, d, regime, config),
                      detect_continuation(bars5, pivots, atrs, d, regime, vwap, config)):
            sniper["families"][f"{setup['family']}:{'CALL' if d > 0 else 'PUT'}"] = {k: v for k, v in setup.items() if k not in ("key_index",)}
            if setup["state"] in ("CONFIRMED", "WATCH"):
                found.append(setup)
    if not found:
        return done("WAIT_FOR_CONFIRMATION", "DETECTED" if any(s.get("state") not in ("NONE",) for s in sniper["families"].values()) else "WATCH",
                    "No setup: " + "; ".join(f"{k.split(':')[0].replace('_', ' ').title()} {k.split(':')[1]}: {v.get('reason', '')}" for k, v in list(sniper["families"].items())[:3]))

    chain = ((context.get("option_chain") or {}).get("contracts")) or []
    spot = float((context.get("option_chain") or {}).get("spot") or bars1[-1].close)
    flow = context.get("options_flow") or None
    vix = context.get("vix") or None
    premium = context.get("premium_candles") or None
    oi_history = context.get("oi_history") or None
    sniper["vix"] = {"value": _num((vix or {}).get("value")), "regime": (vix or {}).get("regime")} if vix else None
    scored = []
    risk_multiplier = config.high_vol_risk_multiplier if regime.get("regime") == "HIGH_VOL_ORDERLY" else 1.0
    for setup in found:
        side = "CE" if setup["direction"] > 0 else "PE"
        ranked, rejected = select_contracts(chain, side, config)
        # Compare the best few strikes (spec V2 9.3): the feasible one with the smallest move needed in
        # the gate scenario wins, not automatically the top-ranked or the cheapest.
        trials = [(item, feasibility(item, spot, atr5, now, symbol, config, risk_multiplier)) for item in ranked[:3]]
        for item, trial in trials:
            item["feasibility_ratio"] = trial.get("feasibility_ratio")
        viable = [pair for pair in trials if pair[1].get("valid") and pair[1].get("feasibility_ratio") is not None]
        selected, feas = (min(viable, key=lambda pair: (pair[1]["feasibility_ratio"], -pair[0]["rank_score"])) if viable else trials[0]) if trials else (None, None)
        early = setup["family"] in config.early_flow_families
        pflow = premium_volume_flow(premium, selected, side, now, config, early)
        wflow = writer_oi_flow(oi_history, flow, side, spot, now, config, early)
        ivc = iv_check(feas, selected, context.get("daily_candles"), bars5, vix, now, config)
        trig = one_minute_trigger(bars1, setup["direction"], now, config)
        ext = abs(bars1[-1].close - setup["trigger_level"]) / atr5 if setup.get("trigger_level") is not None else None
        comps = score_setup(setup, bars5, bars1, atr5, vwap, vwap_ok, flow, vix, selected, feas, spot, config, pflow, ivc, wflow, regime, trig, ext)
        total = round(sum(c["score"] for c in comps) / sum(c["max_score"] for c in comps) * 100.0, 2)
        scored.append({"setup": setup, "selected": selected, "ranked": ranked, "rejected": rejected, "feas": feas, "components": comps, "total": total, "premium_flow": pflow, "writer_flow": wflow, "iv": ivc})
    # Prefer a confirmed setup, then the higher score; a breakout is never relabelled a reversal.
    scored.sort(key=lambda item: (item["setup"]["state"] == "CONFIRMED", item["total"]), reverse=True)
    best = scored[0]
    setup, selected, feas, comps, total = best["setup"], best["selected"], best["feas"], best["components"], best["total"]
    pflow, wflow, ivc = best["premium_flow"], best["writer_flow"], best["iv"]
    sniper["order_flow"] = {"premium_volume": pflow, "writer_oi": wflow, "mode": "EARLY" if setup["family"] in config.early_flow_families else "CONFIRMED"}
    sniper["iv_check"] = ivc
    # Pass 1 picks the contract; the caller then fetches its own 1m candles for the volume check.
    if selected and (not premium or str(premium.get("symbol") or "").upper() != str(selected["symbol"]).upper()):
        base["needs_premium_candles"] = selected["symbol"]
    d = setup["direction"]
    side = "CE" if d > 0 else "PE"
    letter = SETUP_LETTER.get(setup["family"], "?")
    band, action = band_for(total)
    sniper.update(components=comps, selected=selected, candidates=best["ranked"][:4], rejected_contracts=best["rejected"][:8], feasibility=feas,
                  family=setup["family"], setup_type=letter, entry_mode=setup.get("entry_mode"), direction="CALL" if d > 0 else "PUT", config_hash=config_hash(config),
                  score={"total": total, "minimum": config.minimum_sniper_score, "maximum": 100.0, "band": band, "default_action": action},
                  alternatives=[{"family": item["setup"]["family"], "direction": "CALL" if item["setup"]["direction"] > 0 else "PUT", "state": item["setup"]["state"], "score": item["total"]} for item in scored[1:4]])
    sniper["lifecycle"].append({"state": "DETECTED", "at": now.isoformat(), "reason": setup.get("reason", "")})
    result_side = "BUY" if d > 0 else "SELL"

    trigger = one_minute_trigger(bars1, d, now, config)
    sniper["trigger"] = trigger
    trigger_level = setup.get("trigger_level")
    extension = abs(bars1[-1].close - trigger_level) / atr5 if trigger_level is not None else None
    sniper["extension_atr"] = _r(extension)

    # Hard filters (spec 10.3): every one must pass; a high score never overrides them.
    oi_comp = next(c for c in comps if c["key"] == "oi")
    filters = [
        ("SETUP_CONFIRMED", setup["state"] == "CONFIRMED", setup.get("reason", "")),
        ("SIGNAL_FRESH", trigger.get("age_seconds", 10 ** 6) <= config.signal_expiry_seconds and setup.get("fresh", True), f"1m data {trigger.get('age_seconds')}s old; setup fresh: {setup.get('fresh', True)}"),
        ("ENTRY_TRIGGER", trigger["ok"], trigger["reason"]),
        ("NOT_CHASING", extension is not None and extension <= config.max_extension_atr, f"{extension:.2f} ATR from the trigger level (max {config.max_extension_atr})" if extension is not None else "no trigger level"),
        ("ENTRY_WINDOW", config.entry_start_min <= minute < config.entry_cutoff_min, f"entries {config.entry_start_min // 60:02d}:{config.entry_start_min % 60:02d}-{config.entry_cutoff_min // 60:02d}:{config.entry_cutoff_min % 60:02d} IST"),
        ("REGIME_PERMITS", REGIME_PERMISSIONS.get(regime.get("regime"), {}).get(letter, False), f"15m regime {regime.get('regime')} {'permits' if REGIME_PERMISSIONS.get(regime.get('regime'), {}).get(letter) else 'does not permit'} setup {letter}" + (" (half risk)" if regime.get("regime") == "HIGH_VOL_ORDERLY" else "")),
        ("SETUP_ENABLED", letter in config.enabled_setups, f"setup {letter} {'enabled' if letter in config.enabled_setups else 'switched off'}"),
        ("CONTRACT_SELECTED", selected is not None, f"{selected['symbol']} Δ{selected['delta']}" if selected else (f"no contract passed: {best['rejected'][0]['reasons'][0]}" if best["rejected"] else "option chain unavailable")),
        ("SPREAD_OK", selected is not None and (selected["spread_pct"] is None or selected["spread_pct"] <= config.max_spread_percent), f"spread {selected.get('spread_pct') if selected else 'n/a'}% ({selected.get('spread_source') if selected else 'n/a'})"),
        ("FEASIBILITY_2X", bool(feas and feas.get("valid")), (feas or {}).get("reason") or f"feasible in the {(feas or {}).get('gate_scenario', 'BASE').lower()} scenario"),
        ("POSITION_SIZE", bool(feas and feas.get("lots", 0) >= 1), ((feas or {}).get("sizing") or {}).get("reason", "no contract to size")),
        ("OI_AVAILABLE", (not config.require_oi) or oi_comp["status"] != "UNAVAILABLE", "OI required by configuration" if config.require_oi else "OI optional (scored 0 when missing)"),
        ("PREMIUM_VOLUME_RISING", (not config.require_premium_volume) or pflow["passed"], ("price/volume momentum: " + pflow["reason"])),
        # OI is context (spec V2 10.4): only an opposing read blocks; neutral or unknown OI scores lower.
        ("OI_NOT_AGAINST", not (config.oi_blocks_when_against and wflow.get("verdict") == "AGAINST"), f"OI {wflow.get('verdict', 'UNKNOWN').lower()} (heuristic): {wflow['reason']}"),
        ("IV_NOT_RICH", (not config.require_iv_check) or ivc["passed"], ivc["reason"]),
        ("SCORE_MINIMUM", total >= config.minimum_sniper_score, f"score {total} / 100 (A grade needs {config.minimum_sniper_score:g}; {band.replace('_', ' ').lower()}" + (": journal only, no order" if band == "B_GRADE" else "") + ")"),
    ]
    if not pflow["passed"] and pflow.get("status") == "UNAVAILABLE":
        REASON_CODES_LOCAL = {**REASON_CODES, "PREMIUM_VOLUME_RISING": "PREMIUM_DATA_UNAVAILABLE"}
    else:
        REASON_CODES_LOCAL = REASON_CODES
    if ivc.get("status") in ("VIX_ONLY", "UNAVAILABLE"):
        REASON_CODES_LOCAL = {**REASON_CODES_LOCAL, "IV_NOT_RICH": "IV_UNKNOWN"}
    sniper["hard_filters"] = [{"code": code, "passed": bool(ok), "detail": detail, "reason_code": None if ok else REASON_CODES_LOCAL.get(code, code)} for code, ok, detail in filters]
    failed = [code for code, ok, _ in filters if not ok]
    sniper["reason_codes"] = [REASON_CODES_LOCAL.get(code, code) for code in failed]
    sniper["grade"] = band
    if failed:
        state = "EXPIRED" if setup["state"] == "EXPIRED" else "REJECTED" if setup["state"] == "CONFIRMED" and band == "NO_TRADE" else "CONFIRMED" if setup["state"] == "CONFIRMED" else "WATCH"
        decision = "WAIT_FOR_CONFIRMATION" if state in ("WATCH", "CONFIRMED") else "NO_TRADE"
        return done(decision, state, f"{setup['family'].replace('_', ' ').title()} {'CALL' if d > 0 else 'PUT'} · score {total} ({band}) · blocked by {', '.join(failed)}", side=result_side)

    sniper["lifecycle"].append({"state": "CONFIRMED", "at": now.isoformat(), "reason": setup.get("reason", "")})
    contract = {"symbol": selected["symbol"], "type": side, "strike": selected["strike"], "expiry": selected.get("expiry"),
                "lot_size": selected.get("lot_size"), "tick_size": selected.get("tick_size"), "freeze_quantity": selected.get("freeze_quantity")}
    trigger_time = trigger.get("time")
    invalidation = setup.get("invalidation")
    setup_out = {
        "side": result_side, "instrument": "OPTION_PREMIUM", "family": setup["family"], "contract": contract,
        "entry": feas["entry"], "stop_loss": feas["stop_loss"], "target": feas["target"], "partial_target": feas["partial_target"],
        "risk_reward": feas["risk_reward"], "lots": feas["lots"], "quantity": feas["quantity"], "max_loss": feas["max_loss"], "planned_max_loss": feas["planned_max_loss"],
        "spot": {"entry": _r(spot), "stop": invalidation, "target": _r(spot + d * (feas["index_move_needed"]["2x"] or 0))},
        "greeks": feas["greeks"], "trigger_time": trigger_time, "score": total, "band": band,
        "stop_percent": config.stop_percent, "target_multiple": config.target_multiple,
        "cost_per_unit": round((feas["costs_per_lot"]["at_target"] or 0) / feas["lot_size"], 2),
        "max_entry": feas["max_entry"], "stop_gap": feas["stop_gap"], "fees_at_stop_per_lot": feas["fees_at_stop_per_lot"],
        "probability": feas["probability"], "config_version": config.version, "config_hash": config_hash(config),
        "setup_type": letter, "entry_mode": setup.get("entry_mode"), "regime": regime.get("regime"), "scenarios": feas.get("scenarios"), "grade": band,
        "setup_id": f"{STRATEGY_ID}:{symbol}:{setup['family']}:{side}:{(setup.get('mss') or setup.get('breakout') or {}).get('time') or trigger_time}",
        "stop_method": f"PREMIUM_{config.stop_percent:g}PCT_FROM_FILL + INDEX_INVALIDATION", "target_method": f"PREMIUM_{config.target_multiple:g}X_FROM_FILL",
    }
    sniper["lifecycle"].append({"state": "ELIGIBLE", "at": now.isoformat(), "reason": "all hard filters passed"})
    sniper["state"] = "ELIGIBLE"
    return {**base, "decision": "CONFIRMED", "confidence": int(total), "side": result_side, "setup": setup_out, "sniper": sniper,
            "reason": f"{setup['family'].replace('_', ' ').title()} {'CALL' if d > 0 else 'PUT'} · score {total} ({band}): BUY {selected['symbol']} ~₹{feas['entry']:.2f}, SL ₹{feas['stop_loss']:.2f} (-{config.stop_percent:g}%), 2x target ₹{feas['target']:.2f}; 2x probability UNAVAILABLE (uncalibrated)"}
