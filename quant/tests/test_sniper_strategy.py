"""NIFTY Sniper AI: deterministic structure, no look-ahead, scoring and hard filters (spec 21)."""
from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timedelta

from tradepulse_quant.algo_engine import engine, sniper_strategy as sn

IST = sn.IST
TODAY = datetime(2026, 11, 17, tzinfo=IST)  # a Tuesday (NIFTY weekly expiry)


@dataclass(frozen=True)
class C:
    timestamp: str
    open: float
    high: float
    low: float
    close: float
    volume: float


def five(day: datetime, index: int, o: float, h: float, l: float, c: float, v: float = 1000.0) -> C:
    start = day.replace(hour=9, minute=15) + timedelta(minutes=5 * index)
    return C(start.isoformat(), o, h, l, c, v)


def previous_day() -> list[C]:
    day = TODAY - timedelta(days=1)
    out = []
    price = 24020.0
    for i in range(75):
        drift = 4.0 if i % 6 < 3 else -4.0
        o, c = price, price + drift
        out.append(five(day, i, o, max(o, c) + 5, min(o, c) - 5, c))
        price = c
    return out


# Today: decline to a swing low (bar 3), bounce to a lower high (bar 6, the protected level), sweep
# below the swing low with a reclaim close (bar 10), bullish displacement closing above the lower
# high (bar 11, MSS), continuation leaving a bullish FVG (bar 12 low above bar 10 high).
TODAY_BARS = [
    (24010, 24014, 23996, 23998), (23998, 24000, 23978, 23980), (23980, 23983, 23962, 23965),
    (23965, 23968, 23950, 23955), (23955, 23972, 23953, 23970), (23970, 23984, 23966, 23982),
    (23982, 23990, 23975, 23978), (23978, 23981, 23966, 23968), (23968, 23972, 23958, 23960),
    (23960, 23964, 23955, 23958), (23958, 23965, 23940, 23962), (23962, 24001, 23960, 23999),
    (23999, 24008, 23994, 24005),
]


def today_five(upto: int = len(TODAY_BARS)) -> list[C]:
    out = []
    for i, (o, h, l, c) in enumerate(TODAY_BARS[:upto]):
        out.append(five(TODAY, i, o, h, l, c, 3200.0 if i == 11 else 1000.0))
    return out


def one_minute(end: datetime) -> list[C]:
    """1m tape following the 5m closes, ending in a bullish trigger candle."""
    out = []
    start = TODAY.replace(hour=9, minute=15)
    minutes = int((end - start).total_seconds() // 60)
    for m in range(minutes):
        bar = TODAY_BARS[min(m // 5, len(TODAY_BARS) - 1)]
        frac = (m % 5) / 5.0
        price = bar[0] + (bar[3] - bar[0]) * frac
        out.append(C((start + timedelta(minutes=m)).isoformat(), price, price + 2, price - 2, price + 0.5, 200.0))
    last = start + timedelta(minutes=minutes - 1)
    out[-2] = C((last - timedelta(minutes=1)).isoformat(), 23998.0, 24001.0, 23996.0, 23999.0, 200.0)
    out[-1] = C(last.isoformat(), 23999.0, 24005.0, 23998.0, 24004.0, 300.0)
    return out


def chain(expiry: str = "2026-11-17") -> dict:
    rows = []
    for strike, delta, premium in ((23900, 0.78, 108.0), (23950, 0.66, 66.0), (24000, 0.52, 31.0), (24050, 0.36, 12.0)):
        rows.append({"symbol": f"NIFTY25N17{strike}CE", "contract": "CALL", "strike": strike, "expiry": expiry, "premium": premium, "bid": 0, "ask": 0,
                     "openInterest": 500000, "volume": 900000, "iv": 14.0, "delta": delta, "theta": -18.0, "lotSize": 65, "tickSize": 0.05})
        rows.append({"symbol": f"NIFTY25N17{strike}PE", "contract": "PUT", "strike": strike, "expiry": expiry, "premium": 40.0, "bid": 0, "ask": 0,
                     "openInterest": 400000, "volume": 700000, "iv": 14.0, "delta": -(1 - delta), "theta": -18.0, "lotSize": 65, "tickSize": 0.05})
    return {"spot": 24004.0, "expiry": expiry, "contracts": rows}


FLOW = {"available": True, "oi_direction_score": 2, "pcr_oi": 1.1, "strikes": [
    {"strike": 24000, "is_atm": True, "ce_activity": "SHORT_COVERING", "pe_activity": "SHORT_BUILDUP", "ce_oi": 900000, "pe_oi": 1000000},
    {"strike": 24200, "ce_activity": None, "pe_activity": None, "ce_oi": 2000000, "pe_oi": 100000},
]}
VIX = {"value": 13.5, "regime": "NORMAL"}
NOW = TODAY.replace(hour=10, minute=20, second=30)


def context(**overrides) -> dict:
    base = {"setup_candles": previous_day() + today_five(), "option_chain": chain(), "options_flow": FLOW, "vix": VIX, "max_loss_per_trade": 1500}
    return {**base, **overrides}


def run(now: datetime = NOW, **overrides) -> dict:
    return sn.analyze_sniper("NIFTY", one_minute(now.replace(second=0)), context(**overrides), now)


# ---------------------------------------------------------------- structure, timing

def test_pivot_is_confirmed_only_after_its_right_side_closes():
    bars = sn.to_bars(today_five(), 5)
    lows = [p for p in sn.find_pivots(bars, 2, 2) if p.kind == "LOW"]
    first = lows[0]
    assert first.index == 3 and first.confirmed_index == 5
    assert first.confirmed_at == bars[5].end.isoformat()
    # With only bars 0..4 the same low cannot be a pivot yet (no repainting backwards).
    assert not [p for p in sn.find_pivots(bars[:5], 2, 2) if p.kind == "LOW" and p.index == 3]


def test_resample_is_left_closed_and_drops_the_forming_bucket():
    bars = sn.to_bars(today_five(), 5)
    fifteen = sn.resample(bars, 15, NOW)
    # 09:15, 09:30, 09:45, 10:00 complete; 10:15 (10:15-10:30) is still forming at 10:20.
    assert [b.start.strftime("%H:%M") for b in fifteen] == ["09:15", "09:30", "09:45", "10:00"]
    assert fifteen[0].open == TODAY_BARS[0][0] and fifteen[0].close == TODAY_BARS[2][3]


def test_fvg_boundaries_and_mitigation():
    bars = sn.to_bars(today_five(), 5)
    fvg = sn.find_fvg(bars, 11, 1, len(bars) - 1, sn.SniperConfig())
    assert fvg["lower"] == 23965 and fvg["upper"] == 23994 and fvg["status"] == "UNMITIGATED"
    assert sn.find_fvg(bars, 11, -1, len(bars) - 1, sn.SniperConfig()) is None


def test_sweep_and_mss_are_detected_with_evidence():
    result = run()
    family = result["sniper"]["families"]["LIQUIDITY_REVERSAL:CALL"]
    assert family["state"] == "CONFIRMED"
    assert family["sweep"]["level"] == 23950 and family["sweep"]["reclaim_bars"] == 1
    assert family["mss"]["level"] == 23990
    assert family["displacement"]["time"].startswith("2026-11-17T10:10")


def test_wick_without_structure_stays_watch_not_entry():
    # Stop the tape at the reclaim bar: swept and reclaimed, no MSS yet.
    now = TODAY.replace(hour=10, minute=10, second=30)
    result = sn.analyze_sniper("NIFTY", one_minute(now.replace(second=0)), context(setup_candles=previous_day() + today_five(11)), now)
    family = result["sniper"]["families"]["LIQUIDITY_REVERSAL:CALL"]
    assert family["state"] == "WATCH" and family["mss"] is None
    assert result["decision"] != "CONFIRMED"


def test_future_candles_never_change_a_past_decision():
    """Feeding bars that start after ``now`` must not alter the decision at ``now``."""
    early = TODAY.replace(hour=10, minute=10, second=30)
    plain = sn.analyze_sniper("NIFTY", one_minute(early.replace(second=0)), context(setup_candles=previous_day() + today_five(11)), early)
    leaked = sn.analyze_sniper("NIFTY", one_minute(NOW.replace(second=0)), context(), early)
    assert plain["decision"] == leaked["decision"]
    assert plain["sniper"]["families"]["LIQUIDITY_REVERSAL:CALL"]["state"] == leaked["sniper"]["families"]["LIQUIDITY_REVERSAL:CALL"]["state"]


# ---------------------------------------------------------------- decision, scoring, filters

def test_confirmed_reversal_produces_an_explainable_call_setup():
    result = run()
    assert result["decision"] == "CONFIRMED", result["reason"]
    setup = result["setup"]
    assert setup["family"] == "LIQUIDITY_REVERSAL" and setup["contract"]["type"] == "CE"
    assert abs(setup["stop_loss"] - setup["entry"] * 0.75) <= 0.05 and abs(setup["target"] - setup["entry"] * 2) <= 0.05
    assert setup["probability"]["reach_2x_before_stop"] == "UNAVAILABLE"
    assert setup["spot"]["stop"] < 23940  # invalidation below the sweep extreme
    comps = result["sniper"]["components"]
    assert {c["key"] for c in comps} == set(sn.SniperConfig().weights)
    for c in comps:
        assert {"score", "max_score", "status", "reason", "source_timestamp", "features"} <= set(c)
    assert result["sniper"]["score"]["total"] >= 85
    assert result["sniper"]["state"] == "ELIGIBLE"


def test_missing_oi_scores_zero_and_is_never_favourable():
    result = run(options_flow=None)
    oi = next(c for c in result["sniper"]["components"] if c["key"] == "oi")
    assert oi["score"] == 0 and oi["status"] == "UNAVAILABLE"
    full = run()
    assert result["sniper"]["score"]["total"] < full["sniper"]["score"]["total"]
    # Without OI the 85 bar is out of reach here: the system returns no trade, not a guess.
    assert result["decision"] != "CONFIRMED"


def test_stale_feed_is_data_invalid():
    stale_now = NOW + timedelta(minutes=5)
    result = sn.analyze_sniper("NIFTY", one_minute(NOW.replace(second=0)), context(), stale_now)
    assert result["decision"] == "DATA_INVALID"


def test_only_nifty_in_version_one():
    assert sn.analyze_sniper("BANKNIFTY", one_minute(NOW.replace(second=0)), context(), NOW)["decision"] == "NO_TRADE"


def test_entry_cutoff_and_feasibility_gates_block():
    late = run(now=TODAY.replace(hour=14, minute=45, second=30))
    assert late["decision"] != "CONFIRMED"
    # An expensive, far-dated premium cannot plausibly double within the holding horizon.
    pricey = chain("2026-11-24")
    for row in pricey["contracts"]:
        row["premium"] = row["premium"] * 4
        row["theta"] = -6.0
    result = run(option_chain=pricey)
    filters = {f["code"]: f["passed"] for f in result["sniper"]["hard_filters"]}
    assert filters["FEASIBILITY_2X"] is False and result["decision"] != "CONFIRMED"


def test_position_size_never_rounds_up_beyond_the_risk_budget():
    result = run(max_loss_per_trade=300)
    feas = result["sniper"]["feasibility"]
    assert feas["lots"] == 0 and result["decision"] != "CONFIRMED"


def test_score_bands():
    assert sn.band_for(90)[0] == "SNIPER_CANDIDATE" and sn.band_for(80)[0] == "STRONG" and sn.band_for(70)[0] == "WATCHLIST" and sn.band_for(10)[0] == "WEAK"


def test_engine_pipeline_wires_the_sniper_evidence(monkeypatch):
    class Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return NOW
    monkeypatch.setattr(engine, "datetime", Frozen)
    as_dict = lambda rows: [{"timestamp": r.timestamp, "open": r.open, "high": r.high, "low": r.low, "close": r.close, "volume": r.volume} for r in rows]
    payload = {
        "symbol": "NIFTY", "strategy": sn.STRATEGY_ID, "interval_minutes": 1, "candles": as_dict(one_minute(NOW.replace(second=0))),
        "setup_candles": as_dict(previous_day() + today_five()), "option_chain": chain(), "options_flow": FLOW, "vix": VIX, "max_loss_per_trade": 1500,
        "option_evidence": {"option_quote_fresh": True},
        "pipeline": {"broker_healthy": True, "daily_risk_allowed": True, "contract_metadata_available": True, "reconciliation_ok": True, "execution_ready": True},
    }
    result = engine.analyze_payload(payload)
    assert result["strategy_decision"] == "CONFIRMED", result["strategy_reason"]
    assert result["pipeline"]["decision"] == "CONFIRMED", result["pipeline"]["reasons"]
    assert result["setup"]["contract"]["symbol"] == "NIFTY25N1724000CE"
    gates = {g["code"]: g["passed"] for g in result["pipeline"]["gates"]}
    assert gates["BREAKOUT_INVALID"] and gates["RETEST_NOT_CONFIRMED"] and gates["SCORE_BELOW_MINIMUM"] and gates["RR_BELOW_MINIMUM"]
    assert "REGIME_BLOCKED" not in gates and "ORS_NOT_CONFIRMED" not in gates
    assert result["calculations"]["sniper"]["family"] == "LIQUIDITY_REVERSAL"
    # A kill switch still blocks everything, whatever the score.
    payload["pipeline"]["kill_switch"] = True
    assert engine.analyze_payload(payload)["decision"] == "NO_TRADE"
