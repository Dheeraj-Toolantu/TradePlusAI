"""Walk-forward replay of the Intrinsic Value OTM strategy on recorded candles.

For every completed 5-minute bar of the test day inside the entry window, the live
``analyze()`` strategy function is called with only what was known at that moment: index
candles up to the bar, a strike ladder rebuilt from each option's last completed premium
candle (delta solved from that premium), and the selected premium's own candles. A CONFIRMED
setup is entered at its premium entry; the position is then managed bar by bar on the
contract's premium candles with the strategy's stop, trailing stop and target, one position at
a time, at most three trades, squared off at 15:15.

Not replayable, so excluded: live option-chain OI (no OI wall level, liquidity from premium and
volume only), India VIX, broker and risk-manager gates. Sentiment is a single reading for the
day, normally the point-in-time 09:00 IST score from ``sentiment.backtest_index``.

stdin JSON: ``symbol``, ``day`` (YYYY-MM-DD), ``candles_5m`` and ``daily_candles`` (index,
including prior sessions), ``sentiment`` ({score, label}), ``mapping`` (CONTRARIAN|FOLLOW), ``extreme`` (ACTIVE|BALANCED|STRICT
or a number; default ACTIVE),
``options``: [{symbol, type: CE|PE, strike, expiry, lot_size, candles}].
"""
from __future__ import annotations

import json
import math
import sys
from datetime import date, datetime, timedelta

from ..algo_engine.engine import MARKET_TIMEZONE, Candle, _normalize_timestamp, analyze

ENTRY_START = 9 * 60 + 35
ENTRY_END = 14 * 60 + 45
SQUARE_OFF = 15 * 60 + 15
BAR = timedelta(minutes=5)
MAX_TRADES = 3


def _candle(item: dict) -> Candle:
    return Candle(_normalize_timestamp(item.get("time", item.get("timestamp"))), float(item["open"]), float(item["high"]), float(item["low"]), float(item["close"]), float(item.get("volume") or 0))


def _start(candle: Candle) -> datetime:
    return datetime.fromisoformat(candle.timestamp)


def _cdf(value: float) -> float:
    return 0.5 * (1.0 + math.erf(value / math.sqrt(2.0)))


def _bs_price(spot: float, strike: float, years: float, sigma: float, kind: str) -> float:
    d1 = (math.log(spot / strike) + 0.5 * sigma * sigma * years) / (sigma * math.sqrt(years))
    d2 = d1 - sigma * math.sqrt(years)
    return spot * _cdf(d1) - strike * _cdf(d2) if kind == "CE" else strike * _cdf(-d2) - spot * _cdf(-d1)


def implied_delta(spot: float, strike: float, premium: float, expiry: str, now: datetime, kind: str) -> tuple[float | None, float | None]:
    """(delta, iv%) from the premium by bisection on volatility (zero rates)."""
    try:
        day = date.fromisoformat(expiry[:10])
    except ValueError:
        return None, None
    years = max((datetime(day.year, day.month, day.day, 15, 30, tzinfo=now.tzinfo) - now).total_seconds(), 1800.0) / (365.0 * 86400.0)
    intrinsic = max(0.0, spot - strike) if kind == "CE" else max(0.0, strike - spot)
    if spot <= 0 or premium <= intrinsic:
        return None, None
    low, high = 0.005, 4.0
    for _ in range(80):
        mid = (low + high) / 2
        if _bs_price(spot, strike, years, mid, kind) > premium:
            high = mid
        else:
            low = mid
    sigma = (low + high) / 2
    d1 = (math.log(spot / strike) + 0.5 * sigma * sigma * years) / (sigma * math.sqrt(years))
    return (_cdf(d1) if kind == "CE" else _cdf(d1) - 1.0), sigma * 100.0


def _minutes(moment: datetime) -> int:
    return moment.hour * 60 + moment.minute


def replay(payload: dict) -> dict:
    symbol = str(payload.get("symbol", "NIFTY"))
    day = date.fromisoformat(str(payload["day"]))
    mapping = str(payload.get("mapping") or "CONTRARIAN")
    sentiment = dict(payload.get("sentiment") or {})
    sentiment.pop("generated_at", None)  # a replay reading has no wall-clock age
    index = sorted((_candle(item) for item in payload.get("candles_5m", [])), key=_start)
    daily = [_candle(item) for item in payload.get("daily_candles", [])]
    options = []
    for item in payload.get("options", []):
        bars = sorted((_candle(row) for row in item.get("candles", [])), key=_start)
        if bars:
            options.append({**item, "type": str(item["type"]).upper(), "strike": float(item["strike"]), "bars": bars})

    today = [bar for bar in index if _start(bar).date() == day]
    trades: list[dict] = []
    decisions: dict[str, int] = {}
    timeline: list[dict] = []
    position: dict | None = None
    last_reason = None

    for bar in today:
        now = _start(bar) + BAR  # the bar has closed
        if position is not None:
            premium = next((c for c in position["bars"] if _start(c) == _start(bar)), None)
            if premium is not None:
                stop = max(position["stop"], position["high_water"] - position["trail"])
                exit_price = reason = None
                if premium.low <= stop:  # stop first when both are touched in one bar
                    exit_price, reason = stop, "TRAILING_STOP" if stop > position["stop"] else "STOP_LOSS"
                elif premium.high >= position["target"]:
                    exit_price, reason = position["target"], "TARGET"
                elif _minutes(now) >= SQUARE_OFF:
                    exit_price, reason = premium.close, "SQUARE_OFF"
                position["high_water"] = max(position["high_water"], premium.high)
                if exit_price is not None:
                    trades.append(_close(position, exit_price, reason, now))
                    position = None
            continue
        if len(trades) >= MAX_TRADES or not (ENTRY_START <= _minutes(now) <= ENTRY_END):
            continue
        history = [c for c in index if _start(c) < now]
        spot = history[-1].close
        contracts = []
        for option in options:
            done = [c for c in option["bars"] if _start(c) + BAR <= now]
            if not done or _start(done[-1]).date() != day:
                continue
            delta, iv = implied_delta(spot, option["strike"], done[-1].close, str(option.get("expiry", "")), now, option["type"])
            contracts.append({"symbol": option["symbol"], "contract": "CALL" if option["type"] == "CE" else "PUT", "strike": option["strike"], "premium": done[-1].close,
                              "delta": delta, "iv": iv, "openInterest": None, "volume": sum(c.volume for c in done if _start(c).date() == day),
                              "expiry": option.get("expiry"), "lotSize": option.get("lot_size"), "tickSize": 0.05, "freezeQuantity": None, "_bars": done})
        context = {"index_sentiment": sentiment, "sentiment_mapping": mapping, "sentiment_extreme": payload.get("extreme"), "option_chain": {"spot": spot, "contracts": [{k: v for k, v in c.items() if k != "_bars"} for c in contracts]}}
        result = analyze(symbol, history, strategy="INTRINSIC_VALUE", daily_candles=daily, context=context, now=now)
        wanted = result.get("needs_premium_candles")
        if wanted:
            bars = next((c["_bars"] for c in contracts if c["symbol"] == wanted), [])
            result = analyze(symbol, history, strategy="INTRINSIC_VALUE", daily_candles=daily, context={**context, "premium_candles": {"symbol": wanted, "candles": bars}}, now=now)
        decisions[result["decision"]] = decisions.get(result["decision"], 0) + 1
        if result["reason"] != last_reason:
            timeline.append({"time": now.strftime("%H:%M"), "decision": result["decision"], "reason": result["reason"]})
            last_reason = result["reason"]
        setup = result.get("setup")
        if result["decision"] == "CONFIRMED" and setup:
            contract = setup["contract"]
            option = next(o for o in options if o["symbol"] == contract["symbol"])
            position = {"symbol": contract["symbol"], "type": contract["type"], "strike": contract["strike"], "entry": setup["entry"], "stop": setup["stop_loss"],
                        "target": setup["target"], "trail": setup["trailing_distance"], "high_water": setup["entry"], "entered_at": now, "spot": spot,
                        "key_value": setup["key_value"], "lot_size": option.get("lot_size") or 1, "bars": option["bars"], "reason": result["reason"]}
    if position is not None:
        last = [c for c in position["bars"] if _start(c).date() == day]
        trades.append(_close(position, last[-1].close if last else position["entry"], "SQUARE_OFF", _start(last[-1]) + BAR if last else position["entered_at"]))

    pnl_points = sum(t["pnl_points"] for t in trades)
    return {"symbol": symbol, "day": day.isoformat(), "mapping": mapping, "sentiment": sentiment, "bars_evaluated": sum(decisions.values()),
            "decisions": decisions, "trades": trades, "pnl_points": round(pnl_points, 2), "pnl_rupees_1_lot": round(sum(t["pnl_rupees_1_lot"] for t in trades), 2),
            "options_loaded": len(options), "timeline": timeline[-40:]}


def _close(position: dict, price: float, reason: str, at: datetime) -> dict:
    points = price - position["entry"]
    return {"contract": position["symbol"], "type": position["type"], "strike": position["strike"], "spot_at_entry": round(position["spot"], 2), "key_value": position["key_value"],
            "entry_time": position["entered_at"].strftime("%H:%M"), "entry": position["entry"], "stop": position["stop"], "target": position["target"], "trail": position["trail"],
            "exit_time": at.strftime("%H:%M"), "exit": round(price, 2), "exit_reason": reason, "pnl_points": round(points, 2),
            "pnl_rupees_1_lot": round(points * float(position["lot_size"]), 2), "r_multiple": round(points / max(position["entry"] - position["stop"], 0.05), 2), "why": position["reason"]}


def main() -> None:
    payload = json.load(sys.stdin)
    runs = payload["runs"] if isinstance(payload.get("runs"), list) else [payload]
    print(json.dumps({"runs": [replay(run) for run in runs]}))


if __name__ == "__main__":
    main()
