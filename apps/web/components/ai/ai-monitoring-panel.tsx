"use client";

import { useCallback, useEffect, useState } from "react";
import { getAIMonitoring, updateAIMonitoring } from "../../lib/ai-monitoring-client";
import type { OptionAdvice } from "../../../../services/ai-monitoring/src/option-advisor";

type ChatMessage = { role: "user" | "assistant"; content: string };
type Monitoring = { sessionId?: string; state: string; monitoringEnabled: boolean; automationEnabled: boolean; mode: string; blockers: string[]; latest?: { direction?: string; status?: string; confidence?: number; invalidation?: string }; log: Array<Record<string, unknown>> };

const POLL_MS = 5_000;
const ADVICE_MS = 60_000;
const AUTOTRADE_MS = 15_000;

type AutoTradeOrder = { id: string; symbol: string; quantity: number; price: number; stopLoss?: number; target?: number; status: string; currentPrice?: number; pnl?: number; realizedPnl?: number; exitReason?: string; exitPrice?: number; createdAt?: string };
type AutoTradeStatus = {
  automationEnabled?: boolean;
  risk?: { tradesToday: number; openPositions: number; realizedPnlToday: number; consecutiveLosses: number };
  limits?: { maxTradesPerDay: number; maxDailyLoss: number; maxConsecutiveLosses: number; cooldownMinutes: number; lots: number };
  orders?: AutoTradeOrder[];
  decision?: { allowed: boolean; reasons: string[]; summary?: string };
  error?: string;
};

function readMonitoring(data: Record<string, unknown>, current: Monitoring): Monitoring {
  const monitoring = (data.monitoring ?? {}) as Record<string, unknown>;
  const health = (data.health ?? {}) as Record<string, unknown>;
  const latest = (data.latest ?? {}) as Record<string, unknown>;
  const log = (data.log && typeof data.log === "object" && Array.isArray((data.log as Record<string, unknown>).items)) ? (data.log as { items: Array<Record<string, unknown>> }).items : current.log;
  return {
    sessionId: typeof monitoring.sessionId === "string" ? monitoring.sessionId : current.sessionId,
    state: String(monitoring.state ?? current.state),
    monitoringEnabled: typeof monitoring.monitoringEnabled === "boolean" ? monitoring.monitoringEnabled : current.monitoringEnabled,
    automationEnabled: typeof monitoring.automationEnabled === "boolean" ? monitoring.automationEnabled : current.automationEnabled,
    mode: String(monitoring.mode ?? current.mode),
    blockers: Array.isArray(health.blockers) ? health.blockers.map(String) : current.blockers,
    latest: {
      direction: typeof latest.direction === "string" ? latest.direction : current.latest?.direction,
      status: typeof latest.status === "string" ? latest.status : current.latest?.status,
      confidence: typeof latest.confidence === "number" ? latest.confidence : current.latest?.confidence,
      invalidation: typeof latest.invalidation === "string" ? latest.invalidation : current.latest?.invalidation,
    },
    log,
  };
}

/**
 * AI market monitoring and the AI trader chat. Suggestions combine the market-intel brief with a
 * 1D/15m/5m/1m multi-timeframe read (candle psychology, key levels, option intrinsic/fair value).
 * With "Auto-trade" on, AI suggestions that pass every deterministic gate are executed as PAPER
 * trades with automatic stop/target/trailing/square-off management. Real-money orders still go
 * only through the PIN-confirmed live flow.
 */
export function AIMonitoringPanel({ symbol, strategyId, buildContext, onLoadAdvice }: { symbol: string; strategyId: string; buildContext: () => Record<string, unknown>; onLoadAdvice?: (advice: OptionAdvice) => void }) {
  const [monitoring, setMonitoring] = useState<Monitoring>({ state: "DISABLED", monitoringEnabled: false, automationEnabled: false, mode: "PAPER", blockers: [], log: [] });
  const [chat, setChat] = useState<ChatMessage[]>([{ role: "assistant", content: "Ask about trend, candles, levels, option-chain positioning, risk/reward or a paper-trade plan for NIFTY, BANKNIFTY or SENSEX." }]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advice, setAdvice] = useState<OptionAdvice | null>(null);
  const [adviceBusy, setAdviceBusy] = useState(false);
  const [adviceError, setAdviceError] = useState<string | null>(null);
  const [autoTrade, setAutoTrade] = useState<AutoTradeStatus | null>(null);

  const refresh = useCallback(async (sessionId?: string) => {
    try {
      const data = await getAIMonitoring(sessionId);
      setMonitoring((current) => readMonitoring(data, current));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "AI monitoring status unavailable");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!monitoring.monitoringEnabled) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(monitoring.sessionId); }, POLL_MS);
    return () => clearInterval(timer);
  }, [monitoring.monitoringEnabled, monitoring.sessionId, refresh]);

  // While monitoring is on, the AI re-reads the whole market (zones, 1m trigger, structure, OI,
  // PCR, VIX, sentiment, global cues) every minute and names the best CE / PE, or WAIT.
  const suggest = useCallback(async () => {
    if (!monitoring.sessionId) return;
    setAdviceBusy(true);
    try {
      const response = await fetch("/api/ai-monitoring/suggest", { method: "POST", headers: { "content-type": "application/json", "x-user-id": "local-user" }, body: JSON.stringify({ symbol, sessionId: monitoring.sessionId }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(data.error ?? "AI suggestion unavailable"));
      setAdvice(data.advice as OptionAdvice);
      setAdviceError(null);
    } catch (reason) {
      setAdviceError(reason instanceof Error ? reason.message : "AI suggestion unavailable");
    } finally {
      setAdviceBusy(false);
    }
  }, [monitoring.sessionId, symbol]);
  useEffect(() => {
    if (!monitoring.monitoringEnabled || !monitoring.sessionId) { setAdvice(null); return; }
    void suggest();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void suggest(); }, ADVICE_MS);
    return () => clearInterval(timer);
  }, [monitoring.monitoringEnabled, monitoring.sessionId, suggest]);

  const toggle = async () => {
    try {
      if (monitoring.monitoringEnabled && monitoring.sessionId) {
        await updateAIMonitoring({ action: "DISABLE_MONITORING", sessionId: monitoring.sessionId, reason: "User stopped AI monitoring" });
        setMonitoring((current) => ({ ...current, state: "STOPPED", monitoringEnabled: false, automationEnabled: false }));
      } else {
        const response = await updateAIMonitoring({ action: "ENABLE_MONITORING", symbols: [symbol], timeframes: ["5m"], mode: "PAPER", strategyVersion: strategyId, confidenceThreshold: 70, automationEnabled: false, riskAcknowledged: true });
        setMonitoring({ sessionId: String(response.sessionId), state: String(response.state ?? "ACTIVE"), monitoringEnabled: true, automationEnabled: false, mode: "PAPER", blockers: [], log: [] });
      }
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "AI monitoring action failed");
    }
  };

  const toggleAutoTrade = async () => {
    if (!monitoring.sessionId) return;
    const enable = !monitoring.automationEnabled;
    if (enable && !window.confirm(`Turn on AI auto-trade for ${symbol} (PAPER)?\n\nThe AI will place paper trades only when every gate passes: timeframes aligned, confidence ≥ 70%, honest premium reward/risk, fresh price, inside 09:30-14:45 IST. Each trade gets a structural stop, target, trailing stop and a 15:15 square-off. Trading stops for the day after the daily loss limit or consecutive losses.`)) return;
    try {
      await updateAIMonitoring({ action: "SET_AUTOMATION", sessionId: monitoring.sessionId, enabled: enable, mode: "PAPER" });
      setMonitoring((current) => ({ ...current, automationEnabled: enable }));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not change AI auto-trade");
    }
  };

  // Auto-trade loop: exits are managed every tick; entries only when the policy allows. Keeps
  // running while an AI position is open so it is always managed to an exit.
  const autoTradeTick = useCallback(async () => {
    try {
      const response = await fetch("/api/ai-monitoring/autotrade", { method: "POST", headers: { "content-type": "application/json", "x-user-id": "local-user" }, body: JSON.stringify({ symbol, sessionId: monitoring.sessionId ?? "" }) });
      const data = await response.json().catch(() => ({})) as AutoTradeStatus;
      setAutoTrade(response.ok || data.risk ? data : { error: String(data.error ?? "Auto-trade unavailable") });
    } catch (reason) {
      setAutoTrade({ error: reason instanceof Error ? reason.message : "Auto-trade unavailable" });
    }
  }, [symbol, monitoring.sessionId]);
  const hasOpenAiPosition = (autoTrade?.risk?.openPositions ?? 0) > 0;
  useEffect(() => {
    if (!monitoring.automationEnabled && !hasOpenAiPosition) return;
    void autoTradeTick();
    const timer = setInterval(() => { void autoTradeTick(); }, AUTOTRADE_MS);
    return () => clearInterval(timer);
  }, [monitoring.automationEnabled, hasOpenAiPosition, autoTradeTick]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const history = [...chat, { role: "user" as const, content: text }];
    setChat(history);
    setInput("");
    setBusy(true);
    try {
      const response = await fetch("/api/ai-monitoring/chat", { method: "POST", headers: { "content-type": "application/json", "x-user-id": "local-user" }, body: JSON.stringify({ message: text, history: history.slice(-10), context: { ...buildContext(), monitoringState: monitoring.state } }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(data.error ?? "AI chat unavailable"));
      setChat((current) => [...current, { role: "assistant", content: String(data.content ?? "No answer returned.") }]);
    } catch (reason) {
      setChat((current) => [...current, { role: "assistant", content: `AI chat unavailable: ${reason instanceof Error ? reason.message : "provider error"}. The deterministic analysis above remains authoritative.` }]);
    } finally {
      setBusy(false);
    }
  };

  const latest = monitoring.latest;
  return (
    <section className="mi-card ai-panel" aria-label="AI monitoring and chat">
      <div className="algo-panel-head">
        <div><span className="algo-kicker">AI MONITORING · 1D/15m/5m/1m · {monitoring.automationEnabled ? "AUTO-TRADE ON (PAPER)" : "ADVISORY"}</span><h2>{latest?.direction ?? (monitoring.monitoringEnabled ? "Waiting for the first evaluation" : "AI monitoring is off")}</h2></div>
        <div className="ai-toggles">
          <label className="auto-trade-toggle"><input type="checkbox" checked={monitoring.monitoringEnabled} onChange={() => void toggle()} /> Monitor {symbol}</label>
          <label className="auto-trade-toggle" title={monitoring.monitoringEnabled ? "Let the AI place paper trades when every safety gate passes" : "Turn on monitoring first"}><input type="checkbox" checked={monitoring.automationEnabled} disabled={!monitoring.monitoringEnabled} onChange={() => void toggleAutoTrade()} /> Auto-trade (paper)</label>
        </div>
      </div>
      <p className="mi-note">
        <span className={latest?.status === "CONFIRMED" ? "gain" : "warning"}>{latest?.status ?? monitoring.state}</span>
        {latest?.confidence !== undefined ? ` · model confidence ${latest.confidence}%` : ""}
        {latest?.invalidation ? ` · invalidation: ${latest.invalidation}` : ""}
      </p>
      {monitoring.blockers.length > 0 && <p className="warning mi-note">Blocked: {monitoring.blockers.join("; ")}</p>}
      {monitoring.monitoringEnabled && (advice ? <AdviceCard advice={advice} busy={adviceBusy} onRefresh={() => void suggest()} onLoad={onLoadAdvice} /> : <p className="mi-note">{adviceBusy ? "AI is reading zones, 1m structure, OI, PCR, VIX and sentiment…" : adviceError ?? "Waiting for the first AI suggestion…"}</p>)}
      {advice && adviceError && <p className="warning mi-note">Last refresh failed: {adviceError}</p>}
      {(monitoring.automationEnabled || hasOpenAiPosition) && <AutoTradeCard status={autoTrade} />}
      {error && <p className="warning mi-note">{error}</p>}
      {monitoring.log.length > 0 && (
        <details className="mi-management"><summary>AI evaluation log ({monitoring.log.length})</summary>
          <ul>{monitoring.log.slice(-10).reverse().map((entry, index) => { const summary = (entry.summary ?? {}) as Record<string, unknown>; return <li key={String(entry.id ?? index)}><small>{String(entry.occurredAt ?? "")} · {String(summary.direction ?? "evaluation")} · {String(summary.status ?? entry.eventType ?? "")}{summary.confidence !== undefined ? ` · ${String(summary.confidence)}%` : ""}</small></li>; })}</ul>
        </details>
      )}
      <div className="ai-chat-messages">{chat.map((item, index) => <div className={`ai-chat-message ${item.role}`} key={`${item.role}-${index}`}><b>{item.role === "assistant" ? "AI TRADER" : "YOU"}</b><span>{item.content}</span></div>)}</div>
      <form className="ai-chat-form" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <input aria-label="Ask the AI trader" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Ask about trend, levels, options or a paper plan…" disabled={busy} />
        <button type="submit" disabled={busy || !input.trim()}>{busy ? "…" : "Ask AI"}</button>
      </form>
    </section>
  );
}

function AdviceCard({ advice, busy, onRefresh, onLoad }: { advice: OptionAdvice; busy: boolean; onRefresh: () => void; onLoad?: (advice: OptionAdvice) => void }) {
  const fmt = (value: number | null | undefined) => (value === null || value === undefined || !Number.isFinite(value) ? "--" : value.toLocaleString("en-IN", { maximumFractionDigits: 2 }));
  const tone = advice.action === "BUY_CE" ? "gain" : advice.action === "BUY_PE" ? "loss" : "warning";
  const label = advice.action === "BUY_CE" ? "BUY CALL" : advice.action === "BUY_PE" ? "BUY PUT" : "WAIT";
  return (
    <div className="smart-entry ai-advice">
      <div className="smart-entry-head">
        <b className={tone}>{label}{advice.contract ? ` · ${advice.contract.trading_symbol || advice.contract.strike}` : ""}</b>
        <span>{advice.headline}</span>
        {advice.action !== "WAIT" ? <b>{advice.confidence}%</b> : null}
        <button type="button" onClick={onRefresh} disabled={busy}>{busy ? "…" : "Re-analyse"}</button>
      </div>
      <p className="mi-note">{advice.strategy} · {advice.source === "AI" ? `AI (${advice.model ?? "model"})` : "rule-based fallback"} · {new Date(advice.generatedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false })}</p>
      {advice.premium && advice.spot ? (
        <div className="mi-risk-row">
          <span>Premium <b>₹{fmt(advice.premium.entry)}</b> · SL <b className="loss">₹{fmt(advice.premium.stop)}</b> · T1 <b className="gain">₹{fmt(advice.premium.target1)}</b>{advice.premium.target2 ? <> · T2 <b className="gain">₹{fmt(advice.premium.target2)}</b></> : null} · {advice.premium.riskReward}R</span>
          <span>Spot entry <b>{fmt(advice.spot.entryLow)}{advice.spot.entryHigh !== advice.spot.entryLow ? `–${fmt(advice.spot.entryHigh)}` : ""}</b> · SL <b>{fmt(advice.spot.stop)}</b> · T1 <b>{fmt(advice.spot.target1)}</b></span>
        </div>
      ) : null}
      {advice.marketRead ? <p className="mi-note">{advice.marketRead}</p> : null}
      {advice.trigger ? <p className="mi-note"><b>{advice.action === "WAIT" ? "Would trade if:" : "Entry trigger:"}</b> {advice.trigger}</p> : null}
      {advice.invalidation ? <p className="mi-note"><b>Invalidation:</b> {advice.invalidation}</p> : null}
      {advice.blockedBy.length ? <p className="warning mi-note">Blocked: {advice.blockedBy.join("; ")}</p> : null}
      {advice.mtf ? <MtfTable mtf={advice.mtf} /> : null}
      {advice.exitPlan?.length ? <details className="mi-management" open><summary>Exit plan</summary><ul>{advice.exitPlan.map((line) => <li key={line}><small>{line}</small></li>)}</ul></details> : null}
      {advice.psychology.length ? <details className="mi-management" open><summary>Market psychology</summary><ul>{advice.psychology.map((line) => <li key={line}><small>{line}</small></li>)}</ul></details> : null}
      {advice.reasons.length || advice.risks.length ? <details className="mi-management"><summary>Evidence for / against</summary><ul>
        {advice.reasons.map((line) => <li key={`r${line}`}><small className="gain">+ </small><small>{line}</small></li>)}
        {advice.risks.map((line) => <li key={`k${line}`}><small className="loss">− </small><small>{line}</small></li>)}
      </ul></details> : null}
      {advice.notes.length ? <p className="mi-note">{advice.notes.join(" ")}</p> : null}
      {advice.action !== "WAIT" && advice.contract && advice.premium && onLoad ? <button type="button" className="mi-use-plan" onClick={() => onLoad(advice)}>Load this suggestion into the order ticket</button> : null}
      <p className="mi-note">With auto-trade off this is a suggestion only. With auto-trade on, it is executed as a PAPER trade only if every server-side gate passes; live orders always need the PIN-confirmed flow.</p>
    </div>
  );
}

function MtfTable({ mtf }: { mtf: NonNullable<OptionAdvice["mtf"]> }) {
  const tone = (trend: string) => (trend === "UP" ? "gain" : trend === "DOWN" ? "loss" : "warning");
  return (
    <details className="mi-management" open>
      <summary>Multi-timeframe read · <span className={mtf.alignment === "BULLISH_ALIGNED" ? "gain" : mtf.alignment === "BEARISH_ALIGNED" ? "loss" : "warning"}>{mtf.alignment.replaceAll("_", " ").toLowerCase()}</span> · engine {mtf.action.replace("_", " ")} {mtf.confidence}%</summary>
      <table className="ai-mtf-table">
        <thead><tr><th>TF</th><th>Trend</th><th>Score</th><th>RSI</th><th>Candles (psychology)</th></tr></thead>
        <tbody>{mtf.timeframes.map((row) => <tr key={row.timeframe}><td>{row.timeframe}</td><td className={tone(row.trend)}>{row.trend}</td><td>{row.score > 0 ? "+" : ""}{row.score}</td><td>{row.rsi14 ?? "--"}</td><td>{row.patterns.join(", ") || "—"}</td></tr>)}</tbody>
      </table>
      <p className="mi-note">{mtf.headline}</p>
      {mtf.valuation.length ? <ul>{mtf.valuation.map((value) => <li key={value.tradingSymbol}><small><b>{value.side} {value.tradingSymbol}</b>: intrinsic ₹{value.intrinsic} · time value ₹{value.extrinsic} ({value.extrinsicPct}%){value.fairValue !== null ? ` · fair ≈ ₹${value.fairValue}` : ""} · <span className={value.verdict === "OVERPRICED" ? "loss" : value.verdict === "UNDERVALUED" ? "gain" : ""}>{value.verdict.toLowerCase()}</span></small></li>)}</ul> : null}
      {mtf.keyLevels.length ? <p className="mi-note"><b>Key levels:</b> {mtf.keyLevels.slice(0, 12).join(" · ")}</p> : null}
    </details>
  );
}

function AutoTradeCard({ status }: { status: AutoTradeStatus | null }) {
  if (!status) return <p className="mi-note">AI auto-trade is starting…</p>;
  const inr = (value: number | undefined) => `${(value ?? 0) >= 0 ? "" : "-"}₹${Math.abs(value ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  const open = (status.orders ?? []).filter((order) => order.status === "OPEN" || order.status === "FILLED");
  const closed = (status.orders ?? []).filter((order) => order.status === "EXITED").slice(0, 5);
  return (
    <div className="smart-entry ai-autotrade">
      <div className="smart-entry-head">
        <b className={status.decision?.allowed ? "gain" : "warning"}>AI AUTO-TRADE · PAPER</b>
        <span>{status.risk ? `${status.risk.tradesToday}/${status.limits?.maxTradesPerDay ?? 3} trades · realised ${inr(status.risk.realizedPnlToday)} (limit -₹${status.limits?.maxDailyLoss ?? 3000}) · ${status.limits?.lots ?? 1} lot` : ""}</span>
      </div>
      {status.error ? <p className="warning mi-note">{status.error}</p> : null}
      {status.decision?.summary ? <p className="gain mi-note">{status.decision.summary}</p> : null}
      {status.decision && !status.decision.allowed && status.decision.reasons.length ? <p className="mi-note"><b>Not entering:</b> {status.decision.reasons.slice(0, 3).join("; ")}</p> : null}
      {open.map((order) => <p className="mi-note" key={order.id}><b>OPEN {order.symbol}</b> × {order.quantity} @ ₹{order.price} · SL ₹{order.stopLoss} · T ₹{order.target} · LTP ₹{order.currentPrice ?? order.price} · <span className={(order.pnl ?? 0) >= 0 ? "gain" : "loss"}>{inr(order.pnl)}</span></p>)}
      {closed.length ? <details className="mi-management"><summary>Closed today ({closed.length})</summary><ul>{closed.map((order) => <li key={order.id}><small>{order.symbol} {order.price} → {order.exitPrice} · {order.exitReason?.replace("AUTO_", "").replaceAll("_", " ").toLowerCase()} · <span className={(order.realizedPnl ?? 0) >= 0 ? "gain" : "loss"}>{inr(order.realizedPnl)}</span></small></li>)}</ul></details> : null}
    </div>
  );
}
