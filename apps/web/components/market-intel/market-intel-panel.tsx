"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { OperatorFootprintPanel, type OperatorFootprint } from "./operator-footprint-panel";

type Signal = "BULLISH" | "BEARISH" | "NEUTRAL";
type Factor = { key: string; name: string; signal: Signal; points: number; max: number; detail: string; learn: string };
type CheckItem = { key: string; label: string; passed: boolean; detail: string };
type Contract = { strike: number; side: "CE" | "PE"; premium: number; delta: number | null; iv: number | null; oi: number; volume: number; trading_symbol: string; liquidity_score: number; moneyness: string };
type StrikeRow = {
  strike: number; is_atm: boolean;
  ce_oi: number | null; ce_oi_change: number | null; ce_ltp: number | null; ce_ltp_change: number | null; ce_activity: string | null; ce_activity_text?: string;
  pe_oi: number | null; pe_oi_change: number | null; pe_ltp: number | null; pe_ltp_change: number | null; pe_activity: string | null; pe_activity_text?: string;
};
type Zone = { direction: "BULLISH" | "BEARISH"; top: number; bottom: number; mid?: number; time: string; partially_filled?: boolean; tested?: boolean };
export type TradePlan = {
  status: "READY" | "WAIT" | "NO_TRADE" | "MARKET_CLOSED";
  headline: string;
  direction: "CE" | "PE" | null;
  contract?: Contract | null;
  entry?: { type: string; source: string; zone_low: number | null; zone_high: number | null; entry: number; instruction: string };
  spot?: { entry: number; stop: number; target1: number; target2: number; target2_label: string; risk_points: number };
  premium?: { entry: number; stop: number; target1: number; target2: number; stop_basis: string; risk_per_lot?: number; risk_budget?: number; capital_needed?: number } | null;
  risk_reward?: number;
  lots?: number | null;
  quantity?: number | null;
  capital_at_risk?: number | null;
  invalidation?: string;
  checklist: CheckItem[];
  reasons_for?: string[];
  reasons_against?: string[];
  watch?: { bullish_above: number | null; bearish_below: number | null };
  management: string[];
  notes?: string[];
};
type Intel = {
  symbol: string; available: boolean; error?: string; reason?: string; spot: number; expiry: string | null; expiry_today: boolean; lot_size: number | null; generated_at: string; fetched_at?: string; baseline_history_seconds?: number;
  session: { window: string; market_open: boolean; entry_permitted: boolean };
  technicals: { vwap: number | null; vwap_is_volume_weighted: boolean; ema20: number | null; ema50: number | null; atr14: number | null; rsi14: number | null; previous_high: number | null; previous_low: number | null; session_high: number | null; session_low: number | null };
  volatility: { available: boolean; value?: number; change_pct?: number | null; trend?: string; regime: string | null; basis?: string; expected_daily_move?: number; expected_range?: { low: number; high: number }; guidance?: string; reason?: string };
  options_flow: {
    available: boolean; reason?: string; atm_strike: number; pcr_oi: number | null; pcr_volume: number | null; pcr_near_atm: number | null; pcr_change_5m: number | null; total_ce_oi: number; total_pe_oi: number;
    ce_oi_change_5m: number | null; pe_oi_change_5m: number | null; max_pain: number | null; resistance: Array<{ strike: number; oi: number }>; support: Array<{ strike: number; oi: number }>;
    oi_direction_score: number | null; oi_direction_label: string; baseline_minutes: number | null; call_writing: Array<{ strike: number; oi_change: number }>; put_writing: Array<{ strike: number; oi_change: number }>;
    ors_call: number | null; ors_put: number | null; strikes: StrikeRow[];
  };
  smart_money: {
    available: boolean; reason?: string; trend: string; swing_sequence: string; last_event: { type: string; direction: string; level: number; time: string } | null;
    fair_value_gaps: Zone[]; order_blocks: Zone[]; sweeps: Array<{ side: string; bias: string; label: string; level: number; time: string }>;
    liquidity: { previous_day_high: number | null; previous_day_low: number | null; session_high: number | null; session_low: number | null; equal_highs: Array<{ level: number }>; equal_lows: Array<{ level: number }> };
    dealing_range: { high: number; low: number; equilibrium: number; position_pct: number; zone: string; basis: string } | null;
  };
  operator?: OperatorFootprint;
  verdict: { bias: "BULLISH" | "BEARISH" | "SIDEWAYS"; score: number; max_score: number; strength: number; factors: Factor[]; agreeing_factors: number; total_factors: number };
  trade_plan: TradePlan;
};

const SYMBOLS = ["NIFTY", "BANKNIFTY", "SENSEX"] as const;
const POLL_MS = 30_000;
const fmt = (value: number | null | undefined, digits = 2) => (value === null || value === undefined || !Number.isFinite(value) ? "--" : value.toLocaleString("en-IN", { maximumFractionDigits: digits, minimumFractionDigits: 0 }));
const signed = (value: number | null | undefined, digits = 0) => (value === null || value === undefined || !Number.isFinite(value) ? "--" : `${value > 0 ? "+" : ""}${fmt(value, digits)}`);
const compact = (value: number | null | undefined) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)} K`;
  return `${sign}${abs.toFixed(0)}`;
};
const tone = (signal: string | null | undefined) => (signal === "BULLISH" ? "gain" : signal === "BEARISH" ? "loss" : "warning");
const activityTone = (side: "ce" | "pe", activity: string | null) => {
  if (!activity || activity === "NEUTRAL") return "";
  const bullish = side === "pe" ? ["SHORT_BUILDUP", "LONG_UNWINDING"] : ["SHORT_COVERING", "LONG_BUILDUP"];
  return bullish.includes(activity) ? "gain" : "loss";
};
const readNumber = (key: string, fallback: number) => {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch { return fallback; }
};
const writeNumber = (key: string, value: number) => {
  try { window.localStorage.setItem(key, String(value)); } catch { /* storage blocked: keep in-memory value */ }
};

function Learn({ children }: { children: string }) {
  return <details className="mi-learn"><summary>What is this?</summary><p>{children}</p></details>;
}

export function MarketIntelPanel({ symbol, onSymbolChange, onUsePlan }: { symbol: string; onSymbolChange: (symbol: string) => void; onUsePlan?: (plan: TradePlan, intel: { symbol: string; expiry: string | null; lotSize: number | null }) => void }) {
  const [intel, setIntel] = useState<Intel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [capital, setCapital] = useState(100_000);
  const [riskPct, setRiskPct] = useState(0.5);
  const inflight = useRef(false);
  const supported = (SYMBOLS as readonly string[]).includes(symbol);

  useEffect(() => {
    setCapital(readNumber("tp.intel.capital", 100_000));
    setRiskPct(readNumber("tp.intel.riskPct", 0.5));
  }, []);

  const load = useCallback(async () => {
    if (!supported || inflight.current) return;
    inflight.current = true;
    setLoading(true);
    try {
      const response = await fetch(`/api/market-intel?symbol=${symbol}&capital=${capital}&riskPct=${riskPct}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.available === false) {
        setError(data.error ?? data.reason ?? "Market intelligence unavailable");
      } else {
        setIntel(data as Intel);
        setError(null);
      }
    } catch {
      setError("Market intelligence request failed");
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, [capital, riskPct, supported, symbol]);

  useEffect(() => {
    setIntel(null);
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const verdict = intel?.verdict;
  const plan = intel?.trade_plan;
  const flow = intel?.options_flow;
  const smc = intel?.smart_money;
  const vol = intel?.volatility;
  const tech = intel?.technicals;
  const gaugePosition = verdict ? ((verdict.score + 10) / 20) * 100 : 50;
  const maxOiChange = Math.max(1, ...(flow?.strikes ?? []).flatMap((row) => [Math.abs(row.ce_oi_change ?? 0), Math.abs(row.pe_oi_change ?? 0)]));
  const maxOi = Math.max(1, ...(flow?.strikes ?? []).flatMap((row) => [row.ce_oi ?? 0, row.pe_oi ?? 0]));
  const baselineWait = flow?.available && flow.baseline_minutes === null ? Math.max(0, 4 - Math.floor((intel?.baseline_history_seconds ?? 0) / 60)) : null;

  return (
    <section className="mi-desk" aria-label="Beginner trade desk">
      <header className="mi-header">
        <div>
          <span className="algo-kicker">BEGINNER TRADE DESK · INDEX OPTIONS</span>
          <h2>What is the market doing, and is there a trade?</h2>
          <p>Trend, option writers, India VIX and smart-money price structure combined into one plain-English plan. Refreshes every 30 seconds.</p>
        </div>
        <div className="mi-header-controls">
          <div className="mi-symbols" role="tablist" aria-label="Index">
            {SYMBOLS.map((item) => <button type="button" role="tab" aria-selected={symbol === item} className={symbol === item ? "active" : ""} key={item} onClick={() => onSymbolChange(item)}>{item}</button>)}
          </div>
          <label>Capital ₹<input type="number" min={10000} step={10000} value={capital} onChange={(event) => { const value = Math.max(10_000, Number(event.target.value) || 10_000); setCapital(value); writeNumber("tp.intel.capital", value); }} /></label>
          <label>Risk / trade<select value={riskPct} onChange={(event) => { const value = Number(event.target.value); setRiskPct(value); writeNumber("tp.intel.riskPct", value); }}>{[0.25, 0.5, 0.75, 1].map((value) => <option key={value} value={value}>{value}%</option>)}</select></label>
          <button type="button" onClick={() => void load()} disabled={loading}>{loading ? "Updating..." : "Refresh"}</button>
        </div>
      </header>

      {!supported && <div className="algo-empty">Market intelligence covers NIFTY, BANKNIFTY and SENSEX. Pick one above.</div>}
      {supported && error && !intel && <div className="algo-empty">{error}. The desk retries automatically; no trade plan is shown without live data.</div>}
      {supported && !error && !intel && <div className="algo-empty">Loading option chain, candles and India VIX...</div>}

      {intel && verdict && plan && (
        <>
          <div className={`mi-verdict mi-${verdict.bias.toLowerCase()}`}>
            <div className="mi-verdict-main">
              <small>{intel.symbol} market bias</small>
              <b className={tone(verdict.bias)}>{verdict.bias}</b>
              <span>Strength {verdict.strength}% · score {signed(verdict.score, 1)} / {verdict.max_score} · {verdict.agreeing_factors} of {verdict.total_factors} signals agree</span>
            </div>
            <div className="mi-gauge" aria-label={`Confluence score ${verdict.score} from -10 bearish to +10 bullish`}>
              <div className="mi-gauge-track"><i style={{ left: `${Math.min(100, Math.max(0, gaugePosition))}%` }} /></div>
              <div className="mi-gauge-labels"><span>Strong bearish</span><span>Sideways</span><span>Strong bullish</span></div>
            </div>
            <div className="mi-verdict-meta">
              <span>Spot <b>{fmt(intel.spot)}</b></span>
              <span>Session <b className={intel.session.entry_permitted ? "gain" : "warning"}>{intel.session.window.replaceAll("_", " ")}</b></span>
              <span>Expiry <b className={intel.expiry_today ? "warning" : ""}>{intel.expiry ?? "--"}{intel.expiry_today ? " (today)" : ""}</b></span>
              <span>Updated <b>{new Date(intel.fetched_at ?? intel.generated_at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false })}</b></span>
            </div>
            {error && <small className="warning">Last refresh failed ({error}); showing the previous reading.</small>}
          </div>

          <div className="mi-grid">
            <article className={`mi-card mi-plan mi-plan-${plan.status.toLowerCase()}`}>
              <div className="algo-panel-head"><div><span className="algo-kicker">TRADE SETUP</span><h2>{plan.headline}</h2></div><span className={`mi-status mi-status-${plan.status.toLowerCase()}`}>{plan.status.replace("_", " ")}</span></div>
              {plan.direction && plan.spot ? (
                <>
                  <div className="mi-action">
                    <b className={plan.direction === "CE" ? "gain" : "loss"}>BUY {plan.contract ? `${intel.symbol} ${fmt(plan.contract.strike, 0)} ${plan.direction}` : `${plan.direction} (no liquid strike)`}</b>
                    {plan.contract && <small>{plan.contract.trading_symbol} · {plan.contract.moneyness} · delta {fmt(plan.contract.delta, 2)} · IV {fmt(plan.contract.iv, 1)}% · liquidity {plan.contract.liquidity_score}/3</small>}
                  </div>
                  {plan.entry && <p className="mi-instruction"><b>How to enter:</b> {plan.entry.instruction}</p>}
                  <div className="mi-table-wrap"><table className="mi-levels">
                    <thead><tr><th /><th>Entry</th><th>Stop-loss</th><th>Target 1</th><th>Target 2</th></tr></thead>
                    <tbody>
                      <tr><th>{intel.symbol} spot</th><td>{fmt(plan.spot.entry)}</td><td className="loss">{fmt(plan.spot.stop)}</td><td className="gain">{fmt(plan.spot.target1)}</td><td className="gain" title={plan.spot.target2_label}>{fmt(plan.spot.target2)}</td></tr>
                      {plan.premium && <tr><th>Option premium</th><td>₹{fmt(plan.premium.entry)}</td><td className="loss">₹{fmt(plan.premium.stop)}</td><td className="gain">₹{fmt(plan.premium.target1)}</td><td className="gain">₹{fmt(plan.premium.target2)}</td></tr>}
                    </tbody>
                  </table></div>
                  <div className="mi-risk-row">
                    <span>Reward : risk <b className={(plan.risk_reward ?? 0) >= 2 ? "gain" : "warning"}>{fmt(plan.risk_reward, 2)} : 1</b></span>
                    <span>Lots <b>{plan.lots === null || plan.lots === undefined ? "--" : plan.lots}</b>{plan.quantity ? <small> ({plan.quantity} qty)</small> : null}</span>
                    <span>Max loss <b className="loss">₹{fmt(plan.capital_at_risk, 0)}</b></span>
                    <span>Premium needed <b>₹{fmt(plan.premium?.capital_needed, 0)}</b></span>
                  </div>
                  {plan.lots === 0 && <p className="warning mi-note">One lot risks ₹{fmt(plan.premium?.risk_per_lot, 0)}, above your ₹{fmt(plan.premium?.risk_budget, 0)} budget ({riskPct}% of capital). Skip it or paper-trade it.</p>}
                  <p className="mi-note">{plan.invalidation} Target 2 = {plan.spot.target2_label}. Stop basis: {plan.premium?.stop_basis ?? "structural"}.</p>
                  {onUsePlan && plan.contract && <button type="button" className="mi-use-plan" onClick={() => onUsePlan(plan, { symbol: intel.symbol, expiry: intel.expiry, lotSize: intel.lot_size })}>{plan.status === "READY" ? "Load this plan into the paper order form" : "Load plan (paper) for practice"}</button>}
                </>
              ) : (
                <div className="mi-watch">
                  <p>{plan.reasons_against?.[0] ?? "Waiting for the market to pick a direction."}</p>
                  <span>Turns bullish above <b className="gain">{fmt(plan.watch?.bullish_above)}</b></span>
                  <span>Turns bearish below <b className="loss">{fmt(plan.watch?.bearish_below)}</b></span>
                </div>
              )}
              {plan.checklist.length > 0 && (
                <ul className="mi-checklist" aria-label="Pre-trade checklist">
                  {plan.checklist.map((item) => <li key={item.key} className={item.passed ? "pass" : "fail"}><i aria-hidden="true">{item.passed ? "✓" : "✗"}</i><span>{item.label}<small>{item.detail}</small></span></li>)}
                </ul>
              )}
              <details className="mi-management"><summary>How to manage the trade once you are in</summary><ol>{plan.management.map((step) => <li key={step}>{step}</li>)}</ol>{plan.notes?.map((note) => <small key={note}>{note}</small>)}</details>
            </article>

            <article className="mi-card">
              <div className="algo-panel-head"><div><span className="algo-kicker">MARKET PULSE</span><h2>VIX, PCR and option walls</h2></div></div>
              <div className="mi-tiles">
                <div><small>India VIX</small><b className={vol?.regime === "EXTREME" || vol?.regime === "HIGH" ? "loss" : vol?.regime === "LOW" ? "warning" : "gain"}>{fmt(vol?.value)}</b><em>{vol?.regime ?? "--"} · {vol?.change_pct !== null && vol?.change_pct !== undefined ? `${signed(vol.change_pct, 2)}%` : "--"}</em></div>
                <div><small>Expected move today</small><b>±{fmt(vol?.expected_daily_move, 0)}</b><em>{fmt(vol?.expected_range?.low, 0)} – {fmt(vol?.expected_range?.high, 0)}</em></div>
                <div><small>PCR (OI)</small><b className={(flow?.pcr_oi ?? 1) >= 1 ? "gain" : (flow?.pcr_oi ?? 1) <= 0.8 ? "loss" : "warning"}>{fmt(flow?.pcr_oi, 2)}</b><em>5m change {signed(flow?.pcr_change_5m, 3)}</em></div>
                <div><small>PCR (volume)</small><b>{fmt(flow?.pcr_volume, 2)}</b><em>Near ATM {fmt(flow?.pcr_near_atm, 2)}</em></div>
                <div><small>Support (put wall)</small><b className="gain">{fmt(flow?.support?.[0]?.strike, 0)}</b><em>OI {compact(flow?.support?.[0]?.oi)}{flow?.support?.[1] ? ` · next ${fmt(flow.support[1].strike, 0)}` : ""}</em></div>
                <div><small>Resistance (call wall)</small><b className="loss">{fmt(flow?.resistance?.[0]?.strike, 0)}</b><em>OI {compact(flow?.resistance?.[0]?.oi)}{flow?.resistance?.[1] ? ` · next ${fmt(flow.resistance[1].strike, 0)}` : ""}</em></div>
                <div><small>Max pain</small><b>{fmt(flow?.max_pain, 0)}</b><em>Expiry magnet</em></div>
                <div><small>VWAP / ATR</small><b>{fmt(tech?.vwap, 1)}</b><em>ATR {fmt(tech?.atr14, 1)}{tech && !tech.vwap_is_volume_weighted ? " · TWAP" : ""}</em></div>
              </div>
              {vol?.guidance && <p className="mi-note">{vol.guidance} <small>({vol.basis})</small></p>}
              <Learn>PCR above 1 means more puts than calls are open: put writers are defending lower levels (bullish). The strike with the most put OI is the market's support; the most call OI is resistance. India VIX is the market's expected annual volatility; divide by √252 to get the expected one-day move shown here.</Learn>
            </article>
          </div>

          <article className="mi-card mi-flow">
            <div className="algo-panel-head">
              <div><span className="algo-kicker">OPTION WRITERS · 5-MINUTE OI CHANGE</span><h2 className={flow?.oi_direction_score ? (flow.oi_direction_score > 0 ? "gain" : "loss") : ""}>{flow?.oi_direction_label ?? "Option chain unavailable"}</h2></div>
              <span>{flow?.baseline_minutes ? `vs ${flow.baseline_minutes} min ago` : baselineWait !== null ? `baseline ready in ~${baselineWait} min` : ""}</span>
            </div>
            {flow?.available ? (
              <>
                <div className="mi-writers">
                  <span>Call writers adding at <b className="loss">{flow.call_writing.length ? flow.call_writing.map((item) => `${fmt(item.strike, 0)} (+${compact(item.oi_change)})`).join(", ") : "none"}</b></span>
                  <span>Put writers adding at <b className="gain">{flow.put_writing.length ? flow.put_writing.map((item) => `${fmt(item.strike, 0)} (+${compact(item.oi_change)})`).join(", ") : "none"}</b></span>
                  <span>Net 5m OI: CE <b>{signed(flow.ce_oi_change_5m === null ? null : flow.ce_oi_change_5m, 0)}</b> · PE <b>{signed(flow.pe_oi_change_5m === null ? null : flow.pe_oi_change_5m, 0)}</b></span>
                </div>
                <div className="mi-table-wrap">
                  <table className="mi-oi-table">
                    <thead><tr><th>CE activity</th><th>CE ΔOI 5m</th><th>CE OI</th><th>CE LTP</th><th>Strike</th><th>PE LTP</th><th>PE OI</th><th>PE ΔOI 5m</th><th>PE activity</th></tr></thead>
                    <tbody>
                      {flow.strikes.map((row) => (
                        <tr key={row.strike} className={row.is_atm ? "mi-atm" : ""}>
                          <td className={activityTone("ce", row.ce_activity)}>{row.ce_activity_text ?? "--"}</td>
                          <td className={(row.ce_oi_change ?? 0) > 0 ? "loss" : (row.ce_oi_change ?? 0) < 0 ? "gain" : ""}><span className="mi-bar mi-bar-ce" style={{ width: `${Math.abs(row.ce_oi_change ?? 0) / maxOiChange * 100}%` }} />{row.ce_oi_change === null ? "--" : signed(row.ce_oi_change)}</td>
                          <td><span className="mi-bar mi-bar-oi" style={{ width: `${(row.ce_oi ?? 0) / maxOi * 100}%` }} />{compact(row.ce_oi)}</td>
                          <td>{fmt(row.ce_ltp)}<small className={(row.ce_ltp_change ?? 0) >= 0 ? "gain" : "loss"}>{row.ce_ltp_change === null ? "" : ` ${signed(row.ce_ltp_change, 2)}`}</small></td>
                          <th>{fmt(row.strike, 0)}{row.is_atm ? <small> ATM</small> : null}</th>
                          <td>{fmt(row.pe_ltp)}<small className={(row.pe_ltp_change ?? 0) >= 0 ? "gain" : "loss"}>{row.pe_ltp_change === null ? "" : ` ${signed(row.pe_ltp_change, 2)}`}</small></td>
                          <td><span className="mi-bar mi-bar-oi" style={{ width: `${(row.pe_oi ?? 0) / maxOi * 100}%` }} />{compact(row.pe_oi)}</td>
                          <td className={(row.pe_oi_change ?? 0) > 0 ? "gain" : (row.pe_oi_change ?? 0) < 0 ? "loss" : ""}><span className="mi-bar mi-bar-pe" style={{ width: `${Math.abs(row.pe_oi_change ?? 0) / maxOiChange * 100}%` }} />{row.pe_oi_change === null ? "--" : signed(row.pe_oi_change)}</td>
                          <td className={activityTone("pe", row.pe_activity)}>{row.pe_activity_text ?? "--"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Learn>Writers (option sellers) are usually big institutions. OI up + premium down = fresh writing. Call writing at a strike means they bet price stays below it (resistance); put writing means they bet price stays above it (support). OI down + premium up = short covering: writers are running, so the level is likely to break. The 5-minute change is measured against a snapshot this server took about 5 minutes ago, so keep this page open for a few minutes after the open.</Learn>
              </>
            ) : <div className="algo-empty">{flow?.reason ?? "Option chain unavailable"}</div>}
          </article>

          <div className="mi-grid">
            <article className="mi-card">
              <div className="algo-panel-head"><div><span className="algo-kicker">SMART MONEY CONCEPTS · 5M</span><h2 className={tone(smc?.trend)}>Structure: {smc?.trend ?? "--"}{smc?.swing_sequence && smc.swing_sequence !== "INSUFFICIENT" ? ` (${smc.swing_sequence.replace("_", " / ")})` : ""}</h2></div></div>
              {smc?.available ? (
                <div className="mi-smc">
                  <p>Last event: {smc.last_event ? <b className={tone(smc.last_event.direction)}>{smc.last_event.type} {smc.last_event.direction.toLowerCase()} at {fmt(smc.last_event.level)} ({new Date(smc.last_event.time).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false })})</b> : "no break of structure yet"}</p>
                  {smc.dealing_range && (
                    <div className="mi-range">
                      <small>{smc.dealing_range.basis}: {fmt(smc.dealing_range.low)} – {fmt(smc.dealing_range.high)} · price is in <b className={smc.dealing_range.zone === "DISCOUNT" ? "gain" : smc.dealing_range.zone === "PREMIUM" ? "loss" : "warning"}>{smc.dealing_range.zone}</b></small>
                      <div className="mi-range-bar"><span className="mi-range-discount" /><span className="mi-range-premium" /><i style={{ left: `${Math.min(100, Math.max(0, smc.dealing_range.position_pct))}%` }} /></div>
                    </div>
                  )}
                  <div className="mi-zones">
                    <div><b>Fair value gaps (unfilled)</b>{smc.fair_value_gaps.length ? smc.fair_value_gaps.slice(0, 4).map((gap) => <span key={`${gap.time}-${gap.bottom}`} className={tone(gap.direction)}>{gap.direction === "BULLISH" ? "▲" : "▼"} {fmt(gap.bottom)} – {fmt(gap.top)}{gap.partially_filled ? " (partly filled)" : ""}</span>) : <span>None nearby</span>}</div>
                    <div><b>Order blocks (active)</b>{smc.order_blocks.length ? smc.order_blocks.slice(0, 4).map((block) => <span key={`${block.time}-${block.bottom}`} className={tone(block.direction)}>{block.direction === "BULLISH" ? "▲" : "▼"} {fmt(block.bottom)} – {fmt(block.top)}{block.tested ? " (tested)" : ""}</span>) : <span>None active</span>}</div>
                    <div><b>Liquidity pools</b>
                      <span>PDH {fmt(smc.liquidity.previous_day_high)} · PDL {fmt(smc.liquidity.previous_day_low)}</span>
                      <span>Today H {fmt(smc.liquidity.session_high)} · L {fmt(smc.liquidity.session_low)}</span>
                      {smc.liquidity.equal_highs.map((level, index) => <span key={`eqh-${index}-${level.level}`} className="loss">Equal highs {fmt(level.level)} (buy stops)</span>)}
                      {smc.liquidity.equal_lows.map((level, index) => <span key={`eql-${index}-${level.level}`} className="gain">Equal lows {fmt(level.level)} (sell stops)</span>)}
                    </div>
                    <div><b>Recent sweeps</b>{smc.sweeps.length ? smc.sweeps.map((sweep) => <span key={`${sweep.time}-${sweep.side}`} className={tone(sweep.bias)}>{sweep.side === "SELL_SIDE" ? "Lows swept → bullish" : "Highs swept → bearish"} at {fmt(sweep.level)} ({sweep.label})</span>) : <span>No stop-hunt in the last 30 min</span>}</div>
                  </div>
                  <Learn>Smart money leaves footprints. A Fair Value Gap is a fast move that skipped prices; price often returns to fill it, making it a good pullback entry. An Order Block is the last opposite candle before a big move: institutions' entry zone. Liquidity pools are obvious highs/lows where retail stop-losses sit; a sweep takes those stops and reverses. Buy in the discount (lower) half of the range and sell in the premium (upper) half.</Learn>
                </div>
              ) : <div className="algo-empty">{smc?.reason ?? "Not enough candles yet"}</div>}
            </article>

            <article className="mi-card">
              <div className="algo-panel-head"><div><span className="algo-kicker">WHY THIS VERDICT</span><h2>Signal-by-signal breakdown</h2></div><span>score {signed(verdict.score, 1)}</span></div>
              <ul className="mi-factors">
                {verdict.factors.map((factor) => (
                  <li key={factor.key}>
                    <div><b>{factor.name}</b><span className={tone(factor.signal)}>{signed(factor.points, 1)} / {factor.max}</span></div>
                    <div className="mi-factor-bar"><i className={factor.points >= 0 ? "pos" : "neg"} style={{ width: `${Math.abs(factor.points) / factor.max * 50}%` }} /></div>
                    <small>{factor.detail}</small>
                    <Learn>{factor.learn}</Learn>
                  </li>
                ))}
              </ul>
              {plan.reasons_against?.length ? <div className="mi-against"><b>Against this trade</b>{plan.reasons_against.slice(0, 5).map((reason) => <small key={reason}>{reason}</small>)}</div> : null}
            </article>
          </div>
          <OperatorFootprintPanel data={intel.operator} />
          <p className="mi-disclaimer">Educational analytics, not investment advice. The desk is not a SEBI-registered adviser. Most retail option buyers lose money; practise in paper mode and never risk more than you can afford to lose.</p>
        </>
      )}
    </section>
  );
}
