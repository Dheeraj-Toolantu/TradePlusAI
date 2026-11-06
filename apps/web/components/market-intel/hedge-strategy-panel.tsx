"use client";

import { memo, useEffect, useMemo, useState } from "react";
import { buildHedgeStrategies, BREAKOUT_MULTIPLE, type HedgePlan } from "../../lib/hedge-strategy";
import type { ChainRow, TrendInput } from "../../lib/option-strategy";
import { fetchJsonShared } from "../../lib/shared-fetch";

type Props = { symbol: string; onSymbolChange: (symbol: string) => void; vix: number | null; trend: TrendInput | null };
type ChainState = { spot: number; expiry: string; contracts: ChainRow[]; at: number } | null;

const INDICES = ["NIFTY", "BANKNIFTY", "SENSEX"] as const;
const BUDGETS = [5_000, 10_000, 15_000, 25_000, 50_000, 0] as const;
const CHAIN_REFRESH_MS = 60_000;
const BUDGET_KEY = "tradepulse.hedge.budget";
const money = (value: number | null | undefined) => (value === null || value === undefined || !Number.isFinite(value) ? "--" : value.toLocaleString("en-IN", { maximumFractionDigits: 2 }));
const signed = (value: number) => `${value >= 0 ? "+" : "−"}₹${money(Math.abs(value))}`;

/** Payoff at expiry across ±2 expected moves: green where it profits, red where it loses. */
function PayoffChart({ plan, spot }: { plan: HedgePlan; spot: number }) {
  const width = 520; const height = 150; const pad = 8;
  const xs = plan.payoff.map((point) => point.price); const ys = plan.payoff.map((point) => point.pnl);
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const minY = Math.min(...ys, 0); const maxY = Math.max(...ys, 0);
  const x = (value: number) => pad + ((value - minX) / (maxX - minX || 1)) * (width - 2 * pad);
  const y = (value: number) => pad + ((maxY - value) / (maxY - minY || 1)) * (height - 2 * pad);
  const line = plan.payoff.map((point, index) => `${index ? "L" : "M"}${x(point.price).toFixed(1)},${y(point.pnl).toFixed(1)}`).join(" ");
  const zero = y(0);
  return (
    <svg className="hedge-payoff" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Payoff at expiry of ${plan.name}`}>
      <defs>
        <clipPath id="hedge-above"><rect x="0" y="0" width={width} height={zero} /></clipPath>
        <clipPath id="hedge-below"><rect x="0" y={zero} width={width} height={height - zero} /></clipPath>
      </defs>
      <path d={`${line} L${x(maxX)},${zero} L${x(minX)},${zero} Z`} fill="rgba(34,213,155,.18)" clipPath="url(#hedge-above)" />
      <path d={`${line} L${x(maxX)},${zero} L${x(minX)},${zero} Z`} fill="rgba(250,107,120,.16)" clipPath="url(#hedge-below)" />
      <line x1={pad} x2={width - pad} y1={zero} y2={zero} stroke="#3b5563" strokeWidth="1" />
      <line x1={x(spot)} x2={x(spot)} y1={pad} y2={height - pad} stroke="#5aa9ff" strokeDasharray="3 3" strokeWidth="1" />
      {plan.breakevens.filter((value) => value > minX && value < maxX).map((value) => <line key={value} x1={x(value)} x2={x(value)} y1={zero - 6} y2={zero + 6} stroke="#ffd27a" strokeWidth="2" />)}
      <path d={line} fill="none" stroke="#e8f1f2" strokeWidth="1.6" />
      <text x={x(spot) + 4} y={pad + 10} fill="#5aa9ff" fontSize="10">spot {money(spot)}</text>
      <text x={pad} y={height - 2} fill="#8a9ba0" fontSize="10">{money(minX)}</text>
      <text x={width - pad} y={height - 2} fill="#8a9ba0" fontSize="10" textAnchor="end">{money(maxX)}</text>
      <text x={width - pad} y={y(maxY) + 22} fill="#22d59b" fontSize="10" textAnchor="end">{signed(maxY)}</text>
      <text x={x(spot) + 4} y={y(minY) - 4} fill="#fa6b78" fontSize="10">max loss {signed(minY)}</text>
    </svg>
  );
}

function Legs({ plan }: { plan: HedgePlan }) {
  return (
    <table className="ost-legs">
      <thead><tr><th>Leg</th><th>Strike</th><th>Lots</th><th>Qty</th><th>Premium</th><th>Cost</th><th>Δ</th></tr></thead>
      <tbody>{plan.legs.map((leg) => (
        <tr key={`${leg.type}${leg.strike}`}><td className="gain">BUY {leg.type}</td><td>{money(leg.strike)}</td><td>{leg.lots}</td><td>{leg.lots * plan.lotSize}</td><td>₹{money(leg.premium)}</td><td>₹{money(leg.premium * leg.lots * plan.lotSize)}</td><td>{leg.delta === null ? "--" : leg.delta.toFixed(2)}</td></tr>
      ))}</tbody>
    </table>
  );
}

function HedgeStrategyPanelView({ symbol, onSymbolChange, vix, trend }: Props) {
  const [chain, setChain] = useState<ChainState>(null);
  const [chainError, setChainError] = useState<string | null>(null);
  const [budget, setBudget] = useState<number>(15_000);
  const [chosen, setChosen] = useState<string | null>(null);

  useEffect(() => { try { const saved = Number(window.localStorage.getItem(BUDGET_KEY)); if (BUDGETS.includes(saved as 0)) setBudget(saved); } catch { /* per-viewer convenience only */ } }, []);
  useEffect(() => { try { window.localStorage.setItem(BUDGET_KEY, String(budget)); } catch { /* per-viewer convenience only */ } }, [budget]);

  useEffect(() => {
    let cancelled = false;
    setChain(null); setChainError(null); setChosen(null);
    const load = async () => {
      try {
        // Shared with the algo page's own chain poll: one request serves both.
        const body = await fetchJsonShared<{ contracts?: ChainRow[]; expiry?: string; spot?: number; error?: string }>(`/api/option-chain?symbol=${symbol}&full=1`, 20_000);
        if (cancelled) return;
        const contracts: ChainRow[] = Array.isArray(body.contracts) ? body.contracts : [];
        // A failed refresh keeps the last chain on screen rather than blanking the panel.
        if (!contracts.length || !body.expiry) { setChainError(body.error ?? "Option chain unavailable"); return; }
        setChain({ spot: Number(body.spot) || 0, expiry: String(body.expiry), contracts, at: Date.now() });
        setChainError(null);
      } catch { if (!cancelled) setChainError("Option chain request failed"); }
    };
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, CHAIN_REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [symbol]);

  const result = useMemo(() => (chain ? buildHedgeStrategies({ symbol, spot: chain.spot, expiry: chain.expiry, chain: chain.contracts, vix, trend, maxRisk: budget || null, now: new Date(chain.at) }) : null), [budget, chain, symbol, trend, vix]);
  const plans = result ? [result.primary, ...result.alternatives].filter((plan): plan is HedgePlan => Boolean(plan)) : [];
  const shown = plans.find((plan) => plan.id === chosen) ?? plans[0] ?? null;
  const f = result?.factors;
  const sideText = result?.side === "UP" ? "bullish: call-heavy hedges" : result?.side === "DOWN" ? "bearish: put-heavy hedges" : "neutral: pays either way";

  return (
    <section className="mi-card ost-panel" aria-label="Hedge builder from option buys">
      <div className="algo-panel-head">
        <div><span className="algo-kicker">HEDGE BUILDER · OPTION BUYS ONLY · DEFINED RISK · REWARD : RISK</span><h2>Lowest-risk, best reward hedge on {symbol}</h2></div>
        <div className="hedge-controls">
          <label>Max risk<select value={budget} onChange={(event) => setBudget(Number(event.target.value))}>{BUDGETS.map((value) => <option key={value} value={value}>{value ? `₹${value.toLocaleString("en-IN")}` : "No cap"}</option>)}</select></label>
          <div className="ost-tabs" role="tablist">{INDICES.map((item) => <button key={item} type="button" role="tab" aria-selected={item === symbol} className={item === symbol ? "active" : ""} onClick={() => onSymbolChange(item)}>{item}</button>)}</div>
        </div>
      </div>
      {!result && <div className="algo-empty">{chainError ?? `Loading the ${symbol} option chain…`}</div>}
      {result && f && (
        <>
          <div className="ost-factors">
            <span><small>Spot / ATM</small><b>{money(f.spot)}</b><em>ATM {money(f.atmStrike)} · lot {f.lotSize}</em></span>
            <span><small>Expiry</small><b>{f.expiry}</b><em>{money(f.daysToExpiry)} days</em></span>
            <span><small>Expected move</small><b>±{money(f.expectedMove)}</b><em>breakout ±{money(f.expectedMove * BREAKOUT_MULTIPLE)} (1.5×)</em></span>
            <span><small>Volatility</small><b className={f.ivRegime === "LOW" ? "gain" : f.ivRegime === "NORMAL" ? "" : "warning"}>{f.ivRegime}</b><em>VIX {money(f.vix)} · ATM IV {money(f.atmIv)}</em></span>
            <span><small>Bias</small><b className={result.side === "UP" ? "gain" : result.side === "DOWN" ? "loss" : "warning"}>{f.bias.label.replaceAll("_", " ")}</b><em>{sideText}</em></span>
            <span><small>Combinations</small><b>{result.considered}</b><em>{result.withinBudget} within {budget ? `₹${budget.toLocaleString("en-IN")}` : "no cap"}</em></span>
          </div>
          {result.notes.length > 0 && <ul className="ost-notes">{result.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
          {shown ? (
            <div className="ost-plan ost-plan-primary">
              <div className="ost-plan-head">
                <div><b>{shown.name}{shown === plans[0] ? " · best fit" : ""}</b><small>{shown.view}</small></div>
                <span className={shown.riskReward >= 1 ? "gain" : shown.riskReward > 0 ? "warning" : "loss"}>{shown.riskReward}R · {shown.rewardToStop}R to stop</span>
              </div>
              <Legs plan={shown} />
              <div className="ost-metrics">
                <span><small>Max loss (premium)</small><b className="loss">₹{money(shown.maxLoss)}</b><em>known before entry</em></span>
                <span><small>Planned stop</small><b className="loss">−₹{money(shown.debit - shown.stop)}</b><em>exit at 60% of premium</em></span>
                <span><small>Reward on breakout</small><b className="gain">↑ {signed(shown.rewardUp)}</b><em>↓ {signed(shown.rewardDown)} · ±{money(shown.breakoutPoints)} pts</em></span>
                {result.side === "BOTH"
                  ? <span><small>Hedge</small><b>Both sides</b><em>either breakout pays; worst side {signed(Math.min(shown.rewardUp, shown.rewardDown))}</em></span>
                  : <span><small>Hedge cover</small><b>{Math.round(shown.hedgeCover * 100)}%</b><em>premium kept on a wrong-way breakout</em></span>}
                <span><small>Breakevens</small><b>{shown.breakevens.length ? shown.breakevens.map(money).join(" / ") : "--"}</b><em>at expiry · {shown.probabilityOfProfit}% prob.</em></span>
                <span><small>Net Δ / θ a day</small><b>{shown.netDelta === null ? "--" : shown.netDelta.toFixed(2)} / {shown.thetaPerDay === null ? "--" : signed(shown.thetaPerDay)}</b><em>no breakout: {signed(shown.atExpectedUp)} / {signed(shown.atExpectedDown)}</em></span>
              </div>
              <PayoffChart plan={shown} spot={f.spot} />
              <div className="ost-why">
                <div><small>Why this hedge</small><ul>{shown.rationale.map((line) => <li key={line}>{line}</li>)}</ul></div>
                <div><small>Exit plan</small><ul>{shown.exit.map((line) => <li key={line}>{line}</li>)}</ul></div>
              </div>
            </div>
          ) : <div className="algo-empty">No liquid CE / PE pair to build a hedge from.</div>}
          {plans.length > 1 && (
            <table className="ost-legs hedge-ranking">
              <thead><tr><th>#</th><th>Combination</th><th>Legs</th><th>Max loss</th><th>Breakout reward</th><th>R:R</th><th>R:R to stop</th><th>Hedge</th><th>Prob.</th></tr></thead>
              <tbody>{plans.map((plan, index) => (
                <tr key={plan.id} className={plan === shown ? "ost-atm" : ""} onClick={() => setChosen(plan.id)} style={{ cursor: "pointer" }} title="Show this combination">
                  <td>{index + 1}</td><td><b>{plan.name}</b></td><td>{plan.legs.map((leg) => `${leg.lots}× ${leg.strike} ${leg.type}`).join(" + ")}</td>
                  <td className="loss">₹{money(plan.debit)}</td><td className="gain">{signed(plan.reward)}</td><td>{plan.riskReward}R</td><td>{plan.rewardToStop}R</td><td>{result.side === "BOTH" ? "both ways" : `${Math.round(plan.hedgeCover * 100)}%`}</td><td>{plan.probabilityOfProfit}%</td>
                </tr>
              ))}</tbody>
            </table>
          )}
          <p className="mi-note">Refreshed {chain ? new Date(chain.at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }) : "--"} IST{chainError ? ` · last refresh failed (${chainError}); showing the previous chain` : ""} · option buys only, so the most any combination can lose is its premium · judged at expiry on LTP before charges and slippage · analysis only, not investment advice.</p>
        </>
      )}
    </section>
  );
}

/** Memoised: the algo page re-renders on every quote flush; this panel only when its own props change. */
export const HedgeStrategyPanel = memo(HedgeStrategyPanelView);
