"use client";

import { useCallback, useEffect, useState } from "react";
import { getAIMonitoring, updateAIMonitoring } from "../../lib/ai-monitoring-client";

type ChatMessage = { role: "user" | "assistant"; content: string };
type Monitoring = { sessionId?: string; state: string; monitoringEnabled: boolean; mode: string; blockers: string[]; latest?: { direction?: string; status?: string; confidence?: number; invalidation?: string }; log: Array<Record<string, unknown>> };

const POLL_MS = 5_000;

function readMonitoring(data: Record<string, unknown>, current: Monitoring): Monitoring {
  const monitoring = (data.monitoring ?? {}) as Record<string, unknown>;
  const health = (data.health ?? {}) as Record<string, unknown>;
  const latest = (data.latest ?? {}) as Record<string, unknown>;
  const log = (data.log && typeof data.log === "object" && Array.isArray((data.log as Record<string, unknown>).items)) ? (data.log as { items: Array<Record<string, unknown>> }).items : current.log;
  return {
    sessionId: typeof monitoring.sessionId === "string" ? monitoring.sessionId : current.sessionId,
    state: String(monitoring.state ?? current.state),
    monitoringEnabled: typeof monitoring.monitoringEnabled === "boolean" ? monitoring.monitoringEnabled : current.monitoringEnabled,
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
 * AI market monitoring (paper mode) and the AI trader chat. The model is advisory only: every
 * order still goes through the deterministic V5 gates, the trade-desk checklist and, for real
 * money, the PIN-confirmed live flow.
 */
export function AIMonitoringPanel({ symbol, strategyId, buildContext }: { symbol: string; strategyId: string; buildContext: () => Record<string, unknown> }) {
  const [monitoring, setMonitoring] = useState<Monitoring>({ state: "DISABLED", monitoringEnabled: false, mode: "PAPER", blockers: [], log: [] });
  const [chat, setChat] = useState<ChatMessage[]>([{ role: "assistant", content: "Ask about trend, candles, levels, option-chain positioning, risk/reward or a paper-trade plan for NIFTY, BANKNIFTY or SENSEX." }]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const toggle = async () => {
    try {
      if (monitoring.monitoringEnabled && monitoring.sessionId) {
        await updateAIMonitoring({ action: "DISABLE_MONITORING", sessionId: monitoring.sessionId, reason: "User stopped AI monitoring" });
        setMonitoring((current) => ({ ...current, state: "STOPPED", monitoringEnabled: false }));
      } else {
        const response = await updateAIMonitoring({ action: "ENABLE_MONITORING", symbols: [symbol], timeframes: ["5m"], mode: "PAPER", strategyVersion: strategyId, confidenceThreshold: 70, automationEnabled: false, riskAcknowledged: true });
        setMonitoring({ sessionId: String(response.sessionId), state: String(response.state ?? "ACTIVE"), monitoringEnabled: true, mode: "PAPER", blockers: [], log: [] });
      }
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "AI monitoring action failed");
    }
  };

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
        <div><span className="algo-kicker">AI MONITORING · PAPER · ADVISORY ONLY</span><h2>{latest?.direction ?? (monitoring.monitoringEnabled ? "Waiting for the first evaluation" : "AI monitoring is off")}</h2></div>
        <label className="auto-trade-toggle"><input type="checkbox" checked={monitoring.monitoringEnabled} onChange={() => void toggle()} /> Monitor {symbol}</label>
      </div>
      <p className="mi-note">
        <span className={latest?.status === "CONFIRMED" ? "gain" : "warning"}>{latest?.status ?? monitoring.state}</span>
        {latest?.confidence !== undefined ? ` · model confidence ${latest.confidence}%` : ""}
        {latest?.invalidation ? ` · invalidation: ${latest.invalidation}` : ""}
      </p>
      {monitoring.blockers.length > 0 && <p className="warning mi-note">Blocked: {monitoring.blockers.join("; ")}</p>}
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
