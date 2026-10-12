"use client";

import { useEffect, useState } from "react";
import type { TelegramOptionCall, TelegramOptions } from "../lib/index-sentiment";

type Live = { premium: number; delta: number; iv: number; expiry: string };
type Status = { label: string; tone: string; odds: number | null };

const pct = (value: number | null | undefined) => (value === null || value === undefined ? "--" : `${Math.round(value * 100)}%`);
const num = (value: number | null | undefined, digits = 0) => (value === null || value === undefined ? "--" : value.toLocaleString("en-IN", { maximumFractionDigits: digits }));
const ago = (hours: number) => (hours < 1 ? `${Math.max(1, Math.round(hours * 60))}m ago` : `${hours.toFixed(1)}h ago`);

/** Where the tipped plan stands at the current premium (current price only, not the path since the call). */
function status(call: TelegramOptionCall, live: Live | undefined): Status {
  if (!live) return { label: "No live price", tone: "isa-muted", odds: call.plan_odds };
  const { target, stop } = call;
  if (target === null || stop === null) return { label: "Open (no levels)", tone: "isa-flat", odds: null };
  const buy = call.side === "BUY";
  if (buy ? live.premium >= target : live.premium <= target) return { label: "At / past target", tone: "isa-up", odds: null };
  if (buy ? live.premium <= stop : live.premium >= stop) return { label: "At / past stop loss", tone: "isa-down", odds: null };
  const odds = buy ? (live.premium - stop) / (target - stop) : (stop - live.premium) / (stop - target);
  return { label: "Open", tone: "isa-flat", odds: Math.max(0, Math.min(1, odds)) };
}

export function TelegramOptionsDesk({ options }: { options: TelegramOptions }) {
  const [live, setLive] = useState<Record<string, Live>>({});
  const [liveError, setLiveError] = useState<string | null>(null);

  useEffect(() => {
    const underlyings = [...new Set(options.consensus.slice(0, 10).map((call) => call.underlying))].slice(0, 4);
    if (!underlyings.length) return;
    let cancelled = false;
    Promise.all(underlyings.map(async (symbol) => {
      const response = await fetch(`/api/option-chain?symbol=${encodeURIComponent(symbol)}&full=1`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Option chain unavailable");
      return (body.contracts as Array<{ strike: number; contract: "CALL" | "PUT"; premium: number; delta: number; iv: number; expiry: string }>).map((row) => [`${symbol}|${row.strike}|${row.contract === "CALL" ? "CE" : "PE"}`, { premium: row.premium, delta: row.delta, iv: row.iv, expiry: row.expiry }] as const);
    }))
      .then((rows) => { if (!cancelled) { setLive(Object.fromEntries(rows.flat())); setLiveError(null); } })
      .catch((error) => { if (!cancelled) setLiveError(error instanceof Error ? error.message : "Option chain unavailable"); });
    return () => { cancelled = true; };
  }, [options]);

  const key = (call: TelegramOptionCall) => `${call.underlying}|${call.strike}|${call.type}`;
  const top = options.top_pick;
  const topLive = top ? live[key(top)] : undefined;
  const topStatus = top ? status(top, topLive) : null;

  return (
    <section className="isa-panel tgo">
      <div className="ce-head">
        <h3>Telegram option calls: consensus</h3>
        <span className="isa-muted">Last {options.window_hours.toFixed(0)}h · {options.posts_scanned} posts · {options.calls_parsed} option calls parsed · {options.channels.length} channels</span>
      </div>
      <div className="tgo-channels">{options.channels.map((row) => <span key={row.channel} className={row.option_calls ? "isa-chip ok" : "isa-chip"}>@{row.channel}: {row.option_calls} calls / {row.posts} posts</span>)}</div>

      {top ? (
        <div className="tgo-top">
          <div>
            <small>Most crowded call</small>
            <strong className={top.type === "CE" ? "isa-up" : "isa-down"}>{top.side} {top.contract}</strong>
            <em>{top.channel_count} channel{top.channel_count === 1 ? "" : "s"} · {top.mentions} mention{top.mentions === 1 ? "" : "s"} · latest {ago(top.latest_age_hours)}</em>
          </div>
          <dl>
            <div><dt>Entry / target / SL</dt><dd>{num(top.entry, 2)} / {num(top.target, 2)} / {num(top.stop, 2)}</dd></div>
            <div><dt>Plan odds</dt><dd title="Chance a premium with no edge reaches the target before the stop loss">{pct(topStatus?.odds ?? top.plan_odds)}</dd></div>
            <div><dt>Reward : risk</dt><dd>{top.reward_risk === null ? "--" : `${top.reward_risk.toFixed(2)} : 1`}</dd></div>
            <div><dt>Live premium</dt><dd>{topLive ? num(topLive.premium, 2) : "--"}</dd></div>
            <div><dt>Delta (≈ chance ITM)</dt><dd>{topLive ? pct(Math.abs(topLive.delta)) : "--"}</dd></div>
            <div><dt>Status</dt><dd className={topStatus?.tone}>{topStatus?.label}</dd></div>
          </dl>
          <p className="isa-muted">Most crowded is not most likely. With no edge every plan has zero expected value: higher odds always come with a smaller reward (odds × (1 + reward/risk) = 1), so any profit has to come from a real edge, and costs and slippage push it below zero.{top.far_otm ? " This strike is far out of the money: a lottery ticket." : ""}</p>
        </div>
      ) : <p className="isa-muted">No option calls parsed from the channels in the window (or Telegram unreachable).</p>}

      {options.by_underlying.length ? (
        <div className="tgo-bias">
          {options.by_underlying.map((row) => (
            <div key={row.underlying}>
              <small>{row.underlying}: {row.ce_buys} CE / {row.pe_buys} PE buys{row.ce_sells + row.pe_sells ? ` · ${row.ce_sells} CE / ${row.pe_sells} PE sells` : ""}</small>
              <div className="isa-split">{row.bullish_pct === null ? null : <><i className="isa-fill-up" style={{ width: `${row.bullish_pct}%` }} /><i className="isa-fill-down" style={{ width: `${100 - row.bullish_pct}%` }} /></>}</div>
              <em className={row.bias === "BULLISH" ? "isa-up" : row.bias === "BEARISH" ? "isa-down" : "isa-muted"}>{row.bias.toLowerCase()} crowd</em>
            </div>
          ))}
        </div>
      ) : null}
      {options.notes.length ? <ul className="isa-notes">{options.notes.map((note) => <li key={note}>{note}</li>)}</ul> : null}

      {options.consensus.length ? (
        <div className="isa-table-wrap">
          <table className="isa-table tgo-table">
            <thead><tr><th>#</th><th>Contract</th><th>Channels</th><th>Mentions</th><th>Entry / Tgt / SL</th><th>Plan odds</th><th>R:R</th><th>vs spot</th><th>Live</th><th>Delta</th><th>Status</th></tr></thead>
            <tbody>
              {options.consensus.map((call, index) => {
                const quote = live[key(call)];
                const state = status(call, quote);
                return (
                  <tr key={key(call) + call.side}>
                    <td>{index + 1}</td>
                    <td><b className={call.type === "CE" ? "isa-up" : "isa-down"}>{call.side} {call.contract}</b><small title={call.posts.map((post) => `@${post.channel}: ${post.text}`).join("\n")}>{call.channels.map((name) => `@${name}`).join(", ")} · {ago(call.latest_age_hours)}</small></td>
                    <td>{call.channel_count}</td>
                    <td>{call.mentions}</td>
                    <td>{num(call.entry, 2)} / {num(call.target, 2)} / {num(call.stop, 2)}</td>
                    <td>{pct(state.odds ?? call.plan_odds)}</td>
                    <td>{call.reward_risk === null ? "--" : call.reward_risk.toFixed(2)}</td>
                    <td>{call.moneyness_pct === null ? "--" : `${call.moneyness_pct > 0 ? "+" : ""}${call.moneyness_pct.toFixed(1)}%${call.far_otm ? " far OTM" : call.otm ? " OTM" : " ITM"}`}</td>
                    <td>{quote ? num(quote.premium, 2) : "--"}</td>
                    <td>{quote ? pct(Math.abs(quote.delta)) : "--"}</td>
                    <td className={state.tone}>{state.label}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      <small className="isa-muted">{liveError ? `Live option prices unavailable (${liveError}). ` : ""}Status uses the current premium only, not the path since the call. {options.method} Tip channels are often not SEBI-registered; SEBI's studies found about nine in ten individual F&amp;O traders lose money. This is a crowd reading, not a recommendation.</small>
    </section>
  );
}
