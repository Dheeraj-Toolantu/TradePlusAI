"use client";

import { memo, useEffect, useRef, useState } from "react";
import type { TelegramLive } from "../lib/telegram-live";
import type { Connection } from "./use-live-feeds";

const LABEL: Record<Connection, string> = { live: "Live · WebSocket", polling: "Auto-refresh · HTTP", connecting: "Connecting…", paused: "Paused (tab hidden, alerts off)", synced: "Live · shared from another open tab" };
const ago = (iso: string, now: number) => {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  return minutes < 60 ? `${minutes}m ago` : `${(minutes / 60).toFixed(1)}h ago`;
};

/** Newest posts across the channels; posts that arrived since the page opened are marked NEW. */
export const TelegramLiveFeed = memo(function TelegramLiveFeed({ live, connection, error }: { live: TelegramLive | null; connection: Connection; error: string | null }) {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const [filter, setFilter] = useState<"ALL" | "OPTIONS" | "STOCKS">("ALL");

  useEffect(() => {
    if (!live) return;
    const links = live.feed.map((post) => post.link);
    if (seen.current === null) { seen.current = new Set(links); return; } // first load: nothing is "new"
    const arrived = links.filter((link) => !seen.current!.has(link));
    arrived.forEach((link) => seen.current!.add(link));
    if (arrived.length) setFresh((current) => new Set([...current, ...arrived]));
  }, [live]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const posts = (live?.feed ?? []).filter((post) => filter === "ALL" || (filter === "OPTIONS" ? post.options.length > 0 : post.stocks.length > 0));
  return (
    <section className="isa-panel tgl">
      <div className="ce-head">
        <h3>Telegram live feed</h3>
        <span className={`tgl-status tgl-${connection}`}><i />{LABEL[connection]}{live ? ` · scanned ${ago(live.generated_at, now)}` : ""}</span>
      </div>
      {error ? <p className="isa-alert">{error}{live ? " (showing the last scan)" : ""}</p> : null}
      {live ? (
        <>
          <div className="tgo-channels">
            {live.channels.map((row) => <span key={row.id} className={row.ok ? "isa-chip ok" : "isa-chip"} title={row.error ?? ""}>{row.name}: {row.fresh} fresh{row.cached ? " (cached)" : ""}</span>)}
          </div>
          <div className="tgl-tools">
            {(["ALL", "OPTIONS", "STOCKS"] as const).map((value) => <button type="button" key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{value === "ALL" ? "All posts" : value === "OPTIONS" ? "Option calls" : "Stock calls"}</button>)}
          </div>
          <ul className="tgl-posts">
            {posts.map((post) => (
              <li key={post.link} className={fresh.has(post.link) ? "new" : ""}>
                <div className="tgl-meta">
                  {fresh.has(post.link) ? <b className="tgl-new">NEW</b> : null}
                  <a href={post.link} target="_blank" rel="noreferrer">@{post.channel}</a>
                  <small>{ago(post.published, now)} · {post.views.toLocaleString("en-IN")} views</small>
                  {post.options.map((call) => <i key={call} className={call.endsWith("CE") ? "ce-chip tgl-ce" : "ce-chip tgl-pe"}>{call}</i>)}
                  {post.stocks.map((symbol) => <i key={symbol} className="ce-chip ce-chip-tg">{symbol}</i>)}
                </div>
                <p>{post.text}</p>
              </li>
            ))}
            {posts.length === 0 ? <li className="isa-muted">No posts in the last {live.window_hours.toFixed(0)}h{filter !== "ALL" ? " for this filter" : ""}.</li> : null}
          </ul>
        </>
      ) : <p className="isa-muted">Waiting for the first Telegram scan…</p>}
    </section>
  );
});
