import unittest
from datetime import datetime, timedelta, timezone

from tradepulse_quant.algo_engine.engine import Candle
from tradepulse_quant.algo_engine.next_day import NextDayConfig, analyze_payload, next_day_setup, next_weekday

IST = timezone(timedelta(hours=5, minutes=30))


def session(day: datetime, path: list[float]) -> list[Candle]:
    """15-minute candles 09:15-15:15 walking through ``path`` (one close per candle)."""
    rows, previous = [], path[0]
    for i, close in enumerate(path):
        start = day.replace(hour=9, minute=15) + timedelta(minutes=15 * i)
        rows.append(Candle(start.isoformat(), previous, max(previous, close) + 6, min(previous, close) - 6, close, 0))
        previous = close
    return rows


def ramp(start: float, end: float, bars: int = 25) -> list[float]:
    return [start + (end - start) * i / (bars - 1) for i in range(bars)]


def history(last_path: list[float], days: int = 8) -> list[Candle]:
    """Alternating up and down sessions ending on 2026-10-21 with ``last_path``; each opens near the prior close."""
    candles, level, day = [], 25000.0, datetime(2026, 10, 12, tzinfo=IST)
    sessions = 0
    while sessions < days - 1:
        if day.weekday() < 5:
            move = 120 if sessions % 2 == 0 else -100
            candles += session(day, ramp(level, level + move))
            level += move + (25 if move > 0 else -25)  # the next open gaps the way the day closed
            sessions += 1
        day += timedelta(days=1)
    while day.weekday() >= 5:
        day += timedelta(days=1)
    shift = level - last_path[0]
    candles += session(datetime(2026, 10, 21, tzinfo=IST), [p + shift for p in last_path])
    return candles


def daily() -> list[Candle]:
    start = datetime(2026, 9, 21, tzinfo=IST)
    return [Candle((start + timedelta(days=i)).isoformat(), 25000, 25110, 24910, 25000, 0) for i in range(25)]


def chain(spot: float) -> dict:
    rows = []
    base = round(spot / 50) * 50
    for k in range(-8, 9):
        strike = base + 50 * k
        call_delta = max(0.03, min(0.97, 0.5 - k * 0.09))
        rows.append({"symbol": f"NIFTY26OCT{strike:.0f}CE", "contract": "CALL", "strike": strike, "premium": round(max(2.0, 70 - 14 * k), 2), "delta": round(call_delta, 2),
                     "openInterest": 9_000_000 if k == 6 else 2_000_000, "volume": 50_000, "expiry": "2026-10-27", "lotSize": 65, "tickSize": 0.05})
        rows.append({"symbol": f"NIFTY26OCT{strike:.0f}PE", "contract": "PUT", "strike": strike, "premium": round(max(2.0, 70 + 14 * k), 2), "delta": round(call_delta - 1, 2),
                     "openInterest": 9_000_000 if k == -6 else 2_000_000, "volume": 50_000, "expiry": "2026-10-27", "lotSize": 65, "tickSize": 0.05})
    return {"spot": spot, "contracts": rows}


AFTER_CLOSE = datetime(2026, 10, 21, 16, 5, tzinfo=IST)
# Opens 25000, dips, then buyers take it to the high into the close.
STRONG_CLOSE = [25000, 24980, 24960, 24950, 24970, 24990, 25000, 25010, 25020, 25030, 25040, 25050, 25060,
                25070, 25080, 25090, 25100, 25110, 25120, 25135, 25150, 25165, 25180, 25195, 25210]
WEAK_CLOSE = [2 * 25000 - p for p in STRONG_CLOSE]
CHOP = [25000, 25030, 24990, 25020, 24985, 25025, 24995, 25015, 24990, 25020, 25000, 25010, 24995,
        25015, 25005, 25000, 25010, 24995, 25005, 25000, 25010, 24995, 25005, 25000, 25002]


def setup(path: list[float], now: datetime = AFTER_CLOSE) -> dict:
    candles = history(path)
    return next_day_setup("NIFTY", candles, daily(), chain(candles[-1].close), {"score": -19.1, "label": "BEARISH"}, now)


class PredictionTest(unittest.TestCase):
    def test_close_at_the_high_predicts_a_gap_up(self):
        result = setup(STRONG_CLOSE)
        self.assertEqual(result["status"], "READY")
        self.assertEqual(result["session_date"], "2026-10-21")
        self.assertEqual(result["next_session_date"], "2026-10-22")
        prediction = result["prediction"]
        self.assertEqual(prediction["opening"], "GAP_UP")
        self.assertGreater(prediction["expected_gap_points"], 0)
        self.assertGreater(prediction["expected_open"], result["reference"]["close"])
        self.assertEqual({f["id"] for f in prediction["factors"]}, {"close_location", "day_body", "open_vs_close", "last_hour", "last_half_hour", "vwap"})
        self.assertAlmostEqual(sum(f["weight"] for f in prediction["factors"]), 1.0)

    def test_close_at_the_low_predicts_a_gap_down(self):
        self.assertEqual(setup(WEAK_CLOSE)["prediction"]["opening"], "GAP_DOWN")

    def test_a_choppy_session_predicts_a_flat_open_with_two_breakout_plans(self):
        result = setup(CHOP)
        self.assertEqual(result["prediction"]["opening"], "FLAT")
        self.assertEqual([p["role"] for p in result["plans"]], ["BREAKOUT_UP", "BREAKOUT_DOWN"])

    def test_during_market_hours_the_previous_session_is_used(self):
        result = setup(STRONG_CLOSE, now=datetime(2026, 10, 21, 11, 0, tzinfo=IST))
        self.assertEqual(result["session_date"], "2026-10-20")
        self.assertEqual(result["next_session_date"], "2026-10-21")

    def test_track_record_scores_earlier_sessions_against_the_next_open(self):
        record = setup(STRONG_CLOSE)["track_record"]
        self.assertEqual(record["days"], 7)
        # The fixture always gaps the way the day closed, which the model reads from the close.
        self.assertEqual(record["direction_hits"], record["directional_days"])
        self.assertGreater(record["directional_days"], 0)

    def test_friday_rolls_to_monday(self):
        from datetime import date
        self.assertEqual(next_weekday(date(2026, 10, 23)), date(2026, 10, 26))


class PlanTest(unittest.TestCase):
    def test_gap_up_plan_buys_an_otm_call_with_full_risk_plan(self):
        result = setup(STRONG_CLOSE)
        primary, alternate = result["plans"]
        self.assertEqual((primary["role"], primary["option_type"]), ("PRIMARY", "CE"))
        self.assertEqual((alternate["role"], alternate["option_type"]), ("ALTERNATE", "PE"))
        index = primary["index"]
        self.assertGreater(index["trigger"], result["prediction"]["expected_open"])
        self.assertLess(index["stop_loss"], index["trigger"])
        self.assertGreater(index["target"], index["trigger"])
        contract = primary["contract"]
        self.assertIsNotNone(contract, primary.get("note"))
        self.assertGreater(contract["strike"], index["trigger"])  # OTM at the trigger
        self.assertLess(contract["strike"], index["target"])  # and inside the key value
        premium = primary["premium"]
        self.assertLess(premium["stop_loss"], premium["entry"])
        self.assertGreater(premium["target"], premium["entry"])
        self.assertGreaterEqual(premium["stop_loss"], round(premium["entry"] * 0.65, 2) - 0.05)  # 35% cap
        self.assertAlmostEqual(premium["breakeven_at"], premium["entry"] + premium["trailing_distance"], places=1)
        self.assertIn("After 9:30", primary["entry_rule"])
        self.assertIn("Trail", primary["trailing_rule"])

    def test_plan_carries_the_premium_calculator(self):
        primary = setup(STRONG_CLOSE)["plans"][0]
        check = primary["premium"]["check"]
        self.assertAlmostEqual(check["spot"], primary["index"]["trigger"], places=0)
        self.assertAlmostEqual(check["key_level"], primary["index"]["target"], places=0)
        self.assertEqual(check["entry"], primary["premium"]["entry"])
        self.assertEqual(check["stop_premium"], primary["premium"]["stop_loss"])
        self.assertIsNotNone(check["move_needed_delta"])
        self.assertTrue(primary["candidates"][0]["target_reachable"])

    def test_gap_down_plan_buys_a_put_below_the_trigger(self):
        primary = setup(WEAK_CLOSE)["plans"][0]
        self.assertEqual(primary["option_type"], "PE")
        self.assertIsNotNone(primary["contract"], primary.get("note"))
        self.assertLess(primary["contract"]["strike"], primary["index"]["trigger"])
        self.assertGreater(primary["contract"]["strike"], primary["index"]["target"])

    def test_expired_contracts_are_skipped(self):
        candles = history(STRONG_CLOSE)
        ladder = chain(candles[-1].close)
        for row in ladder["contracts"]:
            row["expiry"] = "2026-10-21"
        result = next_day_setup("NIFTY", candles, daily(), ladder, None, AFTER_CLOSE)
        self.assertIsNone(result["plans"][0]["contract"])
        self.assertIn("No liquid OTM", result["plans"][0]["note"])

    def test_payload_entry_point(self):
        candles = history(STRONG_CLOSE)
        payload = {"symbol": "nifty", "now": AFTER_CLOSE.isoformat(), "candles": [c.__dict__ for c in candles], "daily_candles": [c.__dict__ for c in daily()], "option_chain": chain(candles[-1].close)}
        result = analyze_payload(payload)
        self.assertEqual(result["symbol"], "NIFTY")
        self.assertEqual(result["status"], "READY")

    def test_no_completed_session(self):
        today_only = session(datetime(2026, 10, 21, tzinfo=IST), STRONG_CLOSE[:8])
        result = next_day_setup("NIFTY", today_only, None, None, None, datetime(2026, 10, 21, 11, 0, tzinfo=IST), NextDayConfig())
        self.assertEqual(result["status"], "NO_DATA")


if __name__ == "__main__":
    unittest.main()
