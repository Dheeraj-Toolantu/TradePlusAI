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


def _ema(values: list[float], period: int) -> float:
    if not values:
        return 0.0
    multiplier = 2 / (period + 1)
    current = values[0]
    for value in values[1:]:
        current += (value - current) * multiplier
    return current


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


def _observe(symbol: str, candles: list[Candle], strategy: str, result: dict, config: StrategyConfiguration, now: datetime, option_evidence: dict | None = None) -> tuple[dict, dict, dict]:
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
    recent = vwap_basis[-20:]
    average_volume = sum(candle.volume for candle in recent) / len(recent) if recent else 0.0
    relative_volume = (candles[-1].volume / average_volume) if candles and average_volume > 0 else None

    orb = evaluate_orb_retest(candles) if strategy == "ORB_RETEST" and data_quality_ok else None
    max_extension = round(min(max(last_close, 1.0) * 0.0035, max(orb.atr, 0.01)), 4) if orb is not None and last_close else None

    gap = None
    if session and previous_session and atr_value:
        gap = evaluate_gap_day(
            opening_price=session[0].open,
            previous_high=max(candle.high for candle in previous_session),
            previous_low=min(candle.low for candle in previous_session),
            atr_value=atr_value,
            post_opening_lows=[candle.low for candle in session[1:]],
            post_opening_highs=[candle.high for candle in session[1:]],
            config=config,
        )

    regime = classify_regime(
        adx_value,
        last_close,
        vwap_value,
        ema_fast,
        ema_slow,
        trend_15m=_trend_15m(candles, config),
        gap_state=gap.state if gap else "NORMAL_DAY",
        config=config,
    )

    direction_consistent = (
        ema_fast is not None and ema_slow is not None and vwap_value is not None and last_close is not None
        and ((ema_fast > ema_slow and last_close > vwap_value) or (ema_fast < ema_slow and last_close < vwap_value))
    )
    trend_cluster = 0
    if ema_fast is not None and ema_slow is not None and ema_fast != ema_slow:
        trend_cluster += 1
    if direction_consistent:
        trend_cluster += 1
    if adx_value is not None and adx_value >= config.adx_entry_threshold:
        trend_cluster += 1
    structure_cluster = (1 if orb is not None and orb.breakout_index is not None else 0) + (1 if orb is not None and orb.status == "CONFIRMED" else 0)
    if relative_volume is None:
        volume_evidence = 0 if candles else None
    elif relative_volume >= config.volume_multiplier:
        volume_evidence = 2
    elif relative_volume >= 1.2:
        volume_evidence = 1
    else:
        volume_evidence = 0
    minimum_score = float(config.score_thresholds["minimum_trade_score"])
    score_total = float(trend_cluster + structure_cluster + (volume_evidence or 0))

    option_evidence = option_evidence or {}
    ors = option_evidence.get("ors")
    oi_direction_score = option_evidence.get("oi_direction_score")
    iv_regime = option_evidence.get("iv_regime")
    liquidity_score = option_evidence.get("liquidity_score")
    calculations = {
        "underlying": {
            "last_price": _round(last_close),
            "vwap": _round(vwap_value),
            "ema20": _round(ema_fast),
            "ema50": _round(ema_slow),
            "adx14": _round(adx_value),
            "atr14": _round(atr_value),
            "relative_volume": _round(relative_volume),
        },
        "orb": {
            "opening_range_high": _round(orb.opening_range_high) if orb else None,
            "opening_range_low": _round(orb.opening_range_low) if orb else None,
            "breakout_index": orb.breakout_index if orb else None,
            "retest_index": orb.retest_index if orb else None,
            "max_extension": max_extension,
            "status": orb.status if orb else None,
        },
        "score": {
            "trend_cluster": trend_cluster,
            "structure_cluster": structure_cluster,
            "volume_evidence": volume_evidence,
            "option_relative_strength": _round(float(ors)) if ors is not None else None,
            "oi_direction": _round(float(oi_direction_score)) if oi_direction_score is not None else None,
            "total": score_total,
            "minimum": minimum_score,
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
        },
        "regime": regime,
    }

    setup = result.get("setup") or {}
    evidence = {
        "data_quality_ok": data_quality_ok,
        "session_allowed": entry_permitted,
        "strategy_decision": result.get("decision"),
        "regime": regime,
        "gap_state": gap.state if gap else None,
        "breakout_valid": orb is not None and orb.breakout_index is not None,
        "retest_confirmed": orb is not None and orb.status == "CONFIRMED",
        "score": score_total,
        "minimum_score": minimum_score,
        "risk_reward": setup.get("risk_reward"),
        "ors_confirmed": option_evidence.get("ors_confirmed"),
        "oi_pcr_supportive": option_evidence.get("oi_pcr_supportive"),
        "vix_regime": iv_regime,
        "option_quote_fresh": option_evidence.get("option_quote_fresh"),
        "liquidity_score": liquidity_score,
    }
    return evidence, calculations, session_info


def analyze(symbol: str, candles: list[Candle], risk_per_trade: float = 1000.0, strategy: str = "ORB_RETEST") -> dict:
    if len(candles) < 21:
        return {"symbol": symbol, "strategy": strategy, "decision": "NO_TRADE", "reason": "At least 21 candles are required", "confidence": 0, "setup": None}
    if strategy == "ORB_RETEST":
        orb = evaluate_orb_retest(candles)
        if orb.status == "CONFIRMED" and orb.side:
            entry = candles[-1].close
            risk = max(orb.atr, entry * 0.002)
            stop = entry - risk if orb.side == "BUY" else entry + risk
            target = entry + risk * 2 if orb.side == "BUY" else entry - risk * 2
            quantity = max(1, int(risk_per_trade / max(risk, 0.01)))
            return {"symbol": symbol, "strategy": strategy, "decision": "CONFIRMED", "reason": orb.reason, "confidence": 100, "calculations": {"orb": {"opening_range_high": orb.opening_range_high, "opening_range_low": orb.opening_range_low, "breakout_index": orb.breakout_index, "retest_index": orb.retest_index, "atr": orb.atr}}, "setup": {"side": orb.side, "entry": entry, "stop_loss": stop, "target": target, "risk_reward": 2.0, "quantity": quantity, "target_method": "PROTOTYPE_2R_ATR_HEURISTIC", "stop_method": "PROTOTYPE_ATR_BUFFER"}}
    closes = [candle.close for candle in candles]
    recent = candles[-20:]
    current = candles[-1]
    ema9 = _ema(closes[-50:], 9)
    ema20 = _ema(closes[-50:], 20)
    vwap_volume = sum(max(candle.volume, 1.0) for candle in recent)
    vwap = sum(candle.close * max(candle.volume, 1.0) for candle in recent) / vwap_volume
    support = min(candle.low for candle in recent)
    resistance = max(candle.high for candle in recent)
    average_volume = sum(candle.volume for candle in recent) / len(recent)
    relative_volume = current.volume / max(average_volume, 1.0)
    bullish = ema9 > ema20 and current.close > vwap
    bearish = ema9 < ema20 and current.close < vwap
    side: Side | None = "BUY" if bullish else "SELL" if bearish else None
    atr = sum(candle.high - candle.low for candle in candles[-14:]) / 14
    confirmation = relative_volume >= 1.2 and ((bullish and current.close > candles[-2].high) or (bearish and current.close < candles[-2].low))
    confidence = min(100, 45 + (20 if side else 0) + (15 if confirmation else 0) + (10 if relative_volume >= 1.2 else 0))
    if not side or not confirmation:
        return {"symbol": symbol, "strategy": strategy, "decision": "WAIT_FOR_CONFIRMATION", "reason": "Trend, VWAP, breakout and volume must agree", "confidence": confidence, "indicators": {"ema9": ema9, "ema20": ema20, "vwap": vwap, "atr": atr, "relative_volume": relative_volume}, "levels": {"support": support, "resistance": resistance}}
    risk = max(atr, current.close * 0.002)
    stop = support - atr * 0.25 if side == "BUY" else resistance + atr * 0.25
    target = current.close + risk * 2 if side == "BUY" else current.close - risk * 2
    quantity = max(1, int(risk_per_trade / max(abs(current.close - stop), 0.01)))
    return {"symbol": symbol, "strategy": strategy, "decision": "CONFIRMED", "reason": "EMA, VWAP, breakout and relative volume confirmed", "confidence": confidence, "indicators": {"ema9": ema9, "ema20": ema20, "vwap": vwap, "atr": atr, "relative_volume": relative_volume}, "levels": {"support": support, "resistance": resistance}, "setup": {"side": side, "entry": current.close, "stop_loss": stop, "target": target, "risk_reward": 2.0, "quantity": quantity, "target_method": "PROTOTYPE_2R_ATR_HEURISTIC", "stop_method": "PROTOTYPE_ATR_BUFFER"}}


def analyze_payload(payload: dict) -> dict:
    candles = [Candle(timestamp=_normalize_timestamp(item.get("timestamp", item.get("time", ""))), open=_number(item["open"]), high=_number(item["high"]), low=_number(item["low"]), close=_number(item["close"]), volume=_number(item.get("volume"))) for item in payload.get("candles", [])]
    symbol = str(payload.get("symbol", "UNKNOWN"))
    strategy = str(payload.get("strategy", "ORB_RETEST"))
    result = analyze(symbol, candles, float(payload.get("risk_per_trade", 1000)), strategy)
    # Evidence the engine can observe directly from candles and the IST clock is computed
    # first; the caller (Node API boundary) may only *add* independently-verified evidence
    # such as broker health, SAFE_MODE, and kill-switch state. A caller can never overwrite
    # observed data-quality, session, regime, gap, breakout, or retest evidence with this merge.
    evidence, calculations, session_info = _observe(symbol, candles, strategy, result, StrategyConfiguration(), datetime.now(MARKET_TIMEZONE), payload.get("option_evidence"))
    result["calculations"] = calculations
    result["session"] = session_info
    caller_evidence = payload.get("pipeline") or {}
    pipeline_input = {**caller_evidence, **evidence}
    pipeline = evaluate_payload(pipeline_input)
    result["pipeline"] = pipeline
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
