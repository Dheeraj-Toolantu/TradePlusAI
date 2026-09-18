"use client";

import { useEffect, useState } from "react";

type PaperStatus = {
  mode: string;
  account: { balance: number; realizedPnl: number; orders: number };
  positions: Array<{ symbol: string; side: string; quantity: number; entry: number; stop: number; target: number }>;
  events: Array<{ type: string; symbol: string; message: string; price: number; timestamp: string }>;
  updatedAt: string;
  marketData?: { source: string; delayed: boolean };
};
type IndexQuote = { symbol: string; price: number; change: number; percent: number };
type OptionCandidate = { id: string; symbol: string; contract: "CALL" | "PUT"; expiry: string; strike: number; premium: number; bid: number; ask: number; spread: number; openInterest: number; oiChange: number; volume: number; iv: number; delta: number; theta: number; lotSize: number; score: number; entry: number; stop: number; target: number; riskReward: number; quantity: number; support: number; resistance: number; confirmation: string; reason: string };
type PaperOptionTrade = OptionCandidate & { quantity: number; enteredAt: string; exit?: number; exitedAt?: string };
type Provider = "groww" | "yahoo" | "fallback";

const money = (value: number) => `Rs ${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const time = (value?: string) => value ? new Date(value).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "--";
const optionMoney = (value: number) => `Rs ${value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function ValidationPage() {
  const [status, setStatus] = useState<PaperStatus | null>(null);
  const [quotes, setQuotes] = useState<IndexQuote[]>([]);
  const [engineCandidates, setEngineCandidates] = useState<OptionCandidate[]>([]);
  const [optionTrades, setOptionTrades] = useState<PaperOptionTrade[]>([]);
  const [notice, setNotice] = useState("Preparing your paper session...");
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<Provider>("groww");

  async function tick() {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/paper-trading?provider=${provider}`, { method: "POST", cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Market data is temporarily unavailable");
      setStatus(data);
      const quoteResponse = await fetch(`/api/market-data?provider=${provider}&symbols=NIFTY,BANKNIFTY,SENSEX`, { cache: "no-store" });
      const quoteData = await quoteResponse.json();
      if (Array.isArray(quoteData.quotes)) setQuotes(quoteData.quotes);
      const engineResponse = await fetch(`/api/options-engine?provider=${provider}&symbols=NIFTY,BANKNIFTY,SENSEX`, { cache: "no-store" });
      const engineData = await engineResponse.json();
      setEngineCandidates(Array.isArray(engineData.candidates) ? engineData.candidates : []);
      setOptionTrades((trades) => trades.map((trade) => { const current = (engineData.candidates ?? []).find((candidate: OptionCandidate) => candidate.id === trade.id); return current ? { ...trade, premium: current.premium, bid: current.bid, ask: current.ask } : trade; }));
      setNotice(data.marketData?.delayed ? "Paper session updated with delayed market data." : "Paper session updated with Groww market data.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Paper session unavailable"); }
    finally { setBusy(false); }
  }

  function enterTrade(candidate: OptionCandidate) {
    if (optionTrades.some((trade) => trade.id === candidate.id && !trade.exit)) {
      setNotice(`${candidate.symbol} ${candidate.contract} is already open in paper trading.`);
      return;
    }
    setOptionTrades((trades) => [...trades, { ...candidate, enteredAt: new Date().toISOString() }]);
    setNotice(`Paper entry recorded for ${candidate.symbol} ${candidate.contract}. No live order was sent.`);
  }

  function exitTrade(trade: PaperOptionTrade) {
    const exit = trade.premium;
    setOptionTrades((trades) => trades.map((item) => item === trade ? { ...item, exit, exitedAt: new Date().toISOString() } : item));
    setNotice(`Paper exit recorded for ${trade.symbol} ${trade.contract} at ${optionMoney(exit)}.`);
  }

  async function resetSession() {
    setBusy(true);
    try { const response = await fetch("/api/paper-trading", { method: "DELETE" }); setStatus(await response.json()); setOptionTrades([]); setNotice("Paper session reset to Rs 1,00,000."); }
    catch { setNotice("Could not reset the paper session."); }
    finally { setBusy(false); }
  }

  useEffect(() => { tick(); }, []);
  useEffect(() => { if (paused) return undefined; const timer = window.setInterval(tick, 5000); return () => window.clearInterval(timer); }, [paused, provider]);

  const latestEvents = status?.events.slice().reverse() ?? [];
  const isDelayed = status?.marketData?.delayed ?? true;
  const candidates = engineCandidates;
  const openOptionTrades = optionTrades.filter((trade) => !trade.exit);
  const realizedOptionPnl = optionTrades.filter((trade) => trade.exit !== undefined).reduce((sum, trade) => sum + ((trade.exit ?? trade.entry) - trade.entry) * trade.quantity, 0);
  const unrealizedOptionPnl = openOptionTrades.reduce((sum, trade) => sum + (trade.premium - trade.entry) * trade.quantity, 0);
  const totalPaperPnl = (status?.account.realizedPnl ?? 0) + realizedOptionPnl + unrealizedOptionPnl;
  return <main className="paper-page">
    <header className="paper-header">
      <div><p className="paper-eyebrow">AUTOMATIC PAPER WORKFLOW</p><h1>Paper trading lab</h1><p className="paper-subtitle">Test the strategy with simulated fills. No live orders can be placed from this workspace.</p></div>
      <div className="paper-actions"><span className="paper-mode"><i /> PAPER ONLY</span><label className="provider-control">Data source<select value={provider} onChange={(event) => setProvider(event.target.value as Provider)} aria-label="Paper market data provider"><option value="groww">Groww live</option><option value="yahoo">Yahoo Finance</option><option value="fallback">Fallback fixture</option></select></label><button className="paper-button secondary" onClick={() => setPaused(!paused)}>{paused ? "Resume updates" : "Pause updates"}</button><button className="paper-button primary" onClick={tick} disabled={busy}>{busy ? "Updating..." : "Update now"}</button></div>
    </header>
    <section className={`paper-notice ${isDelayed ? "delayed" : "realtime"}`}><div><strong>{isDelayed ? "Delayed market data" : "Groww market data connected"}</strong><span>{status?.marketData?.source ?? "Waiting for the first update"}</span></div><span>{notice}</span></section>
    <section className="paper-metrics"><div className="paper-metric"><span>Available balance</span><strong>{money(status?.account.balance ?? 100000)}</strong><small>Starting capital Rs 1,00,000</small></div><div className="paper-metric"><span>Realized P&amp;L</span><strong className={totalPaperPnl >= 0 ? "gain" : "loss"}>{money((status?.account.realizedPnl ?? 0) + realizedOptionPnl)}</strong><small>Closed paper positions</small></div><div className="paper-metric"><span>Live paper P&amp;L</span><strong className={totalPaperPnl >= 0 ? "gain" : "loss"}>{money(totalPaperPnl)}</strong><small>Includes open P&amp;L {money(unrealizedOptionPnl)}</small></div><div className="paper-metric"><span>Simulated orders</span><strong>{(status?.account.orders ?? 0) + optionTrades.length}</strong><small>Live orders: 0</small></div></section>
    <section className="paper-panel option-lab"><div className="paper-panel-heading"><div><span className="paper-kicker">PAPER OPTIONS DESK</span><h2>Call / put candidates</h2></div><span className="paper-lab-badge">REAL CHAIN + PYTHON ENGINE</span></div><div className="paper-lab-notice">Candidates are generated only from a real options chain and 5-minute market history. The engine validates expiry, bid/ask, OI, volume, IV, Greeks, breakout confirmation, structural levels, R:R and lot sizing. No chain means no suggestion.</div><div className="option-candidates">{candidates.length ? candidates.map((candidate) => { const openTrade = optionTrades.find((trade) => trade.id === candidate.id && !trade.exit); return <article className={`option-candidate ${candidate.contract === "CALL" ? "call" : "put"}`} key={candidate.id}><div className="candidate-head"><div><strong>{candidate.symbol}</strong><span>{candidate.strike} {candidate.contract === "CALL" ? "CE" : "PE"} · Exp {candidate.expiry}</span></div><b className="candidate-score">{candidate.score}/100</b></div><div className="candidate-price"><span>Ask / LTP <b>{optionMoney(candidate.entry)} / {optionMoney(candidate.premium)}</b></span><span>Target <b>{optionMoney(candidate.target)}</b></span><span>Stop <b>{optionMoney(candidate.stop)}</b></span></div><div className="candidate-chain"><span>OI {candidate.openInterest.toLocaleString("en-IN")}</span><span>Vol {candidate.volume.toLocaleString("en-IN")}</span><span>IV {candidate.iv.toFixed(1)}%</span><span>Delta {candidate.delta.toFixed(2)}</span><span>R:R {candidate.riskReward.toFixed(2)}</span><span>Qty {candidate.quantity}</span></div><p>{candidate.reason}</p>{openTrade ? <button className="paper-button exit-option" onClick={() => exitTrade(openTrade)}>Exit paper trade at {optionMoney(openTrade.premium)}</button> : <button className="paper-button enter-option" onClick={() => enterTrade(candidate)}>Enter paper trade</button>}</article>; }) : <div className="paper-empty"><strong>No actionable option candidates</strong><p>Configure a real Groww options-chain endpoint and complete 5-minute confirmation. The engine fails closed when chain data is missing or unsafe.</p></div>}</div></section>
    <div className="paper-columns"><section className="paper-panel positions-panel"><div className="paper-panel-heading"><div><span className="paper-kicker">PORTFOLIO</span><h2>Open positions</h2></div><span className="count-badge">{status?.positions.length ?? 0}</span></div>{status?.positions.length ? status.positions.map((position) => <article className="position-row" key={position.symbol}><div><strong>{position.symbol}</strong><span className={position.side === "LONG" ? "gain" : "loss"}>{position.side}</span></div><b>{position.quantity} units</b><div className="position-levels"><span>Entry <b>{money(position.entry)}</b></span><span>Stop <b>{money(position.stop)}</b></span><span>Target <b>{money(position.target)}</b></span></div></article>) : <div className="paper-empty"><span className="empty-icon">+</span><strong>No open positions</strong><p>The strategy is collecting market history and waiting for trend and candle confirmation.</p></div>}</section>
      <section className="paper-panel events-panel"><div className="paper-panel-heading"><div><span className="paper-kicker">ACTIVITY</span><h2>Strategy events</h2></div><span className="updated-label">Updated {time(status?.updatedAt)}</span></div>{latestEvents.length ? latestEvents.slice(0, 8).map((event, index) => <article className="event-row" key={`${event.timestamp}-${index}`}><span className={`event-dot ${event.type.toLowerCase()}`} /><div><div><strong>{event.type}</strong><span>{event.symbol}</span></div><p>{event.message}</p></div><small>{time(event.timestamp)}<br />{money(event.price)}</small></article>) : <div className="paper-empty"><strong>Activity will appear here</strong><p>Run an update to evaluate the strategy.</p></div>}</section></div>
    <footer className="paper-footer"><span>Live updates every 5 seconds {paused ? "(paused)" : ""}</span><button className="reset-button" onClick={resetSession} disabled={busy}>Reset paper session</button><a href="/">Back to dashboard</a></footer>
  </main>;
}
