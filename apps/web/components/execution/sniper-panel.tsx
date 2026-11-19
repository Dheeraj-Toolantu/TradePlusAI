"use client";

import { memo } from "react";

/**
 * NIFTY Sniper AI read-out for the algo page (spec 16.2): lifecycle state, setup family and
 * direction, the 100-point score with its eight components, every hard filter, the liquidity /
 * structure evidence, the selected contract (and why others were rejected), the 2x feasibility
 * read and the reference levels. Probabilities are shown as UNAVAILABLE until a calibrated model
 * exists; nothing here is presented as a promise of a 2x outcome.
 */

type Component = { key: string; score: number; max_score: number; status: string; reason: string; source_timestamp: string | null };
type Filter = { code: string; passed: boolean; detail: string };
type Contract = { symbol: string; strike: number; type: "CE" | "PE"; premium: number; delta: number; iv?: number | null; open_interest: number; volume: number; spread_pct?: number | null; spread_source?: string; rank_score?: number };
type Feasibility = {
  entry: number; stop_loss: number; target: number; partial_target: number; lot_size: number; lots: number; quantity: number; max_loss: number; planned_max_loss: number;
  index_move_needed: { "1_5x": number | null; "2x": number | null }; expected_move: number | null; feasibility_ratio: number | null; cost_share: number | null; hold_minutes: number;
  greeks?: { delta: number; gamma: number; theta_per_day: number | null; iv: number | null; source: string };
  probability?: Record<string, string>; model?: string; valid: boolean; reason: string;
};
export type SniperRead = {
  state?: string; family?: string; direction?: "CALL" | "PUT"; config_version?: string;
  score?: { total: number; minimum: number; maximum: number; band: string; default_action: string };
  components?: Component[]; hard_filters?: Filter[]; lifecycle?: Array<{ state: string; at: string; reason: string }>;
  regime?: { regime: string; reason?: string; ema_fast?: number; ema_slow?: number; vol_ratio?: number | null };
  reference?: { pdh: number | null; pdl: number | null; pdc: number | null; session_high: number | null; session_low: number | null; vwap: number | null; vwap_observable: boolean; atr_5m: number | null };
  levels?: Array<{ name: string; price: number; side: string; created_at: string; status: string }>;
  families?: Record<string, Record<string, unknown> & { state?: string; reason?: string }>;
  selected?: Contract | null; candidates?: Contract[]; rejected_contracts?: Array<{ symbol: string; strike: number | null; reasons: string[] }>;
  feasibility?: Feasibility | null; trigger?: { ok: boolean; time?: string; reason: string; age_seconds?: number }; extension_atr?: number | null;
  alternatives?: Array<{ family: string; direction: string; state: string; score: number }>;
  /** Order flow in the selected option: buying volume in its premium, and the supportive writers' OI change. */
  order_flow?: { premium_volume?: FlowCheck; writer_oi?: FlowCheck };
};
type FlowCheck = { status: string; passed: boolean; reason: string; who?: string };

const LABELS: Record<string, string> = {
  liquidity: "Liquidity event", structure: "MSS / BOS", displacement_fvg: "Displacement + FVG", oi: "OI / derivatives",
  vwap_ema: "VWAP / EMA", volume: "Volume", option_suitability: "Greeks / IV", feasibility: "2x feasibility",
};
const FILTERS: Record<string, string> = {
  SETUP_CONFIRMED: "setup confirmed", SIGNAL_FRESH: "signal fresh", ENTRY_TRIGGER: "1m trigger", NOT_CHASING: "not chasing", ENTRY_WINDOW: "entry window",
  REGIME_TRADABLE: "regime", CONTRACT_SELECTED: "contract", SPREAD_OK: "spread", FEASIBILITY_2X: "2x feasibility", OI_AVAILABLE: "OI", SCORE_MINIMUM: "score ≥ 85",
  PREMIUM_VOLUME_RISING: "premium buying volume", WRITER_OI_RISING: "writer OI rising",
};
const title = (value: string | undefined) => (value ?? "").replaceAll("_", " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
const n = (value: number | null | undefined, digits = 2) => (value === null || value === undefined || !Number.isFinite(value) ? "--" : value.toLocaleString("en-IN", { maximumFractionDigits: digits }));
const clock = (iso: string | undefined | null) => (iso ? iso.slice(11, 16) : "--");

function Evidence({ family }: { family: Record<string, unknown> | undefined }) {
  if (!family) return null;
  const sweep = family.sweep as Record<string, number | string> | null | undefined;
  const mss = family.mss as Record<string, number | string> | null | undefined;
  const disp = family.displacement as Record<string, number | string> | null | undefined;
  const fvg = family.fvg as Record<string, number | string> | null | undefined;
  const ob = family.order_block as Record<string, number | string> | null | undefined;
  const range = family.range as Record<string, number> | undefined;
  const breakout = family.breakout as Record<string, number | string | boolean> | undefined;
  const pullback = family.pullback as { extreme: number; protected: number; zones: string[] } | undefined;
  return (
    <div className="exec-calcs">
      {sweep ? <span>Sweep <b>{String(sweep.level_name).replaceAll("_", " ")} {n(Number(sweep.level))}</b> <small>to {n(Number(sweep.extreme))} ({n(Number(sweep.depth_atr))} ATR) at {clock(String(sweep.sweep_time))}, reclaimed in {sweep.reclaim_bars} bar(s)</small></span> : null}
      {mss ? <span>MSS <b>close beyond {n(Number(mss.level))}</b> <small>{String(mss.protected_from)} · {clock(String(mss.time))}</small></span> : null}
      {range ? <span>Range <b>{n(range.low)}–{n(range.high)}</b> <small>{n(range.height_atr)} ATR · {range.boundary_touches} touch(es)</small></span> : null}
      {breakout ? <span>Breakout <b>{clock(String(breakout.time))}</b> <small>rel. volume {n(Number(breakout.relative_volume))}× · {breakout.holds ? "holding" : "failed back inside"}</small></span> : null}
      {pullback ? <span>Pullback <b>{n(pullback.extreme)}</b> <small>into {pullback.zones.join(", ") || "no zone"} · protected {n(pullback.protected)}</small></span> : null}
      {disp ? <span>Displacement <b>{clock(String(disp.time))}</b> <small>{n(Number(disp.range_atr))} ATR · body {n(Number(disp.body_ratio))}</small></span> : <span>Displacement <b>none</b></span>}
      {fvg ? <span>FVG <b>{n(Number(fvg.lower))}–{n(Number(fvg.upper))}</b> <small>{String(fvg.status).toLowerCase()} · {String(fvg.mitigation_rule).toLowerCase().replace("_", " ")}</small></span> : null}
      {ob ? <span>Order block <b>{n(Number(ob.lower))}–{n(Number(ob.upper))}</b> <small>{String(ob.status).toLowerCase()} (algorithmic zone)</small></span> : null}
      {family.invalidation !== undefined ? <span>Index invalidation <b className="loss">{n(Number(family.invalidation))}</b></span> : null}
    </div>
  );
}

export const SniperPanel = memo(function SniperPanel({ sniper, decision }: { sniper: SniperRead | null | undefined; decision: string | undefined }) {
  if (!sniper) return <p className="mi-note">Waiting for the NIFTY Sniper engine…</p>;
  const score = sniper.score;
  const feas = sniper.feasibility;
  const familyKey = sniper.family && sniper.direction ? `${sniper.family}:${sniper.direction}` : null;
  const family = familyKey ? sniper.families?.[familyKey] : undefined;
  const others = Object.entries(sniper.families ?? {}).filter(([key]) => key !== familyKey);
  return (
    <div className="sniper-panel">
      <div className="exec-score">
        <span><small>Lifecycle</small><b className={sniper.state === "ELIGIBLE" ? "gain" : "warning"}>{sniper.state ?? "--"}</b></span>
        <span><small>Setup</small><b>{sniper.family ? title(sniper.family) : "none"}</b></span>
        <span><small>Direction</small><b className={sniper.direction === "PUT" ? "loss" : sniper.direction === "CALL" ? "gain" : undefined}>{sniper.direction ?? "--"}</b></span>
        <span><small>15m regime</small><b>{sniper.regime?.regime?.replaceAll("_", " ") ?? "--"}</b></span>
        <span className="exec-score-total"><small>Sniper score</small><b className={score && score.total >= score.minimum ? "gain" : "warning"}>{score ? n(score.total, 1) : "--"} / 100</b><em>{score ? `${title(score.band)} · needs ${score.minimum}` : "no setup scored"}</em></span>
      </div>

      {sniper.components?.length ? (
        <ul className="exec-criteria" aria-label="Sniper score components">
          {sniper.components.map((item) => (
            <li key={item.key} className={item.score >= item.max_score * 0.6 ? "gain" : "warning"} title={item.source_timestamp ? `data as of ${item.source_timestamp}` : undefined}>
              <b>{LABELS[item.key] ?? item.key} {n(item.score, 1)}/{item.max_score}</b> <small>[{item.status}]</small> {item.reason}
            </li>
          ))}
        </ul>
      ) : null}

      {sniper.hard_filters?.length ? (
        <>
          <p className="mi-note"><b>Hard filters {sniper.hard_filters.filter((f) => f.passed).length}/{sniper.hard_filters.length}</b>: every one must pass — a high score never overrides them. {decision === "CONFIRMED" ? "" : "No order is placed while any is red."}</p>
          <div className="exec-gates">{sniper.hard_filters.map((f) => <span key={f.code} className={f.passed ? "pass" : "fail"} title={f.detail}>{f.passed ? "✓" : "✗"} {FILTERS[f.code] ?? f.code.toLowerCase()}</span>)}</div>
          {sniper.order_flow ? (
            <ul className="exec-criteria" aria-label="Order flow in the selected option">
              {([["Premium volume", sniper.order_flow.premium_volume], [sniper.direction === "PUT" ? "Call writers' OI" : "Put writers' OI", sniper.order_flow.writer_oi]] as Array<[string, FlowCheck | undefined]>).map(([label, check]) => check ? (
                <li key={label}><b className={check.passed ? "gain" : "loss"}>{check.passed ? "✓" : "✗"}</b>{label}{check.status === "SNAPSHOT" ? " (5-min reading)" : check.status === "UNAVAILABLE" ? " (unavailable)" : ""}: {check.reason}</li>
              ) : null)}
            </ul>
          ) : null}
        </>
      ) : null}

      <Evidence family={family} />

      {sniper.selected ? (
        <div className="exec-orb" aria-label="Sniper contract">
          <span>Contract <b className={sniper.selected.type === "PE" ? "loss" : "gain"}>{sniper.selected.symbol}</b> · ₹{n(sniper.selected.premium)} · Δ {n(sniper.selected.delta, 3)}{sniper.selected.iv ? ` · IV ${n(sniper.selected.iv)}%` : ""} · OI {n(sniper.selected.open_interest, 0)} · vol {n(sniper.selected.volume, 0)} · spread {sniper.selected.spread_pct !== null && sniper.selected.spread_pct !== undefined ? `${n(sniper.selected.spread_pct)}%` : "unavailable (no live bid/ask)"}</span>
          {sniper.candidates && sniper.candidates.length > 1 ? <small>Next: {sniper.candidates.slice(1, 4).map((c) => `${n(c.strike, 0)} ${c.type} Δ${n(c.delta)} ₹${n(c.premium)}`).join(" · ")}</small> : null}
          {sniper.rejected_contracts?.length ? <small>Rejected: {sniper.rejected_contracts.slice(0, 4).map((c) => `${n(c.strike, 0)} (${c.reasons[0]})`).join(" · ")}</small> : null}
        </div>
      ) : null}

      {feas ? (
        <div className="exec-orb" aria-label="2x feasibility">
          <span>Premium entry ~₹{n(feas.entry)} · SL <b className="loss">₹{n(feas.stop_loss)}</b> (−25% of the fill) · 1.5x ₹{n(feas.partial_target)} · 2x target <b className="gain">₹{n(feas.target)}</b> <small>(recomputed from the actual fill when placed)</small></span>
          <span>Index move needed: 1.5x {n(feas.index_move_needed["1_5x"], 1)} pts · 2x <b>{n(feas.index_move_needed["2x"], 1)} pts</b> vs ~{n(feas.expected_move, 1)} pts expected in {feas.hold_minutes} min · ratio <b className={feas.feasibility_ratio !== null && feas.feasibility_ratio <= 1.25 ? "gain" : "warning"}>{n(feas.feasibility_ratio, 3)}</b> (max 1.25)</span>
          <span>{feas.lots} lot(s) × {feas.lot_size} · max loss ₹{n(feas.planned_max_loss)} planned / ₹{n(feas.max_loss)} stressed · charges {feas.cost_share !== null ? `${Math.round(feas.cost_share * 100)}%` : "--"} of the 2x reward{feas.greeks ? ` · Γ ${feas.greeks.gamma} · θ ₹${n(feas.greeks.theta_per_day)}/day (${feas.greeks.source.toLowerCase()})` : ""}</span>
          <span>P(2x before stop): <b>{feas.probability?.reach_2x_before_stop ?? "UNAVAILABLE"}</b> · P(1.5x): <b>{feas.probability?.reach_1_5x_before_stop ?? "UNAVAILABLE"}</b> <small>{feas.probability?.reason ?? ""}. The feasibility ratio is a heuristic, not a probability.</small></span>
          {!feas.valid && feas.reason ? <small className="warning">{feas.reason}</small> : null}
        </div>
      ) : null}

      {sniper.trigger ? <p className="mi-note">1m trigger: <b className={sniper.trigger.ok ? "gain" : "warning"}>{sniper.trigger.ok ? "yes" : "no"}</b> · {sniper.trigger.reason}{sniper.extension_atr !== null && sniper.extension_atr !== undefined ? ` · ${n(sniper.extension_atr)} ATR from the trigger level` : ""}</p> : null}

      <details className="mi-management">
        <summary>Levels, other setups and lifecycle</summary>
        <div className="exec-calcs">
          {sniper.reference ? <>
            <span>PDH / PDL / PDC <b>{n(sniper.reference.pdh)} / {n(sniper.reference.pdl)} / {n(sniper.reference.pdc)}</b></span>
            <span>Session H / L <b>{n(sniper.reference.session_high)} / {n(sniper.reference.session_low)}</b></span>
            <span>VWAP <b>{sniper.reference.vwap_observable ? n(sniper.reference.vwap) : "unavailable (no volume)"}</b></span>
            <span>ATR (5m) <b>{n(sniper.reference.atr_5m)}</b></span>
          </> : null}
          {(sniper.levels ?? []).slice(-8).map((level) => <span key={`${level.name}-${level.price}-${level.created_at}`}>{level.name.replaceAll("_", " ").toLowerCase()} <b>{n(level.price)}</b> <small>{level.status.toLowerCase()}{level.created_at ? ` · ${clock(level.created_at)}` : ""}</small></span>)}
        </div>
        <ul className="exec-criteria">
          {others.map(([key, value]) => <li key={key} className={value.state === "CONFIRMED" ? "gain" : "warning"}><b>{title(key.split(":")[0])} {key.split(":")[1]}</b> <small>[{value.state}]</small> {String(value.reason ?? "")}</li>)}
          {(sniper.lifecycle ?? []).map((item, index) => <li key={`${item.state}-${index}`}><b>{item.state}</b> <small>{clock(item.at)}</small> {item.reason}</li>)}
        </ul>
        <p className="mi-note">Config {sniper.config_version ?? "--"} · research defaults, not validated thresholds. Paper only. A 2x target is an objective, never a promise; most sessions should end with NO TRADE.</p>
      </details>
    </div>
  );
});
