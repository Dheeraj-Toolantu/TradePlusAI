"""Market-intel orchestrator: confluence verdict + beginner-safe, risk-defined trade plan.

stdin/stdout JSON entry point (``python -m tradepulse_quant.market_intel.engine``) so the
Next.js API boundary can call it the same way it calls the V5 algo engine.
"""
from __future__ import annotations

import json
import math
import sys
from datetime import datetime, time

from ..algo_engine.session_engine import current_session_window, is_entry_permitted, is_session_active
from .candles import IST, Bar, parse_bars, technicals
from .options_flow import analyze_options_flow, select_contract
from .smart_money import analyze_smart_money, find_swings
from .volatility import analyze_volatility

HIGH_IMPACT_EVENTS = {"RBI policy", "US Fed", "Union Budget", "Elections", "Inflation data", "Geopolitics"}
BIAS_THRESHOLD = 3.0
READY_THRESHOLD = 5.0
DEFAULT_CAPITAL = 100_000.0
DEFAULT_RISK_PCT = 0.5  # spec §15 default risk per trade
PREMIUM_CIRCUIT_BREAKER = 0.25  # spec §15 last-resort premium stop
STOP_BUFFER_ATR = 0.2
MAX_STOP_ATR = 2.0
MIN_STOP_ATR = 0.3
MAX_VWAP_STRETCH_ATR = 1.5
MIN_RR = 2.0
FLAT_BROKERAGE_PER_LOT = 40.0  # ₹20 per executed order, entry + exit
SLIPPAGE_AND_CHARGES_PCT = 0.008  # spread/slippage + STT/exchange/GST, approx. on premium turnover


def _factor(key: str, name: str, points: float, maximum: float, detail: str, learn: str) -> dict:
    signal = "BULLISH" if points > 0 else "BEARISH" if points < 0 else "NEUTRAL"
    return {"key": key, "name": name, "signal": signal, "points": round(points, 2), "max": maximum, "detail": detail, "learn": learn}


def _fmt(value: float | None) -> str:
    return "--" if value is None else f"{value:,.2f}"


def build_verdict(tech: dict, smc: dict, flow: dict, sentiment: dict | None = None) -> dict:
    factors: list[dict] = []
    price, vwap, atr = tech.get("last_price"), tech.get("vwap"), tech.get("atr14") or 0.0
    band = atr * 0.1
    if price is not None and vwap is not None:
        points = 1.5 if price > vwap + band else -1.5 if price < vwap - band else 0.0
        where = "above" if points > 0 else "below" if points < 0 else "hugging"
        factors.append(_factor("vwap", "Price vs VWAP", points, 1.5, f"Price {_fmt(price)} is {where} session VWAP {_fmt(vwap)}{'' if tech.get('vwap_is_volume_weighted') else ' (TWAP: index has no volume)'}", "VWAP is the day's average traded price. Institutions buy below it and sell above it; trading on the side of VWAP keeps you with the day's flow."))
    ema20, ema50 = tech.get("ema20"), tech.get("ema50")
    if ema20 is not None and ema50 is not None:
        points = 1.0 if ema20 > ema50 else -1.0 if ema20 < ema50 else 0.0
        factors.append(_factor("ema", "EMA 20 vs EMA 50 (5m)", points, 1.0, f"EMA20 {_fmt(ema20)} {'>' if points > 0 else '<' if points < 0 else '='} EMA50 {_fmt(ema50)}", "When the fast average is above the slow one the short-term trend is up. It confirms trend; it does not time entries."))
    trend_15m = tech.get("trend_15m")
    if trend_15m in ("BULLISH", "BEARISH", "FLAT"):
        points = 1.0 if trend_15m == "BULLISH" else -1.0 if trend_15m == "BEARISH" else 0.0
        factors.append(_factor("trend_15m", "Higher timeframe (15m EMA 9/21)", points, 1.0, f"15-minute trend is {trend_15m.lower()}", "Professionals trade the 5-minute chart only in the direction of the 15-minute trend. Fighting the higher timeframe is the most common beginner mistake."))
    if smc.get("available"):
        event = smc.get("last_event")
        trend = smc.get("trend")
        if trend in ("BULLISH", "BEARISH") and event:
            magnitude = 2.0 if event["type"] == "BOS" else 1.0
            points = magnitude if trend == "BULLISH" else -magnitude
            detail = f"Last {event['type']} was {event['direction'].lower()} at {_fmt(event['level'])}; swings: {smc.get('swing_sequence')}"
        else:
            points, detail = 0.0, "No confirmed break of structure yet"
        factors.append(_factor("structure", "Market structure (SMC)", points, 2.0, detail, "BOS = price closed beyond the last swing in the trend's direction (trend continues). CHoCH = first break against the trend (possible reversal, less reliable, so it scores half)."))
        sweeps = smc.get("sweeps") or []
        if sweeps:
            last = sweeps[-1]
            points = 1.0 if last["bias"] == "BULLISH" else -1.0
            detail = f"{'Sell' if last['side'] == 'SELL_SIDE' else 'Buy'}-side liquidity swept at {_fmt(last['level'])} ({last['label']}) and price closed back inside"
        else:
            points, detail = 0.0, "No recent stop-hunt"
        factors.append(_factor("sweep", "Liquidity sweep", points, 1.0, detail, "Big players push price just past obvious highs/lows to trigger retail stop-losses, then reverse. A sweep of lows that closes back up is bullish; a sweep of highs is bearish."))
    if flow.get("available"):
        score = flow.get("oi_direction_score")
        factors.append(_factor("oi_flow", "Option writers (5-min OI change)", float(score or 0), 2.0, flow.get("oi_direction_label") or "Unavailable", "Option writers (sellers) are usually large, well-funded players. Fresh put writing = they expect support; fresh call writing = they expect a ceiling."))
        pcr = flow.get("pcr_oi")
        if pcr is not None:
            points = 0.5 if pcr >= 1.2 else 0.25 if pcr >= 1.0 else -0.5 if pcr <= 0.7 else -0.25 if pcr <= 0.9 else 0.0
            note = " (very high: market may be overbought)" if pcr > 1.6 else " (very low: market may be oversold)" if pcr < 0.5 else ""
            factors.append(_factor("pcr", "Put-Call Ratio (OI)", points, 0.5, f"PCR {pcr:.2f}{note}", "PCR = total put OI / total call OI. Above 1 means more puts are written (bullish support); below 0.7 means call writers dominate. Extremes often reverse, so it is a light-weight factor."))
    rsi_value = tech.get("rsi14")
    if rsi_value is not None:
        points = 0.5 if rsi_value >= 60 else 0.25 if rsi_value >= 55 else -0.5 if rsi_value <= 40 else -0.25 if rsi_value <= 45 else 0.0
        factors.append(_factor("rsi", "Momentum (RSI 14)", points, 0.5, f"RSI {rsi_value:.1f}", "RSI above 55-60 shows buyers in control, below 40-45 sellers. It measures momentum strength, not direction reversals."))
    if sentiment and sentiment.get("india_label") not in (None, "INSUFFICIENT_DATA"):
        score = float(sentiment.get("india_score") or 0.0)
        if sentiment.get("contrarian_note"):
            points, detail = 0.0, f"Crowd extreme ({score:+.0f}): {sentiment['contrarian_note']}"
        else:
            points = 0.5 if score >= 25 else 0.25 if score >= 10 else -0.5 if score <= -25 else -0.25 if score <= -10 else 0.0
            detail = f"India sentiment {score:+.0f}/100 (retail {float(sentiment.get('retail_score') or 0):+.0f}, news {float(sentiment.get('news_score') or 0):+.0f})"
        factors.append(_factor("sentiment", "Retail & news sentiment", points, 0.5, detail, "What retail traders on public forums and the financial news are saying right now. Useful as a light confirmation; at extremes the crowd is usually wrong, so euphoria or panic scores zero."))

    total = sum(factor["points"] for factor in factors)
    bias = "BULLISH" if total >= BIAS_THRESHOLD else "BEARISH" if total <= -BIAS_THRESHOLD else "SIDEWAYS"
    agreeing = sum(1 for f in factors if (f["points"] > 0 and bias == "BULLISH") or (f["points"] < 0 and bias == "BEARISH"))
    return {
        "bias": bias,
        "score": round(total, 2),
        "max_score": 10,
        "strength": min(100, round(abs(total) * 10)),
        "factors": factors,
        "agreeing_factors": agreeing,
        "total_factors": len(factors),
    }


def _structural_stop(bars: list[Bar], entry: float, direction: int, atr: float) -> float:
    swings = find_swings(bars)
    kind = "LOW" if direction > 0 else "HIGH"
    levels = [s.price for s in swings if s.kind == kind and ((s.price < entry) if direction > 0 else (s.price > entry))]
    if levels:
        level = levels[-1]
        stop = level - STOP_BUFFER_ATR * atr if direction > 0 else level + STOP_BUFFER_ATR * atr
        if abs(entry - stop) <= MAX_STOP_ATR * atr:
            return stop
    return entry - atr * direction


def _entry_zone(smc: dict, tech: dict, price: float, direction: int, atr: float) -> dict:
    wanted = "BULLISH" if direction > 0 else "BEARISH"
    zones = []
    for source, items in (("Fair value gap", smc.get("fair_value_gaps") or []), ("Order block", smc.get("order_blocks") or [])):
        for zone in items:
            if zone["direction"] != wanted:
                continue
            edge = zone["top"] if direction > 0 else zone["bottom"]
            gap = (price - edge) * direction
            if -0.1 * atr <= gap <= 1.5 * atr:
                zones.append((gap, source, zone))
    if zones:
        _, source, zone = min(zones, key=lambda item: item[0])
        entry = min(zone["top"], price) if direction > 0 else max(zone["bottom"], price)
        stop = zone["bottom"] - STOP_BUFFER_ATR * atr if direction > 0 else zone["top"] + STOP_BUFFER_ATR * atr
        return {"type": "PULLBACK", "source": source, "zone_low": zone["bottom"], "zone_high": zone["top"], "entry": entry, "stop": stop,
                "instruction": f"Wait for price to pull back into the {wanted.lower()} {source.lower()} {_fmt(zone['bottom'])}-{_fmt(zone['top'])} and show a {'green' if direction > 0 else 'red'} 5-minute candle, then enter."}
    vwap = tech.get("vwap")
    if vwap is not None and 0 < (price - vwap) * direction <= atr:
        return {"type": "VWAP_RETEST", "source": "VWAP", "zone_low": min(vwap, vwap + 0.2 * atr * direction), "zone_high": max(vwap, vwap + 0.2 * atr * direction), "entry": vwap + 0.1 * atr * direction, "stop": None,
                "instruction": f"Wait for a dip to VWAP {_fmt(vwap)} that holds (candle closes back {'above' if direction > 0 else 'below'} it), then enter."}
    return {"type": "CONFIRMATION", "source": "Price action", "zone_low": None, "zone_high": None, "entry": price, "stop": None,
            "instruction": f"No nearby pullback zone. Enter only after the next 5-minute candle closes {'above' if direction > 0 else 'below'} {_fmt(price)} with a strong body."}


def _liquidity_targets(smc: dict, flow: dict, tech: dict, direction: int) -> list[tuple[str, float]]:
    pools = smc.get("liquidity") or {}
    items: list[tuple[str, float | None]]
    if direction > 0:
        items = [("Previous day high", pools.get("previous_day_high")), ("Today's high", pools.get("session_high"))]
        items += [("Equal highs (buy-side liquidity)", level["level"]) for level in pools.get("equal_highs") or []]
        items += [(f"Call-writer wall {int(r['strike'])}", r["strike"]) for r in flow.get("resistance") or []]
    else:
        items = [("Previous day low", pools.get("previous_day_low")), ("Today's low", pools.get("session_low"))]
        items += [("Equal lows (sell-side liquidity)", level["level"]) for level in pools.get("equal_lows") or []]
        items += [(f"Put-writer wall {int(s['strike'])}", s["strike"]) for s in flow.get("support") or []]
    return [(label, float(value)) for label, value in items if value]


def build_trade_plan(bars: list[Bar], tech: dict, smc: dict, flow: dict, vol: dict, verdict: dict, session: dict, meta: dict) -> dict:
    price = tech.get("last_price") or meta["spot"]
    atr = tech.get("atr14") or price * 0.002
    bias = verdict["bias"]
    pools = smc.get("liquidity") or {}
    watch = {
        "bullish_above": max([v for v in (pools.get("session_high"), (flow.get("resistance") or [{}])[0].get("strike")) if v], default=None),
        "bearish_below": min([v for v in (pools.get("session_low"), (flow.get("support") or [{}])[0].get("strike")) if v], default=None),
    }
    management = [
        "Place the stop-loss order immediately after entry. Never widen it.",
        "At +1R profit, move the stop to your entry price (risk-free trade).",
        "At Target 1, book 50% and trail the rest below each new 5-minute swing (above for puts).",
        "Exit everything by 15:15 IST. Do not carry option buys overnight.",
        "Maximum 3 trades a day; stop for the day after 2 consecutive losses.",
    ]
    if bias == "SIDEWAYS":
        return {"status": "NO_TRADE", "headline": "No clear trend. Sitting out is a valid position.", "direction": None, "watch": watch, "checklist": [], "management": management,
                "reasons_against": ["Trend factors disagree; option buyers lose to time decay in sideways markets."]}

    direction = 1 if bias == "BULLISH" else -1
    side = "CE" if direction > 0 else "PE"
    zone = _entry_zone(smc, tech, price, direction, atr)
    entry = zone["entry"]
    stop = zone["stop"] if zone["stop"] is not None else _structural_stop(bars, entry, direction, atr)
    risk = abs(entry - stop)
    if risk < MIN_STOP_ATR * atr:
        stop = entry - MIN_STOP_ATR * atr * direction
        risk = abs(entry - stop)
    target1 = entry + MIN_RR * risk * direction
    # Target 2 = nearest liquidity beyond T1 that is still reachable today (inside the
    # VIX-implied daily range, else within 4R); otherwise a plain 3R extension.
    reach = entry + 4 * risk * direction
    if vol.get("available"):
        reach = vol["expected_range"]["high"] if direction > 0 else vol["expected_range"]["low"]
    beyond = sorted([(label, level) for label, level in _liquidity_targets(smc, flow, tech, direction) if (level - target1) * direction > 0.1 * atr and (reach - level) * direction >= 0], key=lambda item: abs(item[1] - entry))
    target2_label, target2 = beyond[0] if beyond else ("3R extension", entry + 3 * risk * direction)
    walls = [level for label, level in _liquidity_targets(smc, flow, tech, direction) if "wall" in label]
    blocking_wall = next((level for level in walls if 0.25 * risk < (level - entry) * direction < (target1 - entry) * direction), None)

    contract = select_contract(flow.get("chain") or {}, meta["spot"], side) if flow.get("available") else None
    premium_plan = None
    lots = quantity = capital_at_risk = None
    rr = MIN_RR
    if contract:
        delta = abs(contract["delta"]) if contract.get("delta") else 0.5
        spot_now = meta["spot"]

        def premium_at(level: float) -> float:
            return max(contract["premium"] + delta * (level - spot_now) * direction, 0.05)

        premium_entry = premium_at(entry)
        premium_stop = max(premium_at(stop), premium_entry * (1 - PREMIUM_CIRCUIT_BREAKER))
        premium_t1, premium_t2 = premium_at(target1), premium_at(target2)
        premium_risk = max(premium_entry - premium_stop, 0.05)
        rr = (premium_t1 - premium_entry) / premium_risk
        premium_plan = {"entry": round(premium_entry, 2), "stop": round(premium_stop, 2), "target1": round(premium_t1, 2), "target2": round(premium_t2, 2),
                        "stop_basis": "structural" if premium_at(stop) >= premium_entry * (1 - PREMIUM_CIRCUIT_BREAKER) else "25% premium circuit breaker"}
        lot_size = meta.get("lot_size") or 0
        if lot_size > 0:
            multiplier = (vol.get("size_multiplier", 1.0) if vol.get("available") else 1.0) * (0.5 if meta.get("expiry_today") else 1.0)
            budget = meta["capital"] * meta["risk_pct"] / 100.0 * multiplier
            per_lot = premium_risk * lot_size + FLAT_BROKERAGE_PER_LOT + premium_entry * lot_size * SLIPPAGE_AND_CHARGES_PCT
            lots = int(budget // per_lot) if per_lot > 0 else 0
            quantity = lots * lot_size
            capital_at_risk = round(max(lots, 1) * per_lot, 2)
            premium_plan.update({"risk_per_lot": round(per_lot, 2), "risk_budget": round(budget, 2), "capital_needed": round(max(lots, 1) * premium_entry * lot_size, 2)})

    oi_score = flow.get("oi_direction_score") if flow.get("available") else None
    vwap = tech.get("vwap")
    stretch = abs(price - vwap) / atr if vwap is not None and atr else 0.0
    smc_agrees = smc.get("trend") == bias
    last_bar = bars[-1]
    bar_range = max(last_bar.high - last_bar.low, 1e-9)
    body_ratio = abs(last_bar.close - last_bar.open) / bar_range
    candle_ok = (last_bar.close - last_bar.open) * direction > 0 and body_ratio >= 0.5
    high_impact = [event for event in (meta.get("sentiment") or {}).get("event_risk") or [] if event in HIGH_IMPACT_EVENTS]
    late_expiry = bool(meta.get("expiry_today")) and meta["now"].time() >= time(13, 30)
    checklist = [
        {"key": "session", "label": "Inside the entry window (09:35-14:45 IST)", "passed": session["entry_permitted"], "detail": f"Now {session['window'].replace('_', ' ').lower()}"},
        {"key": "trend", "label": "Clear trend (confluence score ≥ 5/10)", "passed": abs(verdict["score"]) >= READY_THRESHOLD, "detail": f"Score {verdict['score']:+.1f}/10 with {verdict['agreeing_factors']}/{verdict['total_factors']} factors agreeing"},
        {"key": "structure", "label": "Price structure agrees (BOS/CHoCH)", "passed": smc_agrees, "detail": f"SMC structure is {str(smc.get('trend', 'UNKNOWN')).lower()}"},
        {"key": "writers", "label": "Option writers agree (5-min OI change)", "passed": oi_score is not None and oi_score * direction >= 1, "detail": flow.get("oi_direction_label") or "Option chain unavailable"},
        {"key": "vix", "label": "Volatility acceptable (India VIX not extreme)", "passed": vol.get("available", False) and vol.get("regime") != "EXTREME", "detail": f"VIX {_fmt(vol.get('value'))} · {vol.get('regime') or 'unavailable'}"},
        {"key": "chase", "label": "Not chasing (≤ 1.5 ATR from VWAP)", "passed": stretch <= MAX_VWAP_STRETCH_ATR, "detail": f"{stretch:.1f} ATR from VWAP"},
        {"key": "stop", "label": "Stop-loss within 2 ATR", "passed": risk <= MAX_STOP_ATR * atr, "detail": f"Risk {risk:.1f} pts = {risk / atr:.1f} ATR"},
        {"key": "rr", "label": "Reward at least 2× risk", "passed": rr >= MIN_RR - 1e-6, "detail": f"R:R {rr:.2f} on the option premium"},
        {"key": "room", "label": "Room to target (no big OI wall before Target 1)", "passed": blocking_wall is None, "detail": f"Wall at {_fmt(blocking_wall)} blocks the path" if blocking_wall else "Path to Target 1 is clear of the main OI wall"},
        {"key": "liquidity", "label": "Liquid strike (liquidity score ≥ 2/3)", "passed": bool(contract) and contract["liquidity_score"] >= 2, "detail": f"{contract['trading_symbol'] or contract['strike']} liquidity {contract['liquidity_score']}/3" if contract else "No liquid contract near ATM"},
        {"key": "candle", "label": "Confirmation candle (last 5m closes in trade direction, body ≥ 50%)", "passed": candle_ok, "detail": f"Last candle {'green' if last_bar.close > last_bar.open else 'red' if last_bar.close < last_bar.open else 'doji'}, body {body_ratio * 100:.0f}% of range"},
        {"key": "events", "label": "No high-impact event in the news right now", "passed": not high_impact, "detail": ("Active: " + ", ".join(high_impact)) if high_impact else ("No RBI/Fed/Budget/election headlines" if meta.get("sentiment") else "Sentiment scan unavailable; check the economic calendar yourself")},
        {"key": "expiry", "label": "No late expiry-day gamma risk", "passed": not late_expiry, "detail": "Expiry day after 13:30: premiums can vanish in minutes" if late_expiry else ("Expiry today: size halved" if meta.get("expiry_today") else "Not expiry day")},
    ]
    failed = [item for item in checklist if not item["passed"]]
    if not session["market_open"]:
        status = "MARKET_CLOSED"
    elif vol.get("regime") == "EXTREME":
        status = "NO_TRADE"
    elif not failed:
        status = "READY"
    else:
        status = "WAIT"
    reasons_for = [f"{f['name']}: {f['detail']}" for f in verdict["factors"] if f["points"] * direction > 0]
    reasons_against = [f"{f['name']}: {f['detail']}" for f in verdict["factors"] if f["points"] * direction < 0] + [f"{item['label']}: {item['detail']}" for item in failed]
    zone_info = smc.get("dealing_range") or {}
    if (direction > 0 and zone_info.get("zone") == "PREMIUM") or (direction < 0 and zone_info.get("zone") == "DISCOUNT"):
        reasons_against.append(f"Price is in the {zone_info['zone'].lower()} half of {zone_info['basis'].lower()} ({zone_info['position_pct']}%); smart money prefers to {'buy in discount' if direction > 0 else 'sell in premium'}, so favour the pullback entry.")
    headline = {
        "READY": f"BUY {meta['symbol']} {int(contract['strike']) if contract else ''} {side}: every check passed",
        "WAIT": f"{bias.title()} bias, but {len(failed)} check(s) are not met yet. Wait.",
        "NO_TRADE": "Volatility is extreme. Option buyers should stay out.",
        "MARKET_CLOSED": f"Market closed. Plan for the next session: {bias.lower()} bias.",
    }[status]
    return {
        "status": status,
        "headline": headline,
        "direction": side,
        "action": f"BUY {side}",
        "contract": contract,
        "entry": {**zone, "entry": round(entry, 2)},
        "spot": {"entry": round(entry, 2), "stop": round(stop, 2), "target1": round(target1, 2), "target2": round(target2, 2), "target2_label": target2_label, "risk_points": round(risk, 2)},
        "premium": premium_plan,
        "risk_reward": round(rr, 2),
        "lots": lots,
        "quantity": quantity,
        "capital_at_risk": capital_at_risk,
        "invalidation": f"Plan is invalid if a 5-minute candle closes {'below' if direction > 0 else 'above'} {_fmt(stop)} before entry.",
        "checklist": checklist,
        "reasons_for": reasons_for,
        "reasons_against": reasons_against,
        "watch": watch,
        "management": management,
        "notes": ["Option levels are delta-approximations of the spot levels; they ignore gamma and time decay.", "Charges are estimated (flat brokerage + STT/exchange/GST + slippage)."],
    }


def analyze_market(payload: dict) -> dict:
    symbol = str(payload.get("symbol") or "NIFTY").upper()
    bars = parse_bars(payload.get("candles") or [])
    try:
        now = datetime.fromisoformat(str(payload["now"]).replace("Z", "+00:00")).astimezone(IST) if payload.get("now") else datetime.now(IST)
    except ValueError:
        now = datetime.now(IST)
    spot = float(payload.get("spot") or 0) or (bars[-1].close if bars else 0.0)
    trading_day = now.weekday() < 5
    session = {
        "time_ist": now.isoformat(),
        "window": current_session_window(now),
        "market_open": trading_day and is_session_active(now),
        "entry_permitted": trading_day and is_entry_permitted(now),
    }
    if len(bars) < 20 or spot <= 0:
        return {"symbol": symbol, "available": False, "reason": "At least 20 valid 5-minute candles and a live spot price are required", "session": session}

    tech = technicals(bars)
    smc = analyze_smart_money(bars, tech.get("atr14"))
    flow = analyze_options_flow(payload.get("chain"), spot, payload.get("baseline_chain"), payload.get("baseline_spot"), payload.get("baseline_age_seconds"))
    vol = analyze_volatility(payload.get("vix"), spot, flow.get("atm_iv") if flow.get("available") else None)
    expiry = str(payload.get("expiry") or "")
    meta = {
        "symbol": symbol,
        "spot": spot,
        "now": now,
        "lot_size": float(payload.get("lot_size") or 0),
        "capital": float(payload.get("capital") or DEFAULT_CAPITAL),
        "risk_pct": min(max(float(payload.get("risk_pct") or DEFAULT_RISK_PCT), 0.1), 2.0),
        "expiry_today": expiry == now.date().isoformat(),
    }
    sentiment = payload.get("sentiment") if isinstance(payload.get("sentiment"), dict) else None
    meta["sentiment"] = sentiment
    verdict = build_verdict(tech, smc, flow, sentiment)
    plan = build_trade_plan(bars, tech, smc, flow, vol, verdict, session, meta)

    liquidity_scores = [c["liquidity_score"] for c in (select_contract(flow.get("chain") or {}, spot, s) for s in ("CE", "PE")) if c] if flow.get("available") else []
    v5_option_evidence = {
        "oi_direction_score": flow.get("oi_direction_score"),
        "ors_call": flow.get("ors_call"),
        "ors_put": flow.get("ors_put"),
        "vix_regime": vol.get("regime"),
        "liquidity_score": min(liquidity_scores) if liquidity_scores else None,
        "option_quote_fresh": bool(flow.get("available")),
        "expiry": expiry or None,
        "expiry_today": meta["expiry_today"],
    }
    flow_public = {key: value for key, value in flow.items() if key != "chain"}
    return {
        "symbol": symbol,
        "available": True,
        "spot": spot,
        "expiry": expiry or None,
        "expiry_today": meta["expiry_today"],
        "lot_size": meta["lot_size"] or None,
        "generated_at": now.isoformat(),
        "session": session,
        "technicals": tech,
        "volatility": vol,
        "options_flow": flow_public,
        "smart_money": smc,
        "verdict": verdict,
        "trade_plan": plan,
        "v5_option_evidence": v5_option_evidence,
    }


def _clean(value: object) -> object:
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(key): _clean(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(item) for item in value]
    if value is None or isinstance(value, (str, int, bool)):
        return value
    return str(value)


def main() -> None:
    result = analyze_market(json.load(sys.stdin))
    print(json.dumps(_clean(result), allow_nan=False))


if __name__ == "__main__":
    main()
