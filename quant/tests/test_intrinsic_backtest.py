import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from test_intrinsic_value import daily_candles, index_candles  # noqa: E402
from tradepulse_quant.backtest.intrinsic_backtest import implied_delta, replay  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))
OPEN = datetime(2026, 10, 21, 9, 15, tzinfo=IST)


def rows(candles):
    return [{"time": c.timestamp, "open": c.open, "high": c.high, "low": c.low, "close": c.close, "volume": c.volume} for c in candles]


def bars(ohlc):
    return [{"time": (OPEN + timedelta(minutes=5 * i)).isoformat(), "open": o, "high": h, "low": l, "close": c, "volume": 1000} for i, (o, h, l, c) in enumerate(ohlc)]


def day_payload(follow_through: bool) -> dict:
    previous = [c for c in index_candles() if c.timestamp < OPEN.isoformat()]
    # Today: a fade from 25080 to 25000, a flat morning, then either a fall to the 24900 key value
    # (follow-through) or a rally away from it.
    closes = [25080, 25060, 25040, 25020] + [25000] * 14 + ([24980, 24960, 24940, 24920, 24900, 24890] if follow_through else [25020, 25040, 25060, 25080, 25100, 25120])
    index = rows(previous) + bars([(c + 5, c + 8, c - 5, c) for c in closes])
    setup = [(30, 31, 29.8, 30.5), (30.5, 34, 30.2, 33.5), (33.5, 38, 33, 37.5), (37.5, 41, 37, 40.5), (40.5, 40.8, 38.5, 39), (39, 39.5, 37, 37.5), (37.5, 38.2, 37.2, 38), (38, 40.2, 37.8, 40)]
    after = [(40, 48, 39.8, 47), (47, 58, 46, 57), (57, 70, 56, 69), (69, 82, 68, 81), (81, 95, 80, 94), (94, 110, 93, 108)] if follow_through else [(40, 40.4, 36, 36.5), (36.5, 37, 33, 33.5), (33.5, 34, 30, 30.5), (30.5, 31, 28, 28.5), (28.5, 29, 26, 26.5), (26.5, 27, 25, 25.5)]
    premium = [(30, 30.4, 29.8, 30)] * 10 + setup + after
    option = lambda symbol, kind, strike, price: {"symbol": symbol, "type": kind, "strike": strike, "expiry": "2026-10-27", "lot_size": 65, "candles": bars([(price, price * 1.01, price * 0.99, price)] * len(closes))}
    return {
        "symbol": "NIFTY", "day": "2026-10-21", "mapping": "CONTRARIAN", "sentiment": {"score": 55, "label": "STRONG_BULLISH"},
        "candles_5m": index, "daily_candles": rows(daily_candles()),
        "options": [
            {"symbol": "NIFTY26OCT24950PE", "type": "PE", "strike": 24950, "expiry": "2026-10-27", "lot_size": 65, "candles": bars(premium)},
            option("NIFTY26OCT25000PE", "PE", 25000, 62), option("NIFTY26OCT24900PE", "PE", 24900, 18), option("NIFTY26OCT25050CE", "CE", 25050, 45),
        ],
    }


class IntrinsicBacktestTest(unittest.TestCase):
    def test_implied_delta_of_an_otm_put(self):
        delta, iv = implied_delta(25000, 24950, 40, "2026-10-27", datetime(2026, 10, 21, 11, 0, tzinfo=IST), "PE")
        self.assertLess(delta, -0.3)
        self.assertGreater(delta, -0.5)
        self.assertGreater(iv, 1)

    def test_confirmed_setup_trades_to_the_key_value_target(self):
        result = replay(day_payload(follow_through=True))
        self.assertEqual(len(result["trades"]), 1, result["timeline"])
        trade = result["trades"][0]
        self.assertEqual(trade["contract"], "NIFTY26OCT24950PE")
        self.assertEqual(trade["exit_reason"], "TARGET")
        self.assertGreater(trade["pnl_points"], 0)
        self.assertGreaterEqual(trade["r_multiple"], 2)

    def test_failed_follow_through_stops_out(self):
        result = replay(day_payload(follow_through=False))
        self.assertEqual(len(result["trades"]), 1, result["timeline"])
        trade = result["trades"][0]
        self.assertEqual(trade["exit_reason"], "STOP_LOSS")
        self.assertLess(trade["pnl_points"], 0)

    def test_neutral_sentiment_never_trades(self):
        payload = day_payload(follow_through=True)
        payload["sentiment"] = {"score": 10}
        result = replay(payload)
        self.assertEqual(result["trades"], [])
        self.assertEqual(set(result["decisions"]), {"NO_TRADE"})


if __name__ == "__main__":
    unittest.main()
