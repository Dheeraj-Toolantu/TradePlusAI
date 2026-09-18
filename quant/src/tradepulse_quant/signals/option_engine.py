"""Fail-closed option-chain ranking for paper-trading suggestions.

The engine accepts a normalized option-chain snapshot. It never fetches data or
places orders; the caller is responsible for authenticating the provider and
normalizing its response. Missing or stale chain fields produce no actionable
candidate.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict, dataclass, field
from datetime import date
from math import isfinite
from typing import Literal


OptionType = Literal["CE", "PE"]
DEFAULT_CONFIG = {
    "weights": {
        "directional": 0.25,
        "trend": 0.20,
        "delta": 0.15,
        "iv": 0.10,
        "oi": 0.10,
        "liquidity": 0.10,
        "risk_reward": 0.10,
    },
    "risk": {
        "minimum_rr": 1.5,
        "preferred_rr": 2.0,
    },
    "delta": {
        "preferred_min": 0.45,
        "preferred_max": 0.65,
        "absolute_min": 0.20,
    },
    "liquidity": {
        "maximum_spread_percent": 2.0,
        "minimum_oi": 10000,
        "minimum_volume": 500,
    },
    "feasibility": {
        "minimum_expected_move_ratio": 0.8,
    },
}


def validate_config(config: dict | None) -> bool:
    resolved = config or DEFAULT_CONFIG
    weights = resolved.get("weights", {})
    if not isinstance(weights, dict):
        return False
    weight_total = sum(float(value) for value in weights.values())
    if not isfinite(weight_total) or abs(weight_total - 1.0) > 1e-6:
        return False
    return True


def _resolved_config(config: dict | None) -> dict:
    resolved = deepcopy(DEFAULT_CONFIG)
    if isinstance(config, dict):
        for key, value in config.items():
            if isinstance(value, dict) and isinstance(resolved.get(key), dict):
                resolved[key].update(value)
            else:
                resolved[key] = value
    return resolved


@dataclass(frozen=True)
class Candle:
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass(frozen=True)
class OptionContract:
    symbol: Literal["NIFTY", "BANKNIFTY", "SENSEX"]
    expiry: str
    strike: float
    option_type: OptionType
    ltp: float
    bid: float
    ask: float
    open_interest: float
    oi_change: float
    volume: float
    iv: float
    delta: float
    theta: float
    lot_size: int
    timestamp_age_seconds: float
    trading_symbol: str = ""


@dataclass(frozen=True)
class EngineInput:
    symbol: str
    spot: float
    contracts: list[OptionContract]
    candles: list[Candle]
    account_risk: float = 1000.0
    min_reward_risk: float = 2.0
    max_age_seconds: float = 1.5
    stop_buffer: float = 0.0
    config: dict = field(default_factory=lambda: deepcopy(DEFAULT_CONFIG))


def _finite(*values: float) -> bool:
    return all(isfinite(value) for value in values)


def _ema(values: list[float], period: int) -> float:
    multiplier = 2 / (period + 1)
    current = values[0]
    for value in values[1:]:
        current += (value - current) * multiplier
    return current


def _market_context(candles: list[Candle]) -> tuple[str, float, float, float, float] | None:
    if len(candles) < 21:
        return None
    closes = [candle.close for candle in candles]
    recent = candles[-20:]
    latest = candles[-1]
    previous = candles[-2]
    ema9 = _ema(closes[-50:], 9)
    ema20 = _ema(closes[-50:], 20)
    support = min(candle.low for candle in recent)
    resistance = max(candle.high for candle in recent)
    average_volume = sum(candle.volume for candle in candles[-20:]) / 20
    volume_expansion = average_volume > 0 and latest.volume >= average_volume * 1.2
    bullish = ema9 > ema20 and latest.close > previous.high and volume_expansion
    bearish = ema9 < ema20 and latest.close < previous.low and volume_expansion
    if bullish:
        return "BULLISH_BREAKOUT", support, resistance, ema9, ema20
    if bearish:
        return "BEARISH_BREAKDOWN", support, resistance, ema9, ema20
    return "WAIT", support, resistance, ema9, ema20


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _spread_percent(contract: OptionContract) -> float:
    if contract.ltp <= 0:
        return 100.0
    return ((contract.ask - contract.bid) / contract.ltp) * 100.0


def _directional_score(contract: OptionContract, context: tuple[str, float, float, float, float], data: EngineInput) -> tuple[str, float, list[str]]:
    regime, support, resistance, ema9, ema20 = context
    bullish_signal = ema9 > ema20 and data.spot >= support and data.spot <= resistance
    bearish_signal = ema9 < ema20 and data.spot <= resistance and data.spot >= support
    if contract.option_type == "CE":
        direction = "BULLISH" if bullish_signal or regime == "BULLISH_BREAKOUT" else "NEUTRAL" if regime == "WAIT" else "BEARISH"
    else:
        direction = "BEARISH" if bearish_signal or regime == "BEARISH_BREAKDOWN" else "NEUTRAL" if regime == "WAIT" else "BULLISH"
    reasons: list[str] = []
    if direction == "BULLISH":
        reasons.append("Price is aligned with bullish structure")
        reasons.append("EMA trend supports upside")
    elif direction == "BEARISH":
        reasons.append("Price is aligned with bearish structure")
        reasons.append("EMA trend supports downside")
    else:
        reasons.append("Market structure is mixed or range-bound")
    score = 50.0
    if regime == "BULLISH_BREAKOUT":
        score += 30
    elif regime == "BEARISH_BREAKDOWN":
        score += 30
    elif regime == "WAIT":
        score -= 10
    if contract.option_type == "CE" and direction == "BULLISH":
        score += 12
    if contract.option_type == "PE" and direction == "BEARISH":
        score += 12
    if contract.option_type == "CE" and direction == "BEARISH":
        score -= 35
    if contract.option_type == "PE" and direction == "BULLISH":
        score -= 35
    return direction, _clamp(score, 0.0, 100.0), reasons


def _trend_score(context: tuple[str, float, float, float, float]) -> tuple[float, list[str]]:
    regime, _, _, ema9, ema20 = context
    if regime == "WAIT":
        return 45.0, ["Trend is weak or range-bound"]
    if regime in {"BULLISH_BREAKOUT", "BEARISH_BREAKDOWN"}:
        spread = abs(ema9 - ema20)
        score = _clamp(55.0 + (spread / max(abs(ema20), 1.0)) * 1500.0, 0.0, 100.0)
        return round(score, 2), ["Multi-timeframe price structure aligns with the market regime"]
    return 50.0, ["Trend confirmation is mixed"]


def _delta_score(contract: OptionContract) -> float:
    value = abs(contract.delta)
    if contract.option_type == "CE":
        if 0.45 <= value <= 0.65:
            return 92.0
        if 0.30 <= value < 0.45:
            return 78.0
        if 0.20 <= value < 0.30:
            return 62.0
        if value < 0.20:
            return 32.0
        return 60.0
    if 0.45 <= value <= 0.65:
        return 90.0
    if 0.30 <= value < 0.45:
        return 76.0
    if 0.20 <= value < 0.30:
        return 58.0
    if value < 0.20:
        return 30.0
    return 60.0


def _iv_score(contract: OptionContract) -> float:
    iv = contract.iv
    if iv <= 0:
        return 0.0
    if iv < 12:
        return 82.0
    if iv < 18:
        return 88.0
    if iv < 25:
        return 80.0
    if iv < 35:
        return 70.0
    return 55.0


def _oi_score(contract: OptionContract) -> float:
    force = abs(contract.oi_change) / max(contract.open_interest, 1)
    score = 50.0 + force * 250.0
    return _clamp(score, 0.0, 100.0)


def _liquidity_score(contract: OptionContract) -> float:
    spread = _spread_percent(contract)
    volume_factor = min(100.0, contract.volume / max(contract.open_interest, 1) * 100.0)
    score = 90.0 - spread * 1.5 - max(0.0, (25.0 - volume_factor) * 0.8)
    return _clamp(score, 0.0, 100.0)


def _rr_score(risk_reward: float, minimum: float) -> float:
    if risk_reward <= 0:
        return 0.0
    return _clamp(50.0 + (risk_reward - minimum) * 20.0, 0.0, 100.0)


def _confidence_score(final_score: float, required_move: float, expected_move: float, spread_percent: float, reward_risk: float) -> float:
    feasibility = 1.0 if required_move <= expected_move else 0.45
    liquidity = 1.0 if spread_percent <= 2.0 else 0.5
    rr_bonus = 1.0 if reward_risk >= 2.0 else 0.6
    return _clamp(final_score * 0.7 + 25.0 * feasibility + 10.0 * liquidity + 5.0 * rr_bonus, 0.0, 100.0)


def _blocked(contract: OptionContract, today: date) -> list[str]:
    reasons: list[str] = []
    try:
        expiry = date.fromisoformat(contract.expiry)
        if expiry < today:
            reasons.append("expired contract")
    except ValueError:
        reasons.append("invalid expiry")
    if not _finite(contract.strike, contract.ltp, contract.bid, contract.ask, contract.open_interest, contract.oi_change, contract.volume, contract.iv, contract.delta, contract.theta):
        reasons.append("non-finite chain field")
    if contract.ltp <= 0 or contract.bid <= 0 or contract.ask < contract.bid:
        reasons.append("invalid bid/ask or LTP")
    if contract.open_interest <= 0 or contract.volume <= 0:
        reasons.append("insufficient open interest or volume")
    if contract.iv <= 0 or contract.lot_size <= 0:
        reasons.append("invalid IV or lot size")
    if contract.timestamp_age_seconds > 1.5:
        reasons.append("stale option chain")
    spread = (contract.ask - contract.bid) / contract.ltp if contract.ltp else 1
    if spread > 0.12:
        reasons.append("bid/ask spread too wide")
    return reasons


def build_audit_record(candidate: dict, data: EngineInput) -> dict:
    config = _resolved_config(data.config)
    option_type = "CE" if candidate.get("contract") == "CALL" else "PE" if candidate.get("contract") == "PUT" else ""
    reasons = candidate.get("reason", "")
    return {
        "timestamp": date.today().isoformat(),
        "spot": data.spot,
        "symbol": data.symbol,
        "expiry": candidate.get("expiry"),
        "strike": candidate.get("strike"),
        "option_type": option_type,
        "premium": candidate.get("premium"),
        "delta": candidate.get("delta"),
        "gamma": None,
        "theta": candidate.get("theta"),
        "iv": candidate.get("iv"),
        "iv_rank": None,
        "oi": candidate.get("openInterest"),
        "volume": candidate.get("volume"),
        "bid": candidate.get("bid"),
        "ask": candidate.get("ask"),
        "spread": candidate.get("spread"),
        "directional_score": candidate.get("directional_score"),
        "trend_score": candidate.get("trend_score"),
        "delta_score": candidate.get("delta_score"),
        "iv_score": candidate.get("iv_score"),
        "oi_score": candidate.get("oi_score"),
        "liquidity_score": candidate.get("liquidity_score"),
        "risk_reward_score": candidate.get("risk_reward_score"),
        "final_score": candidate.get("final_score"),
        "expected_move": candidate.get("feasibility", {}).get("expected_move_points"),
        "expected_range": candidate.get("feasibility", {}).get("expected_range"),
        "breakeven": candidate.get("feasibility", {}).get("breakeven"),
        "required_move": candidate.get("feasibility", {}).get("required_move"),
        "target": candidate.get("target"),
        "stop_loss": candidate.get("stop"),
        "risk_reward": candidate.get("riskReward"),
        "confidence": candidate.get("confidence"),
        "decision": candidate.get("decision"),
        "data_quality_status": candidate.get("pipeline", {}).get("data_quality", "HIGH"),
        "weights": config["weights"],
        "reasons": reasons.split("; ") if reasons else [],
        "warnings": candidate.get("warnings", []),
    }


def _candidate(contract: OptionContract, context: tuple[str, float, float, float, float], data: EngineInput, today: date) -> dict | None:
    config = _resolved_config(data.config)
    weights = config["weights"]
    risk_cfg = config["risk"]
    liquidity_cfg = config["liquidity"]
    delta_cfg = config["delta"]
    blocked = _blocked(contract, today)
    if blocked:
        return None
    regime, support, resistance, ema9, ema20 = context
    direction, directional_score, direction_reasons = _directional_score(contract, context, data)
    if contract.option_type == "CE" and direction != "BULLISH":
        return None
    if contract.option_type == "PE" and direction != "BEARISH":
        return None
    trend_score, trend_reasons = _trend_score(context)
    delta_score = _delta_score(contract)
    iv_score = _iv_score(contract)
    oi_score = _oi_score(contract)
    liquidity_score = _liquidity_score(contract)

    risk_per_unit = max(contract.ltp * 0.08, abs(contract.theta) * 2, 0.05)
    stop = max(contract.ltp - risk_per_unit, 0.05)
    target = contract.ltp + risk_per_unit * data.min_reward_risk
    reward_risk = (target - contract.ltp) / (contract.ltp - stop)
    risk_reward_score = _rr_score(reward_risk, data.min_reward_risk)
    if reward_risk + 1e-9 < data.min_reward_risk:
        return None
    max_units = int(data.account_risk // ((contract.ltp - stop) * contract.lot_size))
    quantity = max_units * contract.lot_size
    if quantity <= 0:
        return None
    spread_ratio = (contract.ask - contract.bid) / contract.ltp
    final_score = (
        directional_score * weights["directional"]
        + trend_score * weights["trend"]
        + delta_score * weights["delta"]
        + iv_score * weights["iv"]
        + oi_score * weights["oi"]
        + liquidity_score * weights["liquidity"]
        + risk_reward_score * weights["risk_reward"]
    )
    spread_percent = _spread_percent(contract)
    expected_move_points = max(10.0, abs(data.spot * 0.0065), abs(ema9 - ema20) * 1.8)
    breakeven = contract.strike + contract.ltp if contract.option_type == "CE" else contract.strike - contract.ltp
    required_move = abs(breakeven - data.spot)
    expected_range = {
        "lower": round(data.spot - expected_move_points, 2),
        "upper": round(data.spot + expected_move_points, 2),
    }
    breakeven_feasibility = "FAVORABLE" if required_move <= expected_move_points else "PENALIZED"
    target_feasibility = "FAVORABLE" if reward_risk >= data.min_reward_risk and spread_percent <= 2.0 else "NEEDS_REVIEW"

    no_trade_reasons: list[str] = []
    if abs(contract.delta) < delta_cfg.get("absolute_min", 0.2):
        no_trade_reasons.append("delta outside preferred directional range")
    if contract.open_interest < liquidity_cfg.get("minimum_oi", 10000):
        no_trade_reasons.append("open interest too low")
    if contract.volume < liquidity_cfg.get("minimum_volume", 5000):
        no_trade_reasons.append("volume too low")
    if spread_percent > liquidity_cfg.get("maximum_spread_percent", 2.0):
        no_trade_reasons.append("spread exceeds liquidity threshold")
    if required_move > expected_move_points * (1.0 / max(config["feasibility"].get("minimum_expected_move_ratio", 0.8), 1e-9)):
        no_trade_reasons.append("required move exceeds expected move feasibility threshold")
    if reward_risk < risk_cfg.get("minimum_rr", 1.5):
        no_trade_reasons.append("risk/reward below minimum threshold")
    if no_trade_reasons:
        return None

    warnings: list[str] = []
    if spread_percent > liquidity_cfg.get("maximum_spread_percent", 2.0):
        warnings.append("Bid/ask spread exceeds the preferred liquidity threshold")
    if required_move > expected_move_points:
        warnings.append("Required breakeven move exceeds the current expected move estimate")
    if direction == "NEUTRAL":
        warnings.append("Directional structure is mixed; the setup is reduced or may be postponed")
    warnings.append("Model output is estimate-based and not a guarantee of profit")

    confidence = _confidence_score(final_score, required_move, expected_move_points, spread_percent, reward_risk)
    score_breakdown = {
        "directional": round(directional_score * weights["directional"], 2),
        "trend": round(trend_score * weights["trend"], 2),
        "delta": round(delta_score * weights["delta"], 2),
        "iv": round(iv_score * weights["iv"], 2),
        "oi": round(oi_score * weights["oi"], 2),
        "liquidity": round(liquidity_score * weights["liquidity"], 2),
        "risk_reward": round(risk_reward_score * weights["risk_reward"], 2),
    }
    return {
        "id": f"{contract.symbol}-{contract.expiry}-{contract.strike:g}-{contract.option_type}",
        "symbol": contract.trading_symbol or f"{contract.symbol}{contract.strike:g}{contract.option_type}",
        "contract": "CALL" if contract.option_type == "CE" else "PUT",
        "expiry": contract.expiry,
        "strike": contract.strike,
        "premium": contract.ltp,
        "bid": contract.bid,
        "ask": contract.ask,
        "spread": round(contract.ask - contract.bid, 4),
        "openInterest": contract.open_interest,
        "oiChange": contract.oi_change,
        "volume": contract.volume,
        "iv": contract.iv,
        "delta": contract.delta,
        "theta": contract.theta,
        "lotSize": contract.lot_size,
        "score": round(final_score, 2),
        "entry": contract.ask,
        "stop": round(stop, 2),
        "target": round(target, 2),
        "riskReward": round(reward_risk, 2),
        "quantity": quantity,
        "support": round(support, 2),
        "resistance": round(resistance, 2),
        "confirmation": regime,
        "direction": direction,
        "directional_score": round(directional_score, 2),
        "trend_score": round(trend_score, 2),
        "delta_score": round(delta_score, 2),
        "iv_score": round(iv_score, 2),
        "oi_score": round(oi_score, 2),
        "liquidity_score": round(liquidity_score, 2),
        "risk_reward_score": round(risk_reward_score, 2),
        "final_score": round(final_score, 2),
        "confidence": round(confidence, 2),
        "decision": "CONFIRMED",
        "ema9": round(ema9, 2),
        "ema20": round(ema20, 2),
        "feasibility": {
            "expected_move_points": round(expected_move_points, 2),
            "required_move": round(required_move, 2),
            "breakeven": round(breakeven, 2),
            "expected_range": expected_range,
            "breakeven_feasibility": breakeven_feasibility,
            "target_feasibility": target_feasibility,
        },
        "pipeline": {
            "direction": direction,
            "directional_score": round(directional_score, 2),
            "trend_score": round(trend_score, 2),
            "delta_score": round(delta_score, 2),
            "iv_score": round(iv_score, 2),
            "oi_score": round(oi_score, 2),
            "liquidity_score": round(liquidity_score, 2),
            "risk_reward_score": round(risk_reward_score, 2),
            "final_score": round(final_score, 2),
            "weights": weights,
            "score_breakdown": score_breakdown,
            "data_quality": "HIGH" if spread_percent <= 2.0 else "MEDIUM",
            "warnings": warnings,
        },
        "warnings": warnings,
        "reason": "; ".join(direction_reasons + trend_reasons + [f"{regime.replace('_', ' ').lower()} with liquid {contract.option_type} chain; real bid/ask, OI, IV, Greeks and R:R passed."]),
    }


def rank_options(data: EngineInput, today: date | None = None) -> list[dict]:
    context = _market_context(data.candles)
    if context is None or data.spot <= 0 or data.symbol not in {"NIFTY", "BANKNIFTY", "SENSEX"}:
        return []
    evaluated = [_candidate(contract, context, data, today or date.today()) for contract in data.contracts if contract.symbol == data.symbol and abs(contract.strike - data.spot) <= data.spot * 0.03]
    return sorted((item for item in evaluated if item is not None), key=lambda item: item["score"], reverse=True)


def evaluate_payload(payload: dict) -> dict:
    contracts = [OptionContract(**item) for item in payload.get("contracts", [])]
    candles = [Candle(**item) for item in payload.get("candles", [])]
    config = payload.get("config") or DEFAULT_CONFIG
    data = EngineInput(
        symbol=payload["symbol"],
        spot=float(payload["spot"]),
        contracts=contracts,
        candles=candles,
        account_risk=float(payload.get("accountRisk", 1000)),
        min_reward_risk=float(payload.get("minRewardRisk", 2.0)),
        config=config,
    )
    return {"symbol": data.symbol, "spot": data.spot, "candidates": rank_options(data)}


def main() -> None:
    import json
    import sys

    print(json.dumps(evaluate_payload(json.load(sys.stdin))))


if __name__ == "__main__":
    main()
