"""Deterministic, fail-closed algo setup engine for paper execution."""
from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Literal

from . import indicators
from .configuration import StrategyConfiguration
from .data_quality_gate import DataQualityGate
from .gap_engine import evaluate_gap_day
from .models import Candle as QualityCandle
from .pipeline import evaluate_payload
from .orb import evaluate_orb_retest
from .regime_engine import classify_regime
from .session_engine import current_session_window, is_entry_permitted, is_session_active

Side = Literal["BUY", "SELL"]
MARKET_TIMEZONE = timezone(timedelta(hours=5, minutes=30), name="Asia/Kolkata")

@dataclass(frozen=True)
class Candle:
    timestamp: str
    open: float
    high: float
    low: float
    close: float
    volume: float


def _normalize_timestamp(value: object) -> str:
    try:
        if isinstance(value, (int, float)) or (isinstance(value, str) and value.isdigit()):
            return datetime.fromtimestamp(float(value), tz=MARKET_TIMEZONE).isoformat()
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (OverflowError, TypeError, ValueError):
        return ""
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=MARKET_TIMEZONE)
    return parsed.astimezone(MARKET_TIMEZONE).isoformat()


def _number(value: object, default: float = 0.0) -> float:
    if value is None or value == "":
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


_GAP_REASONS = {
    "NORMAL_DAY": "Open inside the previous session range",
    "GAP_UP_UNRESOLVED": "Gap up beyond the ATR threshold; hold or fill not yet confirmed",
    "GAP_DOWN_UNRESOLVED": "Gap down beyond the ATR threshold; hold or fill not yet confirmed",
    "GAP_HOLD_CONFIRMED": "Gap day; price is holding beyond the previous session extreme",
    "GAP_FILL_CONFIRMED": "Gap day; price filled back into the previous session range",
    "GAP_INVALIDATED": "Gap-day structure invalidated",
}


def _parse_timestamp(value: str) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=MARKET_TIMEZONE)
    return parsed.astimezone(MARKET_TIMEZONE)


def _round(value: float | None, digits: int = 4) -> float | None:
    return None if value is None else round(float(value), digits)


def _split_sessions(candles: list[Candle]) -> tuple[list[Candle], list[Candle]]:
    """Split candles into the latest IST session and the previous session."""
    dated = [(timestamp, candle) for candle in candles if (timestamp := _parse_timestamp(candle.timestamp)) is not None]
    if not dated:
        return [], []
    session_date = dated[-1][0].date()
    session = [candle for timestamp, candle in dated if timestamp.date() == session_date]
    previous_dates = sorted({timestamp.date() for timestamp, _ in dated if timestamp.date() < session_date})
    previous = [candle for timestamp, candle in dated if previous_dates and timestamp.date() == previous_dates[-1]]
    return session, previous


def _trend_15m(candles: list[Candle], config: StrategyConfiguration) -> str:
    """Deterministic higher-timeframe trend from 5m candles resampled to 15m closes."""
    buckets: dict[tuple[object, int, int], list[Candle]] = {}
    for candle in candles:
        timestamp = _parse_timestamp(candle.timestamp)
        if timestamp is None:
            continue
        key = (timestamp.date(), timestamp.hour, timestamp.minute // 15)
        buckets.setdefault(key, []).append(candle)
    closes = [bucket[-1].close for _, bucket in sorted(buckets.items())]
    fast = indicators.ema(closes, config.ema_fast_period)
    slow = indicators.ema(closes, config.ema_slow_period)
    if fast is None or slow is None or fast == slow:
        return "UNKNOWN"
    return "BULL" if fast > slow else "BEAR"


def _relative_volume(candles: list[Candle], index: int, lookback: int = 20) -> float | None:
    """Spec 7: the candle's volume against the mean of the PRIOR ``lookback`` completed candles.

    The candle itself is excluded from its own baseline. Index candles carry no volume, so
    callers attach near-month futures volume; with none available this returns None.
    """
    if index < 1 or index >= len(candles) or candles[index].volume <= 0:
        return None
    prior = [candle.volume for candle in candles[max(0, index - lookback):index] if candle.volume > 0]
    if len(prior) < lookback // 2:
        return None
    return candles[index].volume / (sum(prior) / len(prior))


def _expiry_today(option_evidence: dict | None, now: datetime) -> bool:
    evidence = option_evidence or {}
    if isinstance(evidence.get("expiry_today"), bool):
        return evidence["expiry_today"]
    expiry = evidence.get("expiry")
    return isinstance(expiry, str) and expiry == now.date().isoformat()


def _observe(symbol: str, candles: list[Candle], strategy: str, result: dict, config: StrategyConfiguration, now: datetime, option_evidence: dict | None = None, daily_candles: list[Candle] | None = None, volume_source: str | None = None) -> tuple[dict, dict, dict]:
    """Compute V5 evidence, the transparent calculations ledger, and live session state.

    Evidence is derived only from facts the engine can verify: candle structure, the
    reference indicators, and the current IST clock for the session gate. Option-chain,
    VIX, liquidity, and broker-state evidence stays caller-supplied and fail-closed.
    """
    timestamps: list[datetime] = []
    quality_candles: list[QualityCandle] = []
    data_quality_ok = bool(candles)
    for candle in candles:
        timestamp = _parse_timestamp(candle.timestamp)
        if timestamp is None:
            data_quality_ok = False
            continue
        timestamps.append(timestamp)
        quality_candles.append(QualityCandle(
            timestamp=timestamp,
            open=Decimal(str(candle.open)),
            high=Decimal(str(candle.high)),
            low=Decimal(str(candle.low)),
            close=Decimal(str(candle.close)),
            volume=Decimal(str(candle.volume)),
        ))

    if data_quality_ok:
        data_quality_ok, _ = DataQualityGate(config).validate_candles(symbol, quality_candles)

    trading_day = now.weekday() < 5
    market_open = trading_day and is_session_active(now, config)
    entry_permitted = trading_day and is_entry_permitted(now, config)
    # Spec 16 expiry-day gamma protocol: stricter score and an earlier entry cutoff.
    expiry_day = _expiry_today(option_evidence, now)
    expiry_rules = config.expiry_day_adjustments
    if expiry_day and entry_permitted:
        cutoff_minutes = config.trading_windows["entry_end"] - int(expiry_rules["entry_cutoff_minutes"])
        entry_permitted = now.hour * 60 + now.minute < cutoff_minutes
    if data_quality_ok and market_open and timestamps:
        candle_age_seconds = (now - timestamps[-1]).total_seconds()
        if candle_age_seconds > 15 * 60:
            data_quality_ok = False

    session_info = {
        "time_ist": now.isoformat(),
        "trading_day": trading_day,
        "window": current_session_window(now, config),
        "market_open": market_open,
        "entry_permitted": entry_permitted,
        "expiry_day": expiry_day,
    }

    session, previous_session = _split_sessions(candles)
    closes = [candle.close for candle in candles]
    last_close = closes[-1] if closes else None
    ema_fast = indicators.ema(closes, config.ema_fast_period)
    ema_slow = indicators.ema(closes, config.ema_slow_period)
    atr_value = indicators.atr(candles, config.atr_period)
    adx_value = indicators.adx(candles, config.atr_period)
    vwap_basis = session if session else candles[-20:]
    vwap_value = indicators.vwap(vwap_basis)
    if vwap_value is None and vwap_basis:
        # Index candles can carry zero volume; fall back to the mean typical price.
        vwap_value = sum((candle.high + candle.low + candle.close) / 3.0 for candle in vwap_basis) / len(vwap_basis)
    orb = _orb_for(candles, config, daily_candles)[0] if strategy == "ORB_RETEST" and data_quality_ok else None
    # ORB volume expansion is judged on the breakout candle; otherwise on the latest candle.
    volume_index = orb.breakout_index if orb is not None and orb.breakout_index is not None else len(candles) - 1
    relative_volume = _relative_volume(candles, volume_index) if candles else None
    max_extension = round(min(max(last_close, 1.0) * 0.0035, orb.atr) if orb.atr > 0 else max(last_close, 1.0) * 0.0035, 4) if orb is not None and last_close else None

    gap = _gap_for(candles, config, daily_candles)

    trend_15m = _trend_15m(candles, config)
    regime = classify_regime(
        adx_value,
        last_close,
        vwap_value,
        ema_fast,
        ema_slow,
        trend_15m=trend_15m,
        gap_state=gap.state if gap else "NORMAL_DAY",
        config=config,
        entry_threshold=config.adx_range_threshold if strategy == "ORB_RETEST" else None,
    )

    setup = result.get("setup") or {}
    side = setup.get("side") or (orb.side if orb is not None else None)
    if side is None and ema_fast is not None and ema_slow is not None and ema_fast != ema_slow:
        side = "BUY" if ema_fast > ema_slow else "SELL"
    direction = 1 if side == "BUY" else -1 if side == "SELL" else 0

    # Spec 7 trend cluster: VWAP, EMA20/EMA50 and 15m trend scored as ONE correlated cluster.
    trend_votes = 0
    if direction and last_close is not None and vwap_value is not None and (last_close - vwap_value) * direction > 0:
        trend_votes += 1
    if direction and ema_fast is not None and ema_slow is not None and (ema_fast - ema_slow) * direction > 0:
        trend_votes += 1
    if (direction == 1 and trend_15m == "BULL") or (direction == -1 and trend_15m == "BEAR"):
        trend_votes += 1
    trend_cluster = 3 if trend_votes == 3 else 1 if trend_votes == 2 else 0

    # Structure cluster: strategy breakout/reclaim confirmation (2) + PDH/PDL acceptance (1).
    strategy_confirmed = result.get("decision") == "CONFIRMED"
    if strategy == "ORB_RETEST":
        structure_confirmed = orb is not None and orb.status == "CONFIRMED"
    else:
        structure_confirmed = strategy_confirmed
    pdh = max(candle.high for candle in previous_session) if previous_session else None
    pdl = min(candle.low for candle in previous_session) if previous_session else None
    pdh_pdl_confirmed = last_close is not None and ((direction == 1 and pdh is not None and last_close > pdh) or (direction == -1 and pdl is not None and last_close < pdl))
    structure_cluster = (2 if structure_confirmed else 0) + (1 if pdh_pdl_confirmed else 0)

    # Index cash candles carry no volume; without a futures volume proxy this scores 0 points.
    if relative_volume is None:
        volume_evidence = 0 if candles else None
    elif relative_volume >= config.volume_multiplier:
        volume_evidence = 2
    else:
        volume_evidence = 0

    option_evidence = option_evidence or {}
    ors_call = option_evidence.get("ors_call")
    ors_put = option_evidence.get("ors_put")
    oi_score_raw = option_evidence.get("oi_direction_score")
    iv_regime = option_evidence.get("vix_regime", option_evidence.get("iv_regime"))
    liquidity_score = option_evidence.get("liquidity_score")
    ors = ors_call if direction == 1 else ors_put if direction == -1 else None
    if ors is None and option_evidence.get("ors") is not None and ors_call is None and ors_put is None:
        ors = option_evidence.get("ors")
    if "ors_confirmed" in option_evidence and ors_call is None and ors_put is None:
        ors_confirmed = option_evidence.get("ors_confirmed")
    else:
        ors_confirmed = (ors is not None and float(ors) >= config.ors_thresholds["normal"]) if direction else False
    if "oi_pcr_supportive" in option_evidence and oi_score_raw is None:
        oi_supportive = option_evidence.get("oi_pcr_supportive")
    else:
        oi_supportive = (oi_score_raw is not None and float(oi_score_raw) * direction >= 1) if direction else False
    minimum_score = float(config.score_thresholds["minimum_trade_score"]) + (float(expiry_rules["minimum_score_increase"]) if expiry_day else 0.0)
    # Index candles carry no volume. When no futures-volume proxy is attached the 2 volume points
    # are unobservable, not bearish, so the bar is scaled to the 8 points that can be observed
    # (8/10 -> 6.4/8) instead of demanding a perfect score on everything else.
    volume_observable = relative_volume is not None
    if not volume_observable:
        maximum = float(config.score_thresholds["maximum_score"])
        minimum_score = round(minimum_score * (maximum - 2) / maximum, 2)
    score_total = float(trend_cluster + structure_cluster + (volume_evidence or 0) + (1 if ors_confirmed else 0) + (1 if oi_supportive else 0))
    oi_direction_score = oi_score_raw
    calculations = {
        "underlying": {
            "last_price": _round(last_close),
            "vwap": _round(vwap_value),
            "ema20": _round(ema_fast),
            "ema50": _round(ema_slow),
            "adx14": _round(adx_value),
            "atr14": _round(atr_value),
            "relative_volume": _round(relative_volume),
            "volume_source": volume_source or ("CANDLES" if any(candle.volume > 0 for candle in candles) else "UNAVAILABLE"),
        },
        "orb": {
            "opening_range_high": _round(orb.opening_range_high) if orb else None,
            "opening_range_low": _round(orb.opening_range_low) if orb else None,
            "breakout_index": orb.breakout_index if orb else None,
            "retest_index": orb.retest_index if orb else None,
            "max_extension": max_extension,
            "status": orb.status if orb else None,
            "reason": orb.reason if orb else None,
            "opening_minutes": orb.opening_minutes if orb else None,
            "breakout_time": orb.breakout_time if orb else None,
            "retest_time": orb.retest_time if orb else None,
            "bars_since_retest": orb.bars_since_retest if orb else None,
        },
        "score": {
            "trend_cluster": trend_cluster,
            "trend_votes": trend_votes,
            "trend_15m": trend_15m,
            "structure_cluster": structure_cluster,
            "pdh_pdl_confirmed": pdh_pdl_confirmed,
            "volume_evidence": volume_evidence,
            "option_relative_strength": 1 if ors_confirmed else 0,
            "oi_direction": 1 if oi_supportive else 0,
            "total": score_total,
            "minimum": minimum_score,
            "volume_observable": volume_observable,
        },
        "option": {"ors": _round(float(ors)) if ors is not None else None, "oi_direction_score": _round(float(oi_direction_score)) if oi_direction_score is not None else None, "iv_regime": iv_regime, "liquidity_score": _round(float(liquidity_score)) if liquidity_score is not None else None},
        "risk": {
            "minimum_reward_risk": float(config.rr_minimum),
            "max_trades_per_day": config.max_trades_per_day,
            "daily_loss_limit_pct": float(config.daily_loss_limit_pct),
        },
        "gap": {
            "status": gap.state if gap else None,
            "reason": _GAP_REASONS.get(gap.state) if gap else None,
            "atr_basis": "DAILY_ATR14_PRIOR_SESSIONS",
        },
        "expiry_day": expiry_day,
        "regime": regime,
    }

    evidence = {
        "data_quality_ok": data_quality_ok,
        "session_allowed": entry_permitted,
        "strategy_decision": result.get("decision"),
        "regime": regime,
        "setup_side": (result.get("setup") or {}).get("side"),
        "gap_state": gap.state if gap else None,
        "breakout_valid": (orb is not None and orb.breakout_index is not None) if strategy == "ORB_RETEST" else strategy_confirmed,
        "retest_confirmed": (orb is not None and orb.status == "CONFIRMED") if strategy == "ORB_RETEST" else strategy_confirmed,
        "score": score_total,
        "minimum_score": minimum_score,
        "risk_reward": setup.get("risk_reward"),
        "ors_confirmed": ors_confirmed if option_evidence else None,
        "oi_pcr_supportive": oi_supportive if option_evidence else None,
        "vix_regime": iv_regime,
        "option_quote_fresh": option_evidence.get("option_quote_fresh"),
        "liquidity_score": liquidity_score,
    }
    return evidence, calculations, session_info


ORB_MAX_SIGNAL_AGE_CANDLES = 2  # the retest candle plus up to two more completed candles


def _orb_max_extension(price: float, atr: float) -> float:
    return min(max(price, 1.0) * 0.0035, atr) if atr > 0 else max(price, 1.0) * 0.0035
CANDLE_MINUTES = 5


@dataclass(frozen=True)
class DailyBar:
    date: str
    high: float
    low: float
    close: float


def _daily_bars(candles: list[Candle], daily_candles: list[Candle] | None, before: object) -> list[DailyBar]:
    """Completed daily bars strictly before ``before`` (today's IST date).

    Exchange daily candles are preferred; otherwise each prior intraday session is folded into
    one bar. Today's session is excluded so the gap classification is fixed at the open and can
    never flip (and change the opening-range window) as the day's ranges develop.
    """
    bars: dict[str, DailyBar] = {}
    grouped: dict[object, list[Candle]] = {}
    for candle in candles:
        timestamp = _parse_timestamp(candle.timestamp)
        if timestamp is not None and timestamp.date() < before:
            grouped.setdefault(timestamp.date(), []).append(candle)
    for day, rows in grouped.items():
        bars[day.isoformat()] = DailyBar(day.isoformat(), max(c.high for c in rows), min(c.low for c in rows), rows[-1].close)
    for candle in daily_candles or []:
        timestamp = _parse_timestamp(candle.timestamp)
        if timestamp is not None and timestamp.date() < before and candle.high > 0 and candle.low > 0:
            bars[timestamp.date().isoformat()] = DailyBar(timestamp.date().isoformat(), candle.high, candle.low, candle.close)
    return [bars[key] for key in sorted(bars)]


def _daily_atr(bars: list[DailyBar], period: int) -> float | None:
    """Wilder ATR on daily bars; with fewer than ``period`` true ranges it is their plain mean."""
    ranges = [bar.high - bar.low if index == 0 else max(bar.high - bar.low, abs(bar.high - bars[index - 1].close), abs(bar.low - bars[index - 1].close)) for index, bar in enumerate(bars)]
    if not ranges:
        return None
    if len(ranges) < period:
        return sum(ranges) / len(ranges)
    result = sum(ranges[:period]) / period
    for value in ranges[period:]:
        result = (result * (period - 1) + value) / period
    return result


def _gap_for(candles: list[Candle], config: StrategyConfiguration, daily_candles: list[Candle] | None = None):
    """Spec 4: gap = open beyond the previous day's range by more than 0.5 x ATR14 (daily).

    A 5-minute ATR (~25 NIFTY points) made almost any open outside the prior range a "gap
    day", and because it included today's candles the verdict could change during the session.
    """
    session, previous = _split_sessions(candles)
    if not (session and previous):
        return None
    today = _parse_timestamp(session[0].timestamp).date()
    atr_value = _daily_atr(_daily_bars(candles, daily_candles, today), config.atr_period)
    if not atr_value:
        return None
    return evaluate_gap_day(
        opening_price=session[0].open,
        previous_high=max(candle.high for candle in previous),
        previous_low=min(candle.low for candle in previous),
        atr_value=atr_value,
        post_opening_lows=[candle.low for candle in session[1:]],
        post_opening_highs=[candle.high for candle in session[1:]],
        config=config,
    )


def _orb_for(candles: list[Candle], config: StrategyConfiguration, daily_candles: list[Candle] | None = None):
    """ORB with the spec-4 gap-day window (30 min instead of 15) and multi-session ATR."""
    gap = _gap_for(candles, config, daily_candles)
    minutes = gap.required_or_duration_minutes if gap else config.orb_duration_minutes
    return evaluate_orb_retest(candles, indicators.atr(candles, config.atr_period), minutes), gap


def _orb_calculations(orb, gap) -> dict:
    return {"orb": {
        "opening_range_high": orb.opening_range_high, "opening_range_low": orb.opening_range_low, "opening_minutes": orb.opening_minutes,
        "breakout_index": orb.breakout_index, "retest_index": orb.retest_index, "breakout_time": orb.breakout_time, "retest_time": orb.retest_time,
        "atr": orb.atr, "bars_since_retest": orb.bars_since_retest, "status": orb.status, "reason": orb.reason, "gap_state": gap.state if gap else None,
    }}


def completed_candles(candles: list[Candle], now: datetime, minutes: int = CANDLE_MINUTES) -> list[Candle]:
    """Drop the candle still forming at ``now``; signals on it would repaint before it closes."""
    kept = []
    for candle in candles:
        started = _parse_timestamp(candle.timestamp)
        if started is None or started + timedelta(minutes=minutes) <= now:
            kept.append(candle)
    return kept



def analyze(symbol: str, candles: list[Candle], risk_per_trade: float = 1000.0, strategy: str = "ORB_RETEST", daily_candles: list[Candle] | None = None, expiry_day: bool = False) -> dict:
    if len(candles) < 21:
        return {"symbol": symbol, "strategy": strategy, "decision": "NO_TRADE", "reason": "At least 21 candles are required", "confidence": 0, "setup": None}
    if strategy == "ORB_RETEST":
        config = StrategyConfiguration()
        orb, gap = _orb_for(candles, config, daily_candles)
        orb_calc = _orb_calculations(orb, gap)
        if orb.status != "CONFIRMED" or not orb.side:
            # Never fall through to a different (EMA/VWAP) rule set: ORB either confirms or waits.
            return {"symbol": symbol, "strategy": strategy, "decision": orb.status, "reason": orb.reason, "confidence": 0, "calculations": orb_calc, "setup": None}
        entry = candles[-1].close
        level = orb.opening_range_high if orb.side == "BUY" else orb.opening_range_low
        # A retest signal stays actionable for a couple of candles while price is still within
        # the max extension of the level (spec 6A); beyond that it is a chase, and the engine
        # waits for the next pullback to the level rather than ending the day.
        fresh = orb.bars_since_retest is not None and orb.bars_since_retest <= ORB_MAX_SIGNAL_AGE_CANDLES
        near_level = level is not None and 0 < (entry - level) * (1 if orb.side == "BUY" else -1) <= _orb_max_extension(entry, orb.atr)
        if not (fresh and near_level):
            retest_clock = orb.retest_time[11:16] if orb.retest_time else "--"
            why = f"{orb.bars_since_retest} candles ago" if not fresh else f"price is now {abs(entry - (level or entry)):.1f} pts from the level"
            return {"symbol": symbol, "strategy": strategy, "decision": "SIGNAL_EXPIRED", "reason": f"ORB retest at {retest_clock} ({why}); entering now would be chasing. Waiting for the next pullback to {level:.2f}", "confidence": 0, "calculations": orb_calc, "setup": None}
        buffer = orb.atr * config.stop_buffer_atr_multiplier
        # Spec 15: structural stop beyond the retest extreme / breakout level, plus an ATR buffer.
        if orb.side == "BUY":
            stop = min(orb.retest_low if orb.retest_low is not None else entry, orb.opening_range_high or entry) - buffer
        else:
            stop = max(orb.retest_high if orb.retest_high is not None else entry, orb.opening_range_low or entry) + buffer
        risk = abs(entry - stop)
        if risk <= 0 or (orb.side == "BUY" and stop >= entry) or (orb.side == "SELL" and stop <= entry):
            return {"symbol": symbol, "strategy": strategy, "decision": "NO_TRADE", "reason": "Structural stop is not on the invalidation side of entry", "confidence": 0, "calculations": orb_calc, "setup": None}
        if orb.atr and risk > 2 * orb.atr:
            return {"symbol": symbol, "strategy": strategy, "decision": "NO_TRADE", "reason": f"Structural stop is {risk / orb.atr:.1f} ATR away (max 2): the retest was too deep for a tight ORB trade", "confidence": 0, "calculations": orb_calc, "setup": None}
        direction = 1 if orb.side == "BUY" else -1
        target = entry + risk * config.rr_minimum * direction
        # Spec 15: never force 2R through a major structural level. The previous day's high
        # (for longs) / low (for shorts) is the obstacle; the reward is measured to it.
        # Prefer the exchange daily bar for PDH/PDL; a 1-minute feed with holes understates it.
        today = _parse_timestamp(candles[-1].timestamp)
        prior_days = _daily_bars(candles, daily_candles, today.date()) if today is not None else []
        obstacle = (prior_days[-1].high if direction > 0 else prior_days[-1].low) if prior_days else None
        reward = abs(target - entry)
        obstacle_label = None
        if obstacle is not None and 0 < (obstacle - entry) * direction < reward:
            reward = abs(obstacle - entry)
            obstacle_label = f"{'PDH' if direction > 0 else 'PDL'} {obstacle:.2f}"
        rr = round(reward / risk, 2)
        if rr < config.rr_minimum:
            return {"symbol": symbol, "strategy": strategy, "decision": "NO_TRADE", "reason": f"Only {rr}R of room before {obstacle_label}; the 2R target is not realistic", "confidence": 0, "calculations": orb_calc, "setup": None}
        size_multiplier = gap.first_trade_risk_multiplier if gap and gap.is_gap_day else 1.0
        if expiry_day:
            size_multiplier *= float(config.expiry_day_adjustments["risk_multiplier"])
        quantity = max(1, int(risk_per_trade * size_multiplier / max(risk, 0.01)))
        return {"symbol": symbol, "strategy": strategy, "decision": "CONFIRMED", "reason": orb.reason, "confidence": 100, "calculations": orb_calc, "setup": {
            "side": orb.side, "entry": entry, "stop_loss": round(stop, 2), "target": round(target, 2), "risk_reward": rr, "quantity": quantity,
            "size_multiplier": size_multiplier, "gap_day": bool(gap and gap.is_gap_day), "expiry_day": expiry_day,
            "target_method": "STRUCTURAL_2R" + (f"_CLEAR_OF_{obstacle_label.split()[0]}" if obstacle_label else ""), "stop_method": "RETEST_EXTREME_MINUS_ATR_BUFFER",
        }}
    if strategy == "VWAP_REVERSAL":
        return _vwap_reversal(symbol, candles, risk_per_trade)
    return {"symbol": symbol, "strategy": strategy, "decision": "NO_TRADE", "reason": "Range Defined Risk is analysis-only until the multi-leg builder is enabled", "confidence": 0, "setup": None}


def _vwap_reversal(symbol: str, candles: list[Candle], risk_per_trade: float) -> dict:
    """Spec 6D: stretch away from VWAP into support/resistance, rejection, then a VWAP reclaim.

    Bullish: price trades below session VWAP, tags support (PDL or the session low) and
    forms a higher low, then the latest completed candle closes back above VWAP as a
    bullish candle. Bearish is the mirror image. Touching a level alone never triggers.
    """
    config = StrategyConfiguration()
    session, previous = _split_sessions(candles)
    base = {"symbol": symbol, "strategy": "VWAP_REVERSAL", "confidence": 0, "setup": None}
    if len(session) < 6:
        return {**base, "decision": "WAIT_FOR_CONFIRMATION", "reason": "VWAP reversal needs at least 6 session candles"}
    atr_value = indicators.atr(candles, config.atr_period) or 0.0
    vwap_series: list[float] = []
    cumulative_pv = cumulative_v = 0.0
    for index, candle in enumerate(session):
        typical = (candle.high + candle.low + candle.close) / 3.0
        weight = candle.volume if candle.volume > 0 else 1.0
        cumulative_pv += typical * weight
        cumulative_v += weight
        vwap_series.append(cumulative_pv / cumulative_v)
    latest, prior = session[-1], session[-2]
    vwap_now, vwap_prior = vwap_series[-1], vwap_series[-2]
    window = session[-12:-1]
    pdl = min(c.low for c in previous) if previous else None
    pdh = max(c.high for c in previous) if previous else None
    tolerance = max(atr_value * 0.25, latest.close * 0.0005)
    indicators_out = {"vwap": vwap_now, "atr": atr_value}

    reclaimed_up = prior.close <= vwap_prior and latest.close > vwap_now and latest.close > latest.open
    reclaimed_down = prior.close >= vwap_prior and latest.close < vwap_now and latest.close < latest.open
    if reclaimed_up and window:
        low_index = min(range(len(window)), key=lambda i: window[i].low)
        swing_low = window[low_index].low
        support = min(c.low for c in session[:-1])
        at_support = abs(swing_low - support) <= tolerance or (pdl is not None and abs(swing_low - pdl) <= tolerance)
        higher_low = low_index < len(window) - 1 and min(c.low for c in window[low_index + 1:] + [latest]) > swing_low
        if at_support and higher_low:
            stop = swing_low - atr_value * config.stop_buffer_atr_multiplier
            return _reversal_setup(base, "BUY", latest.close, stop, config, risk_per_trade, indicators_out, support, pdh)
        return {**base, "decision": "WAIT_FOR_CONFIRMATION", "reason": "VWAP reclaimed, but no support test with a higher low preceded it", "indicators": indicators_out}
    if reclaimed_down and window:
        high_index = max(range(len(window)), key=lambda i: window[i].high)
        swing_high = window[high_index].high
        resistance = max(c.high for c in session[:-1])
        at_resistance = abs(swing_high - resistance) <= tolerance or (pdh is not None and abs(swing_high - pdh) <= tolerance)
        lower_high = high_index < len(window) - 1 and max(c.high for c in window[high_index + 1:] + [latest]) < swing_high
        if at_resistance and lower_high:
            stop = swing_high + atr_value * config.stop_buffer_atr_multiplier
            return _reversal_setup(base, "SELL", latest.close, stop, config, risk_per_trade, indicators_out, pdl, resistance)
        return {**base, "decision": "WAIT_FOR_CONFIRMATION", "reason": "VWAP lost, but no resistance test with a lower high preceded it", "indicators": indicators_out}
    return {**base, "decision": "WAIT_FOR_CONFIRMATION", "reason": "Waiting for a rejection at support/resistance followed by a VWAP reclaim", "indicators": indicators_out}


def _reversal_setup(base: dict, side: Side, entry: float, stop: float, config: StrategyConfiguration, risk_per_trade: float, indicators_out: dict, support: float | None, resistance: float | None) -> dict:
    risk = abs(entry - stop)
    if risk <= 0:
        return {**base, "decision": "NO_TRADE", "reason": "Structural stop is not on the invalidation side of entry", "indicators": indicators_out}
    target = entry + risk * config.rr_minimum if side == "BUY" else entry - risk * config.rr_minimum
    return {**base, "decision": "CONFIRMED", "confidence": 100, "reason": f"{'Support' if side == 'BUY' else 'Resistance'} rejection followed by a confirmed VWAP reclaim", "indicators": indicators_out, "levels": {"support": support, "resistance": resistance}, "setup": {"side": side, "entry": entry, "stop_loss": round(stop, 2), "target": round(target, 2), "risk_reward": round(abs(target - entry) / risk, 2), "quantity": max(1, int(risk_per_trade / max(risk, 0.01))), "target_method": "STRUCTURAL_2R", "stop_method": "REJECTION_EXTREME_MINUS_ATR_BUFFER"}}


def _candles_from(items: object) -> list[Candle]:
    return [Candle(timestamp=_normalize_timestamp(item.get("timestamp", item.get("time", ""))), open=_number(item["open"]), high=_number(item["high"]), low=_number(item["low"]), close=_number(item["close"]), volume=_number(item.get("volume"))) for item in (items if isinstance(items, list) else []) if isinstance(item, dict)]


def analyze_payload(payload: dict) -> dict:
    candles = _candles_from(payload.get("candles", []))
    daily_candles = _candles_from(payload.get("daily_candles")) or None
    symbol = str(payload.get("symbol", "UNKNOWN"))
    strategy = str(payload.get("strategy", "ORB_RETEST"))
    now = datetime.now(MARKET_TIMEZONE)
    candles = completed_candles(candles, now)
    option_evidence = payload.get("option_evidence")
    result = analyze(symbol, candles, float(payload.get("risk_per_trade", 1000)), strategy, daily_candles, _expiry_today(option_evidence, now))
    # Evidence the engine can observe directly from candles and the IST clock is computed
    # first; the caller (Node API boundary) may only *add* independently-verified evidence
    # such as broker health, SAFE_MODE, and kill-switch state. A caller can never overwrite
    # observed data-quality, session, regime, gap, breakout, or retest evidence with this merge.
    volume_source = payload.get("volume_source") if isinstance(payload.get("volume_source"), str) else None
    evidence, calculations, session_info = _observe(symbol, candles, strategy, result, StrategyConfiguration(), now, option_evidence, daily_candles, volume_source)
    result["calculations"] = calculations
    result["session"] = session_info
    caller_evidence = payload.get("pipeline") or {}
    pipeline_input = {**caller_evidence, **evidence}
    pipeline = evaluate_payload(pipeline_input)
    result["pipeline"] = pipeline
    result["strategy_decision"] = result.get("decision")
    result["strategy_reason"] = result.get("reason")
    # The raw strategy setup survives the gate so the paper auto engine (which applies its own
    # risk checks) can act on a fresh ORB signal; ``setup`` stays null unless every gate passes.
    result["strategy_setup"] = result.get("setup")
    if pipeline["decision"] != "CONFIRMED":
        result["decision"] = "NO_TRADE"
        result["reason"] = "; ".join(pipeline["reasons"])
        result["setup"] = None
    return result


def main() -> None:
    import json, sys
    print(json.dumps(analyze_payload(json.load(sys.stdin))))

if __name__ == "__main__":
    main()
