import unittest
from datetime import datetime, timedelta, timezone

from tradepulse_quant.algo_engine import scalp_strategy as S
from tradepulse_quant.algo_engine.engine import Candle, _observe, _scalp_evidence, analyze
from tradepulse_quant.algo_engine.configuration import StrategyConfiguration
from tradepulse_quant.algo_engine.pipeline import evaluate_payload

IST = timezone(timedelta(hours=5, minutes=30))
T0 = datetime(2026, 11, 2, 9, 15, tzinfo=IST)
CHOP = [4, -5, 3, -4, 5, -3, 2, -4, 3, -2, 4, -3]        # opening chop
TREND = [4, 2, 5, -2, 3, 4, -1, 2, 3, 1]                  # a measured trend
PULLBACK = [-4, -3, -2]                                   # into the 9 EMA
RESUME = [7]                                              # the resumption candle


def tape(direction=1, scale=1.0, base=24800.0, volume=True, resume=RESUME):
    """A realistic 1-minute index tape: chop, trend, pullback to the 9 EMA, resumption."""
    path = CHOP + TREND + PULLBACK + resume
    bars, price = [], base
    for i, step in enumerate(path):
        o = price
        c = price + step * scale * direction
        wick = 3.0 * scale
        vol = (9000 if i == len(path) - 1 else 5000 + (i % 4) * 300) if volume else 0
        bars.append(Candle((T0 + timedelta(minutes=i)).isoformat(), o, max(o, c) + wick, min(o, c) - wick, c, vol))
        price = c
    return bars


def chain(spot, step=50, iv=13.5, theta=-9.0, lot=65, deltas=None):
    rows = []
    for k in range(-4, 5):
        strike = round(spot / step) * step + k * step
        for typ, sign in (("CALL", 1), ("PUT", -1)):
            m = (spot - strike) * sign
            delta = deltas(m) if deltas else max(0.05, min(0.95, 0.5 + m / (5 * step)))
            prem = max(5.0, 110 * step / 50 + m * 0.55)
            rows.append({"symbol": f"IDX{int(strike)}{'CE' if typ == 'CALL' else 'PE'}", "contract": typ, "strike": strike, "premium": round(prem, 2),
                         "bid": round(prem - 0.4, 2), "ask": round(prem + 0.4, 2), "openInterest": 400000 + (k + 4) * 25000, "volume": 900000 - abs(k) * 80000,
                         "iv": iv, "delta": round(delta * sign, 3), "theta": theta, "lotSize": lot, "tickSize": 0.05, "freezeQuantity": 1800, "expiry": "2026-11-10"})
    return rows


def flow(spot, step=50, direction=1, atm_ce=None, atm_pe=None, score=None, pcr=None, change=None, wall_gap=None):
    atm = round(spot / step) * step
    atm_ce = atm_ce or ("SHORT_COVERING" if direction > 0 else "SHORT_BUILDUP")
    atm_pe = atm_pe or ("SHORT_BUILDUP" if direction > 0 else "SHORT_COVERING")
    score = (1 if direction > 0 else -1) if score is None else score
    pcr = (1.05 if direction > 0 else 0.85) if pcr is None else pcr
    change = (0.02 if direction > 0 else -0.02) if change is None else change
    wall_gap = 3 * step if wall_gap is None else wall_gap
    rows = []
    for k in range(-4, 5):
        strike = atm + k * step
        rows.append({"strike": strike, "is_atm": k == 0,
                     "ce_oi": 900000 if strike == atm + wall_gap else 300000, "pe_oi": 900000 if strike == atm - wall_gap else 250000,
                     "ce_activity": atm_ce if k == 0 else "NEUTRAL", "pe_activity": atm_pe if k == 0 else "NEUTRAL",
                     "ce_oi_change": 1000, "pe_oi_change": 5000})
    return {"available": True, "pcr_oi": pcr, "pcr_change_5m": change, "oi_direction_score": score, "strikes": rows}


def premium_candles(symbol, accepted=True, n=28):
    out, p = [], 100.0
    for i in range(n):
        step = 1.2 if i < n - 4 else (-1.5 if i < n - 1 else (3.5 if accepted else -6.0))
        o, c = p, p + step
        out.append(Candle((T0 + timedelta(minutes=i)).isoformat(), o, max(o, c) + 0.3, min(o, c) - 0.3, c, 20000 if i == n - 1 else 9000))
        p = c
    return {"symbol": symbol, "candles": out}


def run(direction=1, rr="1:2", scale=1.0, step=50, lot=65, bars=None, vix=None, flow_kw=None, chain_kw=None, accepted=True, ctx_extra=None):
    bars = bars or tape(direction, scale, base=24800.0 if step == 50 else 52000.0)
    spot = bars[-1].close
    now = T0 + timedelta(minutes=len(bars))
    ctx = {"option_chain": {"spot": spot, "expiry": "2026-11-10", "contracts": chain(spot, step, lot=lot, **(chain_kw or {}))},
           "options_flow": flow(spot, step, direction, **(flow_kw or {})), "vix": vix or {"value": 13.2, "regime": "NORMAL"}, "risk_reward": rr, **(ctx_extra or {})}
    first = S.analyze_scalp("NIFTY" if step == 50 else "BANKNIFTY", bars, ctx, now)
    if first.get("needs_premium_candles"):
        ctx["premium_candles"] = premium_candles(first["needs_premium_candles"], accepted)
        return first, S.analyze_scalp("NIFTY" if step == 50 else "BANKNIFTY", bars, ctx, now), bars, now
    return first, first, bars, now


def criteria(result):
    return {c["key"]: c for c in result["scalp"]["criteria"]}


class ConfirmedScalp(unittest.TestCase):
    def test_ce_scalp_meets_all_seven_criteria_at_1_to_2(self):
        first, result, _, _ = run()
        self.assertEqual(first["needs_premium_candles"], "IDX24800CE")  # pass 1 asks for the premium's candles
        self.assertEqual(result["decision"], "CONFIRMED", result["reason"])
        self.assertTrue(all(c["passed"] for c in result["scalp"]["criteria"]))
        self.assertEqual(result["scalp"]["score"]["total"], 10)
        setup = result["setup"]
        self.assertEqual((setup["side"], setup["contract"]["symbol"], setup["contract"]["type"]), ("BUY", "IDX24800CE", "CE"))
        self.assertEqual((setup["entry"], setup["stop_loss"], setup["target"]), (120.85, 114.1, 133.95))
        self.assertEqual((setup["risk_reward"], setup["rr_choice"], setup["lots"], setup["quantity"]), (1.94, "1:2", 1, 65))
        self.assertEqual(setup["spot"], {"entry": 24819.0, "stop": 24807.61, "target": 24841.79})
        # one breakout is one setup: keyed on the trigger candle, so it is never auto-placed twice
        self.assertEqual(setup["setup_id"], "VWAP_EMA_SCALP:NIFTY:CE:2026-11-02T09:40:00+05:30")

    def test_premium_stop_and_target_come_from_delta_and_gamma(self):
        _, result, _, _ = run()
        plan = result["scalp"]["plan"]
        g, r, k = plan["greeks"], plan["risk_points"], plan["target_points"]
        loss = g["delta"] * r - 0.5 * g["gamma"] * r * r + plan["theta_drag"]
        gain = g["delta"] * k + 0.5 * g["gamma"] * k * k - plan["theta_drag"]
        self.assertAlmostEqual(plan["stop_loss"], round(round((plan["entry"] - loss) / 0.05) * 0.05, 2), places=2)
        self.assertAlmostEqual(plan["target"], round(round((plan["entry"] + gain) / 0.05) * 0.05, 2), places=2)
        self.assertLess(plan["gamma_effect"]["on_loss"], 0)  # convexity trims the loss ...
        self.assertGreater(plan["gamma_effect"]["on_gain"], 0)  # ... and adds to the gain
        self.assertAlmostEqual(plan["target_points"], 2 * plan["risk_points"], delta=0.011)
        self.assertLess(plan["net_risk_reward"], plan["risk_reward"])  # charges come off the net ratio

    def test_pe_side_is_the_mirror(self):
        _, result, _, _ = run(direction=-1)
        self.assertEqual(result["decision"], "CONFIRMED", result["reason"])
        self.assertEqual((result["setup"]["side"], result["setup"]["contract"]["type"]), ("SELL", "PE"))
        self.assertLess(result["setup"]["spot"]["target"], result["setup"]["spot"]["entry"])
        self.assertGreater(result["setup"]["spot"]["stop"], result["setup"]["spot"]["entry"])

    def test_one_to_one_is_refused_when_charges_eat_the_small_move(self):
        _, result, _, _ = run(rr="1:1")
        self.assertEqual(result["decision"], "NO_TRADE")
        self.assertIn("Charges take", result["reason"])
        self.assertGreater(result["scalp"]["plan"]["cost_share"], S.ScalpConfig().max_cost_share)

    def test_one_to_one_trades_when_the_move_is_large_enough(self):
        # a BANKNIFTY-sized tape (2.5x the points) carries the 1:1 premium move past the charges
        _, result, _, _ = run(rr="1:1", scale=2.5, step=100, lot=30)
        self.assertEqual(result["decision"], "CONFIRMED", result["reason"])
        self.assertEqual(result["setup"]["rr_choice"], "1:1")
        self.assertAlmostEqual(result["scalp"]["plan"]["target_points"], result["scalp"]["plan"]["risk_points"], places=2)

    def test_lots_are_capped_by_max_loss_and_max_lots(self):
        _, result, _, _ = run(ctx_extra={"max_loss_per_trade": 5000, "max_lots": 3})
        self.assertEqual(result["setup"]["lots"], 3)
        _, refused, _, _ = run(ctx_extra={"max_loss_per_trade": 300})
        self.assertEqual(refused["decision"], "NO_TRADE")
        self.assertIn("max loss per trade", refused["reason"])


class Criteria(unittest.TestCase):
    def test_extreme_or_dead_vix_blocks(self):
        for vix in ({"value": 28.0, "regime": "EXTREME"}, {"value": 9.2, "regime": "LOW"}, None and {}):
            if vix is None:
                continue
            _, result, _, _ = run(vix=vix)
            self.assertFalse(criteria(result)["vix"]["passed"], vix)
            self.assertNotEqual(result["decision"], "CONFIRMED")

    def test_stretched_or_falling_pcr_blocks_a_long(self):
        for kw in ({"pcr": 1.8}, {"pcr": 0.7}, {"change": -0.03}):
            _, result, _, _ = run(flow_kw=kw)
            self.assertFalse(criteria(result)["pcr"]["passed"], kw)

    def test_call_writing_at_atm_blocks_a_long(self):
        _, result, _, _ = run(flow_kw={"atm_ce": "SHORT_BUILDUP", "atm_pe": "NEUTRAL"})
        oi = criteria(result)["oi"]
        self.assertEqual(oi["points"], 1)
        self.assertIn("fresh call writing", oi["detail"])

    def test_call_wall_inside_the_target_blocks(self):
        spot = 24819.0
        points, detail, info = S.read_oi(flow(spot, wall_gap=50), "CE", spot, target_points=40.0)
        self.assertEqual(points, 1)  # writers lean bullish, but the 24850 call wall is 31 pts away
        self.assertEqual(info["wall"], 24850)
        self.assertIn("only 31 pts away, target needs 40", detail)
        self.assertEqual(S.read_oi(flow(spot, wall_gap=50), "CE", spot, target_points=25.0)[0], 2)

    def test_writer_flow_must_lean_the_trade_way(self):
        _, result, _, _ = run(flow_kw={"score": 0})
        self.assertEqual(criteria(result)["oi"]["points"], 1)

    def test_no_futures_volume_means_no_vwap(self):
        _, result, _, _ = run(bars=tape(volume=False))
        self.assertFalse(criteria(result)["vwap"]["passed"])
        self.assertIn("unobservable", criteria(result)["vwap"]["detail"])

    def test_chasing_far_from_vwap_is_refused(self):
        _, result, _, _ = run(bars=tape(resume=[22]))
        vwap = criteria(result)["vwap"]
        self.assertFalse(vwap["passed"])
        self.assertIn("don't chase", vwap["detail"])

    def test_premium_below_its_poc_fails_the_volume_profile(self):
        _, result, _, _ = run(accepted=False)
        self.assertFalse(criteria(result)["volume_profile"]["passed"])

    def test_delta_outside_the_band_has_no_strike(self):
        _, result, _, _ = run(chain_kw={"deltas": lambda m: 0.85 if m > 0 else 0.15})
        self.assertFalse(criteria(result)["delta"]["passed"])
        self.assertIsNone(result["scalp"]["selected"])

    def test_writing_on_a_strike_pushes_it_down_the_ranking(self):
        spot = 24819.0
        rows = chain(spot)
        base = S.select_strikes(rows, flow(spot), spot, "CE", S.ScalpConfig())
        written = flow(spot)
        for row in written["strikes"]:
            if row["strike"] == base[0]["strike"]:
                row["ce_activity"] = "SHORT_BUILDUP"
        reranked = S.select_strikes(rows, written, spot, "CE", S.ScalpConfig())
        self.assertNotEqual(reranked[0]["strike"], base[0]["strike"])


class Helpers(unittest.TestCase):
    def test_volume_profile_poc_and_value_area(self):
        bars = [Candle((T0 + timedelta(minutes=i)).isoformat(), p, p + 0.5, p - 0.5, p, v)
                for i, (p, v) in enumerate([(100, 100), (101, 100), (102, 1000), (102, 1000), (103, 100), (104, 100)])]
        profile = S.volume_profile(bars, bins=10, value_area=0.7)
        self.assertAlmostEqual(profile["poc"], 102.0, delta=0.5)
        self.assertLessEqual(profile["val"], profile["poc"])
        self.assertGreaterEqual(profile["vah"], profile["poc"])

    def test_rr_choice_parsing(self):
        self.assertEqual(S.rr_ratio("1:1"), ("1:1", 1.0))
        self.assertEqual(S.rr_ratio("2"), ("1:2", 2.0))
        self.assertEqual(S.rr_ratio(None), ("1:2", 2.0))


class EngineIntegration(unittest.TestCase):
    def evidence_for(self, rr):
        first, result, bars, now = run(rr=rr) if rr == "1:2" else run(rr=rr, scale=2.5, step=100, lot=30)
        engine_result = analyze("NIFTY", bars, 1000.0, S.STRATEGY_ID, None, False, {
            "option_chain": {"spot": bars[-1].close, "expiry": "2026-11-10", "contracts": chain(bars[-1].close, 50 if rr == "1:2" else 100, lot=65 if rr == "1:2" else 30)},
            "options_flow": flow(bars[-1].close, 50 if rr == "1:2" else 100), "vix": {"value": 13.2, "regime": "NORMAL"}, "risk_reward": rr,
            "premium_candles": premium_candles(result["setup"]["contract"]["symbol"]),
        }, now)
        evidence, calculations, _ = _observe("NIFTY", bars, S.STRATEGY_ID, engine_result, StrategyConfiguration(), now, {}, None, None)
        _scalp_evidence(engine_result, evidence, calculations)
        ops = {"data_quality_ok": True, "session_allowed": True, "option_quote_fresh": True, "daily_risk_allowed": True, "broker_healthy": True,
               "contract_metadata_available": True, "reconciliation_ok": True, "execution_ready": True, "gap_state": "NORMAL_DAY"}
        return engine_result, evidence, calculations, evaluate_payload({**evidence, **ops})

    def test_v5_pipeline_confirms_the_scalp_with_the_chosen_ratio(self):
        result, evidence, calculations, pipeline = self.evidence_for("1:2")
        self.assertEqual(result["decision"], "CONFIRMED")
        self.assertEqual(evidence["minimum_risk_reward"], 1.94)
        self.assertEqual(calculations["score"]["card"], S.STRATEGY_ID)
        self.assertEqual(pipeline["decision"], "CONFIRMED", pipeline["reasons"])
        codes = {g["code"] for g in pipeline["gates"]}
        self.assertNotIn("REGIME_BLOCKED", codes)  # the 1m VWAP/EMA stack is the scalper's trend filter
        self.assertNotIn("ORS_NOT_CONFIRMED", codes)  # OI and PCR are scalper criteria instead

    def test_one_to_one_uses_a_one_r_gate(self):
        _, evidence, _, pipeline = self.evidence_for("1:1")
        self.assertEqual(evidence["minimum_risk_reward"], 0.97)
        self.assertEqual(pipeline["decision"], "CONFIRMED", pipeline["reasons"])
        rr_gate = next(g for g in pipeline["gates"] if g["code"] == "RR_BELOW_MINIMUM")
        self.assertIn("0.97", rr_gate["detail"])

    def test_other_strategies_keep_the_two_r_gate(self):
        pipeline = evaluate_payload({"risk_reward": 1.5})
        rr_gate = next(g for g in pipeline["gates"] if g["code"] == "RR_BELOW_MINIMUM")
        self.assertFalse(rr_gate["passed"])
        self.assertIn("2", rr_gate["detail"])


if __name__ == "__main__":
    unittest.main()
