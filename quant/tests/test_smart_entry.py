"""Smart zone entry: 5m confluence zones + 1m CHoCH confirmation (market_intel.smart_entry)."""
import unittest
from datetime import datetime, timedelta

from tradepulse_quant.market_intel.candles import IST, Bar
from tradepulse_quant.market_intel.smart_entry import analyze_smart_entry, build_zones

START = datetime(2026, 9, 30, 9, 45, tzinfo=IST)
NOW = datetime(2026, 9, 30, 10, 20, tzinfo=IST)

# Sell-off in lower highs into the 24,480-24,500 demand zone, a wick to 24,470 (stop hunt
# below the zone), then a 1-minute close above the last lower high (24,522) and a hold.
SELL_OFF_AND_FLIP = [
    (24560, 24564, 24550, 24552), (24552, 24556, 24544, 24546), (24546, 24554, 24544, 24552),
    (24552, 24553, 24536, 24538), (24538, 24540, 24526, 24528), (24528, 24536, 24526, 24534),
    (24534, 24535, 24516, 24518), (24518, 24520, 24504, 24506), (24506, 24522, 24504, 24520),
    (24520, 24521, 24496, 24498), (24498, 24500, 24486, 24490), (24490, 24492, 24470, 24488),
    (24488, 24502, 24486, 24500), (24500, 24512, 24498, 24510), (24510, 24526, 24508, 24524),
    (24524, 24530, 24520, 24528),
]


def bars_1m(rows, start=START):
    return [Bar(start + timedelta(minutes=index), o, h, l, c, 0.0) for index, (o, h, l, c) in enumerate(rows)]


def mirror(rows, pivot=49000):
    return [(pivot - o, pivot - l, pivot - h, pivot - c) for o, h, l, c in rows]


def context(direction=1, trend_15m="BULLISH", smc_trend="BULLISH", oi_score=1, with_wall=True):
    if direction > 0:
        smc = {"available": True, "trend": smc_trend, "last_event": {"type": "BOS", "direction": "BULLISH", "level": 24600},
               "order_blocks": [{"direction": "BULLISH", "top": 24500.0, "bottom": 24480.0}], "fair_value_gaps": [],
               "liquidity": {"previous_day_low": 24490.0, "previous_day_high": 24700.0, "session_high": 24640.0, "session_low": 24470.0, "equal_highs": [], "equal_lows": []},
               "swings": []}
        flow = {"available": True, "oi_direction_score": oi_score, "oi_direction_label": "Bullish: put-side writing", "pcr_oi": 1.1,
                "support": [{"strike": 24500.0, "oi": 1e7}] if with_wall else [], "resistance": [{"strike": 24700.0, "oi": 1e7}], "chain": {}}
    else:
        smc = {"available": True, "trend": smc_trend, "last_event": {"type": "BOS", "direction": "BEARISH", "level": 24400},
               "order_blocks": [{"direction": "BEARISH", "top": 24520.0, "bottom": 24500.0}], "fair_value_gaps": [],
               "liquidity": {"previous_day_low": 24300.0, "previous_day_high": 24510.0, "session_high": 24530.0, "session_low": 24360.0, "equal_highs": [], "equal_lows": []},
               "swings": []}
        flow = {"available": True, "oi_direction_score": oi_score, "oi_direction_label": "Bearish: call-side writing", "pcr_oi": 0.75,
                "support": [{"strike": 24300.0, "oi": 1e7}], "resistance": [{"strike": 24500.0, "oi": 1e7}] if with_wall else [], "chain": {}}
    tech = {"atr14": 20.0, "trend_15m": trend_15m, "session_bars": 12, "last_price": 24530.0}
    vol = {"available": True, "value": 13.0, "regime": "NORMAL", "expected_range": {"low": 24300.0, "high": 24760.0}}
    return tech, smc, flow, vol


def run(rows, direction=1, session_ok=True, **kwargs):
    tech, smc, flow, vol = context(direction, **kwargs)
    session = {"entry_permitted": session_ok, "market_open": True}
    meta = {"spot": rows[-1][3], "now": NOW, "expiry_today": False}
    sentiment = {"india_label": "BULLISH" if direction > 0 else "BEARISH", "india_score": 20 * direction}
    macro = {"available": True, "score": 15.0 * direction, "label": "TAILWIND" if direction > 0 else "HEADWIND"}
    return analyze_smart_entry([], bars_1m(rows), tech, smc, flow, vol, {}, sentiment, macro, session, meta)


class Zones(unittest.TestCase):
    def test_order_block_level_and_writer_wall_merge_into_one_strong_zone(self):
        tech, smc, flow, _ = context()
        zones = build_zones(smc, flow, tech, 20.0, 1)
        self.assertEqual(len(zones), 1)
        self.assertEqual(zones[0].strength, 3)
        self.assertIn("Put-writer wall 24500", zones[0].sources)


class DemandReversal(unittest.TestCase):
    def test_sweep_and_1m_choch_at_demand_is_an_entry(self):
        result = run(SELL_OFF_AND_FLIP)
        self.assertEqual(result["status"], "ENTRY", result.get("headline"))
        self.assertEqual(result["side"], "CE")
        self.assertTrue(result["trigger"]["swept"])
        self.assertLess(result["spot"]["stop"], 24470)  # below the stop-hunt low
        self.assertGreaterEqual(result["score"], 8)
        self.assertFalse(result["counter_trend"])
        self.assertTrue(any("trapped" in line for line in result["psychology"]))

    def test_waits_for_the_1m_flip_while_price_sits_in_the_zone(self):
        result = run(SELL_OFF_AND_FLIP[:13])
        self.assertEqual(result["status"], "ARMED")
        self.assertIn("waiting for a 1-minute close", result["reason"])

    def test_old_flip_is_not_chased(self):
        drift = [(24532, 24540, 24530, 24538), (24538, 24545, 24536, 24542), (24542, 24548, 24540, 24546), (24546, 24552, 24544, 24550)]
        result = run(SELL_OFF_AND_FLIP + drift)
        self.assertNotEqual(result["status"], "ENTRY")

    def test_counter_trend_against_writers_is_blocked(self):
        result = run(SELL_OFF_AND_FLIP, trend_15m="BEARISH", smc_trend="BEARISH", oi_score=-2)
        self.assertEqual(result["status"], "BLOCKED")
        self.assertTrue(any(not gate["passed"] and "fighting" in gate["label"] for gate in result["gates"]))

    def test_counter_trend_with_writers_support_trades_half_size(self):
        result = run(SELL_OFF_AND_FLIP, trend_15m="BEARISH", smc_trend="BEARISH", oi_score=2)
        self.assertTrue(result["counter_trend"])
        self.assertEqual(result["size_multiplier"], 0.5)

    def test_outside_the_entry_window_is_blocked(self):
        self.assertEqual(run(SELL_OFF_AND_FLIP, session_ok=False)["status"], "BLOCKED")


class SupplyReversal(unittest.TestCase):
    def test_rally_into_supply_with_1m_choch_down_is_a_put_entry(self):
        rows = mirror(SELL_OFF_AND_FLIP)  # 24440 -> rally to 24530 wick -> flip down
        result = run(rows, direction=-1, trend_15m="BEARISH", smc_trend="BEARISH", oi_score=-1)
        self.assertEqual(result["status"], "ENTRY", result.get("headline"))
        self.assertEqual(result["side"], "PE")
        self.assertGreater(result["spot"]["stop"], 24530)
        self.assertLess(result["spot"]["target1"], result["spot"]["entry"])


if __name__ == "__main__":
    unittest.main()
