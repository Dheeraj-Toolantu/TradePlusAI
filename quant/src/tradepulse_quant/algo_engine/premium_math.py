"""Index move vs option premium: does the key level pay the premium target, and is it likely?

One pricing model drives every figure. Black-Scholes with the contract's own strike and expiry,
an explicit risk-free rate (``PremiumConfig.rate``), and a volatility implied from the entry
premium itself, so the model reprices the entry exactly. The volatility scenario is stated:
that implied vol plus ``iv_change`` vol points, over a hold of ``hold_days``. The chain's IV and
delta are reported next to the model's, never mixed into it.

For an option bought at premium E with the index at S0 and a key level K:

* Move to the key level: |K - S0| points and |K - S0| / S0 x 100 %.
* Required premium (the 50% option premium gain rule): E x (1 + gain). Stop: E x (1 - stop_pct)
  unless the strategy passes its structural stop; exit target: the required premium unless the
  strategy passes its own.
* Index move for the required premium:
  - delta only, first order: (required - E) / |delta| (the chain's delta when it has one);
  - Greeks: |delta| x + 1/2 gamma x^2 + vega dIV + theta dt = required - E, solved for x;
  - full repricing: the x at which the model premium at S0 +/- x, time left T - dt and vol
    sigma + dIV equals the required premium.
* Premium at the key level: the Greeks expansion at x = |K - S0| and the full reprice V(K);
  the premium return at the key level is (V(K) - E) / E x 100.
* Reward-to-risk, gross (T - E) / (E - stop) and net of brokerage, STT, exchange and SEBI fees,
  stamp duty, GST, slippage and half the bid-ask spread on each side, for one lot.
* Possible vs likely. Possible: V(K) >= the required premium, i.e. reaching K pays the target.
  Likely: the chance the index touches K at all, from the same vol (driftless lognormal,
  P(touch) = 2 N(-|ln(K/S0)| / (sigma sqrt(tau)))), over the rest of the session and to expiry.

Blocking checks: the key level pays the target (full reprice), net reward-to-risk, spread and
liquidity. The touch probability is reported and flagged, not blocking.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, datetime, time

YEAR_DAYS = 365.0
TRADING_DAYS = 252.0
SESSION_MINUTES = 375.0  # 09:15-15:30


@dataclass(frozen=True)
class PremiumConfig:
    target_gain: float = 0.50  # required premium = entry x 1.5
    stop_pct: float = 0.25  # default stop premium = entry x 0.75
    min_rr: float = 2.0  # on the net (after-cost) reward-to-risk
    max_spread_pct: float = 0.05  # (ask - bid) / premium
    min_liquidity: int = 2
    rate: float = 0.065  # annual risk-free rate used in every model figure (about the 91-day T-bill)
    hold_days: float = 0.25  # time decay charged for an intraday hold (about 1.5 trading hours)
    iv_change: float = 0.0  # vol points added to the implied vol in the key-level scenario
    likely_touch: float = 0.40  # session touch probability at or above this reads as "likely"
    # Costs per order (Indian index options, discount broker).
    brokerage_per_order: float = 20.0
    stt_sell_pct: float = 0.001  # 0.1% of the sell premium
    exchange_pct: float = 0.0003503  # NSE transaction charge on premium turnover
    sebi_pct: float = 0.000001  # Rs 10 per crore
    stamp_buy_pct: float = 0.00003  # 0.003% of the buy premium
    gst_pct: float = 0.18  # on brokerage + exchange + SEBI
    slippage_pct: float = 0.005  # per side, beyond the quoted spread
    default_lot: int = 65


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


def session_years(now: datetime) -> float:
    """Trading time left in today's session (a full session before the open or after the close)."""
    minutes = (datetime.combine(now.date(), time(15, 30), tzinfo=now.tzinfo) - now).total_seconds() / 60.0
    if minutes <= 0 or minutes > SESSION_MINUTES:
        minutes = SESSION_MINUTES
    return minutes / SESSION_MINUTES / TRADING_DAYS


def _d1(spot: float, strike: float, years: float, sigma: float, rate: float) -> float:
    return (math.log(spot / strike) + (rate + 0.5 * sigma * sigma) * years) / (sigma * math.sqrt(years))


def bs_price(spot: float, strike: float, years: float, sigma: float, kind: str, rate: float = 0.0) -> float:
    if years <= 0 or sigma <= 0:
        return max(0.0, spot - strike) if kind == "CE" else max(0.0, strike - spot)
    d1 = _d1(spot, strike, years, sigma, rate)
    d2 = d1 - sigma * math.sqrt(years)
    discount = math.exp(-rate * years)
    return spot * _cdf(d1) - strike * discount * _cdf(d2) if kind == "CE" else strike * discount * _cdf(-d2) - spot * _cdf(-d1)


def bs_greeks(spot: float, strike: float, years: float, sigma: float, kind: str, rate: float = 0.0) -> dict:
    """delta (per point), gamma (per point^2), vega (per vol point), theta (per calendar day)."""
    root = math.sqrt(years)
    d1 = _d1(spot, strike, years, sigma, rate)
    d2 = d1 - sigma * root
    density = _pdf(d1)
    discount = math.exp(-rate * years)
    decay = -spot * density * sigma / (2.0 * root)
    carry = -rate * strike * discount * _cdf(d2) if kind == "CE" else rate * strike * discount * _cdf(-d2)
    return {
        "delta": _cdf(d1) if kind == "CE" else _cdf(d1) - 1.0,
        "gamma": density / (spot * sigma * root),
        "vega": spot * density * root / 100.0,
        "theta": (decay + carry) / YEAR_DAYS,
    }


def implied_vol(price: float, spot: float, strike: float, years: float, kind: str, rate: float = 0.0) -> float | None:
    """Volatility at which the model reprices ``price`` (bisection, 1%-300%)."""
    low, high = 0.01, 3.0
    if not (bs_price(spot, strike, years, low, kind, rate) <= price <= bs_price(spot, strike, years, high, kind, rate)):
        return None
    for _ in range(80):
        mid = 0.5 * (low + high)
        if bs_price(spot, strike, years, mid, kind, rate) > price:
            high = mid
        else:
            low = mid
    return 0.5 * (low + high)


def touch_probability(spot: float, level: float, sigma: float, years: float) -> float | None:
    """Chance a driftless lognormal index touches ``level`` within ``years`` (reflection principle)."""
    if spot <= 0 or level <= 0 or sigma <= 0 or years <= 0:
        return None
    return min(1.0, 2.0 * _cdf(-abs(math.log(level / spot)) / (sigma * math.sqrt(years))))


def _move_for(gain: float, delta: float, gamma: float, carry: float) -> float | None:
    """Smallest x >= 0 with |delta| x + 1/2 gamma x^2 + carry = gain."""
    need = gain - carry
    if need <= 0:
        return 0.0
    if gamma <= 1e-12:
        return need / delta if delta > 0 else None
    return (-delta + math.sqrt(delta * delta + 2.0 * gamma * need)) / gamma


def round_trip_costs(entry: float, exit_: float, quantity: int, half_spread: float, config: PremiumConfig) -> dict:
    """Rupee costs of buying ``quantity`` at ``entry`` and selling at ``exit_``."""
    buy, sell = entry * quantity, exit_ * quantity
    brokerage = 2.0 * config.brokerage_per_order
    exchange = config.exchange_pct * (buy + sell)
    sebi = config.sebi_pct * (buy + sell)
    parts = {
        "brokerage": brokerage, "stt": config.stt_sell_pct * sell, "exchange": exchange, "sebi": sebi,
        "stamp": config.stamp_buy_pct * buy, "gst": config.gst_pct * (brokerage + exchange + sebi),
        "slippage": config.slippage_pct * (buy + sell), "spread": 2.0 * half_spread * quantity,
    }
    total = sum(parts.values())
    return {**{key: round(value, 2) for key, value in parts.items()}, "total": round(total, 2), "per_unit": round(total / quantity, 3)}


def evaluate(spot: float, key_level: float, option_type: str, strike: float, entry: float, expiry: object, now: datetime,
             iv: float | None = None, delta: float | None = None, bid: float | None = None, ask: float | None = None,
             liquidity: int | None = None, stop: float | None = None, target: float | None = None, lot_size: int | None = None,
             config: PremiumConfig | None = None) -> dict:
    """Premium-target calculator for one option against one key level (see the module docstring)."""
    config = config or PremiumConfig()
    direction = 1 if option_type == "CE" else -1
    move_points = abs(key_level - spot)
    toward = (key_level - spot) * direction > 0
    required = entry * (1.0 + config.target_gain)
    target_premium = target if target is not None else required
    stop_premium = stop if stop is not None else entry * (1.0 - config.stop_pct)
    out: dict = {
        "spot": round(spot, 2), "key_level": round(key_level, 2), "move_points": round(move_points, 1),
        "move_pct": round(move_points / spot * 100.0, 3) if spot > 0 else None,
        "entry": round(entry, 2), "target_gain_pct": round(config.target_gain * 100.0, 1), "stop_pct": round(config.stop_pct * 100.0, 1),
        "required_premium": round(required, 2), "percent_target": round(required, 2), "percent_stop": round(entry * (1.0 - config.stop_pct), 2),
        "target_premium": round(target_premium, 2), "stop_premium": round(stop_premium, 2),
        "return_pct": round((target_premium - entry) / entry * 100.0, 1) if entry > 0 else None,
        "risk_reward": round((target_premium - entry) / (entry - stop_premium), 2) if entry > stop_premium else None,
    }

    # ---- one model, one set of inputs -------------------------------------------------
    years = years_to_expiry(expiry, now)
    chain_sigma = (iv or 0.0) / 100.0
    sigma = implied_vol(entry, spot, strike, years, option_type, config.rate) if years and spot > 0 and strike > 0 and entry > 0 else None
    vol_source = "implied from the entry premium"
    if sigma is None and chain_sigma > 0:
        sigma, vol_source = chain_sigma, "chain IV (the entry premium could not be implied)"
    hold = config.hold_days / YEAR_DAYS
    scenario_sigma = sigma + config.iv_change / 100.0 if sigma else None
    out["model"] = {
        "name": "Black-Scholes (European, no dividends)", "strike": strike, "expiry": str(expiry or "")[:10] or None,
        "days_to_expiry": round(years * YEAR_DAYS, 2) if years else None, "rate_pct": round(config.rate * 100.0, 2),
        "iv_pct": round(sigma * 100.0, 2) if sigma else None, "iv_source": vol_source if sigma else None,
        "chain_iv_pct": iv, "chain_delta": delta,
        "scenario": {"iv_change_points": config.iv_change, "scenario_iv_pct": round(scenario_sigma * 100.0, 2) if scenario_sigma else None,
                     "hold_days": config.hold_days, "days_left_at_key": round(max(years - hold, 0.0) * YEAR_DAYS, 2) if years else None},
    }
    greeks = bs_greeks(spot, strike, years, sigma, option_type, config.rate) if years and sigma else None
    model_delta = abs(greeks["delta"]) if greeks else None
    chain_delta = abs(delta) if delta and 0 < abs(delta) < 1 else None
    first_order_delta = chain_delta or model_delta
    gain = required - entry
    out["greeks"] = {"delta": round(model_delta * direction, 4) if model_delta else None,
                     "gamma": round(greeks["gamma"], 6) if greeks else None, "vega": round(greeks["vega"], 3) if greeks else None,
                     "theta": round(greeks["theta"], 3) if greeks else None,
                     # Kept for the panel: the scenario the Greeks figures are charged with.
                     "iv": round(sigma * 100.0, 2) if sigma else iv, "days_to_expiry": round(years * YEAR_DAYS, 2) if years else None,
                     "hold_days": config.hold_days, "iv_change": config.iv_change}
    out["delta_only_source"] = "chain delta" if chain_delta else "model delta" if model_delta else None
    out["move_needed_delta"] = round(gain / first_order_delta, 1) if first_order_delta and gain > 0 else None
    carry = greeks["vega"] * config.iv_change + greeks["theta"] * config.hold_days if greeks else 0.0
    needed_greeks = _move_for(gain, model_delta, greeks["gamma"], carry) if greeks else None
    out["move_needed_greeks"] = round(needed_greeks, 1) if needed_greeks is not None else None

    def reprice(level: float) -> float:
        return bs_price(level, strike, max(years - hold, 1e-6), scenario_sigma, option_type, config.rate)

    needed_model = None
    if greeks and scenario_sigma:
        far = spot * 0.25
        if reprice(spot + direction * far) >= required:
            low, high = 0.0, far
            if reprice(spot) >= required:
                high = 0.0
            for _ in range(60):
                mid = 0.5 * (low + high)
                if reprice(spot + direction * mid) >= required:
                    high = mid
                else:
                    low = mid
            needed_model = high
    out["move_needed_model"] = round(needed_model, 1) if needed_model is not None else None
    for key, value in (("index_target_delta", out["move_needed_delta"]), ("index_target_greeks", out["move_needed_greeks"]), ("index_target_model", out["move_needed_model"])):
        out[key] = round(spot + direction * value, 1) if value is not None else None

    x = move_points if toward else -move_points
    out["premium_at_key_greeks"] = round(max(0.0, entry + model_delta * x + 0.5 * greeks["gamma"] * x * x + carry), 2) if greeks else None
    out["premium_at_key_model"] = round(reprice(key_level), 2) if greeks and scenario_sigma else None
    out["return_at_key_pct"] = round((out["premium_at_key_model"] - entry) / entry * 100.0, 2) if out["premium_at_key_model"] is not None and entry > 0 else None

    # ---- possible vs likely ------------------------------------------------------------
    possible = bool(toward and out["premium_at_key_model"] is not None and out["premium_at_key_model"] >= required)
    touch_session = touch_probability(spot, key_level, sigma, session_years(now)) if sigma and toward else None
    touch_expiry = touch_probability(spot, key_level, sigma, years) if sigma and years and toward else None
    likely = touch_session is not None and touch_session >= config.likely_touch
    out["target_possible"] = possible
    out["touch_probability_session"] = round(touch_session, 3) if touch_session is not None else None
    out["touch_probability_expiry"] = round(touch_expiry, 3) if touch_expiry is not None else None
    out["key_level_likely"] = likely
    out["target_likely"] = bool(possible and likely)

    # ---- costs and net reward-to-risk --------------------------------------------------
    quantity = int(lot_size) if lot_size and lot_size > 0 else config.default_lot
    half_spread = (ask - bid) / 2.0 if bid is not None and ask is not None and ask >= bid else 0.0
    at_target = round_trip_costs(entry, target_premium, quantity, half_spread, config)
    at_stop = round_trip_costs(entry, stop_premium, quantity, half_spread, config)
    net_reward = target_premium - entry - at_target["per_unit"]
    net_risk = entry - stop_premium + at_stop["per_unit"]
    out["costs"] = {"quantity": quantity, "lot_assumed": not (lot_size and lot_size > 0), "at_target": at_target, "at_stop": at_stop}
    out["net_reward"] = round(net_reward, 2)
    out["net_risk"] = round(net_risk, 2)
    out["net_risk_reward"] = round(net_reward / net_risk, 2) if net_risk > 0 else None

    spread_pct = (ask - bid) / entry if bid is not None and ask is not None and entry > 0 and ask >= bid else None
    out["spread_pct"] = round(spread_pct * 100.0, 2) if spread_pct is not None else None
    if not toward:
        key_detail = f"Key level {key_level:.0f} is not on the {option_type} side of the index"
    elif out["premium_at_key_model"] is None:
        key_detail = "No volatility for the model; cannot reprice the option at the key level"
    else:
        key_detail = (f"At {key_level:.0f} the model prices it at ₹{out['premium_at_key_model']:.2f} ({out['return_at_key_pct']:+.1f}%), "
                      f"{'at or above' if possible else 'below'} the ₹{required:.2f} needed for a {config.target_gain:.0%} option premium gain")
    checks = [
        {"id": "KEY_LEVEL_PAYS_TARGET", "passed": possible, "blocking": True, "detail": key_detail},
        {"id": "REWARD_RISK", "passed": out["net_risk_reward"] is not None and out["net_risk_reward"] >= config.min_rr, "blocking": True,
         "detail": f"Net reward-to-risk {out['net_risk_reward'] if out['net_risk_reward'] is not None else '--'} after ₹{at_target['total']:.0f} costs (gross {out['risk_reward']}; minimum {config.min_rr:g} net)"},
        {"id": "SPREAD", "passed": spread_pct is None or spread_pct <= config.max_spread_pct, "blocking": True,
         "detail": f"Bid-ask spread {out['spread_pct']}% of premium (max {config.max_spread_pct * 100:g}%)" if spread_pct is not None else "No bid/ask; spread not checked"},
        {"id": "LIQUIDITY", "passed": liquidity is None or liquidity >= config.min_liquidity, "blocking": True,
         "detail": f"Liquidity score {liquidity if liquidity is not None else '--'}/3 (minimum {config.min_liquidity})"},
        {"id": "TARGET_LIKELY", "passed": out["target_likely"], "blocking": False,
         "detail": (f"Target {'possible' if possible else 'not possible'} at {key_level:.0f}; chance the index touches it today {touch_session:.0%}, before expiry {touch_expiry:.0%} (likely at {config.likely_touch:.0%} today)"
                    if touch_session is not None and touch_expiry is not None else "Touch probability unavailable")},
    ]
    out["checks"] = checks
    out["valid"] = all(check["passed"] for check in checks if check["blocking"])
    out["reason"] = ("Premium target is reachable at the key level" if out["valid"]
                     else "; ".join(check["detail"] for check in checks if check["blocking"] and not check["passed"]))
    return out
