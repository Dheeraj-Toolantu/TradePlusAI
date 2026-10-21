import unittest
from datetime import datetime, timedelta, timezone

from tradepulse_quant.algo_engine.engine import Candle, _intrinsic_evidence, analyze
from tradepulse_quant.algo_engine.intrinsic_value import IntrinsicConfig, premium_trigger, read_sentiment
from tradepulse_quant.algo_engine.pipeline import evaluate_payload

IST = timezone(timedelta(hours=5, minutes=30))
NOW = datetime(2026, 10, 21, 11, 2, tzinfo=IST)


def _bar(day: datetime, index: int, open_: float, high: float, low: float, close: float) -> Candle:
    return Candle((day + timedelta(minutes=5 * index)).isoformat(), open_, high, low, close, 0)


def index_candles() -> list[Candle]:
    """Previous session 24850-25120 (close 25060); today rallies to 25150 and fades to 25000."""
    previous = datetime(2026, 10, 20, 9, 15, tzinfo=IST)
    candles = []
    for i in range(75):
        mid = 24850 + (i % 15) * 18
        candles.append(_bar(previous, i, mid, mid + 10, mid - 10 if i else 24850, mid + 5))
    candles[-1] = _bar(previous, 74, 25050, 25065, 25040, 25060)
    today = datetime(2026, 10, 21, 9, 15, tzinfo=IST)
    path = [25080, 25100, 25120, 25150, 25140, 25120, 25100, 25090, 25070, 25060, 25050, 25040, 25030, 25035, 25025, 25020, 25015, 25010, 25005, 25000]
    for i, close in enumerate(path):
        candles.append(_bar(today, i, close + 5, close + 12, close - 8, close))
    return candles


def daily_candles() -> list[Candle]:
    start = datetime(2026, 9, 21, tzinfo=IST)
    return [Candle((start + timedelta(days=i)).isoformat(), 25000, 25125, 24875, 25000, 0) for i in range(25)]


def chain() -> dict:
    rows = []
    for strike, put_premium, put_delta, put_oi in [(24800, 15, -0.18, 9_000_000), (24850, 22, -0.24, 4_000_000), (24900, 32, -0.32, 6_000_000), (24950, 45, -0.42, 3_000_000), (25000, 62, -0.5, 5_000_000), (25050, 85, -0.6, 2_000_000)]:
        rows.append({"symbol": f"NIFTY26OCT{strike}PE", "contract": "PUT", "strike": strike, "premium": put_premium, "delta": put_delta, "iv": 13.5, "openInterest": put_oi, "volume": 120_000, "expiry": "2026-10-27", "lotSize": 65, "tickSize": 0.05, "freezeQuantity": 1800})
    for strike, call_premium, call_delta, call_oi in [(25050, 40, 0.4, 3_000_000), (25100, 26, 0.3, 4_000_000), (25150, 16, 0.21, 2_500_000), (25200, 9, 0.13, 8_000_000), (25300, 4, 0.06, 6_000_000)]:
        rows.append({"symbol": f"NIFTY26OCT{strike}CE", "contract": "CALL", "strike": strike, "premium": call_premium, "delta": call_delta, "iv": 13.0, "openInterest": call_oi, "volume": 90_000, "expiry": "2026-10-27", "lotSize": 65, "tickSize": 0.05, "freezeQuantity": 1800})
    return {"spot": 25000, "expiry": "2026-10-27", "contracts": rows}


def premium_candles(closes: list[tuple[float, float, float, float]]) -> list[Candle]:
    today = datetime(2026, 10, 21, 9, 15, tzinfo=IST)
    return [_bar(today, i, *ohlc) for i, ohlc in enumerate(closes)]


IMPULSE_PULLBACK_CONTINUATION = [
    (40, 41, 39.5, 40.5), (40.5, 42, 40, 41.5), (41.5, 46, 41, 45.5), (45.5, 51, 45, 50.5), (50.5, 55, 50, 54),
    (54, 54.5, 51, 51.5), (51.5, 52, 49, 49.5), (49.5, 50.5, 49.2, 50), (50, 53, 49.8, 52.5),
]


def context(score: float = 55, mapping: str = "CONTRARIAN", premium: list[Candle] | None = None, symbol: str = "NIFTY26OCT24950PE") -> dict:
    ctx = {
        "index_sentiment": {"score": score, "label": "STRONG_BULLISH" if score >= 40 else "BULLISH", "generated_at": (NOW - timedelta(minutes=8)).isoformat()},
        "option_chain": chain(),
        "sentiment_mapping": mapping,
    }
    if premium is not None:
        ctx["premium_candles"] = {"symbol": symbol, "candles": premium}
    return ctx


def run(ctx: dict) -> dict:
    return analyze("NIFTY", index_candles(), strategy="INTRINSIC_VALUE", daily_candles=daily_candles(), context=ctx, now=NOW)


class SentimentMappingTest(unittest.TestCase):
    def test_contrarian_is_the_default_rule(self):
        config = IntrinsicConfig()
        self.assertEqual(read_sentiment({"score": 55}, "CONTRARIAN", config, NOW)["option_type"], "PE")
        self.assertEqual(read_sentiment({"score": -62}, "CONTRARIAN", config, NOW)["option_type"], "CE")

    def test_follow_mapping_flips_the_direction(self):
        config = IntrinsicConfig()
        self.assertEqual(read_sentiment({"score": 55}, "FOLLOW", config, NOW)["option_type"], "CE")
        self.assertEqual(read_sentiment({"score": -62}, "FOLLOW", config, NOW)["option_type"], "PE")

    def test_moderate_sentiment_is_no_trade(self):
        result = run(context(score=25))
        self.assertEqual(result["decision"], "NO_TRADE")
        self.assertIn("not extreme", result["reason"])

    def test_missing_or_stale_sentiment_fails_closed(self):
        ctx = context()
        ctx["index_sentiment"] = None
        self.assertIn("unavailable", run(ctx)["reason"])
        ctx = context()
        ctx["index_sentiment"]["generated_at"] = (NOW - timedelta(hours=2)).isoformat()
        self.assertIn("old", run(ctx)["reason"])


class StrikeSelectionTest(unittest.TestCase):
    def test_key_value_then_highest_chance_otm_strike(self):
        result = run(context())
        calc = result["intrinsic"]
        # 24950 PE is the first OTM put; the round number 24900 below it is the key value.
        self.assertEqual(calc["key_value"]["price"], 24900)
        self.assertEqual(calc["selected"]["symbol"], "NIFTY26OCT24950PE")
        self.assertEqual(calc["selected"]["intrinsic_at_key"], 50)
        self.assertGreater(calc["selected"]["itm_chance"], calc["selected"]["market_odds"])
        # The strike is chosen first; its premium candles are requested next.
        self.assertEqual(result["decision"], "WAIT_FOR_CONFIRMATION")
        self.assertEqual(result["needs_premium_candles"], "NIFTY26OCT24950PE")

    def test_strike_must_offer_a_meaningful_intrinsic_gain(self):
        ctx = context()
        for row in ctx["option_chain"]["contracts"]:
            row["premium"] *= 4  # an expensive chain: 50 points of intrinsic no longer pays
        result = run(ctx)
        self.assertEqual(result["decision"], "NO_TRADE")
        self.assertIn("intrinsic gain", result["reason"])

    def test_bearish_sentiment_buys_a_call_under_contrarian(self):
        result = run(context(score=-58))
        self.assertEqual(result["intrinsic"]["sentiment"]["option_type"], "CE")
        selected = result["intrinsic"]["selected"]
        self.assertIsNotNone(selected)
        self.assertTrue(selected["symbol"].endswith("CE"))
        self.assertGreater(selected["strike"], 25000)


class PremiumTriggerTest(unittest.TestCase):
    def test_pullback_and_continuation_confirm_the_entry(self):
        result = run(context(premium=premium_candles(IMPULSE_PULLBACK_CONTINUATION)))
        self.assertEqual(result["decision"], "CONFIRMED", result["reason"])
        setup = result["setup"]
        self.assertEqual(setup["side"], "SELL")
        self.assertEqual(setup["contract"]["symbol"], "NIFTY26OCT24950PE")
        self.assertEqual(setup["entry"], 52.5)
        self.assertLess(setup["stop_loss"], 49)  # under the pullback low
        self.assertEqual(setup["target"], 76.25)  # 50 intrinsic at 24900 + half of today's premium
        self.assertGreaterEqual(setup["risk_reward"], 2)
        self.assertAlmostEqual(setup["trailing_distance"], round(52.5 - setup["stop_loss"], 2), places=2)
        self.assertAlmostEqual(setup["breakeven_at"], 52.5 + setup["trailing_distance"], places=2)

    def test_waits_for_the_continuation_candle(self):
        bars = IMPULSE_PULLBACK_CONTINUATION[:-1]
        result = run(context(premium=premium_candles(bars)))
        self.assertEqual(result["decision"], "WAIT_FOR_CONFIRMATION")
        self.assertEqual(result["intrinsic"]["premium"]["status"], "WAIT_FOR_CONTINUATION")

    def test_deep_pullback_is_rejected(self):
        bars = IMPULSE_PULLBACK_CONTINUATION[:5] + [(54, 54, 44, 44.5), (44.5, 46, 43.5, 45.5)]
        trigger = premium_trigger(premium_candles(bars), IntrinsicConfig())
        self.assertEqual(trigger["status"], "PULLBACK_TOO_DEEP")

    def test_premium_candles_for_another_contract_are_ignored(self):
        result = run(context(premium=premium_candles(IMPULSE_PULLBACK_CONTINUATION), symbol="NIFTY26OCT25000PE"))
        self.assertEqual(result["needs_premium_candles"], "NIFTY26OCT24950PE")


class PipelineTest(unittest.TestCase):
    def _evidence(self, mapping: str) -> dict:
        result = run(context(mapping=mapping, premium=premium_candles(IMPULSE_PULLBACK_CONTINUATION)) if mapping == "CONTRARIAN" else context(score=-55, mapping=mapping, premium=premium_candles(IMPULSE_PULLBACK_CONTINUATION)))
        evidence = {"regime": "TRENDING_BULL", "setup_side": None, "regime_gate": True, "option_flow_gate": True, "score": 0, "minimum_score": 8}
        calculations = {"score": {}}
        _intrinsic_evidence(result, evidence, calculations, {}, expiry_day=False)
        return evidence

    def test_contrarian_trade_skips_regime_and_option_flow_gates(self):
        evidence = self._evidence("CONTRARIAN")
        self.assertFalse(evidence["regime_gate"])
        self.assertTrue(evidence["breakout_valid"])
        self.assertTrue(evidence["retest_confirmed"])
        self.assertGreaterEqual(evidence["score"], evidence["minimum_score"])
        gates = {gate["code"] for gate in evaluate_payload(evidence)["gates"]}
        self.assertNotIn("REGIME_BLOCKED", gates)
        self.assertNotIn("ORS_NOT_CONFIRMED", gates)
        self.assertIn("SESSION_BLOCKED", gates)  # operational gates still apply

    def test_follow_mapping_keeps_the_regime_gate(self):
        evidence = self._evidence("FOLLOW")
        self.assertTrue(evidence["regime_gate"])

    def test_missing_gate_flags_keep_every_gate_on(self):
        gates = {gate["code"] for gate in evaluate_payload({})["gates"]}
        self.assertIn("REGIME_BLOCKED", gates)
        self.assertIn("ORS_NOT_CONFIRMED", gates)


if __name__ == "__main__":
    unittest.main()
