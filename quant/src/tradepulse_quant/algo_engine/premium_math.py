"""Index move vs option premium: does the key level pay the premium target?

For an option bought at premium E with the index at S0 and a key level K:

* Move to the key level: |K - S0| points, |K - S0| / S0 x 100 %.
* Premium target and stop: T = E x (1 + gain), stop = E x (1 - stop_pct); reward-to-risk
  = (T - E) / (E - stop). Defaults: +50% target, 25% stop (2:1).
* Index move needed for T, first order (delta only): x = (T - E) / |delta|.
* Index move needed for T with Greeks: dV = |delta| x + 1/2 gamma x^2 + vega dIV + theta dt,
  solved for x (dIV in vol points, dt in days held).
* Premium at the key level: the same Greeks expansion at x = |K - S0|, and a Black-Scholes
  reprice at K with the time left after dt (the pricing-model check).

The trade is valid only if the key level is at least as far as the Greeks move needed for the
target (the level can pay the target), reward-to-risk meets the minimum, the bid-ask spread is
tight enough, and the strike is liquid. Rates are taken as zero; Greeks are Black-Scholes on the
chain IV and the contract's expiry, with the chain's own delta when it has one.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, datetime

YEAR_DAYS = 365.0


@dataclass(frozen=True)
class PremiumConfig:
    target_gain: float = 0.50  # target premium = entry x 1.5
    stop_pct: float = 0.25  # stop premium = entry x 0.75
    min_rr: float = 2.0
    max_spread_pct: float = 0.05  # (ask - bid) / premium
    min_liquidity: int = 2
    hold_days: float = 0.25  # time decay charged for an intraday hold (about 1.5 trading hours)
    iv_change: float = 0.0  # vol points assumed between entry and the key level


def number(value: object) -> float | None:
    """A finite float, or None for missing or non-numeric chain fields."""
    try:
        result = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _cdf(value: float) -> float:
    return 0.5 * (1.0 + math.erf(value / math.sqrt(2.0)))


def _pdf(value: float) -> float:
    return math.exp(-0.5 * value * value) / math.sqrt(2.0 * math.pi)


def years_to_expiry(expiry: object, now: datetime) -> float | None:
    try:
        day = date.fromisoformat(str(expiry)[:10])
    except ValueError:
        return None
    close = datetime(day.year, day.month, day.day, 15, 30, tzinfo=now.tzinfo)
    return max((close - now).total_seconds(), 1800.0) / (YEAR_DAYS * 86400.0)


def bs_price(spot: float, strike: float, years: float, sigma: float, kind: str) -> float:
    if years <= 0 or sigma <= 0:
        return max(0.0, spot - strike) if kind == "CE" else max(0.0, strike - spot)
    d1 = (math.log(spot / strike) + 0.5 * sigma * sigma * years) / (sigma * math.sqrt(years))
    d2 = d1 - sigma * math.sqrt(years)
    return spot * _cdf(d1) - strike * _cdf(d2) if kind == "CE" else strike * _cdf(-d2) - spot * _cdf(-d1)


def bs_greeks(spot: float, strike: float, years: float, sigma: float, kind: str) -> dict:
    """delta (per point), gamma (per point^2), vega (per vol point), theta (per calendar day)."""
    root = math.sqrt(years)
    d1 = (math.log(spot / strike) + 0.5 * sigma * sigma * years) / (sigma * root)
    density = _pdf(d1)
    return {
        "delta": _cdf(d1) if kind == "CE" else _cdf(d1) - 1.0,
        "gamma": density / (spot * sigma * root),
        "vega": spot * density * root / 100.0,
        "theta": -spot * density * sigma / (2.0 * root) / YEAR_DAYS,
    }


def _move_for(gain: float, delta: float, gamma: float, carry: float) -> float | None:
    """Smallest x >= 0 with |delta| x + 1/2 gamma x^2 + carry = gain."""
    need = gain - carry
    if need <= 0:
        return 0.0
    if gamma <= 1e-12:
        return need / delta if delta > 0 else None
    return (-delta + math.sqrt(delta * delta + 2.0 * gamma * need)) / gamma


def evaluate(spot: float, key_level: float, option_type: str, strike: float, entry: float, expiry: object, now: datetime,
             iv: float | None = None, delta: float | None = None, bid: float | None = None, ask: float | None = None,
             liquidity: int | None = None, stop: float | None = None, target: float | None = None,
             config: PremiumConfig | None = None) -> dict:
    """Premium-target calculator for one option against one key level.

    ``stop``/``target`` override the percentage defaults (the strategy passes its structural stop);
    the percentage targets are always reported alongside.
    """
    config = config or PremiumConfig()
    direction = 1 if option_type == "CE" else -1
    move_points = abs(key_level - spot)
    toward = (key_level - spot) * direction > 0
    out: dict = {
        "spot": round(spot, 2), "key_level": round(key_level, 2), "move_points": round(move_points, 1),
        "move_pct": round(move_points / spot * 100.0, 3) if spot > 0 else None,
        "entry": round(entry, 2), "target_gain_pct": round(config.target_gain * 100.0, 1), "stop_pct": round(config.stop_pct * 100.0, 1),
        "percent_target": round(entry * (1.0 + config.target_gain), 2), "percent_stop": round(entry * (1.0 - config.stop_pct), 2),
    }
    target_premium = target if target is not None else out["percent_target"]
    stop_premium = stop if stop is not None else out["percent_stop"]
    out.update({"target_premium": round(target_premium, 2), "stop_premium": round(stop_premium, 2),
                "return_pct": round((target_premium - entry) / entry * 100.0, 1) if entry > 0 else None,
                "risk_reward": round((target_premium - entry) / (entry - stop_premium), 2) if entry > stop_premium else None})

    years = years_to_expiry(expiry, now)
    sigma = (iv or 0.0) / 100.0
    greeks = bs_greeks(spot, strike, years, sigma, option_type) if years and sigma > 0 and spot > 0 and strike > 0 else None
    abs_delta = abs(delta) if delta and 0 < abs(delta) < 1 else abs(greeks["delta"]) if greeks else None
    gain = target_premium - entry
    out["greeks"] = {"delta": round(abs_delta * direction, 3) if abs_delta else None,
                     "gamma": round(greeks["gamma"], 6) if greeks else None, "vega": round(greeks["vega"], 3) if greeks else None,
                     "theta": round(greeks["theta"], 3) if greeks else None, "iv": iv, "days_to_expiry": round(years * YEAR_DAYS, 2) if years else None,
                     "hold_days": config.hold_days, "iv_change": config.iv_change}
    out["move_needed_delta"] = round(gain / abs_delta, 1) if abs_delta and gain > 0 else None
    carry = (greeks["vega"] * config.iv_change + greeks["theta"] * config.hold_days) if greeks else 0.0
    needed = _move_for(gain, abs_delta, greeks["gamma"], carry) if abs_delta and greeks else out["move_needed_delta"]
    out["move_needed_greeks"] = round(needed, 1) if needed is not None else None
    out["index_target_delta"] = round(spot + direction * out["move_needed_delta"], 1) if out["move_needed_delta"] is not None else None
    out["index_target_greeks"] = round(spot + direction * needed, 1) if needed is not None else None
    if abs_delta:
        x = move_points if toward else -move_points
        greek_change = abs_delta * x + (0.5 * greeks["gamma"] * x * x + carry if greeks else 0.0)
        out["premium_at_key_greeks"] = round(max(0.0, entry + greek_change), 2)
    else:
        out["premium_at_key_greeks"] = None
    if greeks and years:
        # Reprice at the key level, scaled to the observed entry (chain IV vs the traded premium).
        model_now = bs_price(spot, strike, years, sigma, option_type)
        model_key = bs_price(key_level, strike, max(years - config.hold_days / YEAR_DAYS, 1e-6), sigma + config.iv_change / 100.0, option_type)
        out["premium_at_key_model"] = round(max(0.0, entry + model_key - model_now), 2)
    else:
        out["premium_at_key_model"] = None

    spread_pct = (ask - bid) / entry if bid is not None and ask is not None and entry > 0 and ask >= bid else None
    out["spread_pct"] = round(spread_pct * 100.0, 2) if spread_pct is not None else None
    checks = [
        {"id": "KEY_LEVEL_PAYS_TARGET", "passed": bool(toward and needed is not None and needed <= move_points),
         "detail": (f"Key level is {move_points:.0f} pts away; the premium needs about {needed:.0f} pts (Greeks) to reach ₹{target_premium:.2f}"
                    if needed is not None else "Delta is unavailable; cannot size the move to the premium target")},
        {"id": "REWARD_RISK", "passed": out["risk_reward"] is not None and out["risk_reward"] >= config.min_rr,
         "detail": f"Reward-to-risk {out['risk_reward'] if out['risk_reward'] is not None else '--'} (minimum {config.min_rr:g})"},
        {"id": "SPREAD", "passed": spread_pct is None or spread_pct <= config.max_spread_pct,
         "detail": f"Bid-ask spread {out['spread_pct']}% of premium (max {config.max_spread_pct * 100:g}%)" if spread_pct is not None else "No bid/ask; spread not checked"},
        {"id": "LIQUIDITY", "passed": liquidity is None or liquidity >= config.min_liquidity,
         "detail": f"Liquidity score {liquidity if liquidity is not None else '--'}/3 (minimum {config.min_liquidity})"},
    ]
    out["checks"] = checks
    out["valid"] = all(check["passed"] for check in checks)
    out["reason"] = "Premium target is reachable at the key level" if out["valid"] else "; ".join(check["detail"] for check in checks if not check["passed"])
    return out
