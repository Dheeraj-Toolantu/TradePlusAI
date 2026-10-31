"""Next-day setup: a predicted opening and a planned option trade, built after the close.

The prediction reads the last completed session's opening and closing candles. Six factors,
each scaled to -1..+1 and weighted, give a composite score:

* Close in the day's range (close location value): a close near the high carries buyers into
  the next open, a close near the low carries sellers.
* Day candle: the open-to-close body as a share of the range.
* Opening vs closing candle: did the session close beyond its opening range (first 15 minutes),
  and was the last candle green or red.
* Last-hour move and last-30-minute push, in daily-ATR units: late positioning is what is
  carried overnight.
* Close vs session VWAP: who is in profit at the close.

A score inside +/-``flat_score`` predicts a FLAT open; beyond it a GAP_UP or GAP_DOWN whose
expected size is scaled by the median overnight gap of recent sessions. The same model is
re-run on every earlier session in the data and scored against the opening that followed, so
each prediction carries its own track record.

The plan follows the live Intrinsic Value strategy: an OTM option between the entry trigger and
the next key value, entered on an index trigger after the first 15 minutes plus a premium
pullback and continuation, stop from the index invalidation translated by delta (capped at 35%
of the premium), target = the contract repriced at the key value (``premium_math``), stop
trailed by the initial risk with breakeven at +1R. The primary plan trades the predicted open;
the alternate plan trades its failure. On a FLAT prediction both are breakout plans.

Premiums are the chain's last prices, moved by delta to the trigger; they are estimates until
the market opens. Exchange holidays are not known here, so the next session is the next weekday.
"""
from __future__ import annotations

import json
import math
import statistics
import sys
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from .engine import MARKET_TIMEZONE, Candle, _candles_from, _daily_atr, _daily_bars, _parse_timestamp
from . import premium_math
from .option_selection import ROUND_STEP, OptionSelectionConfig, liquidity_score, market_itm_odds

SESSION_CLOSE = time(15, 30)
OPENING_RANGE_END = time(9, 30)
LAST_HOUR_START = time(14, 30)
LAST_HALF_HOUR_START = time(15, 0)


@dataclass(frozen=True)
class NextDayConfig:
    flat_score: float = 0.20  # |composite| below this predicts a flat open
    default_gap_atr: float = 0.15  # typical overnight gap when history is too short to measure
    actual_flat_atr: float = 0.08  # an actual open within 0.08 daily ATR of the close was flat
    trigger_atr: float = 0.10  # entry trigger sits 0.1 ATR beyond the expected open
    stop_atr: float = 0.30  # index invalidation 0.3 ATR behind the trigger
    min_target_atr: float = 0.30  # a key value nearer than this is no target
    max_target_atr: float = 1.20  # and one further than this is out of reach for a day
    level_cluster_pct: float = 0.0012
    atr_period: int = 14


WEIGHTS = {"close_location": 0.20, "day_body": 0.15, "open_vs_close": 0.15, "last_hour": 0.20, "last_half_hour": 0.15, "vwap": 0.15}


def _clamp(value: float, low: float = -1.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def _tick(value: float, tick: float = 0.05) -> float:
    return round(round(value / tick) * tick, 2)


def _r(value: float | None, digits: int = 2) -> float | None:
    return None if value is None else round(float(value), digits)


def _sessions(candles: list[Candle], now: datetime) -> list[tuple[date, list[Candle]]]:
    """Completed IST sessions, oldest first. Today's counts only once the market has closed."""
    grouped: dict[date, list[Candle]] = {}
    for candle in candles:
        stamp = _parse_timestamp(candle.timestamp)
        if stamp is not None:
            grouped.setdefault(stamp.date(), []).append(candle)
    today = now.astimezone(MARKET_TIMEZONE)
    done = [(day, sorted(rows, key=lambda c: c.timestamp)) for day, rows in sorted(grouped.items())
            if day < today.date() or (day == today.date() and today.time() >= SESSION_CLOSE)]
    return [(day, rows) for day, rows in done if len(rows) >= 4]


def next_weekday(day: date) -> date:
    step = 3 if day.weekday() == 4 else 2 if day.weekday() == 5 else 1
    return day + timedelta(days=step)


def _at_or_after(rows: list[Candle], start: time) -> list[Candle]:
    return [c for c in rows if (stamp := _parse_timestamp(c.timestamp)) is not None and stamp.time() >= start]


def _vwap(rows: list[Candle]) -> float:
    weights = [c.volume if c.volume > 0 else 1.0 for c in rows]
    return sum((c.high + c.low + c.close) / 3.0 * w for c, w in zip(rows, weights)) / sum(weights)


def session_summary(rows: list[Candle]) -> dict:
    opening = [c for c in rows if (stamp := _parse_timestamp(c.timestamp)) is not None and stamp.time() < OPENING_RANGE_END] or rows[:1]
    last_hour = _at_or_after(rows, LAST_HOUR_START) or rows[-4:]
    last_half = _at_or_after(rows, LAST_HALF_HOUR_START) or rows[-2:]
    first, last = rows[0], rows[-1]
    return {
        "open": first.open, "high": max(c.high for c in rows), "low": min(c.low for c in rows), "close": last.close, "vwap": _vwap(rows),
        "opening_candle": {"time": first.timestamp, "open": first.open, "high": first.high, "low": first.low, "close": first.close},
        "closing_candle": {"time": last.timestamp, "open": last.open, "high": last.high, "low": last.low, "close": last.close},
        "opening_range": {"high": max(c.high for c in opening), "low": min(c.low for c in opening)},
        "last_hour": {"open": last_hour[0].open, "high": max(c.high for c in last_hour), "low": min(c.low for c in last_hour)},
        "last_half_hour_open": last_half[0].open,
    }


def factors(summary: dict, atr: float) -> list[dict]:
    o, h, l, c = summary["open"], summary["high"], summary["low"], summary["close"]
    span = max(h - l, 1e-9)
    clv = ((c - l) - (h - c)) / span
    body = (c - o) / span
    orh, orl = summary["opening_range"]["high"], summary["opening_range"]["low"]
    if c > orh:
        beyond = 1.0
    elif c < orl:
        beyond = -1.0
    else:
        beyond = _clamp((c - (orh + orl) / 2.0) / max((orh - orl) / 2.0, 1e-9)) * 0.5
    closing = summary["closing_candle"]
    last_bar = 1.0 if closing["close"] > closing["open"] else -1.0 if closing["close"] < closing["open"] else 0.0
    open_vs_close = _clamp(0.6 * beyond + 0.4 * last_bar)
    hour = (c - summary["last_hour"]["open"]) / (0.25 * atr)
    half = (c - summary["last_half_hour_open"]) / (0.15 * atr)
    vwap = (c - summary["vwap"]) / (0.25 * atr)
    rows = [
        ("close_location", "Close in day range", clv, f"closed at {(c - l) / span:.0%} of the {h - l:.0f}-pt range"),
        ("day_body", "Day candle (open to close)", body, f"{'green' if c >= o else 'red'} body of {abs(c - o):.0f} pts, {abs(body):.0%} of the range"),
        ("open_vs_close", "Opening vs closing candle", open_vs_close,
         f"closed {'above' if c > orh else 'below' if c < orl else 'inside'} the opening range {orl:.0f}-{orh:.0f}; last candle {'green' if last_bar > 0 else 'red' if last_bar < 0 else 'flat'}"),
        ("last_hour", "Last-hour move", _clamp(hour), f"{c - summary['last_hour']['open']:+.0f} pts from 14:30"),
        ("last_half_hour", "Last 30 minutes", _clamp(half), f"{c - summary['last_half_hour_open']:+.0f} pts from 15:00"),
        ("vwap", "Close vs VWAP", _clamp(vwap), f"close {c - summary['vwap']:+.0f} pts from VWAP {summary['vwap']:.0f}"),
    ]
    return [{"id": key, "name": name, "value": round(value, 3), "weight": WEIGHTS[key], "contribution": round(value * WEIGHTS[key], 3), "note": note} for key, name, value, note in rows]


def classify(score: float, config: NextDayConfig) -> str:
    return "GAP_UP" if score >= config.flat_score else "GAP_DOWN" if score <= -config.flat_score else "FLAT"


def _atr_through(candles: list[Candle], daily: list[Candle] | None, day: date, config: NextDayConfig) -> float | None:
    return _daily_atr(_daily_bars(candles, daily, day + timedelta(days=1)), config.atr_period)


def typical_gap(sessions: list[tuple[date, list[Candle]]], daily: list[Candle] | None) -> float | None:
    """Median absolute overnight gap (points) over the sessions and daily candles available."""
    gaps: dict[date, float] = {}
    for (_, previous), (day, rows) in zip(sessions, sessions[1:]):
        gaps[day] = abs(rows[0].open - previous[-1].close)
    bars = sorted(((stamp.date(), candle) for candle in daily or [] if (stamp := _parse_timestamp(candle.timestamp)) is not None), key=lambda item: item[0])
    for (_, previous), (day, candle) in zip(bars, bars[1:]):
        if candle.open > 0 and previous.close > 0:
            gaps.setdefault(day, abs(candle.open - previous.close))
    values = list(gaps.values())[-20:]
    return statistics.median(values) if len(values) >= 5 else None


def predict(summary: dict, atr: float, gap_size: float | None, config: NextDayConfig) -> dict:
    rows = factors(summary, atr)
    score = round(sum(row["contribution"] for row in rows), 3)
    opening = classify(score, config)
    typical = gap_size if gap_size else config.default_gap_atr * atr
    # A score of +/-0.5 is a typical gap; the estimate is capped at twice that.
    expected = 0.0 if opening == "FLAT" else _clamp(score / 0.5, -2.0, 2.0) * typical
    close = summary["close"]
    return {
        "opening": opening, "score": score, "confidence": round(min(1.0, abs(score)), 2),
        "expected_gap_points": round(expected, 1), "expected_open": round(close + expected, 1),
        "expected_range": [round(close + expected - 0.5 * typical, 1), round(close + expected + 0.5 * typical, 1)],
        "typical_gap_points": round(typical, 1), "factors": rows,
    }


def track_record(sessions: list[tuple[date, list[Candle]]], candles: list[Candle], daily: list[Candle] | None, config: NextDayConfig) -> dict:
    """The model re-run on each earlier session and scored against the open that followed."""
    days = []
    for (day, rows), (next_day, next_rows) in zip(sessions, sessions[1:]):
        atr = _atr_through(candles, daily, day, config)
        if not atr:
            continue
        score = round(sum(row["contribution"] for row in factors(session_summary(rows), atr)), 3)
        gap = next_rows[0].open - rows[-1].close
        actual = "FLAT" if abs(gap) < config.actual_flat_atr * atr else "GAP_UP" if gap > 0 else "GAP_DOWN"
        days.append({"date": day.isoformat(), "next_date": next_day.isoformat(), "predicted": classify(score, config), "score": score, "actual": actual, "gap_points": round(gap, 1)})
    hits = sum(d["predicted"] == d["actual"] for d in days)
    directional = [d for d in days if d["predicted"] != "FLAT"]
    direction_hits = sum((d["gap_points"] > 0) == (d["predicted"] == "GAP_UP") for d in directional)
    return {"days": len(days), "hits": hits, "hit_rate": round(hits / len(days), 2) if days else None,
            "directional_days": len(directional), "direction_hits": direction_hits,
            "direction_hit_rate": round(direction_hits / len(directional), 2) if directional else None,
            "history": days[-10:]}


def levels_for(symbol: str, summary: dict, older: dict | None, chain: list[dict], close: float) -> list[tuple[str, float]]:
    levels = [("PDH", summary["high"]), ("PDL", summary["low"]), ("PDC", summary["close"]), ("VWAP", summary["vwap"]),
              ("Opening-range high", summary["opening_range"]["high"]), ("Opening-range low", summary["opening_range"]["low"]),
              ("Last-hour high", summary["last_hour"]["high"]), ("Last-hour low", summary["last_hour"]["low"])]
    if older:
        levels += [("2-day high", older["high"]), ("2-day low", older["low"])]
    for contract, name in (("CALL", "Call OI wall"), ("PUT", "Put OI wall")):
        rows = [row for row in chain if row.get("contract") == contract and float(row.get("openInterest") or 0) > 0]
        if rows:
            levels.append((name, float(max(rows, key=lambda row: float(row.get("openInterest") or 0))["strike"])))
    step = ROUND_STEP.get(symbol, 100.0)
    base = math.floor(close / step) * step
    levels += [("Round number", base + step * k) for k in range(-3, 5)]
    return levels


def key_value(levels: list[tuple[str, float]], trigger: float, direction: int, atr: float, config: NextDayConfig) -> dict | None:
    near, far = trigger + direction * config.min_target_atr * atr, trigger + direction * config.max_target_atr * atr
    beyond = sorted(((name, price) for name, price in levels if (price - near) * direction >= 0 and (far - price) * direction >= 0), key=lambda item: abs(item[1] - trigger))
    if not beyond:
        return None
    price = beyond[0][1]
    tolerance = price * config.level_cluster_pct
    sources = sorted({name for name, level in beyond if abs(level - price) <= tolerance})
    return {"price": round(price, 2), "sources": sources}


def pick_strike(chain: list[dict], option_type: str, trigger: float, target: float, close: float, now: datetime, session_day: date, intrinsic: OptionSelectionConfig,
                entry_time: datetime | None = None) -> tuple[dict | None, list[dict]]:
    wanted = "CALL" if option_type == "CE" else "PUT"
    direction = 1 if option_type == "CE" else -1
    rows = []
    for row in chain:
        strike, premium = float(row.get("strike") or 0), float(row.get("premium") or 0)
        if row.get("contract") != wanted or premium <= 0 or str(row.get("expiry") or "9999")[:10] <= session_day.isoformat():
            continue
        if not ((strike - trigger) * direction > 0 and (target - strike) * direction > 0):
            continue  # OTM at the trigger and inside the key value
        odds = market_itm_odds(row, close, option_type, now)
        if odds is None or odds < intrinsic.min_delta * 0.5:
            continue
        estimate = max(premium + odds * (trigger - close) * direction, 0.3 * premium, 0.5)
        intrinsic_at_key = abs(target - strike)
        liquid = liquidity_score(row, intrinsic)
        # The premium calculator at the trigger: does the key value pay +50% on the estimated entry?
        scale = estimate / premium
        bid, ask = premium_math.number(row.get("bid")), premium_math.number(row.get("ask"))
        check = premium_math.evaluate(trigger, target, option_type, strike, estimate, row.get("expiry"), entry_time or now, iv=premium_math.number(row.get("iv")), delta=odds,
                                      bid=bid * scale if bid is not None else None, ask=ask * scale if ask is not None else None, liquidity=liquid, lot_size=row.get("lotSize"))
        # The contract repriced at the key value (same model as the check); intrinsic + time value only without one.
        premium_at_key = check["premium_at_key_model"] if check["premium_at_key_model"] is not None else intrinsic_at_key + intrinsic.residual_time_value * estimate
        gain = premium_at_key / estimate - 1.0
        reachable = all(item["passed"] for item in check["checks"] if item["id"] in {"KEY_LEVEL_PAYS_TARGET", "SPREAD"})
        rows.append({"symbol": row.get("symbol"), "strike": strike, "type": option_type, "expiry": row.get("expiry"), "premium_close": premium,
                     "delta": _r(odds, 3), "estimated_entry": round(estimate, 2), "intrinsic_at_key": round(intrinsic_at_key, 2),
                     "premium_at_key": round(premium_at_key, 2), "value_gain": round(gain, 3), "liquidity_score": liquid,
                     "lot_size": row.get("lotSize"), "tick_size": row.get("tickSize"), "iv": premium_math.number(row.get("iv")),
                     "spread": (bid * scale, ask * scale) if bid is not None and ask is not None else None,
                     "premium_check": check, "target_reachable": reachable,
                     "eligible": gain >= intrinsic.min_value_gain and liquid >= 2 and reachable})
    rows.sort(key=lambda item: (not item["eligible"], -(item["delta"] or 0)))
    return next((row for row in rows if row["eligible"]), None), rows[:4]


def build_plan(role: str, direction: int, symbol: str, summary: dict, levels: list[tuple[str, float]], expected_open: float, atr: float, chain: list[dict],
               now: datetime, session_day: date, next_day: date, config: NextDayConfig, intrinsic: OptionSelectionConfig) -> dict:
    option_type = "CE" if direction > 0 else "PE"
    word = "above" if direction > 0 else "below"
    edge = summary["last_hour"]["high"] if direction > 0 else summary["last_hour"]["low"]
    trigger = max(expected_open + config.trigger_atr * atr, edge) if direction > 0 else min(expected_open - config.trigger_atr * atr, edge)
    stop = trigger - direction * config.stop_atr * atr
    key = key_value(levels, trigger, direction, atr, config)
    target = key["price"] if key else trigger + direction * 2 * config.stop_atr * atr
    index = {"trigger": round(trigger, 1), "stop_loss": round(stop, 1), "target": round(target, 1), "key_value_sources": key["sources"] if key else ["2R (no key value in reach)"],
             "risk_points": round(abs(trigger - stop), 1), "reward_points": round(abs(target - trigger), 1), "risk_reward": round(abs(target - trigger) / abs(trigger - stop), 2),
             "skip_if_open_beyond": round(trigger + direction * 0.5 * abs(target - trigger), 1)}
    plan = {"role": role, "option_type": option_type, "direction": "BULLISH" if direction > 0 else "BEARISH", "index": index, "contract": None, "premium": None, "candidates": []}
    entry_time = datetime.combine(next_day, time(10, 0), tzinfo=MARKET_TIMEZONE)
    pick, candidates = pick_strike(chain, option_type, trigger, target, summary["close"], now, session_day, intrinsic, entry_time)
    plan["candidates"] = candidates
    condition = (f"After 9:30 (once the first 15-minute candle is done), {symbol} trades {word} {trigger:.0f} and the option premium pulls back and resumes. "
                 f"Skip if {symbol} opens {word} {index['skip_if_open_beyond']:.0f} (the move is already half done).")
    if pick is None:
        plan["entry_rule"] = condition
        blocked = next((row for row in candidates if not row["target_reachable"]), None)
        plan["note"] = (f"No liquid OTM {option_type} between {trigger:.0f} and the key value {target:.0f} offers a {intrinsic.min_value_gain:.0%} option premium gain at the key value"
                        + (f" ({blocked['symbol']}: {blocked['premium_check']['reason']})" if blocked else "") + "; trade only if the chain reprices at the open.")
        return plan
    tick = float(pick.get("tick_size") or 0.05) or 0.05
    entry = _tick(pick["estimated_entry"], tick)
    raw_risk = (pick["delta"] or 0.3) * abs(trigger - stop)
    risk = _tick(min(raw_risk, intrinsic.max_stop_pct * entry), tick)
    target_premium = _tick(pick["premium_at_key"], tick)
    plan["contract"] = {key_: pick[key_] for key_ in ("symbol", "strike", "type", "expiry", "lot_size", "premium_close", "delta")}
    plan["contract"]["expiry_day"] = str(pick.get("expiry") or "")[:10] == next_day.isoformat()
    spread = pick.get("spread")
    check = premium_math.evaluate(trigger, target, option_type, pick["strike"], entry, pick["expiry"], entry_time, iv=pick.get("iv"), delta=pick["delta"],
                                  bid=spread[0] if spread else None, ask=spread[1] if spread else None, liquidity=pick["liquidity_score"],
                                  stop=entry - risk, target=target_premium, lot_size=pick.get("lot_size"))
    plan["premium"] = {"entry": entry, "stop_loss": _tick(entry - risk, tick), "target": target_premium,
                       "risk_reward": check["net_risk_reward"], "gross_risk_reward": round((target_premium - entry) / risk, 2) if risk > 0 else None,
                       "trailing_distance": risk, "breakeven_at": _tick(entry + risk, tick), "stop_capped": raw_risk > risk + tick, "check": check}
    plan["entry_rule"] = condition + f" Buy {pick['symbol']} near ₹{entry:.2f} (estimated from yesterday's ₹{pick['premium_close']:.2f} and delta {pick['delta']:.2f})."
    plan["trailing_rule"] = (f"Trail the premium stop ₹{risk:.2f} under the highest premium (breakeven at ₹{entry + risk:.2f}, +1R). "
                             f"On the index: once {symbol} is {abs(trigger - stop):.0f} pts in favour, move the index stop to {trigger:.0f}.")
    plan["exit_rule"] = f"Exit at ₹{target_premium:.2f} or when {symbol} reaches {target:.0f}; exit on a 15-minute close {'below' if direction > 0 else 'above'} {stop:.0f}; square off by 15:15."
    return plan


def next_day_setup(symbol: str, candles: list[Candle], daily: list[Candle] | None, chain_payload: dict | None, sentiment: dict | None, now: datetime,
                   config: NextDayConfig | None = None) -> dict:
    config = config or NextDayConfig()
    sessions = _sessions(candles, now)
    if not sessions:
        return {"symbol": symbol, "status": "NO_DATA", "reason": "No completed session in the candles"}
    session_day, rows = sessions[-1]
    next_day = next_weekday(session_day)
    atr = _atr_through(candles, daily, session_day, config)
    if not atr:
        return {"symbol": symbol, "status": "NO_DATA", "reason": "Daily ATR is unavailable"}
    summary = session_summary(rows)
    older = session_summary(sessions[-2][1]) if len(sessions) > 1 else None
    prediction = predict(summary, atr, typical_gap(sessions, daily), config)
    chain = [row for row in (chain_payload or {}).get("contracts", []) if isinstance(row, dict) and row.get("strike") is not None]
    levels = levels_for(symbol, summary, older, chain, summary["close"])
    intrinsic = OptionSelectionConfig()
    expected = prediction["expected_open"]
    if prediction["opening"] == "FLAT":
        plans = [build_plan("BREAKOUT_UP", 1, symbol, summary, levels, expected, atr, chain, now, session_day, next_day, config, intrinsic),
                 build_plan("BREAKOUT_DOWN", -1, symbol, summary, levels, expected, atr, chain, now, session_day, next_day, config, intrinsic)]
    else:
        direction = 1 if prediction["opening"] == "GAP_UP" else -1
        plans = [build_plan("PRIMARY", direction, symbol, summary, levels, expected, atr, chain, now, session_day, next_day, config, intrinsic),
                 build_plan("ALTERNATE", -direction, symbol, summary, levels, expected, atr, chain, now, session_day, next_day, config, intrinsic)]
    reading = sentiment or {}
    return {
        "symbol": symbol, "status": "READY", "session_date": session_day.isoformat(), "next_session_date": next_day.isoformat(),
        "generated_at": now.isoformat(), "daily_atr": round(atr, 1),
        "reference": {key: (_r(value, 2) if isinstance(value, float) else value) for key, value in summary.items()},
        "prediction": prediction, "track_record": track_record(sessions, candles, daily, config),
        "sentiment": {"score": reading.get("score"), "label": reading.get("label")} if reading else None,
        "plans": plans,
        "caveats": ["Premiums are estimated from the last chain prices and delta; confirm the live premium before entry.",
                    "Overnight news, global markets and GIFT Nifty are not in the model; check them before the open.",
                    "Exchange holidays are not known here; the next session is taken as the next weekday."],
    }


def analyze_payload(payload: dict) -> dict:
    now = _parse_timestamp(str(payload.get("now") or "")) or datetime.now(MARKET_TIMEZONE)
    result = next_day_setup(str(payload.get("symbol", "NIFTY")).upper(), _candles_from(payload.get("candles", [])), _candles_from(payload.get("daily_candles")) or None,
                            payload.get("option_chain"), payload.get("index_sentiment"), now)
    if payload.get("delayed"):
        result.setdefault("caveats", []).insert(0, "Candles came from the delayed fallback feed, not Groww.")
    return result


def main() -> None:
    print(json.dumps(analyze_payload(json.load(sys.stdin))))


if __name__ == "__main__":
    main()
