"use client";

import { useEffect, useState } from "react";

type Case = { case: "low" | "base" | "high"; iv_pct: number; premium: number; change: number; change_pct: number };
export type OpenPremiumEstimate = {
  status: "READY" | "ERROR"; reason?: string; contract?: string | null; open_at: string; estimate: number; range: [number, number]; cases: Case[];
  change: number; change_pct: number; opening_quote: { bid: number; ask: number; spread_pct: number; source: string };
  breakdown: { overnight_decay: number; index_move: number; iv_change: number; intrinsic_at_open: number; time_value_at_open: number };
  greeks_at_open: { delta: number; gamma: number; vega: number; theta: number };
  ladder: Array<{ time: string; premium: number }>;
  inputs: {
    spot: number; key_level: number; move_points: number; move_pct: number; option_type: "CE" | "PE"; strike: number; premium: number; expiry: string;
    bid: number | null; ask: number | null; rate_pct: number; days_to_expiry_now: number; days_to_expiry_at_open: number; calendar_days_to_open: number;
    iv_pct: number; iv_source: string; chain_iv_pct: number | null; iv_change_points: number; iv_change_source: string; iv_band_points: number; model: string;
    premium_source?: string; spot_source?: string;
  };
  caveats: string[];
};
export type EstimatorPreset = { label: string; option_type: "CE" | "PE"; strike: number; premium?: number; expiry?: string; key_level: number };

const n = (value: number | null | undefined, digits = 2) => (value === null || value === undefined || !Number.isFinite(value) ? "--" : value.toLocaleString("en-IN", { maximumFractionDigits: digits }));
const signed = (value: number, digits = 2) => `${value >= 0 ? "+" : "−"}${n(Math.abs(value), digits)}`;
const CASE: Record<Case["case"], string> = { low: "IV crush", base: "Base", high: "IV spike" };

/** Premium of a chosen contract at the next session's open if the index is at a chosen key level. */
export function OpenPremiumEstimator({ symbol, presets, levels }: { symbol: string; presets: EstimatorPreset[]; levels: Array<{ label: string; value: number }> }) {
  const first = presets[0];
  const [form, setForm] = useState({ option_type: first?.option_type ?? "PE", strike: first ? String(first.strike) : "", premium: "", spot: "", key_level: first ? String(Math.round(first.key_level)) : "", iv_change: "", expiry: first?.expiry ?? "" });
  const [result, setResult] = useState<OpenPremiumEstimate | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { setResult(null); setError(""); }, [symbol]);

  const apply = (preset: EstimatorPreset) => setForm((current) => ({ ...current, option_type: preset.option_type, strike: String(preset.strike), premium: "", key_level: String(Math.round(preset.key_level)), expiry: preset.expiry ?? "" }));
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm((current) => ({ ...current, [key]: event.target.value }));

  async function run() {
    setBusy(true);
    try {
      const body = { symbol, ...form, strike: Number(form.strike), key_level: Number(form.key_level), premium: form.premium === "" ? undefined : Number(form.premium), spot: form.spot === "" ? undefined : Number(form.spot), iv_change: form.iv_change === "" ? undefined : Number(form.iv_change), expiry: form.expiry || undefined };
      const data = await fetch("/api/algo-trading/premium-estimate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((response) => response.json());
      if (data.status === "READY") { setResult(data); setError(""); } else { setResult(null); setError(String(data.reason ?? "The estimate failed")); }
    } catch { setError("The premium estimate is unavailable; try again shortly."); }
    finally { setBusy(false); }
  }

  const input = result?.inputs;
  return (
    <details className="mi-management exec-open-premium" open={Boolean(result)}>
      <summary>Premium at tomorrow's open for a key level</summary>
      {presets.length > 0 && <div className="exec-tabs">{presets.map((preset) => <button key={preset.label} type="button" onClick={() => apply(preset)}>{preset.label}</button>)}</div>}
      <div className="exec-fields">
        <label>Type<select value={form.option_type} onChange={set("option_type")}><option value="CE">CE</option><option value="PE">PE</option></select></label>
        <label>Strike<input type="number" step={50} value={form.strike} onChange={set("strike")} /></label>
        <label>Premium now ₹<input type="number" step={0.05} placeholder="from the chain" value={form.premium} onChange={set("premium")} /></label>
        <label>Index now<input type="number" placeholder="from the chain" value={form.spot} onChange={set("spot")} /></label>
        <label>Key level<input type="number" value={form.key_level} onChange={set("key_level")} list={`open-premium-levels-${symbol}`} /></label>
        <label>IV change (pts)<input type="number" step={0.5} placeholder="automatic" value={form.iv_change} onChange={set("iv_change")} /></label>
      </div>
      <datalist id={`open-premium-levels-${symbol}`}>{levels.map((level) => <option key={level.label} value={Math.round(level.value)}>{level.label}</option>)}</datalist>
      {levels.length > 0 && <p className="mi-note">Key levels: {levels.map((level, index) => <span key={level.label}>{index ? " · " : ""}<button type="button" className="link-button" onClick={() => setForm((current) => ({ ...current, key_level: String(Math.round(level.value)) }))}>{level.label} {n(level.value, 0)}</button></span>)}</p>}
      <button type="button" onClick={() => void run()} disabled={busy || !form.strike || !form.key_level}>{busy ? "Calculating…" : "Estimate the opening premium"}</button>
      {error && <p className="mi-note warning">{error}</p>}
      {result && input && (
        <div className="exec-premium-check" aria-label="Opening premium estimate">
          <span><small>{result.contract ?? `${symbol} ${n(input.strike, 0)} ${input.option_type}`} · {input.expiry} · if {symbol} is at {n(input.key_level, 0)} ({signed(input.move_points, 0)} pts, {signed(input.move_pct)}%) at {result.open_at.slice(0, 10)} 09:15</small></span>
          <span>Opening premium <b className={result.change >= 0 ? "gain" : "loss"}>₹{n(result.estimate)}</b> ({signed(result.change_pct)}% from ₹{n(input.premium)}) · range <b>₹{n(result.range[0])}–₹{n(result.range[1])}</b> · likely quote ₹{n(result.opening_quote.bid)} bid / ₹{n(result.opening_quote.ask)} ask ({n(result.opening_quote.spread_pct)}% spread, {result.opening_quote.source})</span>
          <div className="exec-calcs">
            {result.cases.map((item) => <span key={item.case}>{CASE[item.case]} (IV {n(item.iv_pct)}%) <b>₹{n(item.premium)}</b> <small>{signed(item.change_pct)}%</small></span>)}
          </div>
          <div className="exec-calcs">
            <span>Overnight decay <b className="loss">{signed(result.breakdown.overnight_decay)}</b></span>
            <span>Index move <b className={result.breakdown.index_move >= 0 ? "gain" : "loss"}>{signed(result.breakdown.index_move)}</b></span>
            <span>IV change <b className={result.breakdown.iv_change >= 0 ? "gain" : "loss"}>{signed(result.breakdown.iv_change)}</b></span>
            <span>Intrinsic <b>₹{n(result.breakdown.intrinsic_at_open)}</b> + time value <b>₹{n(result.breakdown.time_value_at_open)}</b></span>
          </div>
          <span>If the key level comes later in the day: {result.ladder.map((row) => `${row.time} ₹${n(row.premium)}`).join(" · ")}</span>
          <span><small>Inputs: index {n(input.spot)} ({input.spot_source ?? "--"}) · premium ₹{n(input.premium)} ({input.premium_source ?? "--"}){input.bid !== null && input.ask !== null ? ` · bid/ask ₹${n(input.bid)}/₹${n(input.ask)}` : ""} · IV {n(input.iv_pct)}% ({input.iv_source}){input.chain_iv_pct !== null ? `, chain ${n(input.chain_iv_pct)}%` : ""} · IV change {signed(input.iv_change_points)} pts ({input.iv_change_source}) ±{input.iv_band_points} pts · rate {n(input.rate_pct)}% · {n(input.days_to_expiry_now)} → {n(input.days_to_expiry_at_open)} days to expiry ({n(input.calendar_days_to_open)} calendar days to the open) · {input.model}</small></span>
          <span><small>Greeks at the open: Δ {n(result.greeks_at_open.delta, 3)} · Γ {n(result.greeks_at_open.gamma, 5)} · vega ₹{n(result.greeks_at_open.vega)}/vol pt · θ {signed(result.greeks_at_open.theta)}/day</small></span>
          {result.caveats.map((line) => <small key={line} className="mi-note">{line}</small>)}
        </div>
      )}
    </details>
  );
}
