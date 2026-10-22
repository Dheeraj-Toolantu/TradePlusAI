"""What will this option's premium be at the next session if the index is at a chosen key level?

The contract is priced with the same Black-Scholes model as ``premium_math`` (contract strike and
expiry, ``PremiumConfig.rate``), so every figure reprices today's premium exactly:

1. Today: the volatility implied by the quoted premium V0 at index S0, with T0 calendar time left
   (the chain's IV when the premium cannot be inverted).
2. Next open: T1 is the calendar time left from 09:15 of the next weekday, so overnight and weekend
   decay (Friday to Monday is three calendar days) are both charged.
3. Moneyness: the index is at the key level K instead of S0.
4. Volatility at the open: IV moves against the gap, +``iv_beta_down`` vol points per 1% the index
   falls and -``iv_beta_up`` per 1% it rises (index skew: falls lift IV, rallies drain it), capped
   at ``iv_cap`` points, unless the caller fixes the change. The low and high cases take
   ``iv_band`` points off and on, so the low case is the IV-crush scenario.

The open estimate is V(K, T1, sigma0 + dIV). It is decomposed into overnight decay V(S0, T1, s0) - V0,
the index move V(K, T1, s0) - V(S0, T1, s0) and the IV change V(K, T1, s1) - V(K, T1, s0). A ladder
reprices the same scenario if K is reached later in the next session instead of at the open. The
opening quote widens today's bid-ask spread by ``open_spread_mult`` (at least ``min_open_spread``).
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from .engine import MARKET_TIMEZONE, _parse_timestamp
from .premium_math import PremiumConfig, YEAR_DAYS, bs_greeks, bs_price, implied_vol, number

OPEN = time(9, 15)
CLOSE = time(15, 30)
TICK = 0.05


@dataclass(frozen=True)
class OpenConfig:
    iv_beta_down: float = 2.0  # vol points added per 1% the index falls to the key level
    iv_beta_up: float = 1.0  # vol points taken off per 1% the index rises to the key level
    iv_cap: float = 10.0  # largest automatic IV change, in vol points
    iv_band: float = 2.0  # vol points either side of the base case
    open_spread_mult: float = 1.5  # opening spreads are wider than the close
    min_open_spread: float = 0.02  # of the premium, when the chain has no bid/ask
    reach_times: tuple[str, ...] = ("09:15", "10:30", "12:00", "13:30", "15:00")


def _tick(value: float) -> float:
    return round(round(value / TICK) * TICK, 2)


def next_open(now: datetime) -> datetime:
    """09:15 of the next session: today before the open, otherwise the next weekday (holidays unknown)."""
    day = now.date()
    if day.weekday() < 5 and now.time() < OPEN:
        return datetime.combine(day, OPEN, tzinfo=now.tzinfo)
    day += timedelta(days=1)
    while day.weekday() >= 5:
        day += timedelta(days=1)
    return datetime.combine(day, OPEN, tzinfo=now.tzinfo)


def _years(expiry: date, at: datetime) -> float:
    close = datetime.combine(expiry, CLOSE, tzinfo=at.tzinfo)
    return max((close - at).total_seconds(), 60.0) / (YEAR_DAYS * 86400.0)


def iv_shift(spot: float, key_level: float, config: OpenConfig) -> float:
    move_pct = (key_level - spot) / spot * 100.0
    change = -config.iv_beta_up * move_pct if move_pct >= 0 else -config.iv_beta_down * move_pct
    return max(-config.iv_cap, min(config.iv_cap, change))


def estimate(spot: float, key_level: float, option_type: str, strike: float, premium: float, expiry: object, now: datetime,
             iv: float | None = None, bid: float | None = None, ask: float | None = None, iv_change: float | None = None,
             open_at: datetime | None = None, config: OpenConfig | None = None, pricing: PremiumConfig | None = None) -> dict:
    """Premium of ``option_type`` ``strike`` at the next open with the index at ``key_level``; ``premium`` is quoted at ``now``."""
    config, pricing = config or OpenConfig(), pricing or PremiumConfig()
    kind = option_type.upper()
    try:
        expiry_day = date.fromisoformat(str(expiry)[:10])
    except ValueError:
        return {"status": "ERROR", "reason": "The contract's expiry is missing or not a date."}
    if kind not in ("CE", "PE") or min(spot, key_level, strike, premium) <= 0:
        return {"status": "ERROR", "reason": "Spot, key level, strike and premium must be positive, and the type CE or PE."}
    valued_at = open_at or next_open(now)
    if expiry_day < valued_at.date():
        return {"status": "ERROR", "reason": f"The contract expires on {expiry_day} before the next session ({valued_at.date()})."}
    rate = pricing.rate
    t0, t1 = _years(expiry_day, now), _years(expiry_day, valued_at)

    sigma0, source = implied_vol(premium, spot, strike, t0, kind, rate), "implied from the premium"
    if sigma0 is None and iv:
        sigma0, source = iv / 100.0, "option chain IV (the premium is outside the model's range)"
    if sigma0 is None:
        return {"status": "ERROR", "reason": "The premium cannot be repriced (below intrinsic value or beyond 300% IV) and the chain has no IV."}
    auto = iv_change is None
    change = iv_shift(spot, key_level, config) if auto else float(iv_change)

    def value(at_spot: float, years: float, sigma_points: float) -> float:
        return bs_price(at_spot, strike, years, max(sigma_points, 1.0) / 100.0, kind, rate)

    base_iv = sigma0 * 100.0 + change
    cases = []
    for name, points in (("low", base_iv - config.iv_band), ("base", base_iv), ("high", base_iv + config.iv_band)):
        price = value(key_level, t1, points)
        cases.append({"case": name, "iv_pct": round(max(points, 1.0), 2), "premium": _tick(price),
                      "change": round(price - premium, 2), "change_pct": round((price - premium) / premium * 100.0, 2)})
    base = value(key_level, t1, base_iv)

    decayed = value(spot, t1, sigma0 * 100.0)
    moved = value(key_level, t1, sigma0 * 100.0)
    intrinsic = max(0.0, key_level - strike) if kind == "CE" else max(0.0, strike - key_level)
    greeks = bs_greeks(key_level, strike, t1, max(base_iv, 1.0) / 100.0, kind, rate)

    quoted = (ask - bid) / ((ask + bid) / 2.0) if bid and ask and ask > bid > 0 else None
    spread = max((quoted or 0.0) * config.open_spread_mult, config.min_open_spread)

    ladder = []
    for stamp in config.reach_times:
        hour, minute = (int(part) for part in stamp.split(":"))
        at = datetime.combine(valued_at.date(), time(hour, minute), tzinfo=valued_at.tzinfo)
        if at.date() == expiry_day and at.time() >= CLOSE:
            continue
        ladder.append({"time": stamp, "premium": _tick(value(key_level, _years(expiry_day, at), base_iv))})

    move = key_level - spot
    calendar_days = (valued_at - now).total_seconds() / 86400.0
    return {
        "status": "READY",
        "open_at": valued_at.isoformat(),
        "estimate": _tick(base),
        "range": [cases[0]["premium"], cases[2]["premium"]],
        "cases": cases,
        "change": round(base - premium, 2), "change_pct": round((base - premium) / premium * 100.0, 2),
        "opening_quote": {"bid": _tick(base * (1 - spread / 2.0)), "ask": _tick(base * (1 + spread / 2.0)), "spread_pct": round(spread * 100.0, 2),
                          "source": ("today's spread x %.1f" % config.open_spread_mult if quoted and quoted * config.open_spread_mult >= config.min_open_spread
                                     else "minimum %.0f%%" % (config.min_open_spread * 100))},
        "breakdown": {
            "overnight_decay": round(decayed - premium, 2),
            "index_move": round(moved - decayed, 2),
            "iv_change": round(base - moved, 2),
            "intrinsic_at_open": round(intrinsic, 2),
            "time_value_at_open": round(base - intrinsic, 2),
        },
        "greeks_at_open": {"delta": round(greeks["delta"], 4), "gamma": round(greeks["gamma"], 6), "vega": round(greeks["vega"], 2), "theta": round(greeks["theta"], 2)},
        "ladder": ladder,
        "inputs": {
            "spot": round(spot, 2), "key_level": round(key_level, 2), "move_points": round(move, 2), "move_pct": round(move / spot * 100.0, 3),
            "option_type": kind, "strike": strike, "premium": round(premium, 2), "expiry": expiry_day.isoformat(), "quoted_at": now.isoformat(),
            "bid": bid, "ask": ask, "rate_pct": round(rate * 100.0, 2),
            "days_to_expiry_now": round(t0 * YEAR_DAYS, 2), "days_to_expiry_at_open": round(t1 * YEAR_DAYS, 2), "calendar_days_to_open": round(calendar_days, 2),
            "iv_pct": round(sigma0 * 100.0, 2), "iv_source": source, "chain_iv_pct": iv,
            "iv_change_points": round(change, 2), "iv_change_source": "automatic (skew: %.1f pts per 1%% fall, %.1f per 1%% rise)" % (config.iv_beta_down, config.iv_beta_up) if auto else "your input",
            "iv_band_points": config.iv_band, "model": "Black-Scholes, calendar-time decay to 15:30 on expiry",
        },
        "caveats": ["The opening premium also depends on overnight news and the opening auction, which no model sees; treat the range, not the base, as the answer.",
                    "Decay runs on calendar time, so a weekend costs three days; markets often price part of that into Friday's premium already.",
                    "Exchange holidays are not known here; the next session is taken as the next weekday."],
    }


def _row(chain: dict | None, strike: float, kind: str, after: date) -> dict | None:
    """The chain row for this strike and type, on the nearest expiry that is still live at the next open."""
    wanted = "CALL" if kind == "CE" else "PUT"
    rows = [row for row in (chain or {}).get("contracts", []) if number(row.get("strike")) == strike
            and str(row.get("contract", "")).upper() in (wanted, kind) and str(row.get("expiry", ""))[:10] >= after.isoformat()]
    return min(rows, key=lambda row: str(row.get("expiry", ""))) if rows else None


def analyze_payload(payload: dict) -> dict:
    """Payload: option_type, strike, key_level; optional premium, spot, expiry, iv, bid, ask, iv_change, now, option_chain."""
    now = _parse_timestamp(str(payload.get("now") or "")) or datetime.now(MARKET_TIMEZONE)
    kind = str(payload.get("option_type", "")).upper()
    strike, key_level = number(payload.get("strike")), number(payload.get("key_level"))
    if strike is None or key_level is None:
        return {"status": "ERROR", "reason": "Choose a strike and a key level."}
    chain = payload.get("option_chain")
    row = _row(chain, strike, kind, next_open(now).date()) or {}
    premium = number(payload.get("premium"))
    spot = number(payload.get("spot")) or number((chain or {}).get("spot"))
    if spot is None:
        return {"status": "ERROR", "reason": "The index price is unavailable; enter it."}
    if premium is None:
        premium = number(row.get("premium"))
    if premium is None:
        return {"status": "ERROR", "reason": f"No premium for {strike:.0f} {kind} in the option chain; enter one."}
    result = estimate(spot, key_level, kind, strike, premium, payload.get("expiry") or row.get("expiry"), now,
                      iv=number(row.get("iv")), bid=number(payload.get("bid")) if payload.get("bid") is not None else number(row.get("bid")),
                      ask=number(payload.get("ask")) if payload.get("ask") is not None else number(row.get("ask")),
                      iv_change=number(payload.get("iv_change")))
    if result.get("status") == "READY":
        result["symbol"] = str(payload.get("symbol", "")).upper() or None
        result["contract"] = row.get("symbol")
        result["inputs"]["premium_source"] = "your input" if number(payload.get("premium")) is not None else "option chain"
        result["inputs"]["spot_source"] = "your input" if number(payload.get("spot")) is not None else "option chain"
    return result


def main() -> None:
    print(json.dumps(analyze_payload(json.load(sys.stdin))))


if __name__ == "__main__":
    main()
