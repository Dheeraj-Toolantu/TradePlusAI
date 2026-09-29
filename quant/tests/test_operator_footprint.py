import json
import unittest
from datetime import datetime, timedelta

from tradepulse_quant.market_intel.candles import IST, parse_bars
from tradepulse_quant.market_intel.engine import analyze_market
from tradepulse_quant.market_intel.macro import fetch_quotes, parse_chart, score_macro
from tradepulse_quant.market_intel.operator_footprint import (
    directional_context,
    fvg_base_rates,
    operator_entries,
    rolling_atr,
    writer_positions,
)
from tradepulse_quant.market_intel.options_flow import analyze_options_flow

from test_market_intel import bar, chain_rows, trending_candles


def chart(price, previous):
    return json.dumps({"chart": {"result": [{"meta": {"regularMarketPrice": price, "previousClose": previous}, "indicators": {"quote": [{"close": [previous, price]}]}}]}})


def operator_candles():
    """Quiet chop, a stop hunt below the range, then a bullish displacement leg from a red candle."""
    day = datetime(2026, 9, 28, 9, 15, tzinfo=IST)
    rows = []
    for index in range(20):
        base = 25000 + (index % 4) * 3
        rows.append(bar(day + timedelta(minutes=5 * index), base, base + 8, base - 8, base + 1))
    t = len(rows)
    rows.append(bar(day + timedelta(minutes=5 * t), 25000, 25004, 24975, 24996))  # sweep below ~24992 and close back in
    rows.append(bar(day + timedelta(minutes=5 * (t + 1)), 24998, 25000, 24988, 24990))  # last red candle = origin
    rows.append(bar(day + timedelta(minutes=5 * (t + 2)), 24991, 25045, 24990, 25042))  # displacement
    rows.append(bar(day + timedelta(minutes=5 * (t + 3)), 25042, 25090, 25040, 25086))  # displacement, leaves an FVG
    for offset in range(4, 10):
        rows.append(bar(day + timedelta(minutes=5 * (t + offset)), 25080, 25092, 25072, 25084))
    return rows


class MacroTests(unittest.TestCase):
    def test_parse_chart_uses_previous_close(self):
        quote = parse_chart(chart(82.0, 80.0))
        self.assertAlmostEqual(quote["change_pct"], 2.5)
        self.assertIsNone(parse_chart("not json"))

    def test_oil_spike_and_weak_rupee_is_a_headwind(self):
        fixtures = {"BZ=F": chart(84.0, 80.0), "INR=X": chart(84.5, 84.0), "ES=F": chart(5000, 5000)}
        result = score_macro(fetch_quotes(fixtures))
        self.assertTrue(result["available"])
        self.assertLess(result["score"], -12)
        self.assertEqual(result["drivers"][0]["id"], "brent")
        self.assertEqual(result["drivers"][0]["effect"], "HEADWIND")
        self.assertTrue(any("Brent" in note for note in result["notes"]))

    def test_missing_quotes_are_unavailable_not_neutral_guesses(self):
        self.assertFalse(score_macro(None)["available"])
        self.assertFalse(score_macro({"brent": {"change_pct": "x"}})["available"])


class OperatorEntryTests(unittest.TestCase):
    def test_detects_long_entry_with_stop_hunt_fvg_and_writer_defence(self):
        bars = parse_bars(operator_candles())
        flow = {"available": True, "strike_step": 50.0, "support": [{"strike": 25000.0, "oi": 1e7}], "resistance": [], "put_writing": [], "call_writing": []}
        entries = operator_entries(bars, rolling_atr(bars), flow)
        self.assertTrue(entries)
        top = entries[0]
        self.assertEqual(top["direction"], "LONG")
        self.assertEqual((top["zone_low"], top["zone_high"]), (24988.0, 25000.0))
        joined = " ".join(top["evidence"])
        self.assertIn("Swept sell-side stops", joined)
        self.assertIn("fair value gap", joined)
        self.assertIn("Put writers defend 25,000", joined)
        self.assertTrue(top["in_profit"])

    def test_invalidated_zone_is_dropped(self):
        rows = operator_candles()
        last = datetime.fromisoformat(rows[-1]["timestamp"])
        rows.append(bar(last + timedelta(minutes=5), 25080, 25082, 24950, 24960))  # closes below the origin low
        bars = parse_bars(rows)
        entries = operator_entries(bars, rolling_atr(bars), {"available": False})
        self.assertFalse([e for e in entries if e["direction"] == "LONG" and e["zone_low"] == 24988.0])

    def test_writer_breakevens(self):
        flow = analyze_options_flow(chain_rows(25000), 25010)
        writers = writer_positions(flow, 25010)
        put = next(w for w in writers if w["side"] == "PE")
        call = next(w for w in writers if w["side"] == "CE")
        self.assertLess(put["breakeven"], put["strike"])
        self.assertGreater(call["breakeven"], call["strike"])


class FillProbabilityTests(unittest.TestCase):
    def test_base_rates_ignore_the_unfinished_session(self):
        bars = parse_bars(operator_candles())  # single session => nothing completed
        rates = fvg_base_rates(bars, rolling_atr(bars))
        self.assertEqual(rates["sessions"], 0)
        self.assertEqual(rates["gaps"], 0)
        for bucket in rates["buckets"]:
            self.assertEqual(bucket["rate"], round((bucket["prior"] * 4) / 4, 3))

    def test_base_rates_learn_from_completed_sessions(self):
        bars = parse_bars(trending_candles(1, bars_today=40) + trending_candles(1, today=datetime(2026, 9, 29, 9, 15, tzinfo=IST), bars_today=5))
        rates = fvg_base_rates(bars, rolling_atr(bars))
        self.assertGreaterEqual(rates["sessions"], 1)
        self.assertTrue(all(0 < b["rate"] < 1 for b in rates["buckets"]))

    def test_pressure_combines_sources(self):
        pressure, parts = directional_context({"bias": "BULLISH", "score": 7}, {"available": True, "oi_direction_score": 2, "oi_direction_label": "x"}, {"available": True, "trend": "BULLISH", "swing_sequence": "HH_HL"}, None, {"available": True, "score": -50, "drivers": []})
        self.assertGreater(pressure, 0.5)
        self.assertEqual(parts[-1]["signal"], "BEARISH")


class EngineIntegrationTests(unittest.TestCase):
    def payload(self, direction=1, macro=None):
        candles = trending_candles(direction, bars_today=30)
        spot = candles[-1]["close"]
        strike_spot = round(spot / 50) * 50
        return {
            "symbol": "NIFTY", "spot": spot, "candles": candles, "now": "2026-09-28T11:45:00+05:30", "expiry": "2026-09-30", "lot_size": 65,
            "chain": chain_rows(strike_spot, pe_oi_boost=30, pe_ltp_shift=-4), "baseline_chain": chain_rows(strike_spot), "baseline_spot": spot - 20, "baseline_age_seconds": 300,
            "vix": {"value": 13.5, "percent": -1.0}, "macro": macro,
        }

    def test_operator_section_is_emitted_and_json_safe(self):
        macro = {"brent": {"price": 80, "change_pct": -2.5}, "spx_fut": {"price": 5000, "change_pct": 0.8}}
        result = analyze_market(self.payload(1, macro))
        operator = result["operator"]
        self.assertTrue(operator["available"])
        self.assertIn(operator["stance"], ("ACCUMULATING", "DISTRIBUTING", "TWO_SIDED"))
        self.assertTrue(operator["macro"]["available"])
        self.assertGreater(operator["macro"]["score"], 0)
        for gap in operator["fvg_fill"]["gaps"]:
            self.assertTrue(3 <= gap["probability"] <= 97)
        probabilities = [gap["probability"] for gap in operator["fvg_fill"]["gaps"]]
        self.assertEqual(probabilities, sorted(probabilities, reverse=True))
        json.dumps(result, allow_nan=False)

    def test_works_without_macro(self):
        result = analyze_market(self.payload(1))
        self.assertTrue(result["operator"]["available"])
        self.assertIsNone(result["operator"]["macro"])


if __name__ == "__main__":
    unittest.main()
