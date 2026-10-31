"""VWAP-EMA option scalper (index options, 1-minute tape).

The rule set an intraday index-option scalper runs, every rule a hard criterion (10 points, all 10
needed). CE for a long, PE for a short; the PE side is the exact mirror.

  VWAP (2)            the close is on the trade side of the session VWAP (futures-volume weighted),
                      VWAP slopes the same way over the last 5 bars, and price is not stretched more
                      than 1.5 ATR from VWAP (no chasing).
  5/9 EMA (2)         5 EMA beyond 9 EMA, both beyond VWAP (trend stack), then a pullback that tags
                      the 9 EMA and a candle that closes back beyond the 5 EMA and the prior candle's
                      extreme on above-average futures volume (momentum resumes).
  Delta (1)           the selected strike's |delta| is 0.40-0.60: it moves with the index, it is not
                      a far-OTM lottery ticket or a deep-ITM proxy for the future.
  OI (2)              option writers lean the trade's way (5-minute OI flow score >= 1), there is no
                      fresh writing against it at the ATM strike, and the opposing OI wall is far
                      enough for the target.
  PCR (1)             the OI put-call ratio supports the side and is not moving against it; extremes
                      (above 1.6 / below 0.5) read as stretched.
  Volume profile (1)  on the selected premium's own 1-minute candles: price accepted above its point
                      of control, at or above the value-area high or on a volume burst.
  India VIX (1)       a normal regime (10-24): below 10 premiums barely move, EXTREME whipsaws.

The strike is auto-selected from the OI data: delta 0.35-0.65 on the trade side, ranked by open
interest, volume and the option's own build-up (long build-up and short covering up, fresh writing
down).

Risk-reward is set in index points from structure (stop beyond the pullback low or the 9 EMA, plus a
buffer; R = entry - stop) and mapped onto the premium with the strike's delta and gamma:

  premium change for an index move x   ~ |delta| * x + 1/2 * gamma * x^2,
  premium stop    = P - (|delta| * R  - 1/2 * gamma * R^2  + theta drag)
  premium target  = P + (|delta| * kR + 1/2 * gamma * (kR)^2 - theta drag),   k = 1 (1:1) or 2 (1:2)

so gamma's convexity is in the trader's favour (the loss is a little smaller than delta alone says
and the gain a little larger). Theta drag is the decay over the expected hold. A trade whose
round-trip charges take more than a quarter of the reward is refused.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Protocol

from . import premium_math
from .option_selection import liquidity_score, years_to_expiry

STRATEGY_ID = "VWAP_EMA_SCALP"
STRATEGY_NAME = "VWAP-EMA Scalper"
RR_CHOICES = {"1:1": 1.0, "1:2": 2.0}
DEFAULT_RR = "1:2"
FALLBACK_LOT = {"NIFTY": 65, "BANKNIFTY": 30, "SENSEX": 20}
IST = timezone(timedelta(hours=5, minutes=30), name="Asia/Kolkata")
TRADING_MINUTES_PER_DAY = 375.0

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
class ScalpConfig:
    ema_fast: int = 5
    ema_slow: int = 9
    atr_period: int = 14
    min_session_bars: int = 15
    vwap_slope_bars: int = 5
    max_vwap_extension_atr: float = 1.5
    pullback_bars: int = 3
    ema_touch_tolerance_atr: float = 0.05
    min_volume_ratio: float = 1.2  # trigger-candle futures volume vs the prior 20 candles
    volume_lookback: int = 20
    trigger_max_age_bars: int = 1  # the trigger is the latest completed candle, or the one before
    max_drift_atr: float = 0.5  # how far price may have run past a one-candle-old trigger
    select_delta_min: float = 0.35
    select_delta_max: float = 0.65
    delta_min: float = 0.40
    delta_max: float = 0.60
    min_premium: float = 20.0
    max_spread_pct: float = 0.03
    pcr_bull_min: float = 0.80
    pcr_bear_max: float = 1.20
    pcr_stretched_high: float = 1.60
    pcr_stretched_low: float = 0.50
    vix_min: float = 10.0
    vix_max: float = 24.0
    vix_regimes: tuple[str, ...] = ("LOW", "NORMAL", "HIGH")
    profile_bins: int = 24
    value_area: float = 0.70
    profile_min_bars: int = 10
    profile_volume_burst: float = 1.5
    stop_buffer_atr: float = 0.15
    min_risk_atr: float = 0.30  # a stop tighter than this is inside 1-minute noise; widen it
    max_risk_atr: float = 1.50  # a stop wider than this is not a scalp
    hold_minutes: float = 10.0
    max_cost_share: float = 0.25
    # Adverse slippage per side beyond the spread. The route passes the Smart Scalper's own fill
    # slippage (SCALPER_SLIPPAGE_PCT, 0.3% by default) so the plan and the fills use the same number.
    # Groww's chain has no live bid/ask (the route estimates the spread from IV), so it is capped.
    slippage_pct: float = 0.003
    max_half_spread_pct: float = 0.005
    # Stressed risk: a stop can fill through its price between checks. Allow the larger of 2 ticks
    # and 10% of the premium risk on top of the adverse entry and exit slippage.
    stop_gap_risk_share: float = 0.10
    stop_gap_min_ticks: int = 2
    # The live fill may sit at most this share of the premium risk (or 2 ticks) above the planned
    # entry; beyond that the plan is stale and the trade is refused.
    fill_tolerance_risk_share: float = 0.20
    rr_tolerance: float = 0.03  # tick rounding may shave up to 3% off the chosen ratio
    tick: float = 0.05
    max_loss_per_trade: float = 1500.0
    max_lots: int = 1
    minimum_score: float = 10.0
    maximum_score: float = 10.0
    criteria_max: dict[str, int] = field(default_factory=lambda: {"vwap": 2, "ema": 2, "delta": 1, "oi": 2, "pcr": 1, "volume_profile": 1, "vix": 1})


def rr_ratio(choice: object) -> tuple[str, float]:
    text = str(choice or "").replace(" ", "")
    if text in ("1", "1.0"):
        text = "1:1"
    if text in ("2", "2.0"):
        text = "1:2"
    return (text, RR_CHOICES[text]) if text in RR_CHOICES else (DEFAULT_RR, RR_CHOICES[DEFAULT_RR])


# ---------------------------------------------------------------- helpers

def _parse(value: str) -> datetime | None:
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


def _tick_round(value: float, tick: float, how: str = "near") -> float:
    steps = value / tick
    steps = math.floor(steps + 1e-9) if how == "down" else math.ceil(steps - 1e-9) if how == "up" else round(steps)
    return round(steps * tick, 2)


def session_of(candles: list[CandleLike]) -> list[CandleLike]:
    dated = [(stamp, candle) for candle in candles if (stamp := _parse(candle.timestamp)) is not None]
    if not dated:
        return []
    day = dated[-1][0].date()
    return [candle for stamp, candle in dated if stamp.date() == day]


def ema_series(values: list[float], period: int) -> list[float]:
    out: list[float] = []
    k = 2.0 / (period + 1.0)
    for index, value in enumerate(values):
        out.append(value if index == 0 else (value - out[-1]) * k + out[-1])
    return out


def atr_value(candles: list[CandleLike], period: int) -> float | None:
    if len(candles) < 2:
        return None
    ranges = [candles[0].high - candles[0].low] + [
        max(c.high - c.low, abs(c.high - candles[i - 1].close), abs(c.low - candles[i - 1].close)) for i, c in enumerate(candles) if i > 0
    ]
    if len(ranges) < period:
        return sum(ranges) / len(ranges)
    value = sum(ranges[:period]) / period
    for item in ranges[period:]:
        value = (value * (period - 1) + item) / period
    return value


def vwap_series(session: list[CandleLike]) -> tuple[list[float], bool]:
    """Cumulative session VWAP. Index candles carry futures volume; without any volume this is a
    plain time-weighted average and the caller treats VWAP as unobservable."""
    observable = any(c.volume > 0 for c in session)
    out: list[float] = []
    pv = vol = 0.0
    for candle in session:
        weight = candle.volume if observable else 1.0
        pv += (candle.high + candle.low + candle.close) / 3.0 * weight
        vol += weight
        out.append(pv / vol if vol > 0 else candle.close)
    return out, observable


def volume_profile(candles: list[CandleLike], bins: int = 24, value_area: float = 0.70) -> dict | None:
    """Volume at price: each candle's volume spread evenly over the price bins its range covers.
    POC is the busiest bin; the value area grows from the POC to hold ``value_area`` of the volume."""
    rows = [c for c in candles if c.volume > 0 and c.high >= c.low > 0]
    if not rows:
        return None
    low, high = min(c.low for c in rows), max(c.high for c in rows)
    if high <= low:
        return {"poc": round(low, 2), "vah": round(high, 2), "val": round(low, 2), "total_volume": sum(c.volume for c in rows), "bins": []}
    width = (high - low) / bins
    volume = [0.0] * bins
    for candle in rows:
        first = min(bins - 1, int((candle.low - low) / width))
        last = min(bins - 1, int((candle.high - low) / width))
        share = candle.volume / (last - first + 1)
        for index in range(first, last + 1):
            volume[index] += share
    poc = max(range(bins), key=lambda i: volume[i])
    total = sum(volume)
    lo = hi = poc
    held = volume[poc]
    while held < total * value_area and (lo > 0 or hi < bins - 1):
        below = volume[lo - 1] if lo > 0 else -1.0
        above = volume[hi + 1] if hi < bins - 1 else -1.0
        if above >= below:
            hi += 1
            held += above
        else:
            lo -= 1
            held += below
    centre = lambda i: low + (i + 0.5) * width  # noqa: E731
    return {
        "poc": round(centre(poc), 2), "vah": round(low + (hi + 1) * width, 2), "val": round(low + lo * width, 2),
        "total_volume": round(total), "bins": [{"price": round(centre(i), 2), "volume": round(volume[i])} for i in range(bins)],
    }


def _criterion(key: str, name: str, points: int, maximum: int, detail: str) -> dict:
    return {"key": key, "name": name, "points": points, "max": maximum, "passed": points >= maximum, "detail": detail}


# ---------------------------------------------------------------- the reads

def read_tape(candles: list[CandleLike], config: ScalpConfig) -> dict:
    """VWAP, EMA stack, pullback-and-resume trigger and the structural stop on the 1m index tape."""
    session = session_of(candles)
    out: dict = {"session_bars": len(session), "side": None}
    if len(session) < config.min_session_bars:
        out["reason"] = f"Need {config.min_session_bars} one-minute candles today (have {len(session)})"
        return out
    closes = [c.close for c in candles]
    ema5 = ema_series(closes, config.ema_fast)[-len(session):]
    ema9 = ema_series(closes, config.ema_slow)[-len(session):]
    atr = atr_value(candles[-(config.atr_period * 3):], config.atr_period) or 0.0
    vwap, vwap_observable = vwap_series(session)
    last = session[-1]
    out.update(close=last.close, vwap=vwap[-1], ema5=ema5[-1], ema9=ema9[-1], atr=atr, vwap_observable=vwap_observable,
               vwap_slope=vwap[-1] - vwap[-1 - config.vwap_slope_bars] if len(vwap) > config.vwap_slope_bars else 0.0)
    if last.close > vwap[-1] and ema5[-1] > ema9[-1]:
        side = "CE"
    elif last.close < vwap[-1] and ema5[-1] < ema9[-1]:
        side = "PE"
    else:
        side = "CE" if last.close > vwap[-1] else "PE" if last.close < vwap[-1] else None
        out["lean_only"] = True
    out["side"] = side
    if side is None:
        out["reason"] = "Price is on VWAP: no side"
        return out
    d = 1 if side == "CE" else -1
    out["direction"] = d

    # VWAP criterion
    on_side = (last.close - vwap[-1]) * d > 0
    sloping = out["vwap_slope"] * d > 0
    extension = abs(last.close - vwap[-1]) / atr if atr > 0 else 0.0
    out.update(vwap_on_side=on_side, vwap_sloping=sloping, vwap_extension_atr=round(extension, 2), vwap_extended=extension > config.max_vwap_extension_atr)

    # EMA stack + trigger
    stacked = (ema5[-1] - ema9[-1]) * d > 0 and (ema9[-1] - vwap[-1]) * d > 0
    out["ema_stacked"] = stacked
    tolerance = atr * config.ema_touch_tolerance_atr
    trigger = None
    for age in range(0, config.trigger_max_age_bars + 1):
        i = len(session) - 1 - age
        if i < config.pullback_bars + 1:
            break
        bar, prev = session[i], session[i - 1]
        resumes = (bar.close - ema5[i]) * d > 0 and (bar.close - (prev.high if d > 0 else prev.low)) * d > 0 and (bar.close - bar.open) * d > 0
        window = range(i - config.pullback_bars, i + 1)
        touched = any(((session[j].low if d > 0 else session[j].high) - ema9[j]) * d <= tolerance for j in window)
        if resumes and touched:
            trigger = {"index": i, "age": age, "time": session[i].timestamp, "close": bar.close, "pullback_extreme": min(session[j].low for j in window) if d > 0 else max(session[j].high for j in window)}
            break
    if trigger and trigger["age"] > 0:
        drift = (last.close - trigger["close"]) * d
        if drift > config.max_drift_atr * atr or (last.close - ema5[-1]) * d <= 0:
            out["trigger_stale"] = f"trigger one candle ago and price has since run {drift:.1f} pts (max {config.max_drift_atr} ATR) or lost the 5 EMA"
            trigger = None
    volume_ratio = None
    if trigger is not None:
        i = trigger["index"]
        prior = [c.volume for c in session[max(0, i - config.volume_lookback):i] if c.volume > 0]
        if session[i].volume > 0 and len(prior) >= 5:
            volume_ratio = session[i].volume / (sum(prior) / len(prior))
    out.update(trigger=trigger, volume_ratio=_r(volume_ratio))

    # Structural stop in index points
    if trigger is not None:
        buffer = atr * config.stop_buffer_atr
        level = min(trigger["pullback_extreme"], ema9[-1]) if d > 0 else max(trigger["pullback_extreme"], ema9[-1])
        stop = level - buffer * d
        risk = (last.close - stop) * d
        floor = config.min_risk_atr * atr
        if 0 < risk < floor:
            stop, risk = last.close - floor * d, floor
        out.update(spot_stop=stop, risk_points=risk)
    return out


def select_strikes(chain: list[dict], flow: dict | None, spot: float, side: str, config: ScalpConfig) -> list[dict]:
    """Rank the trade side's strikes by OI, volume and the option's own build-up."""
    wanted = "CALL" if side == "CE" else "PUT"
    rows = {float(r.get("strike") or 0): r for r in (flow or {}).get("strikes") or []}
    key = side.lower()
    pool = []
    for row in chain:
        if str(row.get("contract", "")).upper() != wanted:
            continue
        premium = _num(row.get("premium")) or 0.0
        delta = abs(_num(row.get("delta")) or 0.0)
        if premium < config.min_premium or not (config.select_delta_min <= delta <= config.select_delta_max):
            continue
        bid, ask = _num(row.get("bid")) or 0.0, _num(row.get("ask")) or 0.0
        spread = (ask - bid) / premium if ask > bid > 0 and premium > 0 else None
        flow_row = rows.get(float(row.get("strike") or 0), {})
        activity = flow_row.get(f"{key}_activity")
        pool.append({"row": row, "premium": premium, "delta": delta, "spread_pct": spread, "activity": activity,
                     "oi": _num(row.get("openInterest")) or 0.0, "volume": _num(row.get("volume")) or 0.0,
                     "oi_change": flow_row.get(f"{key}_oi_change")})
    if not pool:
        return []
    by_oi = sorted(pool, key=lambda item: item["oi"])
    by_volume = sorted(pool, key=lambda item: item["volume"])
    candidates = []
    for item in pool:
        rank = (by_oi.index(item) + by_volume.index(item)) / max(2 * (len(pool) - 1), 1) * 4.0
        build = 2.0 if item["activity"] in ("LONG_BUILDUP", "SHORT_COVERING") else -2.0 if item["activity"] == "SHORT_BUILDUP" else 0.0
        closeness = 2.0 * (1.0 - min(abs(item["delta"] - 0.5) / 0.15, 1.0))
        spread_ok = item["spread_pct"] is None or item["spread_pct"] <= config.max_spread_pct
        row = item["row"]
        candidates.append({
            "symbol": row.get("symbol"), "strike": float(row.get("strike") or 0), "type": side, "expiry": row.get("expiry") or None,
            "premium": item["premium"], "bid": _num(row.get("bid")), "ask": _num(row.get("ask")), "delta": round(item["delta"], 3),
            "iv": _num(row.get("iv")), "theta": _num(row.get("theta")), "open_interest": item["oi"], "volume": item["volume"],
            "oi_change_5m": item["oi_change"], "activity": item["activity"], "spread_pct": _r(item["spread_pct"] * 100 if item["spread_pct"] is not None else None),
            "lot_size": _num(row.get("lotSize")), "tick_size": _num(row.get("tickSize")), "freeze_quantity": _num(row.get("freezeQuantity")),
            "liquidity_score": liquidity_score(row) if spread_ok else min(liquidity_score(row), 1),
            "selection_score": round(rank + build + closeness - (0 if spread_ok else 3), 2),
        })
    return sorted(candidates, key=lambda item: item["selection_score"], reverse=True)


def read_oi(flow: dict | None, side: str, spot: float, target_points: float | None) -> tuple[int, str, dict]:
    if not flow or not flow.get("available", True) or not flow.get("strikes"):
        return 0, "Option-chain OI flow unavailable", {}
    d = 1 if side == "CE" else -1
    score = _num(flow.get("oi_direction_score"))
    points = 0
    parts = []
    if score is not None and score * d >= 1:
        points += 1
        parts.append(f"writers lean {'bullish' if d > 0 else 'bearish'} (5m OI score {score:+.0f})")
    else:
        parts.append(f"5m OI score {('%+.0f' % score) if score is not None else 'n/a'} (needs {'+1 or more' if d > 0 else '-1 or less'})")
    rows = flow.get("strikes") or []
    atm = next((r for r in rows if r.get("is_atm")), None) or (min(rows, key=lambda r: abs(float(r.get("strike") or 0) - spot)) if rows else None)
    favourable = BULLISH_FLOW if d > 0 else BEARISH_FLOW
    against = BEARISH_FLOW if d > 0 else BULLISH_FLOW
    acts = {("CE", (atm or {}).get("ce_activity")), ("PE", (atm or {}).get("pe_activity"))}
    good = bool(acts & favourable)
    bad_writing = ("CE", "SHORT_BUILDUP") in acts if d > 0 else ("PE", "SHORT_BUILDUP") in acts
    # the opposing wall: biggest call OI above spot (long) / put OI below spot (short)
    wall_key = "ce_oi" if d > 0 else "pe_oi"
    beyond = [r for r in rows if (float(r.get("strike") or 0) - spot) * d > 0 and _num(r.get(wall_key))]
    wall = max(beyond, key=lambda r: _num(r.get(wall_key)) or 0) if beyond else None
    room = abs(float(wall["strike"]) - spot) if wall else None
    room_ok = room is None or target_points is None or room >= target_points
    detail = {"atm_strike": (atm or {}).get("strike"), "atm_activity": {"CE": (atm or {}).get("ce_activity"), "PE": (atm or {}).get("pe_activity")},
              "wall": float(wall["strike"]) if wall else None, "wall_oi": _num(wall.get(wall_key)) if wall else None, "room_points": _r(room), "oi_direction_score": score}
    if good and not bad_writing and room_ok:
        points += 1
        parts.append(f"ATM {(atm or {}).get('strike')}: " + ", ".join(f"{s} {a.lower().replace('_', ' ')}" for s, a in sorted(acts, key=str) if a and (s, a) in favourable)
                     + (f"; {'call' if d > 0 else 'put'} wall {wall['strike']:.0f} is {room:.0f} pts away" if wall else ""))
    else:
        if bad_writing:
            parts.append(f"fresh {'call' if d > 0 else 'put'} writing at ATM {(atm or {}).get('strike')} (against the trade)")
        elif not good:
            parts.append(f"no supportive build-up at ATM {(atm or {}).get('strike')}")
        if not room_ok:
            parts.append(f"{'call' if d > 0 else 'put'} wall {wall['strike']:.0f} only {room:.0f} pts away, target needs {target_points:.0f}")
    return points, "; ".join(parts), detail


PCR_ZONES = {
    "STRETCHED_LOW": "stretched low: call writers crowded, reversal risk (no trades)",
    "BEARISH": "bearish: call writing dominates (shorts only)",
    "NEUTRAL": "balanced (either side; the 5-minute PCR change decides)",
    "BULLISH": "bullish: put writing supports (longs only)",
    "STRETCHED_HIGH": "stretched high: put writers crowded, reversal risk (no trades)",
}


def pcr_zone(pcr: float, config: ScalpConfig) -> str:
    """The PCR zone, with explicit boundaries (defaults shown):

        STRETCHED_LOW   pcr <  0.50
        BEARISH         0.50 <= pcr <  0.80     shorts only
        NEUTRAL         0.80 <= pcr <= 1.20     longs or shorts, decided by the 5-minute PCR change
        BULLISH         1.20 <  pcr <= 1.60     longs only
        STRETCHED_HIGH  pcr >  1.60

    A long needs NEUTRAL or BULLISH and a PCR that is not falling (change >= 0); a short needs
    BEARISH or NEUTRAL and a PCR that is not rising (change <= 0). A missing change does not block.
    """
    if pcr < config.pcr_stretched_low:
        return "STRETCHED_LOW"
    if pcr < config.pcr_bull_min:
        return "BEARISH"
    if pcr <= config.pcr_bear_max:
        return "NEUTRAL"
    if pcr <= config.pcr_stretched_high:
        return "BULLISH"
    return "STRETCHED_HIGH"


def read_pcr(flow: dict | None, side: str, config: ScalpConfig) -> tuple[int, str, dict]:
    pcr = _num((flow or {}).get("pcr_oi"))
    change = _num((flow or {}).get("pcr_change_5m"))
    info = {"pcr": _r(pcr), "pcr_change_5m": _r(change, 3), "zone": None}
    if pcr is None:
        return 0, "PCR unavailable", info
    zone = pcr_zone(pcr, config)
    info["zone"] = zone
    trend = "" if change is None else f", {change:+.3f} in 5m"
    if zone.startswith("STRETCHED"):
        return 0, f"PCR {pcr:.2f}{trend}: {PCR_ZONES[zone]}", info
    if side == "CE":
        zone_ok, change_ok = zone in ("NEUTRAL", "BULLISH"), change is None or change >= 0
        need = "a long needs PCR 0.80-1.60 (neutral or bullish zone)" if not zone_ok else "a long needs a PCR that is not falling"
    else:
        zone_ok, change_ok = zone in ("BEARISH", "NEUTRAL"), change is None or change <= 0
        need = "a short needs PCR 0.50-1.20 (bearish or neutral zone)" if not zone_ok else "a short needs a PCR that is not rising"
    ok = zone_ok and change_ok
    return int(ok), f"PCR {pcr:.2f}{trend}, {PCR_ZONES[zone]}" + ("" if ok else f": {need}"), info


def read_vix(vix: dict | None, config: ScalpConfig) -> tuple[int, str, dict]:
    value = _num((vix or {}).get("value"))
    regime = (vix or {}).get("regime")
    if regime is None and value is not None:
        regime = "LOW" if value < 12 else "NORMAL" if value < 18 else "HIGH" if value < 25 else "EXTREME"
    info = {"value": _r(value), "regime": regime}
    if regime is None:
        return 0, "India VIX unavailable", info
    if regime not in config.vix_regimes:
        return 0, f"India VIX {regime.lower()}{f' {value:.1f}' if value is not None else ''}: whipsaw risk", info
    if value is not None and not (config.vix_min <= value <= config.vix_max):
        return 0, f"India VIX {value:.1f} outside {config.vix_min:.0f}-{config.vix_max:.0f}" + (": premiums barely move" if value < config.vix_min else ": whipsaw risk"), info
    return 1, f"India VIX {f'{value:.1f} ' if value is not None else ''}({regime.lower()})", info


def read_profile(premium_candles: list[CandleLike], config: ScalpConfig) -> tuple[int, str, dict | None]:
    session = session_of(premium_candles)
    if len(session) < config.profile_min_bars:
        return 0, f"Premium volume profile needs {config.profile_min_bars} one-minute candles (have {len(session)})", None
    profile = volume_profile(session, config.profile_bins, config.value_area)
    if profile is None:
        return 0, "Premium candles carry no volume", None
    last = session[-1]
    prior = [c.volume for c in session[-(config.volume_lookback + 1):-1] if c.volume > 0]
    burst = (last.volume / (sum(prior) / len(prior))) if prior and last.volume > 0 else None
    profile["volume_ratio"] = _r(burst)
    profile["close"] = last.close
    above_poc = last.close > profile["poc"]
    accepted = last.close >= profile["vah"] or (burst is not None and burst >= config.profile_volume_burst)
    if above_poc and accepted:
        how = "above the value-area high" if last.close >= profile["vah"] else f"on a {burst:.1f}x volume burst"
        return 1, f"Premium {last.close:.2f} accepted above POC {profile['poc']:.2f}, {how} (VAH {profile['vah']:.2f})", profile
    if not above_poc:
        return 0, f"Premium {last.close:.2f} is below its POC {profile['poc']:.2f}: no acceptance yet", profile
    return 0, f"Premium {last.close:.2f} above POC {profile['poc']:.2f} but inside value (VAH {profile['vah']:.2f}) without a volume burst", profile


def index_move_for(gain: float, delta: float, gamma: float) -> float:
    """Index points x that move the premium by ``gain``: solve |delta|·x + ½·gamma·x² = gain."""
    if gain <= 0:
        return 0.0
    if gamma <= 1e-12:
        return gain / max(delta, 1e-6)
    return (-delta + math.sqrt(delta * delta + 2.0 * gamma * gain)) / gamma


def premium_plan(selected: dict, spot: float, tape: dict, rr: float, symbol: str, now: datetime, config: ScalpConfig) -> dict:
    """The premium plan, with R measured from the EXPECTED FILL.

    The stop comes from the index structure: the premium where the index stop would leave it,
    mapped with delta and gamma from the market premium (|delta|·R − ½·gamma·R² + theta drag).
    The entry is what the scalper actually pays: the ask plus its adverse slippage. R is that fill
    minus the stop, and the target is fill + k·R, so 1:1 / 1:2 hold on the real fill. The index move
    the target needs is solved back through delta and gamma (it is a little more than k index R,
    because the fill pays the spread and slippage) and checked against the OI wall.
    """
    side = selected["type"]
    d = 1 if side == "CE" else -1
    risk_points = float(tape["risk_points"])
    market = float(selected["premium"])
    ask = selected["ask"] if selected.get("ask") and selected["ask"] > 0 else market
    delta = abs(float(selected["delta"]))
    years = years_to_expiry(selected.get("expiry"), now)
    sigma = (selected.get("iv") or 0) / 100.0
    if (sigma <= 0) and years:
        sigma = premium_math.implied_vol(market, spot, selected["strike"], years, side) or 0.0
    greeks = premium_math.bs_greeks(spot, selected["strike"], years, sigma, side) if years and sigma > 0 else None
    gamma = greeks["gamma"] if greeks else 0.0
    theta = selected.get("theta")
    theta_day = abs(float(theta)) if theta not in (None, 0) else abs(greeks["theta"]) if greeks else 0.0
    drag = theta_day * config.hold_minutes / TRADING_MINUTES_PER_DAY
    tick = selected.get("tick_size") or config.tick
    slip = config.slippage_pct
    entry = _tick_round(ask * (1.0 + slip), tick, "up")  # the expected fill
    loss = delta * risk_points - 0.5 * gamma * risk_points ** 2 + drag
    stop = _tick_round(market - loss, tick)
    risk_unit = entry - stop
    target = _tick_round(entry + rr * max(risk_unit, 0.0), tick, "up")
    gain_needed = target - market + drag  # premium the index move must add, from the market premium
    target_points = index_move_for(gain_needed, delta, gamma)
    lot = int(selected.get("lot_size") or FALLBACK_LOT.get(symbol, 1))
    half_spread = min(max(((selected.get("ask") or market) - (selected.get("bid") or market)) / 2.0, 0.0), market * config.max_half_spread_pct)
    # Fees, plus the exit half-spread (a sell fills at the bid; the entry's spread is already in the
    # ask-based fill). The entry slippage is in the fill; the exit slippage is modelled below.
    fees = premium_math.PremiumConfig(slippage_pct=0.0)
    fees_target = premium_math.round_trip_costs(entry, target, lot, 0.0, fees)["total"] + half_spread * lot
    fees_stop = premium_math.round_trip_costs(entry, max(stop, tick), lot, 0.0, fees)["total"] + half_spread * lot
    slip_target = slip * target * lot  # the exit sell fills below
    slip_stop = slip * max(stop, tick) * lot
    at_target = round(fees_target + slip_target, 2)
    at_stop = round(fees_stop + slip_stop, 2)
    reward_unit = target - entry
    stop_gap = max(config.stop_gap_min_ticks * tick, config.stop_gap_risk_share * max(risk_unit, 0.0))
    plan = {
        "spot_entry": round(spot, 2), "spot_stop": round(spot - risk_points * d, 2), "spot_target": round(spot + target_points * d, 2),
        "risk_points": round(risk_points, 2), "target_points": round(target_points, 2), "structural_target_points": round(risk_points * rr, 2), "rr_choice": rr,
        "market_premium": round(market, 2), "ask": round(ask, 2), "entry": entry, "stop_loss": stop, "target": target, "lot_size": lot,
        "greeks": {"delta": round(delta, 3), "gamma": round(gamma, 6), "theta_per_day": round(theta_day, 2), "iv": round(sigma * 100, 2) if sigma else None},
        "theta_drag": round(drag, 2),
        "premium_loss_delta_only": round(delta * risk_points, 2), "premium_gain_needed": round(gain_needed, 2),
        "gamma_effect": {"on_loss": round(-0.5 * gamma * risk_points ** 2, 2), "on_gain": round(0.5 * gamma * target_points ** 2, 2)},
        "spread_paid": round(ask - market, 2), "entry_slippage": round(entry - ask, 2),
        "costs_per_lot": {"at_target": at_target, "at_stop": at_stop, "fees_at_target": round(fees_target, 2), "fees_at_stop": round(fees_stop, 2),
                          "slippage_at_target": round(slip_target, 2), "slippage_at_stop": round(slip_stop, 2),
                          "entry_slippage": round((entry - ask) * lot, 2), "half_spread": round(half_spread, 2)},
        "slippage_pct": slip, "stop_gap": round(stop_gap, 2),
        "valid": True, "reason": "",
    }
    if risk_unit <= 0 or stop < tick or reward_unit <= 0:
        plan.update(valid=False, reason="Premium stop or target is not on the right side of the entry")
        return plan
    plan["risk_reward"] = round(reward_unit / risk_unit, 2)
    # Planned loss: from the actual (expected) fill to the stop, plus fees and the exit slippage.
    planned_lot = risk_unit * lot + at_stop
    # Stressed loss: the planned loss plus a stop filled through its price (stop gap).
    stressed_lot = planned_lot + stop_gap * lot
    plan["net_risk_reward"] = round((reward_unit * lot - at_target) / planned_lot, 2)
    plan["stressed_risk_reward"] = round((reward_unit * lot - at_target) / stressed_lot, 2)
    # Charges, the exit slippage AND what the fill paid above the market (spread + entry slippage).
    plan["cost_share"] = round((at_target + (entry - market) * lot) / ((target - market) * lot), 3) if target > market else 1.0
    # Size on the STRESSED loss, so a gap through the stop still fits the max loss per trade.
    lots = min(config.max_lots, int(config.max_loss_per_trade // stressed_lot)) if stressed_lot > 0 else 0
    tolerance = max(2 * tick, config.fill_tolerance_risk_share * risk_unit)
    worst_entry = _tick_round(entry + tolerance, tick, "down")
    # At the worst accepted fill the target is re-derived (fill + k·R); the OI wall may cap it
    # further once it is known (analyze_scalp).
    max_target = _tick_round(worst_entry + rr * (worst_entry - stop), tick, "up")
    plan.update(lots=lots, quantity=lots * lot, risk_per_lot=round(planned_lot, 2), stressed_risk_per_lot=round(stressed_lot, 2),
                reward_per_lot=round(reward_unit * lot - at_target, 2), planned_max_loss=round(planned_lot * lots, 2), max_loss=round(stressed_lot * lots, 2),
                fill_tolerance=round(tolerance, 2), max_entry=worst_entry, max_target=max_target,
                fees_at_stop_per_lot=round(fees_stop, 2))
    if plan["cost_share"] > config.max_cost_share:
        plan.update(valid=False, reason=f"Charges and slippage take {plan['cost_share'] * 100:.0f}% of the reward (max {config.max_cost_share * 100:.0f}%): too small a move to scalp")
    elif lots < 1:
        plan.update(valid=False, reason=f"One lot risks ₹{stressed_lot:.0f} stressed (₹{planned_lot:.0f} planned + stop gap), more than the ₹{config.max_loss_per_trade:.0f} max loss per trade")
    return plan


# ---------------------------------------------------------------- the strategy

def config_for(context: dict) -> ScalpConfig:
    base = ScalpConfig()
    loss = _num(context.get("max_loss_per_trade"))
    lots = _num(context.get("max_lots"))
    slip = _num(context.get("slippage_pct"))
    return ScalpConfig(
        max_loss_per_trade=loss if loss and loss > 0 else base.max_loss_per_trade,
        max_lots=max(1, int(lots)) if lots and lots >= 1 else base.max_lots,
        slippage_pct=slip if slip is not None and 0 <= slip < 0.05 else base.slippage_pct,
    )


def analyze_scalp(symbol: str, candles: list[CandleLike], context: dict, now: datetime, config: ScalpConfig | None = None) -> dict:
    config = config or config_for(context)
    rr_label, rr = rr_ratio(context.get("risk_reward"))
    base = {"symbol": symbol, "strategy": STRATEGY_ID, "confidence": 0, "setup": None}
    chain_wrap = context.get("option_chain") or {}
    chain = chain_wrap.get("contracts") or []
    flow = context.get("options_flow") or None
    # True VWAP needs one instrument's own price AND volume. The index has no traded volume, so the
    # tape (VWAP, EMAs, ATR, trigger, structural stop) is read on the near-month FUTURE's 1-minute
    # OHLCV. Points on the future and on the index move together intraday (the basis is near
    # constant), so the stop and target distances carry over; index levels = future levels − basis.
    futures = list(context.get("futures_candles") or [])
    tape_candles = futures if futures else candles
    tape = read_tape(tape_candles, config)
    tape["source"] = "FUTURES" if futures else "INDEX"
    calc: dict = {"rr_choice": rr_label, "tape": {k: (_r(v) if isinstance(v, float) else v) for k, v in tape.items() if k not in ("trigger",)},
                  "trigger": tape.get("trigger"), "criteria": [], "candidates": [], "selected": None, "plan": None, "profile": None}
    side = tape.get("side")
    if side is None:
        return {**base, "decision": "WAIT_FOR_CONFIRMATION", "reason": tape.get("reason", "No side"), "scalp": calc}
    d = 1 if side == "CE" else -1
    index_close = candles[-1].close if candles else None
    spot = float(chain_wrap.get("spot") or index_close or tape.get("close") or 0)
    if futures and spot > 0:
        calc["basis"] = round(float(tape["close"]) - spot, 2)
    maxes = config.criteria_max
    criteria = []

    # VWAP (on the future's own price and volume)
    vw_points = 0
    if tape["source"] != "FUTURES":
        vw_detail = "No near-month futures OHLCV: a true VWAP needs one instrument's own price and volume, so VWAP cannot confirm"
    elif not tape["vwap_observable"]:
        vw_detail = "The future's candles carry no volume: VWAP is unobservable, so it cannot confirm"
    else:
        vw_points = int(tape["vwap_on_side"] and not tape["vwap_extended"]) + int(tape["vwap_sloping"])
        vw_detail = (f"future {tape['close']:.2f} {'above' if d > 0 else 'below'} its VWAP {tape['vwap']:.2f}" if tape["vwap_on_side"] else f"future {tape['close']:.2f} on the wrong side of its VWAP {tape['vwap']:.2f}") \
            + (f", VWAP {'rising' if tape['vwap_slope'] > 0 else 'falling'} {abs(tape['vwap_slope']):.1f} pts in {config.vwap_slope_bars}m" if tape["vwap_sloping"] else f", VWAP flat/against ({tape['vwap_slope']:+.1f} pts)") \
            + (f"; stretched {tape['vwap_extension_atr']} ATR from VWAP (max {config.max_vwap_extension_atr}): don't chase" if tape["vwap_extended"] else "")
    criteria.append(_criterion("vwap", "VWAP", vw_points, maxes["vwap"], vw_detail))

    # EMA
    trigger = tape.get("trigger")
    volume_ok = tape.get("volume_ratio") is not None and tape["volume_ratio"] >= config.min_volume_ratio
    ema_points = int(bool(tape["ema_stacked"])) + int(trigger is not None and volume_ok)
    stack_text = f"5 EMA {tape['ema5']:.2f} {'>' if d > 0 else '<'} 9 EMA {tape['ema9']:.2f} {'>' if d > 0 else '<'} VWAP" if tape["ema_stacked"] else f"EMAs not stacked {'bullish' if d > 0 else 'bearish'} beyond VWAP (5 EMA {tape['ema5']:.2f}, 9 EMA {tape['ema9']:.2f})"
    if trigger is None:
        trig_text = tape.get("trigger_stale") or f"waiting for a pullback to the 9 EMA and a close back {'above' if d > 0 else 'below'} the 5 EMA and the prior candle"
    elif not volume_ok:
        trig_text = f"trigger at {trigger['time'][11:16]} but futures volume {tape.get('volume_ratio') or 'n/a'}x (needs {config.min_volume_ratio}x)"
    else:
        trig_text = f"pullback to the 9 EMA, resumed at {trigger['time'][11:16]} on {tape['volume_ratio']}x volume"
    criteria.append(_criterion("ema", "5/9 EMA", ema_points, maxes["ema"], f"{stack_text}; {trig_text}"))

    # Strike selection from OI
    candidates = select_strikes(chain, flow, spot, side, config) if spot > 0 else []
    calc["candidates"] = candidates[:4]
    selected = candidates[0] if candidates else None
    calc["selected"] = selected
    delta_ok = selected is not None and config.delta_min <= selected["delta"] <= config.delta_max
    criteria.append(_criterion("delta", "Delta", int(delta_ok), maxes["delta"],
                               f"{selected['symbol']} delta {selected['delta']:.2f}" + ("" if delta_ok else f" (needs {config.delta_min}-{config.delta_max})") if selected else f"No liquid {side} strike with delta {config.select_delta_min}-{config.select_delta_max} and premium ₹{config.min_premium:.0f}+"))

    plan = None
    if selected and tape.get("risk_points"):
        if tape["atr"] and tape["risk_points"] > config.max_risk_atr * tape["atr"]:
            plan = {"valid": False, "reason": f"Structural stop is {tape['risk_points'] / tape['atr']:.1f} ATR away (max {config.max_risk_atr}): not a scalp"}
        else:
            plan = premium_plan(selected, spot, tape, rr, symbol, now, config)
    calc["plan"] = plan

    # The OI wall must sit beyond the index move the premium target actually needs (solved back
    # through delta and gamma from the fill-based target), not just k x the index risk.
    target_points = (plan or {}).get("target_points") or (tape["risk_points"] * rr if tape.get("risk_points") else None)
    oi_points, oi_detail, oi_info = read_oi(flow, side, spot, target_points)
    calc["oi"] = oi_info
    if plan and plan.get("valid") and oi_info.get("room_points"):
        # The premium the option would show with the index AT the OI wall caps any re-derived target.
        g = plan["greeks"]
        room = float(oi_info["room_points"])
        wall_premium = plan["market_premium"] + g["delta"] * room + 0.5 * g["gamma"] * room * room - plan["theta_drag"]
        plan["wall_premium"] = round(wall_premium, 2)
        plan["max_target"] = min(plan["max_target"], _tick_round(wall_premium, selected.get("tick_size") or config.tick, "down"))
    criteria.append(_criterion("oi", "OI", oi_points, maxes["oi"], oi_detail))
    pcr_points, pcr_detail, pcr_info = read_pcr(flow, side, config)
    calc["pcr"] = pcr_info
    criteria.append(_criterion("pcr", "PCR", pcr_points, maxes["pcr"], pcr_detail))

    premium = context.get("premium_candles") or {}
    premium_rows = premium.get("candles") if selected and premium.get("symbol") == selected["symbol"] else None
    if selected and premium_rows is None:
        vp_points, vp_detail, profile = 0, f"Loading {selected['symbol']} premium candles for the volume profile", None
    elif not selected:
        vp_points, vp_detail, profile = 0, "No strike selected, so no premium volume profile", None
    else:
        vp_points, vp_detail, profile = read_profile(premium_rows, config)
    calc["profile"] = profile
    criteria.append(_criterion("volume_profile", "Volume profile", vp_points, maxes["volume_profile"], vp_detail))
    vix_points, vix_detail, vix_info = read_vix(context.get("vix"), config)
    calc["vix"] = vix_info
    criteria.append(_criterion("vix", "India VIX", vix_points, maxes["vix"], vix_detail))
    calc["criteria"] = criteria

    result: dict = {**base, "side": "BUY" if d > 0 else "SELL", "scalp": calc}
    if selected and premium_rows is None:
        result["needs_premium_candles"] = selected["symbol"]

    failing = [c for c in criteria if not c["passed"]]
    score = sum(c["points"] for c in criteria)
    calc["score"] = {"total": score, "minimum": config.minimum_score, "maximum": config.maximum_score}
    if failing:
        return {**result, "decision": "WAIT_FOR_CONFIRMATION", "reason": f"{len(criteria) - len(failing)}/{len(criteria)} criteria met; waiting on " + ", ".join(c["name"] for c in failing)}
    if not plan or not plan.get("valid"):
        return {**result, "decision": "NO_TRADE", "reason": (plan or {}).get("reason") or "No structural stop yet"}
    contract = {"symbol": selected["symbol"], "type": side, "strike": selected["strike"], "expiry": selected.get("expiry"),
                "lot_size": selected.get("lot_size"), "tick_size": selected.get("tick_size"), "freeze_quantity": selected.get("freeze_quantity")}
    setup = {
        "side": result["side"], "instrument": "OPTION_PREMIUM", "contract": contract,
        "entry": plan["entry"], "stop_loss": plan["stop_loss"], "target": plan["target"],
        "risk_reward": plan["risk_reward"], "net_risk_reward": plan["net_risk_reward"], "rr_choice": rr_label,
        "lots": plan["lots"], "quantity": plan["quantity"], "max_loss": plan["max_loss"],
        "spot": {"entry": plan["spot_entry"], "stop": plan["spot_stop"], "target": plan["spot_target"]},
        "greeks": plan["greeks"], "trigger_time": trigger["time"] if trigger else None,
        # round-trip charges per unit: the breakeven stop covers them (cost-covered breakeven)
        "cost_per_unit": round(plan["costs_per_lot"]["at_target"] / plan["lot_size"], 2),
        # Re-plan on the actual fill: the scalper refuses a fill above max_entry, re-checks the R:R
        # against min_risk_reward and re-sizes on the stressed risk (stop gap + exit slippage).
        "max_entry": plan["max_entry"], "max_target": plan["max_target"], "fill_tolerance": plan["fill_tolerance"],
        "min_risk_reward": round(rr * (1.0 - config.rr_tolerance), 2), "stop_gap": plan["stop_gap"],
        "slippage_pct": plan["slippage_pct"], "fees_at_stop_per_lot": plan["fees_at_stop_per_lot"],
        "planned_max_loss": plan["planned_max_loss"], "stressed_risk_reward": plan["stressed_risk_reward"],
        "setup_id": f"{STRATEGY_ID}:{symbol}:{side}:{trigger['time'] if trigger else ''}",
        "stop_method": "PULLBACK_EXTREME_OR_EMA9_MINUS_ATR_BUFFER", "target_method": f"DELTA_GAMMA_{rr_label.replace(':', 'TO')}",
    }
    return {**result, "decision": "CONFIRMED", "confidence": 100, "setup": setup,
            "reason": f"All {len(criteria)} criteria met: BUY {selected['symbol']} at an expected fill of ₹{plan['entry']:.2f}, SL ₹{plan['stop_loss']:.2f}, target ₹{plan['target']:.2f} ({rr_label} on the fill; the index needs {plan['target_points']:.1f} pts)"}


def score_card(result: dict) -> dict:
    """The strategy's own 10-point card for the V5 score gate (all 10 needed)."""
    calc = result.get("scalp") or {}
    card = {item["key"]: item["points"] for item in calc.get("criteria") or []}
    total = sum(card.values())
    return {**card, "total": float(total), "minimum": float(ScalpConfig().minimum_score)}
