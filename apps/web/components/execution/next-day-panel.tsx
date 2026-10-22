"use client";

import { useCallback, useEffect, useState } from "react";

type Factor = { id: string; name: string; value: number; weight: number; contribution: number; note: string };
type Plan = {
  role: "PRIMARY" | "ALTERNATE" | "BREAKOUT_UP" | "BREAKOUT_DOWN"; option_type: "CE" | "PE"; direction: string;
  index: { trigger: number; stop_loss: number; target: number; key_value_sources: string[]; risk_points: number; reward_points: number; risk_reward: number; skip_if_open_beyond: number };
  contract: { symbol: string; strike: number; type: "CE" | "PE"; expiry?: string; lot_size?: number | null; premium_close: number; delta: number | null; expiry_day: boolean } | null;
  premium: { entry: number; stop_loss: number; target: number; risk_reward: number | null; trailing_distance: number; breakeven_at: number; stop_capped: boolean } | null;
  entry_rule?: string; trailing_rule?: string; exit_rule?: string; note?: string;
};
export type NextDaySetup = {
  symbol: string; status: "READY" | "NO_DATA" | "ERROR"; reason?: string; session_date?: string; next_session_date?: string; daily_atr?: number;
  reference?: { open: number; high: number; low: number; close: number; vwap: number; opening_candle: { open: number; close: number }; closing_candle: { open: number; close: number }; opening_range: { high: number; low: number } };
  prediction?: { opening: "GAP_UP" | "GAP_DOWN" | "FLAT"; score: number; confidence: number; expected_gap_points: number; expected_open: number; expected_range: [number, number]; typical_gap_points: number; factors: Factor[] };
  track_record?: { days: number; hits: number; hit_rate: number | null; directional_days: number; direction_hits: number; direction_hit_rate: number | null };
  sentiment?: { score: number | null; label?: string | null } | null;
  plans?: Plan[]; caveats?: string[];
};

const INDICES = ["NIFTY", "BANKNIFTY", "SENSEX"] as const;
const ROLE: Record<Plan["role"], string> = { PRIMARY: "Primary · trades the predicted open", ALTERNATE: "Alternate · if the predicted open fails", BREAKOUT_UP: "Breakout up", BREAKOUT_DOWN: "Breakout down" };
const OPENING: Record<string, string> = { GAP_UP: "Gap up", GAP_DOWN: "Gap down", FLAT: "Flat" };
const num = (value: number | null | undefined, digits = 2) => (value === null || value === undefined || !Number.isFinite(value) ? "--" : value.toLocaleString("en-IN", { maximumFractionDigits: digits }));
const pct = (value: number | null | undefined) => (value === null || value === undefined ? "--" : `${Math.round(value * 100)}%`);

/** Next-day setup per index: predicted opening from the last session's opening and closing candles, and a planned OTM option trade. */
export function NextDayPanel({ symbol, onSymbolChange, onUsePlan }: { symbol: string; onSymbolChange?: (symbol: string) => void; onUsePlan?: (plan: Plan, setup: NextDaySetup) => void }) {
  const [setups, setSetups] = useState<NextDaySetup[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (force = false) => {
    setBusy(true);
    try {
      const data = await fetch(`/api/algo-trading/next-day?symbol=ALL${force ? "&refresh=1" : ""}`, { cache: "no-store" }).then((response) => response.json());
      if (data.error) setError(String(data.error)); else { setSetups(data.setups ?? []); setError(""); }
    } catch { setError("Next-day setup is unavailable; try again shortly."); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const active = INDICES.includes(symbol as typeof INDICES[number]) ? symbol : "NIFTY";
  const setup = setups.find((item) => item.symbol === active);
  const prediction = setup?.prediction;
  const record = setup?.track_record;

  return (
    <article className="mi-card exec-next-day" aria-label="Next-day setup">
      <div className="algo-panel-head">
        <div>
          <span className="algo-kicker">NEXT-DAY SETUP · BUILT AFTER THE CLOSE{setup?.next_session_date ? ` · FOR ${setup.next_session_date}` : ""}</span>
          <h2>{active} opening: <span className={prediction?.opening === "GAP_UP" ? "gain" : prediction?.opening === "GAP_DOWN" ? "loss" : "warning"}>{prediction ? OPENING[prediction.opening] : setup?.status === "READY" ? "--" : busy ? "Loading…" : setup?.status ?? "--"}</span></h2>
        </div>
        <div className="exec-strategy-controls">
          <div className="exec-tabs" role="tablist">{INDICES.map((item) => {
            const p = setups.find((row) => row.symbol === item)?.prediction;
            return <button key={item} type="button" role="tab" aria-selected={item === active} className={item === active ? "active" : ""} onClick={() => onSymbolChange?.(item)}>{item}{p ? ` ${p.opening === "GAP_UP" ? "▲" : p.opening === "GAP_DOWN" ? "▼" : "▬"}` : ""}</button>;
          })}</div>
          <button type="button" onClick={() => void load(true)} disabled={busy}>{busy ? "…" : "Refresh"}</button>
        </div>
      </div>
      {error && <p className="mi-note warning">{error}</p>}
      {setup && setup.status !== "READY" && <p className="mi-note warning">{setup.reason}</p>}
      {setup?.status === "READY" && prediction && setup.reference && (
        <>
          <p className="mi-note">
            From the {setup.session_date} session: opened {num(setup.reference.open)}, closed {num(setup.reference.close)} (range {num(setup.reference.low)}–{num(setup.reference.high)}).
            Expected open <b>{num(prediction.expected_open, 0)}</b> ({prediction.expected_gap_points >= 0 ? "+" : ""}{num(prediction.expected_gap_points, 0)} pts, range {num(prediction.expected_range[0], 0)}–{num(prediction.expected_range[1], 0)}), model score {prediction.score >= 0 ? "+" : ""}{num(prediction.score)} · confidence {pct(prediction.confidence)}.
            {record && record.days > 0 ? ` Track record: ${record.hits}/${record.days} openings right (${pct(record.hit_rate)}), direction ${record.direction_hits}/${record.directional_days} on gap calls.` : ""}
            {setup.sentiment?.score !== null && setup.sentiment?.score !== undefined ? ` Index sentiment ${setup.sentiment.score > 0 ? "+" : ""}${num(setup.sentiment.score, 1)}.` : ""}
          </p>
          <div className="exec-plans">
            {(setup.plans ?? []).map((plan) => (
              <div key={plan.role} className="exec-orb">
                <span><small>{ROLE[plan.role]}</small></span>
                <span><b className={plan.option_type === "CE" ? "gain" : "loss"}>{plan.contract ? `BUY ${plan.contract.symbol}` : `BUY ${plan.option_type} (no strike qualifies)`}</b>{plan.contract?.expiry_day ? <em className="warning"> expiry day</em> : null}</span>
                <span>Index trigger <b>{num(plan.index.trigger, 0)}</b> · SL <b>{num(plan.index.stop_loss, 0)}</b> · target <b>{num(plan.index.target, 0)}</b> <small>({plan.index.key_value_sources.join(" + ")})</small></span>
                {plan.premium && <span>Premium entry <b>₹{num(plan.premium.entry)}</b> · SL <b>₹{num(plan.premium.stop_loss)}</b> · trail <b>₹{num(plan.premium.trailing_distance)}</b> (breakeven ₹{num(plan.premium.breakeven_at)}) · target <b>₹{num(plan.premium.target)}</b> · {num(plan.premium.risk_reward)}R</span>}
                {plan.entry_rule && <small>{plan.entry_rule}</small>}
                {plan.trailing_rule && <small>{plan.trailing_rule}</small>}
                {plan.exit_rule && <small>{plan.exit_rule}</small>}
                {plan.note && <small className="warning">{plan.note}</small>}
                {plan.contract && plan.premium && onUsePlan && <button type="button" className="mi-use-plan" onClick={() => onUsePlan(plan, setup)}>Load into the order ticket</button>}
              </div>
            ))}
          </div>
          <details className="mi-management">
            <summary>Why this prediction</summary>
            <div className="exec-calcs">
              {prediction.factors.map((factor) => <span key={factor.id} title={factor.note}>{factor.name} <b className={factor.value > 0.05 ? "gain" : factor.value < -0.05 ? "loss" : ""}>{factor.value >= 0 ? "+" : ""}{num(factor.value)}</b> <small>×{factor.weight} · {factor.note}</small></span>)}
              <span>Opening candle <b>{num(setup.reference.opening_candle.open)} → {num(setup.reference.opening_candle.close)}</b></span>
              <span>Closing candle <b>{num(setup.reference.closing_candle.open)} → {num(setup.reference.closing_candle.close)}</b></span>
              <span>Opening range <b>{num(setup.reference.opening_range.low)}–{num(setup.reference.opening_range.high)}</b></span>
              <span>VWAP <b>{num(setup.reference.vwap)}</b></span><span>Daily ATR <b>{num(setup.daily_atr, 0)}</b></span><span>Typical gap <b>{num(prediction.typical_gap_points, 0)} pts</b></span>
            </div>
            {(setup.caveats ?? []).map((line) => <p key={line} className="mi-note">{line}</p>)}
          </details>
        </>
      )}
    </article>
  );
}
