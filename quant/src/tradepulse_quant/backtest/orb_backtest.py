"""Walk-forward replay of the V5 ORB-retest strategy rules for the /validation backtest.

For every completed 5-minute bar inside the entry window, the real ``analyze()`` strategy
function is called with only the candles available at that moment (no look-ahead). Each
CONFIRMED setup becomes a signal; the TypeScript simulator handles fills, exits and risk.

Only the strategy rules are replayed. Live-only no-trade gates (option-chain OI flow, India
VIX, broker health, kill switch) have no reliable history and are not part of the replay.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime

from ..algo_engine.engine import MARKET_TIMEZONE, Candle, _normalize_timestamp, analyze

ENTRY_START = 9 * 60 + 35
ENTRY_END = 14 * 60 + 45
BAR_SECONDS = 300


def _candle(item: dict) -> Candle:
    return Candle(timestamp=_normalize_timestamp(item.get("time", item.get("timestamp"))), open=float(item["open"]), high=float(item["high"]), low=float(item["low"]), close=float(item["close"]), volume=float(item.get("volume") or 0))


def replay(payload: dict) -> dict:
    symbol = str(payload.get("symbol", "NIFTY"))
    bars = sorted(payload.get("candles_5m", []), key=lambda item: float(item["time"]))
    daily = sorted(payload.get("daily_candles", []), key=lambda item: float(item["time"]))
    start_day = str(payload.get("from", "0000-00-00"))
    candles = [_candle(item) for item in bars]
    times = [float(item["time"]) for item in bars]
    days = [datetime.fromtimestamp(t, tz=MARKET_TIMEZONE).date().isoformat() for t in times]
    daily_dates = [datetime.fromtimestamp(float(item["time"]), tz=MARKET_TIMEZONE).date().isoformat() for item in daily]
    signals: list[dict] = []
    seen: set[str] = set()
    evaluated = 0
    for index, started in enumerate(times):
        day = days[index]
        if day < start_day:
            continue
        closed = datetime.fromtimestamp(started + BAR_SECONDS, tz=MARKET_TIMEZONE)
        minute = closed.hour * 60 + closed.minute
        if minute < ENTRY_START or minute > ENTRY_END:
            continue
        # Only today's session plus the two previous sessions: enough for ATR/PDH/PDL, bounded cost.
        session_days = sorted({d for d in days[: index + 1]})[-3:]
        window = [candle for candle, d in zip(candles[: index + 1], days[: index + 1]) if d in session_days]
        prior_daily = [_candle(item) for item, d in zip(daily, daily_dates) if d < day] or None
        evaluated += 1
        result = analyze(symbol, window, 1000.0, "ORB_RETEST", prior_daily)
        setup = result.get("setup")
        if result.get("decision") != "CONFIRMED" or not setup:
            continue
        key = f"{day}:{setup['side']}:{result.get('reason', '')}"
        if key in seen:
            continue
        seen.add(key)
        signals.append({
            "time": started + BAR_SECONDS,
            "side": 1 if setup["side"] == "BUY" else -1,
            "entry": setup["entry"],
            "stop": setup["stop_loss"],
            "target1": setup["target"],
            "reason": str(result.get("reason", "ORB retest"))[:240],
        })
    return {"signals": signals, "evaluated_bars": evaluated}


def main() -> None:
    print(json.dumps(replay(json.load(sys.stdin))))


if __name__ == "__main__":
    main()
