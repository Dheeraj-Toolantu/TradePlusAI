"use client";

import { useEffect, useState } from "react";

type Costs = { brokerage: number; stt: number; exchange: number; sebi: number; stamp: number; gst: number; slippage: number; spread: number; total: number; per_unit: number };
export type PremiumCheck = {
  spot: number; key_level: number; move_points: number; move_pct: number | null; entry: number;
  target_gain_pct: number; stop_pct: number; required_premium: number; percent_target: number; percent_stop: number;
  target_premium: number; stop_premium: number; return_pct: number | null; risk_reward: number | null;
  model: {
    name: string; strike: number; expiry: string | null; days_to_expiry: number | null; rate_pct: number; iv_pct: number | null; iv_source: string | null;
    chain_iv_pct: number | null; chain_delta: number | null;
    scenario: { iv_change_points: number; scenario_iv_pct: number | null; hold_days: number; days_left_at_key: number | null };
  };
  greeks: { delta: number | null; gamma: number | null; vega: number | null; theta: number | null; iv: number | null; days_to_expiry: number | null; hold_days: number; iv_change: number };
  delta_only_source: string | null;
  move_needed_delta: number | null; move_needed_greeks: number | null; move_needed_model: number | null;
  index_target_delta: number | null; index_target_greeks: number | null; index_target_model: number | null;
  premium_at_key_greeks: number | null; premium_at_key_model: number | null; return_at_key_pct: number | null;
  target_possible: boolean; target_likely: boolean; key_level_likely: boolean; touch_probability_session: number | null; touch_probability_expiry: number | null;
  costs: { quantity: number; lot_assumed: boolean; at_target: Costs; at_stop: Costs };
  net_reward: number; net_risk: number; net_risk_reward: number | null; spread_pct: number | null;
  checks: Array<{ id: string; passed: boolean; blocking: boolean; detail: string }>; valid: boolean; reason: string;
};

const LABELS: Record<string, string> = { KEY_LEVEL_PAYS_TARGET: "Key level pays target", REWARD_RISK: "Net reward-to-risk", SPREAD: "Bid-ask spread", LIQUIDITY: "Liquidity", TARGET_LIKELY: "Key level likely today" };
const pct = (value: number | null | undefined) => (value === null || value === undefined ? "--" : `${Math.round(value * 100)}%`);
const n = (value: number | null | undefined, digits = 2) => (value === null || value === undefined || !Number.isFinite(value) ? "--" : value.toLocaleString("en-IN", { maximumFractionDigits: digits }));

/** Index move vs option premium for one strike and key level, plus a delta-only what-if calculator. */
export function PremiumCalculator({ check, optionType, title = "Premium target check" }: { check: PremiumCheck; optionType: "CE" | "PE"; title?: string }) {
  const down = optionType === "PE";
  const [inputs, setInputs] = useState({ spot: check.spot, key: check.key_level, entry: check.entry, delta: Math.abs(check.greeks.delta ?? 0.35), gain: check.target_gain_pct, stop: check.stop_pct });
  useEffect(() => {
    setInputs({ spot: check.spot, key: check.key_level, entry: check.entry, delta: Math.abs(check.greeks.delta ?? 0.35), gain: check.target_gain_pct, stop: check.stop_pct });
  }, [check.spot, check.key_level, check.entry, check.greeks.delta, check.target_gain_pct, check.stop_pct]);

  // Delta-only, first order: move = entry x gain / |delta|.
  const target = inputs.entry * (1 + inputs.gain / 100);
  const stop = inputs.entry * (1 - inputs.stop / 100);
  const move = inputs.delta > 0 ? (target - inputs.entry) / inputs.delta : null;
  const indexTarget = move === null ? null : inputs.spot + (down ? -move : move);
  const distance = Math.abs(inputs.key - inputs.spot);
  const rr = inputs.entry > stop ? (target - inputs.entry) / (inputs.entry - stop) : null;
  const field = (key: keyof typeof inputs, label: string, step = 1) => (
    <label key={key}>{label}<input type="number" step={step} value={inputs[key]} onChange={(event) => setInputs((current) => ({ ...current, [key]: Number(event.target.value) }))} /></label>
  );

  return (
    <div className="exec-premium-check" aria-label={title}>
      <span><small>{title}</small> <b className={check.valid ? "gain" : "loss"}>{check.valid ? "valid" : "rejected"}</b></span>
      <span>Move to key {n(check.key_level, 0)}: <b>{n(check.move_points, 0)} pts</b> ({n(check.move_pct, 2)}%)</span>
      <span>Entry <b>₹{n(check.entry)}</b> · a {n(check.target_gain_pct, 0)}% option premium gain needs <b>₹{n(check.required_premium)}</b> · exit target <b>₹{n(check.target_premium)}</b> · stop <b>₹{n(check.stop_premium)}</b></span>
      <span>Premium at the key level (full reprice): <b className={check.target_possible ? "gain" : "loss"}>₹{n(check.premium_at_key_model)}</b> ({check.return_at_key_pct !== null ? `${check.return_at_key_pct >= 0 ? "+" : ""}${n(check.return_at_key_pct)}%` : "--"}) · Greeks estimate ₹{n(check.premium_at_key_greeks)}</span>
      <span>Index move for ₹{n(check.required_premium)}: <b>{n(check.move_needed_model, 0)} pts</b> full reprice (to {n(check.index_target_model, 0)}) · {n(check.move_needed_greeks, 0)} pts Greeks · {n(check.move_needed_delta, 0)} pts delta-only ({check.delta_only_source ?? "--"})</span>
      <span>Target <b className={check.target_possible ? "gain" : "loss"}>{check.target_possible ? "possible" : "not possible"}</b> if the index reaches the key level · key level <b className={check.key_level_likely ? "gain" : "warning"}>{check.key_level_likely ? "likely" : "not likely"}</b> to be touched today ({pct(check.touch_probability_session)} today, {pct(check.touch_probability_expiry)} before expiry) · target <b className={check.target_likely ? "gain" : "warning"}>{check.target_likely ? "likely" : "not likely"}</b> (needs both)</span>
      <span>Reward-to-risk <b>{n(check.net_risk_reward)}R net</b> after ₹{n(check.costs.at_target.total, 0)} costs per {check.costs.quantity} qty{check.costs.lot_assumed ? " (lot assumed)" : ""} · {n(check.risk_reward)}R gross</span>
      <span><small>Model: {check.model.name} · strike {n(check.model.strike, 0)} · expiry {check.model.expiry ?? "--"} ({n(check.model.days_to_expiry, 1)} days) · rate {n(check.model.rate_pct)}% · IV {n(check.model.iv_pct)}% {check.model.iv_source ? `(${check.model.iv_source})` : ""}{check.model.chain_iv_pct ? ` · chain IV ${n(check.model.chain_iv_pct)}%` : ""} · scenario IV {n(check.model.scenario.scenario_iv_pct)}% ({check.model.scenario.iv_change_points >= 0 ? "+" : ""}{check.model.scenario.iv_change_points} pts), {check.model.scenario.hold_days}-day hold, {n(check.model.scenario.days_left_at_key, 2)} days left at the key</small></span>
      <span><small>Greeks (same model): Δ {n(check.greeks.delta, 3)} · Γ {n(check.greeks.gamma, 5)} · vega ₹{n(check.greeks.vega)}/vol pt · θ {check.greeks.theta !== null && check.greeks.theta < 0 ? "−" : ""}₹{n(check.greeks.theta === null ? null : Math.abs(check.greeks.theta))}/day{check.model.chain_delta !== null ? ` · chain Δ ${n(check.model.chain_delta, 3)}` : ""}{check.spread_pct !== null ? ` · spread ${n(check.spread_pct)}%` : ""}</small></span>
      <div className="exec-gates">{check.checks.map((item) => <span key={item.id} className={item.passed ? "pass" : item.blocking ? "fail" : "warn"} title={`${item.detail}${item.blocking ? "" : " (information, does not block)"}`}>{item.passed ? "✓" : item.blocking ? "✗" : "!"} {LABELS[item.id] ?? item.id}</span>)}</div>
      {!check.valid && <small className="warning">{check.reason}</small>}
      <details className="mi-management">
        <summary>Costs at the target (₹, {check.costs.quantity} qty)</summary>
        <div className="exec-calcs">
          {(["brokerage", "stt", "exchange", "sebi", "stamp", "gst", "slippage", "spread"] as const).map((part) => <span key={part}>{part === "stt" ? "STT" : part === "gst" ? "GST" : part === "sebi" ? "SEBI fee" : part[0].toUpperCase() + part.slice(1)} <b>₹{n(check.costs.at_target[part])}</b></span>)}
          <span>Total <b>₹{n(check.costs.at_target.total)}</b> (₹{n(check.costs.at_target.per_unit, 3)}/unit)</span><span>Net reward <b>₹{n(check.net_reward)}</b>/unit</span><span>Net risk <b>₹{n(check.net_risk)}</b>/unit</span>
        </div>
      </details>
      <details className="mi-management">
        <summary>Try your own values (delta-only)</summary>
        <div className="exec-fields">
          {field("spot", "Index price")}{field("key", "Key level")}{field("entry", `${optionType} entry ₹`, 0.05)}{field("delta", "|Delta| (0–1)", 0.01)}{field("gain", "Target gain %")}{field("stop", "Stop-loss %")}
        </div>
        <p className="mi-note">
          Target ₹{n(target)} · stop ₹{n(stop)} · {n(rr)}R. Estimated index move <b>{n(move, 1)} pts {down ? "down" : "up"}</b> to <b>{n(indexTarget, 1)}</b>.
          {move !== null ? ` The key level is ${n(distance, 1)} pts ${down ? "below" : "above"}; ${move <= distance ? "the premium target is reached at or before it." : "the premium target needs more than the key level gives."}` : ""}
          {" "}Delta-only ignores gamma, IV, time decay and costs; the engine's full reprice above includes all but costs, which the net reward-to-risk adds.
        </p>
      </details>
    </div>
  );
}
