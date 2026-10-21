"use client";

import { useEffect, useRef, useState } from "react";
import type { TelegramLive } from "../lib/telegram-live";

export type Connection = "connecting" | "live" | "polling" | "paused" | "synced";

const FALLBACK_AFTER_MS = 8_000;
const TELEGRAM_POLL_MS = 60_000;
const SENTIMENT_POLL_MS = 120_000;

/**
 * Live sentiment feeds. Prefers the API WebSocket ("telegram" pushes, "index-sentiment" new-scan
 * notices); if it can't connect, polls the same endpoints over HTTP. With `background` off nothing
 * is fetched while the tab is hidden (both catch up once it is visible); with it on, the feeds keep
 * running in a hidden tab so alerts can fire (browsers throttle background timers to ~1/minute).
 * With `enabled` off (another tab is the leader and shares its data) nothing connects at all.
 */
export function useLiveFeeds(options: { onTelegram: (live: TelegramLive) => void; onNewScan: (generatedAt: string) => void; background?: boolean; enabled?: boolean }): { connection: Connection; telegramError: string | null } {
  const [connection, setConnection] = useState<Connection>("connecting");
  const [telegramError, setTelegramError] = useState<string | null>(null);
  const handlers = useRef(options);
  handlers.current = options;
  const background = useRef(Boolean(options.background));
  background.current = Boolean(options.background);

  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) { setConnection("synced"); setTelegramError(null); return; }
    setConnection("connecting");
    let socket: WebSocket | null = null;
    let retry = 1_000;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTelegram: ReturnType<typeof setInterval> | null = null;
    let pollSentiment: ReturnType<typeof setInterval> | null = null;
    let lastSignature = "";
    let closed = false;
    const paused = () => document.hidden && !background.current;

    const telegramOverHttp = async () => {
      if (paused()) return;
      try {
        const response = await fetch("/api/telegram-live", { cache: "no-cache" });
        const body = await response.json();
        if (!response.ok || body.error) throw new Error(body.error ?? "Telegram scan unavailable");
        if (body.signature !== lastSignature) { lastSignature = body.signature; handlers.current.onTelegram(body as TelegramLive); }
        setTelegramError(null);
      } catch (error) { setTelegramError(error instanceof Error ? error.message : "Telegram scan unavailable"); }
    };
    const sentimentOverHttp = async () => {
      if (paused()) return;
      try {
        const body = await (await fetch("/api/index-sentiment?meta=1", { cache: "no-store" })).json();
        if (typeof body.generated_at === "string") handlers.current.onNewScan(body.generated_at);
      } catch { /* the page keeps its last scan */ }
    };
    const startPolling = () => {
      if (pollTelegram || closed) return;
      setConnection(paused() ? "paused" : "polling");
      void telegramOverHttp();
      pollTelegram = setInterval(() => void telegramOverHttp(), TELEGRAM_POLL_MS);
      pollSentiment = setInterval(() => void sentimentOverHttp(), SENTIMENT_POLL_MS);
    };
    const stopPolling = () => {
      if (pollTelegram) clearInterval(pollTelegram);
      if (pollSentiment) clearInterval(pollSentiment);
      pollTelegram = pollSentiment = null;
    };

    const connect = () => {
      if (closed) return;
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      try {
        socket = new WebSocket(process.env.NEXT_PUBLIC_API_WS_URL ?? `${protocol}://${window.location.hostname}:4000/ws/quotes`);
      } catch { startPolling(); return; }
      fallbackTimer = setTimeout(startPolling, FALLBACK_AFTER_MS);
      socket.onopen = () => {
        retry = 1_000;
        if (fallbackTimer) clearTimeout(fallbackTimer);
        stopPolling();
        setConnection(paused() ? "paused" : "live");
        socket?.send(JSON.stringify({ channels: ["telegram", "index-sentiment"] }));
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data as string) as { type?: string; data?: TelegramLive; generated_at?: string; error?: string };
          if (message.type === "telegram") {
            if (message.error) { setTelegramError(message.error); return; }
            if (message.data && message.data.signature !== lastSignature) { lastSignature = message.data.signature; handlers.current.onTelegram(message.data); }
            setTelegramError(null);
          } else if (message.type === "index-sentiment" && message.generated_at) {
            handlers.current.onNewScan(message.generated_at);
          }
        } catch { /* ignore malformed frames */ }
      };
      socket.onclose = () => {
        socket = null;
        if (closed) return;
        startPolling(); // keep data flowing while we retry the socket
        reconnectTimer = setTimeout(connect, retry);
        retry = Math.min(retry * 2, 30_000);
      };
      socket.onerror = () => socket?.close();
    };

    const onVisibility = () => {
      if (paused()) { setConnection("paused"); return; }
      setConnection(socket?.readyState === WebSocket.OPEN ? "live" : pollTelegram ? "polling" : "connecting");
      if (pollTelegram) { void telegramOverHttp(); void sentimentOverHttp(); }
    };
    document.addEventListener("visibilitychange", onVisibility);
    connect();
    return () => {
      closed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      stopPolling();
      socket?.close();
    };
  }, [enabled]);

  return { connection, telegramError };
}
