"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const LOCK = "tradepulse-sentiment-leader";
const CHANNEL = "tradepulse-sentiment";
const PRESENCE_TTL_MS = 90_000;
/** Topic passed to `onData` when another tab opens, so the leader can send it the latest data. */
export const JOINED = "__joined";

export type TabMessage =
  | { kind: "data"; topic: string; payload: unknown }
  | { kind: "presence"; tab: string; active: boolean }
  | { kind: "hello"; tab: string }
  | { kind: "bye"; tab: string };

const isActive = () => !document.hidden && document.hasFocus();

/**
 * Coordinates every open tab of the page so the work happens once:
 *
 * - Leader election with the Web Locks API: exactly one tab holds the lock and runs the live feeds;
 *   when it closes, the next tab takes over within moments. Chrome also does not freeze a
 *   background tab that holds a lock, so the leader keeps running while you work elsewhere.
 * - A BroadcastChannel carries the leader's data to the other tabs (no extra requests) and each
 *   tab's presence, so alerts are delivered once: by the tab you are looking at, or, when no tab of
 *   the page is in front, by the leader as a system notification.
 *
 * Browsers without Web Locks or BroadcastChannel fall back to every tab being its own leader.
 */
export function useTabSync(onData: (topic: string, payload: unknown) => void) {
  const [leader, setLeader] = useState(false);
  const [tabs, setTabs] = useState(1);
  const tab = useRef("");
  const channel = useRef<BroadcastChannel | null>(null);
  const presence = useRef(new Map<string, { active: boolean; at: number }>());
  const handler = useRef(onData);
  handler.current = onData;

  useEffect(() => {
    tab.current = Math.random().toString(36).slice(2, 10);
    const others = presence.current;
    const count = () => {
      const now = Date.now();
      for (const [id, row] of others) if (now - row.at > PRESENCE_TTL_MS) others.delete(id);
      setTabs(others.size + 1);
    };
    const announce = () => channel.current?.postMessage({ kind: "presence", tab: tab.current, active: isActive() } satisfies TabMessage);

    if (typeof BroadcastChannel !== "undefined") {
      channel.current = new BroadcastChannel(CHANNEL);
      channel.current.onmessage = (event: MessageEvent<TabMessage>) => {
        const message = event.data;
        if (message.kind === "data") handler.current(message.topic, message.payload);
        else if (message.kind === "presence") { others.set(message.tab, { active: message.active, at: Date.now() }); count(); }
        else if (message.kind === "hello") { others.set(message.tab, { active: false, at: Date.now() }); count(); announce(); handler.current(JOINED, message.tab); }
        else if (message.kind === "bye") { others.delete(message.tab); count(); }
      };
      channel.current.postMessage({ kind: "hello", tab: tab.current } satisfies TabMessage);
    }

    // Presence on focus changes, plus a slow heartbeat so a crashed tab ages out.
    const events = ["visibilitychange", "focus", "blur"] as const;
    events.forEach((name) => (name === "visibilitychange" ? document : window).addEventListener(name, announce));
    const heartbeat = setInterval(() => { announce(); count(); }, PRESENCE_TTL_MS / 3);
    const bye = () => channel.current?.postMessage({ kind: "bye", tab: tab.current } satisfies TabMessage);
    window.addEventListener("pagehide", bye);

    const abort = new AbortController();
    let release: (() => void) | null = null;
    if (typeof navigator !== "undefined" && navigator.locks) {
      navigator.locks
        .request(LOCK, { signal: abort.signal }, () => new Promise<void>((resolve) => { release = resolve; setLeader(true); }))
        .catch(() => undefined); // aborted on unmount while waiting
    } else {
      setLeader(true);
    }

    return () => {
      abort.abort();
      release?.();
      setLeader(false);
      bye();
      events.forEach((name) => (name === "visibilitychange" ? document : window).removeEventListener(name, announce));
      window.removeEventListener("pagehide", bye);
      clearInterval(heartbeat);
      channel.current?.close();
      channel.current = null;
    };
  }, []);

  /** Send data to every other tab. */
  const share = useCallback((topic: string, payload: unknown) => {
    try { channel.current?.postMessage({ kind: "data", topic, payload } satisfies TabMessage); } catch { /* uncloneable payload: other tabs fetch their own */ }
  }, []);
  /** True when another tab of the page is visible and focused (that tab delivers alerts). */
  const otherTabActive = useCallback(() => {
    const now = Date.now();
    for (const row of presence.current.values()) if (row.active && now - row.at <= PRESENCE_TTL_MS) return true;
    return false;
  }, []);

  return { leader, tabs, share, otherTabActive };
}
