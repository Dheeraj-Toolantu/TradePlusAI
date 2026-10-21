"use client";

import { memo, useEffect, useState } from "react";

type Snapshot = { id: string; recordedAt: string; reasons: string[]; indices?: Record<string, { name: string; score: number | null }>; commodities?: Record<string, { name: string; score: number | null }> };
type Reversal = { id: string; name: string; type: "SENTIMENT" | "PRICE"; from: string; to: string; previous_score: number | null; score: number | null; change_pct: number | null; recordedAt: string };
type History = { snapshots: Snapshot[]; reversals: Reversal[] };

const time = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
const signed = (value: number | null | undefined) => (value === null || value === undefined ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(0)}`);
const up = (direction: string) => direction === "BULLISH" || direction === "UP";

/** What has been saved to Firestore: the latest 15-minute snapshot and recent reversals. */
export const SentimentHistoryPanel = memo(function SentimentHistoryPanel() {
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (document.hidden) return;
      fetch("/api/sentiment-history?limit=12", { cache: "no-store" })
        .then(async (response) => { const body = await response.json(); if (!response.ok || body.error) throw new Error(body.error ?? "History unavailable"); return body as History; })
        .then((body) => { if (!cancelled) { setHistory(body); setError(null); } })
        .catch((failure) => { if (!cancelled) setError(failure instanceof Error ? failure.message : "History unavailable"); });
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const latest = history?.snapshots[0];
  return (
    <section className="isa-panel smh">
      <div className="ce-head">
        <h3>Sentiment history (Firestore)</h3>
        <span className="isa-muted">{latest ? `Last saved ${time(latest.recordedAt)} IST (${latest.reasons.join(" + ").toLowerCase()})` : "Saved every 15 min and on every reversal"}</span>
      </div>
      {error ? <p className="isa-alert">{error}</p> : null}
      {latest ? (
        <div className="tgo-channels">
          {Object.entries({ ...latest.indices, ...latest.commodities }).map(([id, row]) => <span key={id} className="isa-chip">{row.name}: {signed(row.score)}</span>)}
        </div>
      ) : null}
      {history ? (
        history.reversals.length ? (
          <ul className="smh-list">
            {history.reversals.map((item) => (
              <li key={item.id}>
                <small>{time(item.recordedAt)}</small>
                <b>{item.name}</b>
                <span>{item.type === "SENTIMENT" ? "sentiment" : "price"} <i className={up(item.from) ? "isa-up" : "isa-down"}>{item.from.toLowerCase()}</i> → <i className={up(item.to) ? "isa-up" : "isa-down"}>{item.to.toLowerCase()}</i></span>
                <small>{item.type === "SENTIMENT" ? `${signed(item.previous_score)} → ${signed(item.score)}` : `${item.change_pct === null ? "--" : `${item.change_pct > 0 ? "+" : ""}${item.change_pct.toFixed(2)}%`} today`}</small>
              </li>
            ))}
          </ul>
        ) : <p className="isa-muted">No reversals recorded yet.</p>
      ) : !error ? <p className="isa-muted">Loading history…</p> : null}
      <small className="isa-muted">A reversal is a sentiment flip (score crossing from +10 or more to -10 or less, or back) or a price flip (day change from +0.2% or more to -0.2% or less, or back), for NIFTY 50, BANK NIFTY, SENSEX and each commodity.</small>
    </section>
  );
});
