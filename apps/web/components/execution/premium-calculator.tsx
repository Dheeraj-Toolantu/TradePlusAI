"use client";

import { useEffect, useState } from "react";

export type PremiumCheck = {
  spot: number; key_level: number; move_points: number; move_pct: number | null; entry: number;
  target_gain_pct: number; stop_pct: number; percent_target: number; percent_stop: number;
  target_premium: number; stop_premium: number; return_pct: number | null; risk_reward: number | null;
  greeks: { delta: number | null; gamma: number | null; vega: number | null; theta: number | null; iv: number | null; days_to_expiry: number | null; hold_days: number; iv_change: number };
  move_needed_delta: number | null; move_needed_greeks: number | null; index_target_delta: number | null; index_target_greeks: number | null;
  premium_at_key_greeks: number | null; premium_at_key_model: number | null; spread_pct: number | null;
  checks: Array<{ id: string; passed: boolean; detail: string }>; valid: boolean; reason: string;
};

const LABELS: Record<string, string> = { KEY_LEVEL_PAYS_TARGET: "Key level pays target", REWARD_RISK: "Reward-to-risk", SPREAD: "Bid-ask spread", LIQUIDITY: "Liquidity" };
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
      <span>Entry <b>₹{n(check.entry)}</b> → target <b>₹{n(check.target_premium)}</b> ({check.return_pct !== null ? `+${n(check.return_pct, 0)}%` : "--"}) · stop <b>₹{n(check.stop_premium)}</b> · <b>{n(check.risk_reward)}R</b></span>
      <span>Index move for +{n(check.target_gain_pct, 0)}%: <b>{n(check.move_needed_delta, 0)} pts</b> delta-only (to {n(check.index_target_delta, 0)}), <b>{n(check.move_needed_greeks, 0)} pts</b> with Greeks (to {n(check.index_target_greeks, 0)})</span>
      <span>Premium at the key level: <b>₹{n(check.premium_at_key_greeks)}</b> Greeks · <b>₹{n(check.premium_at_key_model)}</b> pricing model</span>
      <span><small>Δ {n(check.greeks.delta, 3)} · Γ {n(check.greeks.gamma, 5)} · vega {n(check.greeks.vega)}/vol pt · θ {n(check.greeks.theta)}/day · IV {n(check.greeks.iv)}% · {n(check.greeks.days_to_expiry, 1)} days to expiry · {check.greeks.hold_days} day hold{check.spread_pct !== null ? ` · spread ${n(check.spread_pct)}%` : ""}</small></span>
      <div className="exec-gates">{check.checks.map((item) => <span key={item.id} className={item.passed ? "pass" : "fail"} title={item.detail}>{item.passed ? "✓" : "✗"} {LABELS[item.id] ?? item.id}</span>)}</div>
      {!check.valid && <small className="warning">{check.reason}</small>}
      <details className="mi-management">
        <summary>Try your own values (delta-only)</summary>
        <div className="exec-fields">
          {field("spot", "Index price")}{field("key", "Key level")}{field("entry", `${optionType} entry ₹`, 0.05)}{field("delta", "|Delta| (0–1)", 0.01)}{field("gain", "Target gain %")}{field("stop", "Stop-loss %")}
        </div>
        <p className="mi-note">
          Target ₹{n(target)} · stop ₹{n(stop)} · {n(rr)}R. Estimated index move <b>{n(move, 1)} pts {down ? "down" : "up"}</b> to <b>{n(indexTarget, 1)}</b>.
          {move !== null ? ` The key level is ${n(distance, 1)} pts ${down ? "below" : "above"}; ${move <= distance ? "the premium target is reached at or before it." : "the premium target needs more than the key level gives."}` : ""}
          {" "}Delta-only ignores gamma, IV and time decay; the engine's Greeks figure above includes them.
        </p>
      </details>
    </div>
  );
}
