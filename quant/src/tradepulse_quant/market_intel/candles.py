"""Candle parsing and session-anchored technicals shared by the market-intel modules."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Iterable

from ..algo_engine import indicators

IST = timezone(timedelta(hours=5, minutes=30), name="Asia/Kolkata")


@dataclass(frozen=True)
class Bar:
    time: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float

    @property
    def bullish(self) -> bool:
        return self.close > self.open

    @property
    def bearish(self) -> bool:
        return self.close < self.open


def _parse_time(value: object) -> datetime | None:
    try:
        if isinstance(value, (int, float)) or (isinstance(value, str) and value.strip().isdigit()):
            number = float(value)
            if number > 10_000_000_000:  # epoch milliseconds
                number /= 1000.0
            return datetime.fromtimestamp(number, tz=IST)
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (OverflowError, TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=IST)
    return parsed.astimezone(IST)


def parse_bars(rows: Iterable[dict]) -> list[Bar]:
    """Parse, validate, de-duplicate and time-sort candles. Invalid rows are dropped."""
    bars: dict[datetime, Bar] = {}
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        moment = _parse_time(row.get("timestamp", row.get("time")))
        try:
            o, h, l, c = (float(row[key]) for key in ("open", "high", "low", "close"))
            v = float(row.get("volume") or 0.0)
        except (KeyError, TypeError, ValueError):
            continue
        if moment is None or min(o, h, l, c) <= 0 or h < max(o, c, l) or l > min(o, c, h):
            continue
        bars[moment] = Bar(moment, o, h, l, c, max(v, 0.0))
    return [bars[key] for key in sorted(bars)]


def split_sessions(bars: list[Bar]) -> tuple[list[Bar], list[Bar]]:
    """Return (latest session bars, previous session bars) by IST calendar date."""
    if not bars:
        return [], []
    last_day: date = bars[-1].time.date()
    session = [bar for bar in bars if bar.time.date() == last_day]
    earlier_days = sorted({bar.time.date() for bar in bars if bar.time.date() < last_day})
    previous = [bar for bar in bars if earlier_days and bar.time.date() == earlier_days[-1]]
    return session, previous


def session_vwap(session: list[Bar]) -> tuple[float | None, bool]:
    """Session-anchored VWAP. Index cash candles carry no volume, so fall back to a
    time-weighted typical price (TWAP) and report that the value is an approximation."""
    if not session:
        return None, False
    volume = sum(bar.volume for bar in session)
    if volume > 0:
        return sum(((bar.high + bar.low + bar.close) / 3.0) * bar.volume for bar in session) / volume, True
    return sum((bar.high + bar.low + bar.close) / 3.0 for bar in session) / len(session), False


def rsi(closes: list[float], period: int = 14) -> float | None:
    if len(closes) <= period:
        return None
    gains = losses = 0.0
    for previous, current in zip(closes[:period], closes[1:period + 1]):
        change = current - previous
        gains += max(change, 0.0)
        losses += max(-change, 0.0)
    average_gain, average_loss = gains / period, losses / period
    for previous, current in zip(closes[period:], closes[period + 1:]):
        change = current - previous
        average_gain = (average_gain * (period - 1) + max(change, 0.0)) / period
        average_loss = (average_loss * (period - 1) + max(-change, 0.0)) / period
    if average_loss == 0:
        return 100.0
    return 100.0 - 100.0 / (1.0 + average_gain / average_loss)


def technicals(bars: list[Bar]) -> dict:
    session, previous = split_sessions(bars)
    closes = [bar.close for bar in bars]
    vwap, volume_weighted = session_vwap(session)
    atr_value = indicators.atr(bars, 14)
    return {
        "last_price": closes[-1] if closes else None,
        "vwap": vwap,
        "vwap_is_volume_weighted": volume_weighted,
        "ema20": indicators.ema(closes, 20),
        "ema50": indicators.ema(closes, 50),
        "atr14": atr_value,
        "rsi14": rsi(closes, 14),
        "session_open": session[0].open if session else None,
        "session_high": max((bar.high for bar in session), default=None),
        "session_low": min((bar.low for bar in session), default=None),
        "previous_high": max((bar.high for bar in previous), default=None),
        "previous_low": min((bar.low for bar in previous), default=None),
        "previous_close": previous[-1].close if previous else None,
        "session_bars": len(session),
    }
