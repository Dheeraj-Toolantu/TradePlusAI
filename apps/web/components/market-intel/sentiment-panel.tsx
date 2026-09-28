"use client";

import { useEffect, useState } from "react";

type Aggregate = { score: number; label: string; items: number; bullish_pct: number; bearish_pct: number };
type Headline = { title: string; link: string; source: string; audience: string; age_hours: number; score: number };
type Sentiment = {
  generated_at: string;
  summary: Record<"india" | "india_retail" | "india_news" | "global" | "global_retail" | "global_news", Aggregate>;
  contrarian_note: string | null;
  divergence: string | null;
  event_risk: Array<{ event: string; mentions: number; latest: string; link: string }>;
  top_bullish: Headline[];
  top_bearish: Headline[];
  global_headlines: Headline[];
  sources: Array<{ id: string; name: string; ok: boolean; items: number; error: string | null }>;
  sources_ok: number;
  sources_total: number;
  method: string;
  error?: string;
};

const REFRESH_MS = 10 * 60_000;
const tone = (score: number) => (score >= 12 ? "gain" : score <= -12 ? "loss" : "warning");
const label = (value: string) => value.replaceAll("_", " ").toLowerCase();

function Gauge({ title, data }: { title: string; data: Aggregate }) {
  const insufficient = data.label === "INSUFFICIENT_DATA";
  return (
    <div className="snt-gauge">
      <small>{title}</small>
      <b className={insufficient ? "" : tone(data.score)}>{insufficient ? "--" : `${data.score > 0 ? "+" : ""}${data.score.toFixed(0)}`}</b>
      <div className="snt-bar"><i style={{ left: `${(Math.max(-100, Math.min(100, data.score)) + 100) / 2}%` }} /></div>
      <em>{insufficient ? `only ${data.items} posts` : `${label(data.label)} · ${data.items} posts · ${data.bullish_pct.toFixed(0)}% bull / ${data.bearish_pct.toFixed(0)}% bear`}</em>
    </div>
  );
}

function Headlines({ items }: { items: Headline[] }) {
  if (!items.length) return <small>None in the last 36 hours</small>;
  return <ul className="snt-headlines">{items.map((item) => <li key={item.link || item.title}><a href={item.link} target="_blank" rel="noreferrer noopener">{item.title}</a><small>{item.source} · {item.audience === "RETAIL" ? "forum" : "news"} · {item.age_hours.toFixed(0)}h ago</small></li>)}</ul>;
}

export function SentimentPanel() {
  const [data, setData] = useState<Sentiment | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/sentiment", { cache: "no-store" });
        const body = await response.json();
        if (cancelled) return;
        const wellFormed = body && typeof body === "object" && body.summary?.india && Array.isArray(body.event_risk) && Array.isArray(body.sources) && Array.isArray(body.top_bullish) && Array.isArray(body.top_bearish) && Array.isArray(body.global_headlines);
        if (!response.ok || body.error || !wellFormed) setError(body?.error ?? "Sentiment unavailable");
        else { setData(body as Sentiment); setError(null); }
      } catch { if (!cancelled) setError("Sentiment request failed"); }
    };
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  return (
    <section className="mi-card snt-panel" aria-label="Retail and news sentiment">
      <div className="algo-panel-head">
        <div><span className="algo-kicker">PUBLIC SENTIMENT · FORUMS + NEWS · INDIA & GLOBAL</span><h2>What retail traders and the media are saying</h2></div>
        <span>{data ? `${data.sources_ok}/${data.sources_total} sources · ${new Date(data.generated_at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false })}` : ""}</span>
      </div>
      {!data && <div className="algo-empty">{error ?? "Scanning public news feeds and forums (first scan takes up to ~40 s)…"}</div>}
      {data && (
        <>
          {data.event_risk.length > 0 && <div className="snt-alert"><b>Event risk:</b> {data.event_risk.map((event) => <a key={event.event} href={event.link} target="_blank" rel="noreferrer noopener">{event.event} ({event.mentions} mentions)</a>)}</div>}
          {data.contrarian_note && <div className="snt-alert snt-contrarian">{data.contrarian_note}</div>}
          {data.divergence && <div className="snt-note">{data.divergence}</div>}
          <div className="snt-gauges">
            <Gauge title="India · overall" data={data.summary.india} />
            <Gauge title="India · retail forums" data={data.summary.india_retail} />
            <Gauge title="India · news media" data={data.summary.india_news} />
            <Gauge title="Global · overall" data={data.summary.global} />
          </div>
          <div className="snt-columns">
            <div><b className="gain">Most bullish (India)</b><Headlines items={data.top_bullish} /></div>
            <div><b className="loss">Most bearish (India)</b><Headlines items={data.top_bearish} /></div>
            <div><b>Global market movers</b><Headlines items={data.global_headlines} /></div>
          </div>
          <details className="mi-learn">
            <summary>Sources and method</summary>
            <p>{data.method} Extreme crowd readings are treated as contrarian warnings, not signals.</p>
            <ul className="snt-sources">{data.sources.map((source) => <li key={source.id} className={source.ok ? "gain" : "loss"}>{source.ok ? "●" : "○"} {source.name}<small>{source.ok ? ` ${source.items} items` : ` ${source.error ?? "unavailable"}`}</small></li>)}</ul>
          </details>
        </>
      )}
    </section>
  );
}
