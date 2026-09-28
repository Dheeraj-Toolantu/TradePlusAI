import json
import subprocess
import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path

from tradepulse_quant.market_intel.candles import IST, parse_bars, session_vwap
from tradepulse_quant.market_intel.engine import analyze_market
from tradepulse_quant.market_intel.options_flow import analyze_options_flow, classify, max_pain, participation, parse_chain, select_contract
from tradepulse_quant.market_intel.smart_money import analyze_smart_money, fair_value_gaps, find_swings, liquidity_sweeps, market_structure
from tradepulse_quant.market_intel.volatility import analyze_volatility, vix_regime


def bar(moment, o, h, l, c, v=0):
    return {"timestamp": moment.isoformat(), "open": o, "high": h, "low": l, "close": c, "volume": v}


def trending_candles(direction=1, today=datetime(2026, 9, 28, 9, 15, tzinfo=IST), bars_today=20):
    """A flat previous session, then a stair-step trend today (impulse legs with shallow pullbacks)."""
    rows = []
    previous = today - timedelta(days=3)  # Friday before a Monday session
    for index in range(75):
        base = 25000 + (index % 6) * 4
        rows.append(bar(previous + timedelta(minutes=5 * index), base, base + 12, base - 12, base + 2))
    price = 25005.0
    pattern = [1, 1, 1, -1, -1, 1, 1, 1, -1, -1]
    for index in range(bars_today):
        step = pattern[index % len(pattern)] * direction
        move = 22 if step * direction > 0 else 9
        o = price
        c = price + move * step
        rows.append(bar(today + timedelta(minutes=5 * index), o, max(o, c) + 4, min(o, c) - 4, c))
        price = c
    return rows


def chain_rows(spot, pe_oi_boost=0.0, pe_ltp_shift=0.0, ce_oi_cut=0.0, ce_ltp_shift=0.0):
    rows = []
    for strike in range(24700, 25551, 50):
        distance = strike - spot
        ce_ltp = max(spot - strike, 0) + 90 * 2.718 ** (-abs(distance) / 250)
        pe_ltp = max(strike - spot, 0) + 90 * 2.718 ** (-abs(distance) / 250)
        ce_delta = max(0.05, min(0.95, 0.5 - distance / 600))
        rows.append({
            "strike": strike,
            "ce": {"ltp": round(ce_ltp + ce_ltp_shift, 2), "oi": 100_000 + max(distance, 0) * 400 - ce_oi_cut * 1000, "volume": 400_000, "iv": 13, "delta": ce_delta, "trading_symbol": f"NIFTY{strike}CE"},
            "pe": {"ltp": round(pe_ltp + pe_ltp_shift, 2), "oi": 100_000 + max(-distance, 0) * 400 + pe_oi_boost * 1000, "volume": 400_000, "iv": 14, "delta": ce_delta - 1, "trading_symbol": f"NIFTY{strike}PE"},
        })
    return rows


class CandleTests(unittest.TestCase):
    def test_parse_bars_drops_invalid_rows_and_sorts(self):
        moment = datetime(2026, 9, 28, 9, 20, tzinfo=IST)
        bars = parse_bars([bar(moment, 10, 11, 9, 10.5), {"timestamp": "bad", "open": 1, "high": 1, "low": 1, "close": 1}, bar(moment - timedelta(minutes=5), 10, 9, 11, 10), {"time": int((moment - timedelta(minutes=5)).timestamp()), "open": 9, "high": 10, "low": 8, "close": 9.5}])
        self.assertEqual([b.close for b in bars], [9.5, 10.5])

    def test_vwap_falls_back_to_twap_without_volume(self):
        bars = parse_bars([bar(datetime(2026, 9, 28, 9, 15, tzinfo=IST), 10, 12, 8, 10)])
        value, weighted = session_vwap(bars)
        self.assertAlmostEqual(value, 10.0)
        self.assertFalse(weighted)


class SmartMoneyTests(unittest.TestCase):
    def test_bullish_fvg_is_detected_and_filled_gaps_are_dropped(self):
        start = datetime(2026, 9, 28, 9, 15, tzinfo=IST)
        bars = parse_bars([bar(start, 100, 101, 99, 100.5), bar(start + timedelta(minutes=5), 100.5, 106, 100.4, 105.5), bar(start + timedelta(minutes=10), 105.5, 107, 102, 106.5)])
        gaps = fair_value_gaps(bars, 2.0)
        self.assertEqual(len(gaps), 1)
        self.assertEqual(gaps[0]["direction"], "BULLISH")
        self.assertEqual((gaps[0]["bottom"], gaps[0]["top"]), (101, 102))
        filled = parse_bars([*(vars_ for vars_ in [bar(start, 100, 101, 99, 100.5), bar(start + timedelta(minutes=5), 100.5, 106, 100.4, 105.5), bar(start + timedelta(minutes=10), 105.5, 107, 102, 106.5), bar(start + timedelta(minutes=15), 106, 106.5, 100.8, 101.5)])])
        self.assertEqual(fair_value_gaps(filled, 2.0), [])

    def test_structure_reports_bos_in_an_uptrend(self):
        bars = parse_bars(trending_candles(1))
        trend, events, _ = market_structure(bars, find_swings(bars))
        self.assertEqual(trend, "BULLISH")
        self.assertEqual(events[-1]["direction"], "BULLISH")

    def test_choch_on_first_break_against_trend(self):
        rows = trending_candles(1)
        last = datetime.fromisoformat(rows[-1]["timestamp"])
        price = rows[-1]["close"]
        for index in range(1, 9):
            rows.append(bar(last + timedelta(minutes=5 * index), price, price + 3, price - 40, price - 36))
            price -= 36
        bars = parse_bars(rows)
        trend, events, _ = market_structure(bars, find_swings(bars))
        self.assertEqual(trend, "BEARISH")
        self.assertIn("CHOCH", [event["type"] for event in events])

    def test_sell_side_sweep_of_previous_day_low(self):
        rows = trending_candles(1, bars_today=4)
        pdl = min(r["low"] for r in rows[:75])
        last = datetime.fromisoformat(rows[-1]["timestamp"])
        rows.append(bar(last + timedelta(minutes=5), pdl + 5, pdl + 8, pdl - 6, pdl + 6))
        bars = parse_bars(rows)
        smc = analyze_smart_money(bars, 20.0)
        self.assertTrue(any(s["side"] == "SELL_SIDE" and s["label"] == "Previous day low" for s in smc["sweeps"]))


class OptionsFlowTests(unittest.TestCase):
    def test_price_oi_classification(self):
        self.assertEqual(classify(5000, 3, 100000, 100), "LONG_BUILDUP")
        self.assertEqual(classify(5000, -3, 100000, 100), "SHORT_BUILDUP")
        self.assertEqual(classify(-5000, 3, 100000, 100), "SHORT_COVERING")
        self.assertEqual(classify(-5000, -3, 100000, 100), "LONG_UNWINDING")
        self.assertEqual(classify(10, -3, 100000, 100), "NEUTRAL")

    def test_put_writing_and_call_covering_is_bullish(self):
        spot = 25100
        baseline = chain_rows(spot - 20)
        current = chain_rows(spot, pe_oi_boost=30, pe_ltp_shift=-4, ce_oi_cut=25, ce_ltp_shift=3)
        flow = analyze_options_flow(current, spot, baseline, spot - 20, 300)
        self.assertEqual(flow["oi_direction_score"], 2)
        self.assertGreater(flow["pcr_oi"], 1.0)
        self.assertGreater(flow["pcr_change_5m"], 0)
        self.assertTrue(flow["put_writing"])
        self.assertEqual(flow["baseline_minutes"], 5.0)
        self.assertEqual(flow["atm_strike"], 25100)

    def test_call_writing_is_bearish(self):
        spot = 25100
        flow = analyze_options_flow(chain_rows(spot, ce_oi_cut=-30, ce_ltp_shift=-4, pe_oi_boost=-25, pe_ltp_shift=3), spot, chain_rows(spot + 20), spot + 20, 300)
        self.assertLessEqual(flow["oi_direction_score"], -1)
        self.assertTrue(flow["call_writing"])

    def test_no_baseline_means_no_direction_score(self):
        flow = analyze_options_flow(chain_rows(25100), 25100)
        self.assertIsNone(flow["oi_direction_score"])
        self.assertIn("baseline", flow["oi_direction_label"])

    def test_max_pain_and_walls(self):
        chain = parse_chain([
            {"strike": 100, "ce": {"ltp": 5, "oi": 10}, "pe": {"ltp": 1, "oi": 500}},
            {"strike": 110, "ce": {"ltp": 2, "oi": 50}, "pe": {"ltp": 3, "oi": 50}},
            {"strike": 120, "ce": {"ltp": 1, "oi": 600}, "pe": {"ltp": 9, "oi": 10}},
        ])
        self.assertEqual(max_pain(chain), 110)
        flow = analyze_options_flow([{"strike": s, "ce": {"ltp": 1, "oi": o[0]}, "pe": {"ltp": 1, "oi": o[1]}} for s, o in ((100, (10, 500)), (110, (50, 50)), (120, (600, 10)))], 110)
        self.assertEqual(flow["resistance"][0]["strike"], 120)
        self.assertEqual(flow["support"][0]["strike"], 100)

    def test_ors_is_delta_normalised(self):
        self.assertAlmostEqual(participation(25.0, 50.0, 0.5, 25000), 1.0)
        self.assertIsNone(participation(1.0, 1.0, 0.5, 25000))

    def test_contract_selection_prefers_liquid_atm_or_itm_with_strong_delta(self):
        contract = select_contract(parse_chain(chain_rows(25100)), 25100, "CE")
        self.assertIn(contract["moneyness"], {"ATM", "ITM"})
        self.assertGreaterEqual(abs(contract["delta"]), 0.45)
        self.assertGreaterEqual(contract["liquidity_score"], 2)


class VolatilityTests(unittest.TestCase):
    def test_regimes_and_expected_move(self):
        self.assertEqual(vix_regime(10), "LOW")
        self.assertEqual(vix_regime(14), "NORMAL")
        self.assertEqual(vix_regime(21), "HIGH")
        self.assertEqual(vix_regime(30), "EXTREME")
        result = analyze_volatility({"value": 15.87, "percent": 6}, 25000, None)
        self.assertAlmostEqual(result["expected_daily_move"], 25000 * 0.1587 / 252 ** 0.5, places=4)
        self.assertEqual(result["trend"], "RISING_FAST")

    def test_falls_back_to_atm_iv(self):
        result = analyze_volatility(None, 25000, 13.0)
        self.assertTrue(result["available"])
        self.assertIn("ATM implied volatility", result["basis"])


class MarketIntelEngineTests(unittest.TestCase):
    def payload(self, direction=1, vix=13.5, baseline=True, now="2026-09-28T11:00:00+05:30"):
        candles = trending_candles(direction)
        spot = candles[-1]["close"]
        strike_spot = round(spot / 50) * 50
        if direction > 0:
            current = chain_rows(strike_spot, pe_oi_boost=30, pe_ltp_shift=-4, ce_oi_cut=25, ce_ltp_shift=3)
        else:
            current = chain_rows(strike_spot, ce_oi_cut=-30, ce_ltp_shift=-4, pe_oi_boost=-25, pe_ltp_shift=3)
        return {
            "symbol": "NIFTY", "spot": spot, "candles": candles, "now": now, "expiry": "2026-09-30", "lot_size": 65,
            "chain": current, "baseline_chain": chain_rows(strike_spot) if baseline else None, "baseline_spot": spot - 20 * direction, "baseline_age_seconds": 300,
            "vix": {"value": vix, "percent": -1.0}, "capital": 500000,
        }

    def test_bullish_market_produces_a_ce_plan_with_structural_risk(self):
        result = analyze_market(self.payload(1))
        self.assertEqual(result["verdict"]["bias"], "BULLISH")
        plan = result["trade_plan"]
        self.assertEqual(plan["direction"], "CE")
        self.assertLess(plan["spot"]["stop"], plan["spot"]["entry"])
        self.assertGreater(plan["spot"]["target1"], plan["spot"]["entry"])
        self.assertGreaterEqual(plan["risk_reward"], 1.9)
        self.assertLess(plan["premium"]["stop"], plan["premium"]["entry"])
        self.assertIsNotNone(plan["lots"])
        self.assertTrue(any(item["key"] == "writers" and item["passed"] for item in plan["checklist"]))
        self.assertEqual(result["v5_option_evidence"]["oi_direction_score"], 2)
        self.assertNotIn("chain", result["options_flow"])

    def test_bearish_market_produces_a_pe_plan(self):
        result = analyze_market(self.payload(-1))
        self.assertEqual(result["verdict"]["bias"], "BEARISH")
        self.assertEqual(result["trade_plan"]["direction"], "PE")
        self.assertGreater(result["trade_plan"]["spot"]["stop"], result["trade_plan"]["spot"]["entry"])

    def test_extreme_vix_blocks_option_buying(self):
        result = analyze_market(self.payload(1, vix=32))
        self.assertEqual(result["trade_plan"]["status"], "NO_TRADE")
        self.assertEqual(result["v5_option_evidence"]["vix_regime"], "EXTREME")

    def test_missing_baseline_keeps_plan_waiting(self):
        result = analyze_market(self.payload(1, baseline=False))
        writers = next(item for item in result["trade_plan"]["checklist"] if item["key"] == "writers")
        self.assertFalse(writers["passed"])
        self.assertNotEqual(result["trade_plan"]["status"], "READY")

    def test_after_hours_is_market_closed(self):
        result = analyze_market(self.payload(1, now="2026-09-28T16:00:00+05:30"))
        self.assertEqual(result["trade_plan"]["status"], "MARKET_CLOSED")

    def test_insufficient_candles_fail_closed(self):
        result = analyze_market({"symbol": "NIFTY", "candles": trending_candles(1)[:5], "spot": 25000})
        self.assertFalse(result["available"])

    def test_cli_emits_strict_json(self):
        root = Path(__file__).resolve().parents[1]
        completed = subprocess.run([sys.executable, "-m", "tradepulse_quant.market_intel.engine"], input=json.dumps(self.payload(1)), capture_output=True, text=True, cwd=root, env={"PYTHONPATH": str(root / "src")}, check=True)
        parsed = json.loads(completed.stdout)
        self.assertEqual(parsed["symbol"], "NIFTY")


if __name__ == "__main__":
    unittest.main()
