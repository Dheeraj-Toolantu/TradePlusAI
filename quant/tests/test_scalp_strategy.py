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
    futures = bars or tape(direction, scale, base=(24800.0 if step == 50 else 52000.0) + BASIS)
    bars = index_of(futures)
    spot = bars[-1].close
    now = T0 + timedelta(minutes=len(bars))
    ctx = {"futures_candles": futures,
           "option_chain": {"spot": spot, "expiry": "2026-11-10", "contracts": chain(spot, step, lot=lot, **(chain_kw or {}))},
           "options_flow": flow(spot, step, direction, **(flow_kw or {})), "vix": vix or {"value": 13.2, "regime": "NORMAL"}, "risk_reward": rr, **(ctx_extra or {})}
    first = S.analyze_scalp("NIFTY" if step == 50 else "BANKNIFTY", bars, ctx, now)
    if first.get("needs_premium_candles"):
        ctx["premium_candles"] = premium_candles(first["needs_premium_candles"], accepted)
        return first, S.analyze_scalp("NIFTY" if step == 50 else "BANKNIFTY", bars, ctx, now), bars, now
    return first, first, bars, now


BASIS = 60.0  # the near-month future trades this many points above the index


def index_of(futures):
    """The index candles under a futures tape: the same moves, BASIS points lower, no volume."""
    return [Candle(c.timestamp, c.open - BASIS, c.high - BASIS, c.low - BASIS, c.close - BASIS, 0) for c in futures]


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
        # expected fill = ask 120.85 + 0.3% slippage → 121.25; structural SL 113.70; target = fill + 2R
        self.assertEqual((setup["entry"], setup["stop_loss"], setup["target"]), (121.25, 113.7, 136.35))
        self.assertEqual((setup["risk_reward"], setup["rr_choice"], setup["lots"], setup["quantity"]), (2.0, "1:2", 1, 65))
        self.assertEqual(setup["spot"]["stop"], round(setup["spot"]["entry"] - result["scalp"]["plan"]["risk_points"], 2))
        self.assertGreater(setup["spot"]["target"] - setup["spot"]["entry"], 2 * result["scalp"]["plan"]["risk_points"])  # the fill paid spread + slippage
        # one breakout is one setup: keyed on the trigger candle, so it is never auto-placed twice
        self.assertEqual(setup["setup_id"], "VWAP_EMA_SCALP:NIFTY:CE:2026-11-02T09:40:00+05:30")

    def test_stop_from_structure_and_target_from_the_fill_via_delta_and_gamma(self):
        _, result, _, _ = run()
        plan = result["scalp"]["plan"]
        g, r = plan["greeks"], plan["risk_points"]
        # SL: the premium where the index stop leaves it, from the MARKET premium
        loss = g["delta"] * r - 0.5 * g["gamma"] * r * r + plan["theta_drag"]
        self.assertAlmostEqual(plan["stop_loss"], round(round((plan["market_premium"] - loss) / 0.05) * 0.05, 2), places=2)
        # entry: what the scalper pays (ask + slippage, on the tick); R and the target from that fill
        self.assertAlmostEqual(plan["entry"], 121.25, places=2)
        self.assertAlmostEqual(plan["target"], plan["entry"] + 2 * (plan["entry"] - plan["stop_loss"]), places=2)
        self.assertEqual(plan["risk_reward"], 2.0)
        # the index move the target needs, solved back through delta and gamma
        x = plan["target_points"]
        self.assertAlmostEqual(g["delta"] * x + 0.5 * g["gamma"] * x * x, plan["premium_gain_needed"], delta=0.02)
        self.assertGreater(x, plan["structural_target_points"])
        self.assertLess(plan["gamma_effect"]["on_loss"], 0)
        self.assertGreater(plan["gamma_effect"]["on_gain"], 0)
        self.assertLess(plan["net_risk_reward"], plan["risk_reward"])

    def test_pe_side_is_the_mirror(self):
        _, result, _, _ = run(direction=-1)
        self.assertEqual(result["decision"], "CONFIRMED", result["reason"])
        self.assertEqual((result["setup"]["side"], result["setup"]["contract"]["type"]), ("SELL", "PE"))
        self.assertLess(result["setup"]["spot"]["target"], result["setup"]["spot"]["entry"])
        self.assertGreater(result["setup"]["spot"]["stop"], result["setup"]["spot"]["entry"])

    def test_one_to_one_is_refused_when_charges_eat_the_small_move(self):
        _, result, _, _ = run(rr="1:1")
        self.assertEqual(result["decision"], "NO_TRADE")
        self.assertIn("Charges and slippage take", result["reason"])
        self.assertGreater(result["scalp"]["plan"]["cost_share"], S.ScalpConfig().max_cost_share)

    def test_one_to_one_trades_when_the_move_is_large_enough(self):
        # a large BANKNIFTY-sized move (3.5x the points) carries the 1:1 premium move past the
        # charges and the adverse slippage on both legs
        _, result, _, _ = run(rr="1:1", scale=3.5, step=100, lot=30)
        self.assertEqual(result["decision"], "CONFIRMED", result["reason"])
        self.assertEqual(result["setup"]["rr_choice"], "1:1")
        self.assertEqual(result["scalp"]["plan"]["risk_reward"], 1.0)  # 1:1 on the actual fill

    def test_lots_are_capped_by_max_loss_and_max_lots(self):
        _, result, _, _ = run(ctx_extra={"max_loss_per_trade": 5000, "max_lots": 3})
        self.assertEqual(result["setup"]["lots"], 3)
        _, refused, _, _ = run(ctx_extra={"max_loss_per_trade": 300})
        self.assertEqual(refused["decision"], "NO_TRADE")
        self.assertIn("max loss per trade", refused["reason"])


class FillAndStressedRisk(unittest.TestCase):
    """Defects 1 and 2: plan with the scalper's slippage on both legs, size on stressed risk."""

    def test_slippage_is_adverse_on_both_legs_and_matches_the_scalper(self):
        _, result, _, _ = run(ctx_extra={"slippage_pct": 0.003})
        plan = result["scalp"]["plan"]
        lot, ask, entry, target, stop = plan["lot_size"], plan["ask"], plan["entry"], plan["target"], plan["stop_loss"]
        self.assertGreaterEqual(entry, ask * 1.003 - 1e-9)  # entry slippage is IN the fill (adverse)
        self.assertAlmostEqual(plan["costs_per_lot"]["slippage_at_target"], 0.003 * target * lot, places=1)  # exit slippage
        self.assertAlmostEqual(plan["costs_per_lot"]["slippage_at_stop"], 0.003 * stop * lot, places=1)
        self.assertEqual(plan["slippage_pct"], 0.003)
        _, cheaper, _, _ = run(ctx_extra={"slippage_pct": 0.0})
        self.assertLess(cheaper["scalp"]["plan"]["entry"], entry)

    def test_sizing_uses_the_stressed_loss_not_the_planned_loss(self):
        _, result, _, _ = run()
        plan = result["scalp"]["plan"]
        self.assertGreater(plan["stressed_risk_per_lot"], plan["risk_per_lot"])
        self.assertAlmostEqual(plan["stressed_risk_per_lot"] - plan["risk_per_lot"], plan["stop_gap"] * plan["lot_size"], delta=0.01 * plan["lot_size"])  # stop_gap is shown rounded
        self.assertEqual(plan["max_loss"], plan["stressed_risk_per_lot"] * plan["lots"])
        self.assertLess(plan["stressed_risk_reward"], plan["net_risk_reward"])
        # a max loss between the planned and the stressed loss of one lot must refuse the trade
        between = (plan["risk_per_lot"] + plan["stressed_risk_per_lot"]) / 2
        _, refused, _, _ = run(ctx_extra={"max_loss_per_trade": between})
        self.assertEqual(refused["decision"], "NO_TRADE")
        self.assertIn("stressed", refused["reason"])

    def test_setup_carries_what_the_scalper_needs_to_re_plan_on_the_fill(self):
        _, result, _, _ = run()
        setup, plan = result["setup"], result["scalp"]["plan"]
        self.assertEqual(setup["min_risk_reward"], 1.94)
        self.assertEqual(setup["max_entry"], plan["max_entry"])
        self.assertAlmostEqual(setup["fill_tolerance"], max(0.1, 0.2 * (setup["entry"] - setup["stop_loss"])), places=2)
        self.assertGreater(setup["max_entry"], setup["entry"])
        for key in ("stop_gap", "slippage_pct", "fees_at_stop_per_lot", "planned_max_loss", "stressed_risk_reward"):
            self.assertIn(key, setup)


class FillReplanLimits(unittest.TestCase):
    def test_worst_fill_target_is_capped_at_the_oi_wall(self):
        _, result, _, _ = run()
        plan, setup = result["scalp"]["plan"], result["setup"]
        worst = plan["max_entry"]
        uncapped = round(worst + 2 * (worst - plan["stop_loss"]), 2)
        self.assertIn("wall_premium", plan)  # the premium with the index at the OI wall
        self.assertLessEqual(plan["max_target"], max(uncapped + 0.05, plan["wall_premium"]))
        self.assertLessEqual(plan["max_target"], plan["wall_premium"] + 1e-9)
        self.assertEqual(setup["max_target"], plan["max_target"])
        self.assertGreaterEqual(plan["max_target"], plan["target"])  # the expected-fill target fits


class FuturesVwap(unittest.TestCase):
    """Defect 4: VWAP on the near-month future's own price and volume."""

    def test_tape_is_read_on_the_future_and_index_levels_use_the_basis(self):
        _, result, _, _ = run()
        self.assertEqual(result["scalp"]["tape"]["source"], "FUTURES")
        self.assertAlmostEqual(result["scalp"]["basis"], BASIS, places=2)
        self.assertIn("future", criteria(result)["vwap"]["detail"])
        plan = result["scalp"]["plan"]
        self.assertAlmostEqual(plan["spot_entry"], result["scalp"]["tape"]["close"] - BASIS, places=2)

    def test_without_futures_ohlcv_vwap_fails_closed(self):
        futures = tape(base=24800.0 + BASIS)
        bars = index_of(futures)
        with_volume = [Candle(c.timestamp, c.open, c.high, c.low, c.close, 5000) for c in bars]  # index + borrowed volume (the old proxy)
        spot = bars[-1].close
        ctx = {"option_chain": {"spot": spot, "expiry": "2026-11-10", "contracts": chain(spot)}, "options_flow": flow(spot), "vix": {"value": 13.2, "regime": "NORMAL"}}
        result = S.analyze_scalp("NIFTY", with_volume, ctx, T0 + timedelta(minutes=len(bars)))
        vwap = criteria(result)["vwap"]
        self.assertFalse(vwap["passed"])
        self.assertIn("No near-month futures OHLCV", vwap["detail"])
        self.assertNotEqual(result["decision"], "CONFIRMED")


class PcrZones(unittest.TestCase):
    """Defect 3: explicit PCR zones and inclusive/exclusive boundaries."""

    def test_zone_boundaries(self):
        cfg = S.ScalpConfig()
        for pcr, zone in ((0.49, "STRETCHED_LOW"), (0.50, "BEARISH"), (0.79, "BEARISH"), (0.80, "NEUTRAL"), (1.20, "NEUTRAL"),
                          (1.21, "BULLISH"), (1.60, "BULLISH"), (1.61, "STRETCHED_HIGH")):
            self.assertEqual(S.pcr_zone(pcr, cfg), zone, pcr)

    def test_which_side_each_zone_allows(self):
        cfg = S.ScalpConfig()
        allowed = lambda pcr, side, change=0.0: S.read_pcr({"pcr_oi": pcr, "pcr_change_5m": change}, side, cfg)[0]  # noqa: E731
        self.assertEqual((allowed(1.40, "CE"), allowed(1.40, "PE")), (1, 0))  # bullish zone: longs only
        self.assertEqual((allowed(0.65, "CE"), allowed(0.65, "PE")), (0, 1))  # bearish zone: shorts only
        self.assertEqual((allowed(1.00, "CE", 0.01), allowed(1.00, "PE", 0.01)), (1, 0))  # neutral: the change decides
        self.assertEqual((allowed(1.00, "CE", -0.01), allowed(1.00, "PE", -0.01)), (0, 1))
        self.assertEqual((allowed(1.70, "CE"), allowed(0.45, "PE")), (0, 0))  # stretched: no trades
        self.assertEqual(S.read_pcr({"pcr_oi": 1.40, "pcr_change_5m": 0.0}, "CE", cfg)[2]["zone"], "BULLISH")


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
        first, result, bars, now = run(rr=rr) if rr == "1:2" else run(rr=rr, scale=3.5, step=100, lot=30)
        futures = tape(1, 1.0 if rr == "1:2" else 3.5, base=(24800.0 if rr == "1:2" else 52000.0) + BASIS)
        engine_result = analyze("NIFTY", bars, 1000.0, S.STRATEGY_ID, None, False, {
            "futures_candles": futures,
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
