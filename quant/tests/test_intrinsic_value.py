import unittest
from datetime import datetime, timedelta, timezone

from tradepulse_quant.algo_engine.engine import Candle, _intrinsic_evidence, analyze
from tradepulse_quant.algo_engine.intrinsic_value import IntrinsicConfig, config_for, premium_trigger, rank_strikes, read_sentiment
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

    def test_moderate_sentiment_is_no_trade_but_shows_the_strike_it_leans_to(self):
        result = run(context(score=10))
        self.assertEqual(result["decision"], "NO_TRADE")
        self.assertIn("not extreme", result["reason"])
        calc = result["intrinsic"]
        self.assertTrue(calc["watch"])
        self.assertEqual(calc["sentiment"]["lean_option_type"], "PE")
        self.assertEqual(calc["selected"]["symbol"], "NIFTY26OCT24950PE")
        # A watched strike is never a passed gate.
        evidence = {"regime": "TRENDING_BULL", "regime_gate": True, "option_flow_gate": True, "score": 0, "minimum_score": 8}
        _intrinsic_evidence(result, evidence, {"score": {}}, {}, expiry_day=False)
        self.assertFalse(evidence["breakout_valid"])
        self.assertIsNone(evidence["liquidity_score"])
        self.assertEqual(evidence["score"], 0)

    def test_screenshot_reading_minus_19_trades_a_call_on_the_default_cut_off(self):
        # -19.1 sat in the analyser's Fear zone but under the old +/-40 cut-off, so the strategy never traded.
        sentiment = read_sentiment({"score": -19.1}, "CONTRARIAN", IntrinsicConfig(), NOW)
        self.assertTrue(sentiment["ok"])
        self.assertEqual(sentiment["option_type"], "CE")

    def test_strict_preset_keeps_the_old_cut_off(self):
        self.assertEqual(config_for("STRICT").extreme_score, 40)
        self.assertEqual(config_for("25").extreme_score, 25)
        self.assertEqual(config_for("999").extreme_score, 60)
        self.assertEqual(config_for(None).extreme_score, 15)
        ctx = context(score=25)
        ctx["sentiment_extreme"] = "STRICT"
        self.assertEqual(run(ctx)["decision"], "NO_TRADE")
        self.assertEqual(run(context(score=25))["decision"], "WAIT_FOR_CONFIRMATION")

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

    def test_strike_must_offer_a_50_percent_option_premium_gain(self):
        ctx = context()
        for row in ctx["option_chain"]["contracts"]:
            row["premium"] *= 8  # an expensive chain: repriced at any key value, no strike gains 50%
        result = run(ctx)
        self.assertEqual(result["decision"], "NO_TRADE")
        self.assertIn("50% option premium gain", result["reason"])
        self.assertNotIn("intrinsic gain", result["reason"])

    def test_bearish_sentiment_buys_a_call_under_contrarian(self):
        result = run(context(score=-58))
        self.assertEqual(result["intrinsic"]["sentiment"]["option_type"], "CE")
        selected = result["intrinsic"]["selected"]
        self.assertIsNotNone(selected)
        self.assertTrue(selected["symbol"].endswith("CE"))
        self.assertGreater(selected["strike"], 25000)


class PremiumTargetTest(unittest.TestCase):
    def test_selected_strike_carries_the_premium_calculator(self):
        check = run(context())["intrinsic"]["selected"]["premium_check"]
        self.assertEqual(check["move_points"], 100)  # spot 25000 to the 24900 key value
        self.assertEqual(check["target_premium"], 67.5)  # 45 x 1.5
        self.assertEqual(check["move_needed_delta"], 53.6)  # 22.5 / 0.42
        self.assertLessEqual(check["move_needed_model"], check["move_points"])
        self.assertTrue(check["target_possible"])
        # The candidate's premium at the key value is the full reprice, not intrinsic + time value.
        selected = run(context())["intrinsic"]["selected"]
        self.assertEqual(selected["premium_at_key"], check["premium_at_key_model"])

    def test_key_value_too_close_for_a_50_percent_premium_is_rejected(self):
        ctx = context()
        ctx["option_chain"]["spot"] = 24960  # the 24900 key value is now 60 pts away
        for row in ctx["option_chain"]["contracts"]:
            if row["symbol"] == "NIFTY26OCT24950PE":
                row["premium"], row["delta"] = 60, -0.45  # needs ~67 pts for +50%
        # 24900 cannot pay +50%, so the engine moves on to the next key value (PDL 24840).
        result = run(ctx)
        calc = result["intrinsic"]
        self.assertEqual(calc["key_value"]["price"], 24840)
        self.assertGreaterEqual(calc["selected"]["premium_check"]["move_points"], calc["selected"]["premium_check"]["move_needed_greeks"])
        near = rank_strikes(ctx["option_chain"]["contracts"], 24960, {"price": 24900}, "PE", 0.2, NOW, IntrinsicConfig())
        row = next(r for r in near if r["symbol"] == "NIFTY26OCT24950PE")
        self.assertFalse(row["target_reachable"])
        self.assertFalse(row["eligible"])
        self.assertGreater(row["premium_check"]["move_needed_greeks"], 60)

    def test_confirmed_trade_reports_the_entry_check_and_passes_the_gate(self):
        result = run(context(premium=premium_candles(IMPULSE_PULLBACK_CONTINUATION)))
        self.assertEqual(result["decision"], "CONFIRMED", result["reason"])
        check = result["intrinsic"]["premium_check"]
        self.assertEqual(check["entry"], 52.5)
        self.assertEqual(check["percent_target"], 78.75)
        self.assertTrue(check["valid"])
        evidence = {"regime": "TRENDING_BULL", "regime_gate": True, "option_flow_gate": True, "score": 0, "minimum_score": 8}
        _intrinsic_evidence(result, evidence, {"score": {}}, {}, expiry_day=False)
        self.assertTrue(evidence["premium_target_reachable"])
        gates = {gate["code"]: gate["passed"] for gate in evaluate_payload(evidence)["gates"]}
        self.assertTrue(gates["PREMIUM_TARGET_UNREACHABLE"])


class PremiumTriggerTest(unittest.TestCase):
    def test_pullback_and_continuation_confirm_the_entry(self):
        result = run(context(premium=premium_candles(IMPULSE_PULLBACK_CONTINUATION)))
        self.assertEqual(result["decision"], "CONFIRMED", result["reason"])
        setup = result["setup"]
        self.assertEqual(setup["side"], "SELL")
        self.assertEqual(setup["contract"]["symbol"], "NIFTY26OCT24950PE")
        self.assertEqual(setup["entry"], 52.5)
        self.assertLess(setup["stop_loss"], 49)  # under the pullback low
        check = result["intrinsic"]["premium_check"]
        # Target = this contract repriced at the 24900 key value; it must clear 1.5 x entry.
        self.assertAlmostEqual(setup["target"], check["premium_at_key_model"], delta=0.05)
        self.assertGreaterEqual(setup["target"], 52.5 * 1.5)
        self.assertEqual(setup["target_method"], "KEY_VALUE_REPRICE")
        # Reward-to-risk is net of costs, so it is below the gross figure.
        self.assertGreaterEqual(setup["risk_reward"], 2)
        self.assertEqual(setup["risk_reward"], check["net_risk_reward"])
        self.assertLess(setup["risk_reward"], result["intrinsic"]["plan"]["gross_risk_reward"])
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

    def test_confirmed_trade_at_a_moderate_score_clears_the_scorecard(self):
        # The old card (6/10, sentiment points from 40) could not be met by a typical setup.
        result = run(context(score=22, premium=premium_candles(IMPULSE_PULLBACK_CONTINUATION)))
        self.assertEqual(result["decision"], "CONFIRMED", result["reason"])
        evidence = {"regime": "TRENDING_BULL", "regime_gate": True, "option_flow_gate": True, "score": 0, "minimum_score": 8}
        _intrinsic_evidence(result, evidence, {"score": {}}, {}, expiry_day=False)
        self.assertGreaterEqual(evidence["score"], evidence["minimum_score"])

    def test_follow_mapping_keeps_the_regime_gate(self):
        evidence = self._evidence("FOLLOW")
        self.assertTrue(evidence["regime_gate"])

    def test_missing_gate_flags_keep_every_gate_on(self):
        gates = {gate["code"] for gate in evaluate_payload({})["gates"]}
        self.assertIn("REGIME_BLOCKED", gates)
        self.assertIn("ORS_NOT_CONFIRMED", gates)


if __name__ == "__main__":
    unittest.main()
