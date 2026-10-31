"use client";

import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HistoryReading, RecorderStatus, StoredReversal, StoredSnapshot } from "../lib/sentiment-history";
import { SentimentChart, seriesColor } from "./sentiment-chart";

type History = { snapshots: StoredSnapshot[]; reversals: StoredReversal[]; warnings?: string[]; recorder?: RecorderStatus };
type Row = { snapshot: StoredSnapshot; reading: HistoryReading & Record<string, unknown>; kind: "INDEX" | "COMMODITY" };

const LATEST = "";
const DEFAULT_SHOWN = ["NIFTY", "BANKNIFTY", "SENSEX"];
const ORDER = ["NIFTY", "BANKNIFTY", "SENSEX", "CRUDEOIL", "NATURALGAS", "GOLD", "SILVER", "COPPER"];
const IST_OFFSET_MS = 330 * 60_000;
const today = () => new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
const istDate = (iso: string) => new Date(new Date(iso).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const istTime = (iso: string) => new Date(new Date(iso).getTime() + IST_OFFSET_MS).toISOString().slice(11, 16);
const validIso = (iso: unknown) => typeof iso === "string" && Number.isFinite(new Date(iso).getTime());
const dateOf = (snapshot: { date?: string; recordedAt?: string }) => snapshot.date ?? (validIso(snapshot.recordedAt) ? istDate(snapshot.recordedAt!) : "--");
const timeOf = (snapshot: { time?: string; recordedAt?: string }) => snapshot.time ?? (validIso(snapshot.recordedAt) ? istTime(snapshot.recordedAt!) : "--");
const reasonsOf = (snapshot: StoredSnapshot) => (Array.isArray(snapshot.reasons) ? snapshot.reasons : []);
const lower = (value: unknown) => (typeof value === "string" ? value.toLowerCase() : "--");
const when = (iso: string | null | undefined) => (validIso(iso) ? `${istDate(iso!)} ${istTime(iso!)} IST` : "never");
export const FETCH_TIMEOUT_MS = 30_000;

/** Fetch one page of history; a non-JSON reply (an HTML error page, a proxy) or a hang becomes a readable error. */
export async function fetchHistory(day: string, fetcher: typeof fetch = fetch): Promise<History> {
  let response: Response;
  try {
    response = await fetcher(`/api/sentiment-history?${day ? `date=${day}` : "limit=48"}`, { cache: "no-store", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (failure) {
    const name = (failure as { name?: string })?.name;
    throw new Error(name === "TimeoutError" || name === "AbortError" ? "Sentiment history timed out. The server took longer than 30s." : "Couldn't reach the server for sentiment history.");
  }
  const text = await response.text();
  let body: (Partial<History> & { error?: string }) | null = null;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!response.ok || !body || body.error) throw new Error(body?.error ?? `Sentiment history unavailable (HTTP ${response.status}).`);
  return { snapshots: Array.isArray(body.snapshots) ? body.snapshots : [], reversals: Array.isArray(body.reversals) ? body.reversals : [], warnings: body.warnings ?? [], recorder: body.recorder };
}
const tone = (score: number | null | undefined) => (score === null || score === undefined ? "isa-muted" : score >= 12 ? "isa-up" : score <= -12 ? "isa-down" : "isa-flat");
const signed = (value: number | null | undefined, digits = 0) => {
  if (value === null || value === undefined) return "--";
  const text = Math.abs(value).toFixed(digits);
  return Number(text) === 0 ? text : `${value > 0 ? "+" : "-"}${text}`; // never "-0"
};
const price = (value: number | null | undefined) => (value === null || value === undefined ? "--" : value.toLocaleString("en-IN", { maximumFractionDigits: 2 }));
const pct = (value: unknown) => (typeof value === "number" ? `${Math.round(value)}%` : "--");
const words = (value: unknown) => (typeof value === "string" ? value.replaceAll("_", " ").toLowerCase() : "--");
const up = (direction: string) => direction === "BULLISH" || direction === "UP";
const readingOf = (snapshot: StoredSnapshot, id: string) => snapshot.indices?.[id] ?? snapshot.commodities?.[id];

function csv(rows: Array<Array<string | number | null | undefined>>): string {
  return rows.map((row) => row.map((cell) => {
    const text = cell === null || cell === undefined ? "" : String(cell);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }).join(",")).join("\n");
}
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  link.click();
  URL.revokeObjectURL(url);
}

function Reason({ snapshot, id }: { snapshot: StoredSnapshot; id?: string }) {
  const flips = (snapshot.reversals ?? []).filter((item) => !id || item.instrument === id);
  return (
    <span className="smh-reason">
      {reasonsOf(snapshot).includes("SCHEDULED") ? <i className="smh-tag">15 min</i> : null}
      {flips.map((item) => <i key={item.instrument + item.type} className={`smh-tag ${up(item.to) ? "smh-up" : "smh-down"}`} title={`${item.instrument} ${lower(item.type)} ${item.from} → ${item.to}`}>{id ? "" : `${item.instrument} `}{item.type === "SENTIMENT" ? "sentiment" : "price"} → {lower(item.to)}</i>)}
      {reasonsOf(snapshot).includes("REVERSAL") && !flips.length && id ? <i className="smh-tag">reversal (other)</i> : null}
    </span>
  );
}

function Constituents({ reading }: { reading: Row["reading"] }) {
  const stocks = (reading.constituents as Array<{ symbol: string; name: string; weight: number | null; score: number | null; label: string; price: number | null; change_pct: number | null }> | undefined) ?? [];
  if (!stocks.length) return <p className="isa-muted">Share prices were not stored with this snapshot.</p>;
  return (
    <table className="isa-table smh-stocks">
      <thead><tr><th>Stock</th><th>Weight</th><th>Price</th><th>Change</th><th>Score</th><th>Label</th></tr></thead>
      <tbody>
        {[...stocks].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)).map((stock) => (
          <tr key={stock.symbol}>
            <td><b>{stock.symbol}</b><small>{stock.name}</small></td>
            <td>{stock.weight === null ? "--" : `${stock.weight.toFixed(1)}%`}</td>
            <td>{price(stock.price)}</td>
            <td className={tone((stock.change_pct ?? 0) * 20)}>{signed(stock.change_pct, 2)}%</td>
            <td className={tone(stock.score)}>{signed(stock.score)}</td>
            <td>{words(stock.label)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Everything saved to Firestore: every 15-minute snapshot (date, time, score, price, breadth, share prices) and the reversals. */
export const SentimentHistoryPanel = memo(function SentimentHistoryPanel() {
  const [date, setDate] = useState<string>(LATEST);
  const [instrument, setInstrument] = useState<string>("ALL");
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [shown, setShown] = useState<string[]>(DEFAULT_SHOWN);
  const dayRef = useRef<string>(LATEST);

  const load = useCallback(async (day: string) => {
    setLoading(true);
    try {
      const next = await fetchHistory(day);
      // A slow reply for a day no longer selected must not overwrite the current one.
      if (day === dayRef.current) { setHistory(next); setError(null); }
    } catch (failure) {
      // Keep the last good history on screen; just say the refresh failed.
      if (day === dayRef.current) setError(failure instanceof Error ? failure.message : "Sentiment history unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    dayRef.current = date;
    void load(date);
    // A past day doesn't change; the latest view and today pick up new snapshots every minute.
    if (date && date !== today()) return;
    const timer = setInterval(() => { if (!document.hidden) void load(date); }, 60_000);
    return () => clearInterval(timer);
  }, [date, load]);

  const snapshots = useMemo(() => history?.snapshots ?? [], [history]);
  const instruments = useMemo(() => {
    const ids = new Set(snapshots.flatMap((snapshot) => [...Object.keys(snapshot.indices ?? {}), ...Object.keys(snapshot.commodities ?? {})]));
    return [...ids].sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99)).map((id) => ({ id, name: snapshots.map((snapshot) => readingOf(snapshot, id)?.name).find(Boolean) ?? id }));
  }, [snapshots]);
  const rows: Row[] = useMemo(() => instrument === "ALL" ? [] : snapshots.flatMap((snapshot) => {
    const index = snapshot.indices?.[instrument];
    const reading = index ?? snapshot.commodities?.[instrument];
    return reading ? [{ snapshot, reading: reading as Row["reading"], kind: index ? "INDEX" as const : "COMMODITY" as const }] : [];
  }), [snapshots, instrument]);
  const reversals = (history?.reversals ?? []).filter((item) => instrument === "ALL" || item.instrument === instrument);
  const isIndex = rows[0]?.kind === "INDEX";

  const exportCsv = () => {
    const name = `sentiment-${instrument.toLowerCase()}-${date || "latest"}.csv`;
    if (instrument === "ALL") {
      download(name, csv([["date", "time_ist", "reasons", ...instruments.flatMap(({ id }) => [`${id}_score`, `${id}_price`, `${id}_change_pct`])],
        ...snapshots.map((snapshot) => [dateOf(snapshot), timeOf(snapshot), reasonsOf(snapshot).join("+"), ...instruments.flatMap(({ id }) => { const reading = readingOf(snapshot, id); return [reading?.score, reading?.price, reading?.change_pct]; })])]));
    } else {
      download(name, csv([["date", "time_ist", "score", "label", "price", "change_pct", "bullish_pct", "bearish_pct", "advances", "declines", "india_impact", "reasons"],
        ...rows.map(({ snapshot, reading }) => [dateOf(snapshot), timeOf(snapshot), reading.score, reading.label, reading.price, reading.change_pct, reading.bullish_pct as number, reading.bearish_pct as number,
          reading.advances as number, reading.declines as number, reading.india_impact as number, reasonsOf(snapshot).join("+")])]));
    }
  };

  const chartSeries = useMemo(() => instrument === "ALL" ? instruments.filter((item) => shown.includes(item.id)) : instruments.filter((item) => item.id === instrument), [instrument, instruments, shown]);
  const toggle = (id: string) => setShown((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  const latest = snapshots[0];
  const recorder = history?.recorder;
  // Explain an empty history, and say so whenever the recorder is failing.
  const recorderNote = !recorder ? null
    : recorder.lastError ? `Recorder is failing (${recorder.failures} of ${recorder.attempts} tries; last ${when(recorder.lastErrorAt)}): ${recorder.lastError}`
    : !snapshots.length && !date ? (recorder.attempts ? `Recorder is running (last try ${when(recorder.lastAttemptAt)}, last save ${when(recorder.lastRecordedAt)}). The first snapshot appears within a minute.` : "The recorder starts about 10 seconds after the server boots. The first snapshot appears within a minute.")
    : null;
  return (
    <section className="isa-panel smh">
      <div className="ce-head">
        <h3>Sentiment history</h3>
        <span className="isa-muted">{latest ? `Last saved ${dateOf(latest)} ${timeOf(latest)} IST` : "Saved to Firestore every 15 min and on every reversal"}</span>
      </div>

      <div className="smh-tools">
        <label>Day <input type="date" value={date} max={today()} onChange={(event) => { setDate(event.target.value); setOpen(null); }} /></label>
        <button type="button" className={date === LATEST ? "active" : ""} onClick={() => setDate(LATEST)}>Latest 48</button>
        <button type="button" className={date === today() ? "active" : ""} onClick={() => setDate(today())}>Today</button>
        <select value={instrument} onChange={(event) => { setInstrument(event.target.value); setOpen(null); }} aria-label="Instrument">
          <option value="ALL">All indices &amp; commodities</option>
          {instruments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <button type="button" onClick={exportCsv} disabled={!snapshots.length}>Download CSV</button>
        {loading ? <small className="isa-muted">Loading…</small> : null}
      </div>
      {error ? <p className="isa-alert">{history ? `Couldn't refresh: ${error} Showing the last history loaded.` : error}</p> : null}
      {(history?.warnings ?? []).map((warning) => <p key={warning} className="isa-alert">{warning}</p>)}
      {recorderNote ? <p className={history?.recorder?.lastError ? "isa-alert" : "isa-muted"}>{recorderNote}</p> : null}

      {history && !snapshots.length ? <p className="isa-muted">No snapshots {date ? `on ${date}` : "yet"}.</p> : null}

      {snapshots.length ? (
        <div className="smc-block">
          <div className="smc-head">
            <h4 className="smh-sub">Sentiment score over time</h4>
            {instrument === "ALL" ? (
              <div className="smc-legend" role="group" aria-label="Lines shown">
                {instruments.map((item) => (
                  <button type="button" key={item.id} className={shown.includes(item.id) ? "on" : ""} aria-pressed={shown.includes(item.id)} onClick={() => toggle(item.id)}>
                    <i style={{ background: seriesColor(item.id) }} />{item.name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {chartSeries.length ? <SentimentChart snapshots={snapshots} series={chartSeries} /> : <p className="isa-muted">Pick at least one line above.</p>}
        </div>
      ) : null}

      {instrument === "ALL" && snapshots.length ? (
        <div className="isa-table-wrap smh-wrap">
          <table className="isa-table smh-table">
            <thead><tr><th>Date</th><th>Time (IST)</th>{instruments.map((item) => <th key={item.id}>{item.name}<small>score · price (chg)</small></th>)}<th>Saved because</th></tr></thead>
            <tbody>
              {snapshots.map((snapshot) => (
                <tr key={snapshot.id}>
                  <td>{dateOf(snapshot)}</td>
                  <td>{timeOf(snapshot)}</td>
                  {instruments.map(({ id }) => {
                    const reading = readingOf(snapshot, id);
                    return (
                      <td key={id}>
                        {reading ? <><b className={tone(reading.score)}>{signed(reading.score)}</b><small>{price(reading.price)} <span className={tone((reading.change_pct ?? 0) * 20)}>({signed(reading.change_pct, 2)}%)</span></small></> : "--"}
                      </td>
                    );
                  })}
                  <td><Reason snapshot={snapshot} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {instrument !== "ALL" && rows.length ? (
        <div className="isa-table-wrap smh-wrap">
          <table className="isa-table smh-table">
            <thead>
              <tr>
                <th>Date</th><th>Time (IST)</th><th>Score</th><th>Δ score</th><th>{isIndex ? "Zone" : "Label"}</th><th>Price</th><th>Change</th>
                {isIndex ? <><th>Bull / bear by weight</th><th>A / D</th><th>Shares</th></> : <th>For India</th>}
                <th>Saved because</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ snapshot, reading }, position) => {
                const older = rows[position + 1]?.reading.score;
                const delta = reading.score !== null && older !== null && older !== undefined ? reading.score - older : null;
                const expanded = open === snapshot.id;
                return (
                  <Fragment key={snapshot.id}>
                    <tr className={reasonsOf(snapshot).includes("REVERSAL") ? "smh-flip" : ""}>
                      <td>{dateOf(snapshot)}</td>
                      <td>{timeOf(snapshot)}</td>
                      <td><b className={tone(reading.score)}>{signed(reading.score)}</b></td>
                      <td className={tone((delta ?? 0) * 3)}>{signed(delta)}</td>
                      <td>{isIndex ? String(reading.zone ?? words(reading.label)) : words(reading.label)}</td>
                      <td>{price(reading.price)}{reading.unit ? <small>{String(reading.unit)}</small> : null}</td>
                      <td className={tone((reading.change_pct ?? 0) * 20)}>{signed(reading.change_pct, 2)}%</td>
                      {isIndex ? (
                        <>
                          <td><span className="isa-up">{pct(reading.bullish_pct)}</span> / <span className="isa-down">{pct(reading.bearish_pct)}</span></td>
                          <td>{String(reading.advances ?? "--")}:{String(reading.declines ?? "--")}</td>
                          <td><button type="button" className="smh-expand" onClick={() => setOpen(expanded ? null : snapshot.id)} aria-expanded={expanded}>{expanded ? "Hide" : "Show"}</button></td>
                        </>
                      ) : <td className={tone(reading.india_impact as number | null)}>{words(reading.india_label)} ({signed(reading.india_impact as number | null)})</td>}
                      <td><Reason snapshot={snapshot} id={instrument} /></td>
                    </tr>
                    {expanded ? <tr className="smh-detail"><td colSpan={11}><Constituents reading={reading} /></td></tr> : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      <h4 className="smh-sub">Reversals{instrument !== "ALL" ? ` · ${instruments.find((item) => item.id === instrument)?.name ?? instrument}` : ""}</h4>
      {reversals.length ? (
        <ul className="smh-list">
          {reversals.map((item) => (
            <li key={item.id}>
              <small>{dateOf(item)} {timeOf(item)}</small>
              <b>{item.name}</b>
              <span>{item.type === "SENTIMENT" ? "sentiment" : "price"} <i className={up(item.from) ? "isa-up" : "isa-down"}>{lower(item.from)}</i> → <i className={up(item.to) ? "isa-up" : "isa-down"}>{lower(item.to)}</i></span>
              <small>score {signed(item.previous_score)} → {signed(item.score)} · price {price(item.price)} ({signed(item.change_pct, 2)}%)</small>
            </li>
          ))}
        </ul>
      ) : <p className="isa-muted">No reversals {date ? `on ${date}` : "recorded yet"}.</p>}
      <small className="isa-muted">A reversal is a sentiment flip (score crossing from +10 or more to -10 or less, or back) or a price flip (day change from +0.2% or more to -0.2% or less, or back). Rows marked with a reversal tag were saved the moment it happened; the rest every 15 minutes.</small>
    </section>
  );
});
