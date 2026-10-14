"use client";

import { memo, useCallback, useEffect, useState } from "react";
import type { TelegramOptionCall } from "../lib/index-sentiment";
import { MAX_ANALYSIS_CHANNELS, normalizeChannel, type TelegramAnalysis } from "../lib/telegram-channels";

const STORAGE_KEY = "tradepulse.telegramAnalysisChannels";
const WINDOWS = [6, 12, 24];
const num = (value: number | null | undefined, digits = 0) => (value === null || value === undefined ? "--" : value.toLocaleString("en-IN", { maximumFractionDigits: digits }));
const ago = (hours: number) => (hours < 1 ? `${Math.max(1, Math.round(hours * 60))}m ago` : `${hours.toFixed(1)}h ago`);

function readSaved(): string[] {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((name): name is string => typeof name === "string") : [];
  } catch { return []; }
}
function save(channels: string[]) {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(channels)); } catch { /* private window: the list lives for this visit only */ }
}

function CallList({ title, calls, tone }: { title: string; calls: TelegramOptionCall[]; tone: string }) {
  return (
    <div className="tga-list">
      <small>{title}</small>
      {calls.length ? (
        <ol>{calls.map((call) => <li key={call.contract + call.side}><b className={tone}>{call.side} {call.contract}</b><span>{call.mentions} ask{call.mentions === 1 ? "" : "s"} · {call.channel_count} ch</span></li>)}</ol>
      ) : <p className="isa-muted">None in the window.</p>}
    </div>
  );
}

/** User-chosen Telegram channels: put / call counts in the window and the five most asked option calls. */
export const TelegramChannelAnalysis = memo(function TelegramChannelAnalysis() {
  const [channels, setChannels] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [windowHours, setWindowHours] = useState(12);
  const [result, setResult] = useState<TelegramAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async (list: string[], hours: number) => {
    if (!list.length) { setResult(null); return; }
    setLoading(true);
    try {
      const response = await fetch("/api/telegram-analysis", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channels: list, window_hours: hours }) });
      const body = await response.json();
      if (!response.ok || body.error) throw new Error(body.error ?? "Telegram analysis unavailable");
      setResult(body as TelegramAnalysis);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Telegram analysis unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const saved = readSaved();
    setChannels(saved);
    if (saved.length) void run(saved, 12);
  }, [run]);

  const update = (next: string[]) => { setChannels(next); save(next); };
  const add = () => {
    const names = draft.split(/[\s,]+/).filter(Boolean);
    const valid = names.map(normalizeChannel).filter((name): name is string => name !== null);
    const known = new Set(channels.map((name) => name.toLowerCase()));
    const fresh = valid.filter((name) => !known.has(name.toLowerCase()) && (known.add(name.toLowerCase()), true));
    const next = [...channels, ...fresh].slice(0, MAX_ANALYSIS_CHANNELS);
    setError(valid.length < names.length ? `Skipped ${names.length - valid.length} invalid name(s): use a public channel username, @name or t.me link.` : channels.length + fresh.length > MAX_ANALYSIS_CHANNELS ? `At most ${MAX_ANALYSIS_CHANNELS} channels.` : null);
    update(next);
    setDraft("");
  };
  const remove = (name: string) => update(channels.filter((channel) => channel !== name));

  const totals = result?.totals;
  const share = totals && totals.calls + totals.puts ? (100 * totals.calls) / (totals.calls + totals.puts) : null;
  return (
    <section className="isa-panel tga">
      <div className="ce-head">
        <h3>Telegram channel analysis</h3>
        <span className="isa-muted">Add the public channels you follow · calls (CE) vs puts (PE) in the last {windowHours}h · top 5 most asked</span>
      </div>

      <form className="tga-form" onSubmit={(event) => { event.preventDefault(); add(); }}>
        <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="@channel, t.me/channel or several separated by commas" aria-label="Telegram channel" />
        <button type="submit" disabled={!draft.trim()}>Add</button>
        <select value={windowHours} onChange={(event) => setWindowHours(Number(event.target.value))} aria-label="Window">
          {WINDOWS.map((hours) => <option key={hours} value={hours}>Last {hours}h</option>)}
        </select>
        <button type="button" className="tga-run" onClick={() => void run(channels, windowHours)} disabled={loading || !channels.length}>{loading ? "Analysing…" : `Analyse ${channels.length} channel${channels.length === 1 ? "" : "s"}`}</button>
      </form>
      <div className="tgo-channels">
        {channels.map((name) => {
          const row = result?.channels.find((item) => item.channel.toLowerCase() === name.toLowerCase());
          return (
            <span key={name} className={row ? (row.ok ? "isa-chip ok" : "isa-chip tga-bad") : "isa-chip"} title={row?.error ?? ""}>
              @{name}{row ? `: ${row.calls} CE / ${row.puts} PE` : ""}
              <button type="button" className="tga-remove" onClick={() => remove(name)} aria-label={`Remove ${name}`}>×</button>
            </span>
          );
        })}
        {channels.length === 0 ? <span className="isa-muted">No channels yet: add one or more public Telegram channels above.</span> : null}
        {channels.length ? <button type="button" className="tga-clear" onClick={() => { update([]); setResult(null); }}>Clear all</button> : null}
      </div>
      {error ? <p className="isa-alert">{error}</p> : null}

      {result && totals ? (
        <>
          <div className="tga-stats">
            <div><small>Channels read</small><strong>{result.channels_read} / {result.channels_requested}</strong><em>{result.posts_scanned} posts · {result.calls_parsed} option calls</em></div>
            <div><small>Calls (CE)</small><strong className="isa-up">{totals.calls}</strong><em>{totals.call_buys} buy · {totals.call_sells} sell</em></div>
            <div><small>Puts (PE)</small><strong className="isa-down">{totals.puts}</strong><em>{totals.put_buys} buy · {totals.put_sells} sell</em></div>
            <div><small>Put / call ratio</small><strong>{num(totals.put_call_ratio, 2)}</strong><em className={result.bias === "BULLISH" ? "isa-up" : result.bias === "BEARISH" ? "isa-down" : "isa-muted"}>{result.bias.toLowerCase()} crowd{result.bullish_pct === null ? "" : ` · ${result.bullish_pct.toFixed(0)}% bullish`}</em></div>
          </div>
          {share !== null ? <div className="isa-split tga-split"><i className="isa-fill-up" style={{ width: `${share}%` }} /><i className="isa-fill-down" style={{ width: `${100 - share}%` }} /></div> : null}

          <h4 className="tga-title">Top 5 most asked option calls (last {result.window_hours.toFixed(0)}h)</h4>
          {result.top.length ? (
            <div className="isa-table-wrap">
              <table className="isa-table tgo-table">
                <thead><tr><th>#</th><th>Contract</th><th>Channels</th><th>Asks</th><th>Entry / Tgt / SL</th><th>Plan odds</th><th>R:R</th><th>vs spot</th><th>Latest</th></tr></thead>
                <tbody>
                  {result.top.map((call, index) => (
                    <tr key={call.contract + call.side}>
                      <td>{index + 1}</td>
                      <td><b className={call.type === "CE" ? "isa-up" : "isa-down"}>{call.side} {call.contract}</b><small title={call.posts.map((post) => `@${post.channel}: ${post.text}`).join("\n")}>{call.channels.map((name) => `@${name}`).join(", ")}</small></td>
                      <td>{call.channel_count}</td>
                      <td>{call.mentions}</td>
                      <td>{num(call.entry, 2)} / {num(call.target, 2)} / {num(call.stop, 2)}</td>
                      <td>{call.plan_odds === null ? "--" : `${Math.round(call.plan_odds * 100)}%`}</td>
                      <td>{call.reward_risk === null ? "--" : call.reward_risk.toFixed(2)}</td>
                      <td>{call.moneyness_pct === null ? "--" : `${call.moneyness_pct > 0 ? "+" : ""}${call.moneyness_pct.toFixed(1)}%${call.far_otm ? " far OTM" : call.otm ? " OTM" : " ITM"}`}</td>
                      <td>{ago(call.latest_age_hours)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="isa-muted">No option calls found in these channels in the last {result.window_hours.toFixed(0)}h.</p>}

          <div className="tga-lists">
            <CallList title="Top 5 calls (CE)" calls={result.top_calls} tone="isa-up" />
            <CallList title="Top 5 puts (PE)" calls={result.top_puts} tone="isa-down" />
          </div>
          {result.notes.length ? <ul className="isa-notes">{result.notes.map((note) => <li key={note}>{note}</li>)}</ul> : null}
          <small className="isa-muted">Analysed {new Date(result.generated_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })} IST. {result.method} Most asked is not most likely to work; tip channels are often not SEBI-registered. This is a crowd reading, not a recommendation.</small>
        </>
      ) : null}
    </section>
  );
});
