"""Explainable, paper-trading signal engine for Indian index options.

This module is deliberately broker-agnostic. It converts a validated index
price series and option-chain snapshot into a call or an explicit no-trade
decision. It does not place orders and cannot guarantee profitable outcomes.
"""

from dataclasses import dataclass
from math import isfinite
from typing import Literal


Direction = Literal["BUY_CALL", "BUY_PUT", "NO_TRADE"]


@dataclass(frozen=True)
class Candle:
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass(frozen=True)
class OptionSnapshot:
    symbol: Literal["NIFTY", "BANKNIFTY", "SENSEX"]
    spot: float
    strike: float
    option_type: Literal["CE", "PE"]
    ltp: float
    call_oi: float
    put_oi: float
    call_support: float
    put_support: float
    iv: float
    timestamp_age_seconds: float = 0.0
    quality: Literal["FRESH", "DELAYED", "STALE"] = "FRESH"


@dataclass(frozen=True)
class SignalEngineInput:
    candles: list[Candle]
    option: OptionSnapshot
    account_risk: float = 1_000.0
    max_data_age_seconds: float = 90.0
    min_reward_risk: float = 1.8


@dataclass(frozen=True)
class SignalCall:
    direction: Direction
    symbol: str
    option_type: Literal["CE", "PE"] | None
    entry: float | None
    stop_loss: float | None
    targets: tuple[float, ...]
    support: float | None
    resistance: float | None
    score: int
    confidence: int
    reward_risk: float | None
    rationale: tuple[str, ...]
    smart_money: tuple[str, ...]
    blocked_by: tuple[str, ...]


def _ema(values: list[float], period: int) -> float:
    multiplier = 2 / (period + 1)
    result = values[0]
    for value in values[1:]:
        result = (value - result) * multiplier + result
    return result


def _atr(candles: list[Candle], period: int = 14) -> float:
    ranges = [max(candle.high - candle.low, 0.0) for candle in candles[-period:]]
    return sum(ranges) / len(ranges)


def _vwap(candles: list[Candle]) -> float:
    volume = sum(candle.volume for candle in candles)
    return sum(candle.close * candle.volume for candle in candles) / volume if volume else 0.0


def _valid_input(data: SignalEngineInput) -> list[str]:
    blocked: list[str] = []
    if len(data.candles) < 20:
        blocked.append("insufficient candle history")
    if data.option.quality == "STALE" or data.option.timestamp_age_seconds > data.max_data_age_seconds:
        blocked.append("stale market data")
    if data.option.ltp <= 0 or data.option.spot <= 0:
        blocked.append("invalid option or spot price")
    for candle in data.candles:
        if not all(isfinite(value) for value in (candle.open, candle.high, candle.low, candle.close, candle.volume)):
            blocked.append("invalid candle values")
            break
        if candle.high < candle.low or candle.volume < 0:
            blocked.append("invalid candle range")
            break
    return blocked


def generate_signal(data: SignalEngineInput) -> SignalCall:
    """Generate an explainable options call; never emits an order instruction."""

    option = data.option
    blocked = _valid_input(data)
    if blocked:
        return SignalCall("NO_TRADE", option.symbol, None, None, None, (), None, None, 0, 0, None, (), (), tuple(blocked))

    candles = data.candles
    closes = [candle.close for candle in candles]
    latest = candles[-1]
    previous = candles[-2]
    atr = _atr(candles)
    vwap = _vwap(candles)
    fast_ema = _ema(closes, 9)
    slow_ema = _ema(closes, 20)
    pcr = option.put_oi / option.call_oi if option.call_oi else 0.0
    average_volume = sum(candle.volume for candle in candles[-20:]) / 20
    volume_expansion = latest.volume >= average_volume * 1.2
    bullish_structure = latest.high > previous.high and latest.low > previous.low
    bearish_structure = latest.high < previous.high and latest.low < previous.low

    bullish_points = sum((fast_ema > slow_ema, latest.close > vwap, 0.8 <= pcr <= 1.5, volume_expansion, bullish_structure))
    bearish_points = sum((fast_ema < slow_ema, latest.close < vwap, 0.5 <= pcr <= 1.1, volume_expansion, bearish_structure))
    smart_money: list[str] = []
    rationale: list[str] = []
    if volume_expansion:
        smart_money.append("volume expansion confirms participation")
    if bullish_structure:
        smart_money.append("higher-high and higher-low structure")
    if bearish_structure:
        smart_money.append("lower-high and lower-low structure")
    if option.put_oi > option.call_oi:
        smart_money.append("put open interest exceeds call open interest")
    elif option.call_oi > option.put_oi:
        smart_money.append("call open interest exceeds put open interest")

    if bullish_points >= 4 and bullish_points > bearish_points:
        direction: Direction = "BUY_CALL"
        option_type: Literal["CE", "PE"] = "CE"
        support = max(option.put_support, vwap)
        resistance = latest.close + 2 * atr
        entry = option.ltp
        stop_loss = max(entry - max(atr * 0.5, entry * 0.08), 0.05)
        target_one = entry + (entry - stop_loss) * 1.8
        target_two = entry + (entry - stop_loss) * 2.5
        rationale.extend(["bullish EMA alignment", "spot above VWAP", f"PCR {pcr:.2f} supports bullish bias"])
        score = bullish_points
    elif bearish_points >= 4 and bearish_points > bullish_points:
        direction = "BUY_PUT"
        option_type = "PE"
        support = latest.close - 2 * atr
        resistance = min(option.call_support, vwap)
        entry = option.ltp
        stop_loss = max(entry - max(atr * 0.5, entry * 0.08), 0.05)
        target_one = entry + (entry - stop_loss) * 1.8
        target_two = entry + (entry - stop_loss) * 2.5
        rationale.extend(["bearish EMA alignment", "spot below VWAP", f"PCR {pcr:.2f} supports bearish bias"])
        score = bearish_points
    else:
        return SignalCall("NO_TRADE", option.symbol, None, None, None, (), min(option.put_support, option.call_support), max(option.put_support, option.call_support), max(bullish_points, bearish_points), 0, None, ("trend, VWAP, volume, and structure are not aligned",), tuple(smart_money), ())

    risk = entry - stop_loss
    reward_risk = (target_one - entry) / risk if risk > 0 else 0.0
    if reward_risk < data.min_reward_risk:
        return SignalCall("NO_TRADE", option.symbol, None, None, None, (), support, resistance, score, 0, reward_risk, ("reward-to-risk below configured minimum",), tuple(smart_money), ("weak reward-to-risk",))
    confidence = min(95, 55 + score * 8 + (5 if volume_expansion else 0))
    rationale.append(f"ATR-based risk with {reward_risk:.1f}:1 reward-to-risk")
    return SignalCall(direction, option.symbol, option_type, entry, stop_loss, (round(target_one, 2), round(target_two, 2)), support, resistance, score, confidence, reward_risk, tuple(rationale), tuple(smart_money), ())