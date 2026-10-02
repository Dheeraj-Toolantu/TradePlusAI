"""Deterministic NIFTY 15-minute opening-range breakout and retest checks."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timedelta
from typing import Protocol

from .indicators import atr as calculate_atr


class CandleLike(Protocol):
    timestamp: str
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass(frozen=True)
class ORBResult:
    status: str
    side: str | None
    reason: str
    opening_range_high: float | None = None
    opening_range_low: float | None = None
    breakout_index: int | None = None
    retest_index: int | None = None
    atr: float = 0.0
    bars_since_retest: int | None = None
    retest_low: float | None = None
    retest_high: float | None = None
    breakout_time: str | None = None
    retest_time: str | None = None
    opening_minutes: int = 15


def _timestamp(value: str) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed


def _vwap(candles: list[CandleLike]) -> float:
    volume = sum(max(candle.volume, 1.0) for candle in candles)
    return sum(candle.close * max(candle.volume, 1.0) for candle in candles) / volume


RETEST_ZONE_ATR = 0.1  # spec 6B "or defined breakout zone": a retest may stop 0.1 x ATR short of the level
MAX_RETEST_CANDLES = 3  # immediate retest window after the breakout candle
PULLBACK_WINDOW_CANDLES = 24  # a broken level stays tradeable on a pullback for 2 hours
MAX_BREAKOUT_ATTEMPTS = 3  # more failed breaks than this is a whipsaw/range day
MOMENTUM_REVERSAL_ATR = 1.0  # a counter-candle body above 1 x ATR into the level is a rejection, not a retest


def _max_extension(price: float, atr: float) -> float:
    # Spec 6A: max extension = min(0.35% of spot, 1.0 x ATR(5m)).
    return min(max(price, 1.0) * 0.0035, atr) if atr > 0 else max(price, 1.0) * 0.0035


def evaluate_orb_retest(candles: list[CandleLike], atr_value: float | None = None, opening_minutes: int = 15) -> ORBResult:
    """Evaluate only completed, timestamped sessions; missing timestamps fail closed.

    ``atr_value`` should come from the full multi-session history (a session-only ATR is
    undefined until ~10:25 IST). ``opening_minutes`` is 15 on normal days and 30 on gap days
    (spec 4). Callers must pass COMPLETED candles only; a forming candle would repaint.

    The session is walked as a state machine instead of stopping at the first breakout:

    * A close outside the range is a breakout; a close back inside fails it and the scan
      resumes, so a failed break on one side can be followed by a real break on either side
      (up to ``MAX_BREAKOUT_ATTEMPTS``).
    * An orderly breakout may be retested inside ``MAX_RETEST_CANDLES`` (the classic retest).
    * An extended breakout, or one whose first retest signal has gone stale, stays live while
      price holds beyond the level: a later pullback that tags the level and holds is a new
      entry (``PULLBACK_WINDOW_CANDLES``). Entry is always within the max extension of the
      level, so this never chases; a violent counter-candle into the level is not a retest.
    * The most recent valid retest is reported, so the caller's freshness check applies to it.
    """
    timestamps = [_timestamp(candle.timestamp) for candle in candles]
    if len(candles) < 6 or any(value is None for value in timestamps):
        return ORBResult("NO_TRADE", None, "ORB requires timestamped 5-minute candles", opening_minutes=opening_minutes)
    session_date = timestamps[-1].date()
    session = [(index, candle, timestamps[index]) for index, candle in enumerate(candles) if timestamps[index].date() == session_date]
    or_end = (datetime.combine(session_date, time(9, 15)) + timedelta(minutes=opening_minutes)).time()
    opening = [(index, candle) for index, candle, timestamp in session if time(9, 15) <= timestamp.time() < or_end]
    if len(opening) < opening_minutes // 5:
        return ORBResult("WAIT_FOR_BREAKOUT", None, f"{opening_minutes}-minute opening range is incomplete", opening_minutes=opening_minutes)
    opening_high = max(candle.high for _, candle in opening)
    opening_low = min(candle.low for _, candle in opening)
    after_opening = [(index, candle) for index, candle, _ in session if index > opening[-1][0]]
    base = {"opening_range_high": opening_high, "opening_range_low": opening_low, "opening_minutes": opening_minutes}
    if not after_opening:
        return ORBResult("WAIT_FOR_BREAKOUT", None, "Waiting for a candle after the opening range", **base)
    atr = atr_value if atr_value and atr_value > 0 else (calculate_atr(candles, 14) or 0.0)
    zone = RETEST_ZONE_ATR * atr
    last_index = len(candles) - 1
    stamp = lambda index: timestamps[index].isoformat()
    clock = lambda index: timestamps[index].strftime("%H:%M")

    attempts = 0
    failures: list[str] = []
    active: dict | None = None  # the breakout currently being tracked
    for position, (index, candle) in enumerate(after_opening):
        if active is not None:
            direction, level = active["side"], active["level"]
            held = candle.close > level if direction == "BUY" else candle.close < level
            if not held:
                # Spec 6B: a close back through the level invalidates the breakout. The same candle
                # may close beyond the OTHER side of the range, so fall through to the breakout check.
                failures.append(f"{direction} break at {clock(active['index'])} failed at {clock(index)}")
                active = None
        if active is not None:
            direction, level = active["side"], active["level"]
            since_breakout = position - active["position"]
            touched = candle.low <= level + zone if direction == "BUY" else candle.high >= level - zone
            # A "hold" whose wick fell through half the opening range is not a hold: the level was lost
            # intrabar, and the stop under that wick would be far too wide.
            midpoint = (opening_high + opening_low) / 2
            touched = touched and (candle.low >= midpoint if direction == "BUY" else candle.high <= midpoint)
            confirmed_colour = candle.close > candle.open if direction == "BUY" else candle.close < candle.open
            entry_distance = abs(candle.close - level)
            max_extension = _max_extension(candle.close, atr)
            previous = after_opening[position - 1][1]
            counter_body = (previous.open - previous.close) if direction == "BUY" else (previous.close - previous.open)
            violent = atr > 0 and counter_body > MOMENTUM_REVERSAL_ATR * atr and previous is not active["candle"]
            early = since_breakout <= MAX_RETEST_CANDLES and active["excursion"] <= active["max_extension"]
            in_pullback_window = since_breakout <= PULLBACK_WINDOW_CANDLES
            if touched and confirmed_colour and entry_distance <= max_extension and (early or (in_pullback_window and not violent)):
                active["retests"].append((index, candle, "retest" if early and not active["retests"] else "pullback retest"))
            elif touched and violent:
                active["note"] = f"Pullback at {clock(index)} came on a {counter_body:.0f}-pt counter-candle; waiting for a calmer retest"
            active["excursion"] = max(active["excursion"], (candle.high - level) if direction == "BUY" else (level - candle.low))
            continue
        direction = "BUY" if candle.close > opening_high else "SELL" if candle.close < opening_low else None
        if direction is None:
            continue
        attempts += 1
        if attempts > MAX_BREAKOUT_ATTEMPTS:
            return ORBResult("NO_TRADE", None, f"{MAX_BREAKOUT_ATTEMPTS} opening-range breaks failed ({'; '.join(failures)}); range/whipsaw day", **base, atr=atr)
        level = opening_high if direction == "BUY" else opening_low
        excursion = candle.close - level if direction == "BUY" else level - candle.close
        active = {"side": direction, "level": level, "index": index, "position": position, "candle": candle, "excursion": excursion,
                  "max_extension": _max_extension(candle.close, atr), "retests": [], "note": None}

    failure_note = f" (earlier: {'; '.join(failures)})" if failures else ""
    if active is None:
        if failures:
            return ORBResult("WAIT_FOR_BREAKOUT", None, f"Last breakout failed: {failures[-1]}; waiting for a fresh break of either side", **base, atr=atr)
        return ORBResult("WAIT_FOR_BREAKOUT", None, "No candle has closed outside the opening range yet", **base, atr=atr)

    direction, level = active["side"], active["level"]
    found = {**base, "breakout_index": active["index"], "atr": atr, "breakout_time": stamp(active["index"])}
    since_breakout = len(after_opening) - 1 - active["position"]
    if active["retests"]:
        retest_index, retest, kind = active["retests"][-1]
        word = "breakout" if direction == "BUY" else "breakdown"
        return ORBResult("CONFIRMED", direction, f"ORB {word} {kind} of {level:.2f} confirmed at {clock(retest_index)}{failure_note}", **found,
                         retest_index=retest_index, bars_since_retest=last_index - retest_index, retest_low=retest.low, retest_high=retest.high, retest_time=stamp(retest_index))
    if since_breakout > PULLBACK_WINDOW_CANDLES:
        return ORBResult("NO_TRADE", None, f"{direction} break of {level:.2f} was not retested within {PULLBACK_WINDOW_CANDLES} candles; the opening-range edge has faded", **found)
    if since_breakout < MAX_RETEST_CANDLES and active["excursion"] <= active["max_extension"]:
        return ORBResult("WAIT_FOR_RETEST", direction, f"Breakout seen; waiting up to {MAX_RETEST_CANDLES - since_breakout} more candle(s) for a retest of {level:.2f}{failure_note}", **found)
    reason = active["note"] or f"Breakout ran {active['excursion']:.0f} pts beyond {level:.2f}; waiting for a pullback to the level instead of chasing"
    return ORBResult("WAIT_FOR_PULLBACK", direction, reason + failure_note, **found)
