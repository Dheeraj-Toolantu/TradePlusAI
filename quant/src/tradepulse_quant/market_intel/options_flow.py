"""Option-chain positioning and 5-minute OI flow.

Price/OI activity per strike and side (standard F&O reading):

    OI up   + premium up   -> LONG_BUILDUP   (option buyers adding)
    OI up   + premium down -> SHORT_BUILDUP  (option WRITERS adding)
    OI down + premium up   -> SHORT_COVERING (writers exiting)
    OI down + premium down -> LONG_UNWINDING (buyers exiting)

Call writing (CE short build-up) caps the upside -> bearish/resistance.
Put writing (PE short build-up) supports the downside -> bullish/support.

Spec §9: absolute PCR alone is never a signal; the direction score is built from OI
*change* near ATM. All thresholds are initial values that must be backtested.
"""
from __future__ import annotations

from dataclasses import dataclass

NEAR_ATM_STRIKES = 5
OI_CHANGE_MIN_FRACTION = 0.005  # ignore OI changes smaller than 0.5% of the strike's OI
PRICE_CHANGE_MIN_FRACTION = 0.005

BULLISH_WEIGHTS = {("PE", "SHORT_BUILDUP"): 1.0, ("CE", "SHORT_COVERING"): 1.0, ("CE", "LONG_BUILDUP"): 0.5, ("PE", "LONG_UNWINDING"): 0.5}
BEARISH_WEIGHTS = {("CE", "SHORT_BUILDUP"): 1.0, ("PE", "SHORT_COVERING"): 1.0, ("PE", "LONG_BUILDUP"): 0.5, ("CE", "LONG_UNWINDING"): 0.5}

ACTIVITY_TEXT = {
    ("CE", "SHORT_BUILDUP"): "Call writing (resistance building)",
    ("CE", "LONG_BUILDUP"): "Call buying",
    ("CE", "SHORT_COVERING"): "Call short covering (resistance weakening)",
    ("CE", "LONG_UNWINDING"): "Call longs exiting",
    ("PE", "SHORT_BUILDUP"): "Put writing (support building)",
    ("PE", "LONG_BUILDUP"): "Put buying",
    ("PE", "SHORT_COVERING"): "Put short covering (support weakening)",
    ("PE", "LONG_UNWINDING"): "Put longs exiting",
}


@dataclass(frozen=True)
class Leg:
    ltp: float
    oi: float
    volume: float
    iv: float | None
    delta: float | None
    trading_symbol: str


def _num(value: object) -> float | None:
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return number if number == number and abs(number) != float("inf") else None


def _leg(raw: object) -> Leg | None:
    if not isinstance(raw, dict):
        return None
    ltp = _num(raw.get("ltp"))
    oi = _num(raw.get("oi", raw.get("open_interest")))
    if ltp is None or oi is None or ltp < 0 or oi < 0:
        return None
    return Leg(ltp, oi, _num(raw.get("volume")) or 0.0, _num(raw.get("iv")), _num(raw.get("delta")), str(raw.get("trading_symbol") or raw.get("symbol") or ""))


def parse_chain(rows: object) -> dict[float, dict[str, Leg]]:
    chain: dict[float, dict[str, Leg]] = {}
    for row in rows or []:  # type: ignore[union-attr]
        if not isinstance(row, dict):
            continue
        strike = _num(row.get("strike"))
        if strike is None or strike <= 0:
            continue
        sides = {side: leg for side in ("CE", "PE") if (leg := _leg(row.get(side.lower(), row.get(side)))) is not None}
        if sides:
            chain[strike] = sides
    return dict(sorted(chain.items()))


def classify(oi_change: float, price_change: float, oi: float, price: float) -> str:
    if abs(oi_change) < max(oi * OI_CHANGE_MIN_FRACTION, 1.0):
        return "NEUTRAL"
    if abs(price_change) < max(price * PRICE_CHANGE_MIN_FRACTION, 0.05):
        return "WRITING_FLAT" if oi_change > 0 else "NEUTRAL"
    if oi_change > 0:
        return "LONG_BUILDUP" if price_change > 0 else "SHORT_BUILDUP"
    return "SHORT_COVERING" if price_change > 0 else "LONG_UNWINDING"


def max_pain(chain: dict[float, dict[str, Leg]]) -> float | None:
    strikes = list(chain)
    if not strikes:
        return None
    best, best_pain = None, None
    for settle in strikes:
        pain = 0.0
        for strike, sides in chain.items():
            if "CE" in sides:
                pain += sides["CE"].oi * max(settle - strike, 0.0)
            if "PE" in sides:
                pain += sides["PE"].oi * max(strike - settle, 0.0)
        if best_pain is None or pain < best_pain:
            best, best_pain = settle, pain
    return best


def participation(premium_change: float, spot_change: float, delta: float | None, spot: float) -> float | None:
    """Spec §8 ORS, delta-normalised: actual premium change / delta-implied change.

    1.0 = the option moved exactly as its delta implied; >1.3 strong; <0.8 lagging.
    Undefined when the underlying barely moved (noise) or delta is unknown.
    """
    if delta is None or abs(delta) < 0.05 or abs(spot_change) < max(spot * 0.0005, 2.0):
        return None
    return premium_change / (abs(delta) * abs(spot_change))


def _nearest(strikes: list[float], spot: float) -> float:
    return min(strikes, key=lambda strike: (abs(strike - spot), strike))


def analyze_options_flow(chain_rows: object, spot: float, baseline_rows: object = None, baseline_spot: float | None = None, baseline_age_seconds: float | None = None) -> dict:
    chain = parse_chain(chain_rows)
    if not chain or spot <= 0:
        return {"available": False, "reason": "Option chain unavailable"}
    strikes = list(chain)
    atm = _nearest(strikes, spot)
    step = min((b - a for a, b in zip(strikes, strikes[1:]) if b > a), default=0.0)
    atm_position = strikes.index(atm)
    near = strikes[max(atm_position - NEAR_ATM_STRIKES, 0):atm_position + NEAR_ATM_STRIKES + 1]

    def total(side: str, field: str, subset: list[float] | None = None) -> float:
        return sum(getattr(chain[strike][side], field) for strike in (subset or strikes) if side in chain[strike])

    ce_oi, pe_oi = total("CE", "oi"), total("PE", "oi")
    ce_vol, pe_vol = total("CE", "volume"), total("PE", "volume")
    pcr_oi = pe_oi / ce_oi if ce_oi > 0 else None
    pcr_volume = pe_vol / ce_vol if ce_vol > 0 else None
    near_ce, near_pe = total("CE", "oi", near), total("PE", "oi", near)
    pcr_near = near_pe / near_ce if near_ce > 0 else None

    above = [s for s in strikes if s >= spot - step / 2 and "CE" in chain[s]]
    below = [s for s in strikes if s <= spot + step / 2 and "PE" in chain[s]]
    resistances = sorted(above, key=lambda s: chain[s]["CE"].oi, reverse=True)[:2]
    supports = sorted(below, key=lambda s: chain[s]["PE"].oi, reverse=True)[:2]

    baseline = parse_chain(baseline_rows) if baseline_rows else {}
    has_baseline = bool(baseline)
    rows: list[dict] = []
    bull_pressure = bear_pressure = 0.0
    ce_change_total = pe_change_total = 0.0
    call_writing: list[dict] = []
    put_writing: list[dict] = []
    for strike in near:
        row: dict = {"strike": strike, "is_atm": strike == atm}
        for side in ("CE", "PE"):
            leg = chain[strike].get(side)
            prior = baseline.get(strike, {}).get(side) if has_baseline else None
            key = side.lower()
            row[f"{key}_oi"] = leg.oi if leg else None
            row[f"{key}_ltp"] = leg.ltp if leg else None
            row[f"{key}_iv"] = leg.iv if leg else None
            row[f"{key}_symbol"] = leg.trading_symbol if leg else None
            if leg is None or prior is None:
                row[f"{key}_oi_change"] = None
                row[f"{key}_ltp_change"] = None
                row[f"{key}_activity"] = None
                continue
            oi_change = leg.oi - prior.oi
            ltp_change = leg.ltp - prior.ltp
            activity = classify(oi_change, ltp_change, prior.oi, prior.ltp)
            if activity == "WRITING_FLAT":
                activity = "SHORT_BUILDUP"
            row[f"{key}_oi_change"] = oi_change
            row[f"{key}_ltp_change"] = round(ltp_change, 2)
            row[f"{key}_activity"] = activity
            row[f"{key}_activity_text"] = ACTIVITY_TEXT.get((side, activity), "No meaningful change")
            if side == "CE":
                ce_change_total += oi_change
            else:
                pe_change_total += oi_change
            bull_pressure += abs(oi_change) * BULLISH_WEIGHTS.get((side, activity), 0.0)
            bear_pressure += abs(oi_change) * BEARISH_WEIGHTS.get((side, activity), 0.0)
            if activity == "SHORT_BUILDUP":
                (call_writing if side == "CE" else put_writing).append({"strike": strike, "oi_change": oi_change})
        rows.append(row)

    pcr_change = None
    if has_baseline:
        base_ce = sum(legs["CE"].oi for legs in baseline.values() if "CE" in legs)
        base_pe = sum(legs["PE"].oi for legs in baseline.values() if "PE" in legs)
        if base_ce > 0 and pcr_oi is not None:
            pcr_change = pcr_oi - base_pe / base_ce

    direction_score: int | None = None
    direction_label = "Building 5-minute baseline"
    flow_ratio = None
    if has_baseline:
        activity_total = bull_pressure + bear_pressure
        near_oi = max(near_ce + near_pe, 1.0)
        if activity_total < near_oi * 0.002:
            direction_score, direction_label, flow_ratio = 0, "Quiet: no meaningful writer activity in 5 minutes", 0.0
        else:
            flow_ratio = (bull_pressure - bear_pressure) / activity_total
            pcr_agrees_bull = pcr_change is None or pcr_change >= 0
            pcr_agrees_bear = pcr_change is None or pcr_change <= 0
            if flow_ratio >= 0.5 and pcr_agrees_bull:
                direction_score, direction_label = 2, "Strongly bullish: put writers adding / call writers covering"
            elif flow_ratio >= 0.2:
                direction_score, direction_label = 1, "Bullish: put-side writing outweighs call-side writing"
            elif flow_ratio <= -0.5 and pcr_agrees_bear:
                direction_score, direction_label = -2, "Strongly bearish: call writers adding / put writers covering"
            elif flow_ratio <= -0.2:
                direction_score, direction_label = -1, "Bearish: call-side writing outweighs put-side writing"
            else:
                direction_score, direction_label = 0, "Neutral: writers active on both sides"

    ors_call = ors_put = None
    if has_baseline and baseline_spot:
        spot_change = spot - baseline_spot
        atm_prior = baseline.get(atm, {})
        if spot_change > 0 and "CE" in chain[atm] and "CE" in atm_prior:
            ors_call = participation(chain[atm]["CE"].ltp - atm_prior["CE"].ltp, spot_change, chain[atm]["CE"].delta, spot)
        if spot_change < 0 and "PE" in chain[atm] and "PE" in atm_prior:
            ors_put = participation(chain[atm]["PE"].ltp - atm_prior["PE"].ltp, spot_change, chain[atm]["PE"].delta, spot)

    atm_iv_values = [leg.iv for leg in chain[atm].values() if leg.iv]
    return {
        "available": True,
        "atm_strike": atm,
        "strike_step": step,
        "pcr_oi": pcr_oi,
        "pcr_volume": pcr_volume,
        "pcr_near_atm": pcr_near,
        "pcr_change_5m": pcr_change,
        "total_ce_oi": ce_oi,
        "total_pe_oi": pe_oi,
        "ce_oi_change_5m": ce_change_total if has_baseline else None,
        "pe_oi_change_5m": pe_change_total if has_baseline else None,
        "max_pain": max_pain(chain),
        "resistance": [{"strike": s, "oi": chain[s]["CE"].oi} for s in resistances],
        "support": [{"strike": s, "oi": chain[s]["PE"].oi} for s in supports],
        "oi_direction_score": direction_score,
        "oi_direction_label": direction_label,
        "flow_ratio": flow_ratio,
        "baseline_minutes": round(baseline_age_seconds / 60, 1) if has_baseline and baseline_age_seconds is not None else None,
        "call_writing": sorted(call_writing, key=lambda item: item["oi_change"], reverse=True)[:3],
        "put_writing": sorted(put_writing, key=lambda item: item["oi_change"], reverse=True)[:3],
        "ors_call": ors_call,
        "ors_put": ors_put,
        "atm_iv": sum(atm_iv_values) / len(atm_iv_values) if atm_iv_values else None,
        "strikes": rows,
        "chain": chain,  # parsed legs for the trade planner; stripped before serialisation
    }


def select_contract(chain: dict[float, dict[str, Leg]], spot: float, side: str, near: int = NEAR_ATM_STRIKES) -> dict | None:
    """Spec §12: ATM or slightly ITM, strong delta (0.45-0.65), liquid; never far OTM."""
    strikes = list(chain)
    if not strikes:
        return None
    atm = _nearest(strikes, spot)
    position = strikes.index(atm)
    window = strikes[max(position - near, 0):position + near + 1]
    candidates = [(s, chain[s][side]) for s in window if side in chain[s] and chain[s][side].ltp > 0]
    if not candidates:
        return None
    oi_values = sorted(leg.oi for _, leg in candidates)
    volume_values = sorted(leg.volume for _, leg in candidates)
    median_oi = oi_values[len(oi_values) // 2]
    median_volume = volume_values[len(volume_values) // 2]

    def liquidity(leg: Leg) -> int:
        if leg.oi <= 0 or leg.volume <= 0:
            return 0
        if leg.oi >= median_oi and leg.volume >= median_volume:
            return 3
        if leg.oi >= median_oi * 0.4 and leg.volume >= median_volume * 0.4:
            return 2
        return 1

    def is_itm_or_atm(strike: float) -> bool:
        return strike <= atm if side == "CE" else strike >= atm

    def rank(item: tuple[float, Leg]) -> tuple:
        strike, leg = item
        delta = abs(leg.delta) if leg.delta is not None else None
        delta_gap = abs(delta - 0.55) if delta is not None else 0.5 + abs(strike - atm) / max(spot, 1.0) * 100
        return (liquidity(leg) < 2, not is_itm_or_atm(strike), delta_gap, -leg.oi)

    strike, leg = sorted(candidates, key=rank)[0]
    return {"strike": strike, "side": side, "premium": leg.ltp, "delta": leg.delta, "iv": leg.iv, "oi": leg.oi, "volume": leg.volume, "trading_symbol": leg.trading_symbol, "liquidity_score": liquidity(leg), "moneyness": "ATM" if strike == atm else ("ITM" if is_itm_or_atm(strike) else "OTM")}
