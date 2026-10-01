"use client";

import { useEffect, useMemo, useState } from "react";
import { buildOptionStrategy, type ChainRow, type SentimentInput, type StrategyPlan, type TrendInput } from "../../lib/option-strategy";

type Props = { symbol: string; onSymbolChange: (symbol: string) => void; vix: number | null; trend: TrendInput | null };
type ChainState = { spot: number; expiry: string; contracts: ChainRow[]; lotSize?: number; at: number } | null;

const INDICES = ["NIFTY", "BANKNIFTY", "SENSEX"] as const;
const CHAIN_REFRESH_MS = 60_000;
const SENTIMENT_REFRESH_MS = 10 * 60_000;
const money = (value: number | null | undefined) => (value === null || value === undefined || !Number.isFinite(value) ? "--" : value.toLocaleString("en-IN", { maximumFractionDigits: 2 }));
const signed = (value: number) => `${value > 0 ? "+" : ""}${money(value)}`;
const phaseLabel: Record<string, string> = { EXPIRY_DAY: "Expiry day", NEAR: "Near expiry", MID: "Mid cycle", FAR: "Far from expiry" };
const biasTone = (score: number) => (score >= 15 ? "gain" : score <= -15 ? "loss" : "warning");

function PlanCard({ plan, lotSize, primary }: { plan: StrategyPlan; lotSize: number; primary?: boolean }) {
  return (
    <div className={primary ? "ost-plan ost-plan-primary" : "ost-plan"}>
      <div className="ost-plan-head">
        <div><b>{plan.name}</b><small>{plan.view}</small></div>
        <span className={plan.fit >= 60 ? "gain" : plan.fit >= 45 ? "warning" : "loss"}>fit {plan.fit}/100</span>
      </div>
      <table className="ost-legs">
        <thead><tr><th>Leg</th><th>Strike</th><th>Premium</th><th>Intrinsic</th><th>Time value</th><th>Δ</th></tr></thead>
        <tbody>{plan.legs.map((leg) => (
          <tr key={`${leg.action}${leg.type}${leg.strike}`}><td className={leg.action === "BUY" ? "gain" : "loss"}>{leg.action} {leg.type}</td><td>{money(leg.strike)}</td><td>₹{money(leg.premium)}</td><td>{money(leg.intrinsic)}</td><td>{money(leg.extrinsic)}</td><td>{leg.delta === null ? "--" : leg.delta.toFixed(2)}</td></tr>
        ))}</tbody>
      </table>
      <div className="ost-metrics">
        <span><small>Net {plan.kind === "DEBIT" ? "debit" : "credit"}</small><b>₹{money(Math.abs(plan.netPremium))}</b><em>₹{money(Math.abs(plan.perLot.premium))}/lot</em></span>
        <span><small>Max profit</small><b className="gain">{plan.maxProfit === null ? "Unlimited" : `₹${money(plan.maxProfit)}`}</b><em>{plan.perLot.maxProfit === null ? "open-ended" : `₹${money(plan.perLot.maxProfit)}/lot`}</em></span>
        <span><small>Max loss</small><b className="loss">₹{money(plan.maxLoss)}</b><em>₹{money(plan.perLot.maxLoss)}/lot</em></span>
        <span><small>Breakeven</small><b>{plan.breakevens.length ? plan.breakevens.map(money).join(" / ") : "--"}</b><em>at expiry</em></span>
        <span><small>Prob. of profit</small><b>{plan.probabilityOfProfit === null ? "--" : `${plan.probabilityOfProfit.toFixed(0)}%`}</b><em>IV-implied</em></span>
        <span><small>Net Δ / θ</small><b>{plan.netDelta === null ? "--" : plan.netDelta.toFixed(2)} / {plan.netTheta === null ? "--" : signed(plan.netTheta)}</b><em>time value {plan.netExtrinsic >= 0 ? "paid" : "earned"} ₹{money(Math.abs(plan.netExtrinsic))}</em></span>
      </div>
      {primary ? (
        <div className="ost-why">
          <div><small>Why this structure</small><ul>{plan.rationale.map((line) => <li key={line}>{line}</li>)}</ul></div>
          <div><small>Exit plan</small><ul>{plan.exit.map((line) => <li key={line}>{line}</li>)}</ul></div>
        </div>
      ) : (
        <details className="mi-management"><summary>Why / exit plan</summary><ul className="ost-list">{[...plan.rationale, ...plan.exit].map((line) => <li key={line}>{line}</li>)}</ul></details>
      )}
      <p className="mi-note">Lot size {lotSize}. Analysis only — place each leg from the order ticket after reviewing it.</p>
    </div>
  );
}

export function OptionStrategyPanel({ symbol, onSymbolChange, vix, trend }: Props) {
  const [chain, setChain] = useState<ChainState>(null);
  const [chainError, setChainError] = useState<string | null>(null);
  const [sentiment, setSentiment] = useState<SentimentInput | null>(null);
  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    setChain(null);
    setChainError(null);
    const load = async () => {
      try {
        const response = await fetch(`/api/option-chain?symbol=${symbol}&full=1`, { cache: "no-store" });
        const body = await response.json();
        if (cancelled) return;
        const contracts: ChainRow[] = Array.isArray(body.contracts) ? body.contracts : [];
        if (!response.ok || !contracts.length || !body.expiry) { setChainError(body.error ?? "Option chain unavailable"); return; }
        setChain({ spot: Number(body.spot) || 0, expiry: String(body.expiry), contracts, at: Date.now() });
        setChainError(null);
        setClock(Date.now());
      } catch { if (!cancelled) setChainError("Option chain request failed"); }
    };
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, CHAIN_REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [symbol]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const body = await fetch("/api/sentiment", { cache: "no-store" }).then((response) => response.json());
        if (cancelled || !body?.summary?.india) return;
        const usable = (aggregate: { score: number; label: string } | undefined) => (aggregate && aggregate.label !== "INSUFFICIENT_DATA" ? aggregate.score : null);
        setSentiment({ indiaScore: usable(body.summary.india), globalScore: usable(body.summary.global), eventRisk: Array.isArray(body.event_risk) ? body.event_risk.map((event: { event: string }) => event.event) : [], contrarianNote: body.contrarian_note ?? null });
      } catch { /* sentiment is one input among several; the strategy still runs without it */ }
    };
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, SENTIMENT_REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const result = useMemo(() => (chain ? buildOptionStrategy({ symbol, spot: chain.spot, expiry: chain.expiry, chain: chain.contracts, vix, sentiment, trend, now: new Date(clock) }) : null), [chain, clock, sentiment, symbol, trend, vix]);
  const f = result?.factors;
  const strikes = useMemo(() => [...new Set((result?.rows ?? []).map((row) => row.strike))], [result]);

  return (
    <section className="mi-card ost-panel" aria-label="Options strategy by value, time and sentiment">
      <div className="algo-panel-head">
        <div><span className="algo-kicker">OPTIONS STRATEGY · INTRINSIC · TIME VALUE · EXPIRY · VOLATILITY · SENTIMENT</span><h2>Which structure fits {symbol} right now</h2></div>
        <div className="ost-tabs" role="tablist">{INDICES.map((item) => <button key={item} type="button" role="tab" aria-selected={item === symbol} className={item === symbol ? "active" : ""} onClick={() => onSymbolChange(item)}>{item}</button>)}</div>
      </div>
      {!result && <div className="algo-empty">{chainError ?? `Loading the ${symbol} option chain…`}</div>}
      {result && f && (
        <>
          <div className={result.verdict === "TRADE" ? "ost-verdict ost-verdict-trade" : "ost-verdict"}><b>{result.verdict}</b><span>{result.headline}</span></div>
          <div className="ost-factors">
            <span><small>Spot / ATM</small><b>{money(f.spot)}</b><em>ATM {money(f.atmStrike)} · step {f.strikeStep}</em></span>
            <span><small>Expiry</small><b>{f.expiry}</b><em>{phaseLabel[f.phase]} · {f.phase === "EXPIRY_DAY" ? `${Math.max(0, f.minutesToClose)} min left` : `${money(f.daysToExpiry)} days`}</em></span>
            <span><small>Volatility</small><b className={f.ivRegime === "LOW" ? "gain" : f.ivRegime === "NORMAL" ? "" : "warning"}>{f.ivRegime}</b><em>VIX {money(f.vix)} · ATM IV {money(f.atmIv)}{f.ivRichVsVix ? " · rich" : ""}</em></span>
            <span><small>Expected move</small><b>±{money(f.expectedMove)}</b><em>{money(f.expectedMovePct)}% · {money(f.rangeLow)}–{money(f.rangeHigh)}</em></span>
            <span><small>ATM straddle</small><b>₹{money(f.straddle)}</b><em>time value ₹{money(f.atmExtrinsic)} · θ ≈ ₹{money(f.thetaPerDay)}/day</em></span>
            <span><small>OI positioning</small><b>PCR {money(f.pcr)}</b><em>S {money(f.support)} · R {money(f.resistance)} · max pain {money(f.maxPain)}</em></span>
            <span><small>Market bias</small><b className={biasTone(f.bias.score)}>{signed(f.bias.score)}</b><em>{f.bias.label.replaceAll("_", " ").toLowerCase()}</em></span>
            <span><small>Bias inputs</small><b className="ost-small">news {signed(f.bias.sentiment)} · global {signed(f.bias.global)}</b><em>trend {signed(f.bias.trend)} · PCR {signed(f.bias.pcr)}</em></span>
          </div>
          {result.notes.length > 0 && <ul className="ost-notes">{result.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
          {result.primary && <PlanCard plan={result.primary} lotSize={f.lotSize} primary />}
          {result.alternatives.length > 0 && <div className="ost-alts">{result.alternatives.map((plan) => <PlanCard key={plan.id} plan={plan} lotSize={f.lotSize} />)}</div>}
          <details className="mi-management">
            <summary>Premium decomposition: intrinsic vs time value (±4 strikes)</summary>
            <table className="ost-legs ost-decomp">
              <thead><tr><th>CE premium</th><th>CE intrinsic</th><th>CE time value</th><th>Strike</th><th>PE time value</th><th>PE intrinsic</th><th>PE premium</th></tr></thead>
              <tbody>{strikes.map((strike) => {
                const ce = result.rows.find((row) => row.strike === strike && row.type === "CE");
                const pe = result.rows.find((row) => row.strike === strike && row.type === "PE");
                return (
                  <tr key={strike} className={strike === f.atmStrike ? "ost-atm" : ""}>
                    <td>{ce ? `₹${money(ce.premium)}` : "--"}</td><td>{ce ? money(ce.intrinsic) : "--"}</td><td>{ce ? `${money(ce.extrinsic)} (${ce.extrinsicPct.toFixed(0)}%)` : "--"}</td>
                    <td><b>{money(strike)}</b></td>
                    <td>{pe ? `${money(pe.extrinsic)} (${pe.extrinsicPct.toFixed(0)}%)` : "--"}</td><td>{pe ? money(pe.intrinsic) : "--"}</td><td>{pe ? `₹${money(pe.premium)}` : "--"}</td>
                  </tr>
                );
              })}</tbody>
            </table>
            <p className="mi-note">Intrinsic = what the option is worth if exercised now; time value = premium − intrinsic, the part that decays to zero by expiry. Buyers want low time value; sellers want to collect it.</p>
          </details>
          <p className="mi-note">Refreshed {chain ? new Date(chain.at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }) : "--"} IST · defined-risk structures only, no naked selling · not investment advice.</p>
        </>
      )}
    </section>
  );
}
