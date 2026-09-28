"use client";

import { useEffect, useState } from "react";

type AIStreamState = { state: string; direction?: string; status?: string; confidence?: number; connected: boolean };

export default function IntelligencePage() {
  const [ai, setAi] = useState<AIStreamState>({ state: "CONNECTING", connected: false });

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(process.env.NEXT_PUBLIC_API_WS_URL ?? `${protocol}://${window.location.hostname}:4000/ws/quotes`);
    socket.onopen = () => {
      setAi((current) => ({ ...current, connected: true }));
      socket.send(JSON.stringify({ channels: ["ai-monitoring"] }));
    };
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as { type?: string; error?: string; monitoring?: { state?: string }; latest?: { direction?: string; status?: string; confidence?: number } };
        if (message.type !== "ai-monitoring") return;
        if (message.error) {
          setAi((current) => ({ ...current, state: "UNAVAILABLE" }));
          return;
        }
        setAi({ state: String(message.monitoring?.state ?? "DISABLED"), direction: message.latest?.direction, status: message.latest?.status, confidence: message.latest?.confidence, connected: true });
      } catch { setAi((current) => ({ ...current, state: "UNAVAILABLE" })); }
    };
    socket.onerror = () => setAi((current) => ({ ...current, state: "UNAVAILABLE", connected: false }));
    socket.onclose = () => setAi((current) => ({ ...current, connected: false }));
    return () => socket.close();
  }, []);

  return <main style={{ padding: 32, color: "#e6f2f3", background: "#06141c", minHeight: "100vh", fontFamily: "Manrope, sans-serif" }}><p style={{ color: "#30d4ca", letterSpacing: 2 }}>CONTEXT ENGINE</p><h1>AI Market Brain</h1><p>AI stream <b style={{ color: ai.connected ? "#30d4ca" : "#fa6b78" }}>{ai.connected ? "CONNECTED" : "DISCONNECTED"}</b> · State <b>{ai.state}</b></p><p>Latest direction <b>{ai.direction ?? "WAITING"}</b> · Status <b>{ai.status ?? "NO EVALUATION"}</b>{ai.confidence !== undefined ? ` · Confidence ${ai.confidence}%` : ""}</p><p>News can inform regime and risk gates, but cannot submit orders.</p><section style={{ marginTop: 24, border: "1px solid #173944", padding: 16 }}><b>News outcome tracker</b><p>Predictions are stored with 1m, 5m, 15m, 30m, 1h, and 1d outcomes. Calibration reports never rewrite the original prediction.</p><strong>Calibration: awaiting samples</strong></section><a href="/" style={{ color: "#30d4ca" }}>Back to dashboard</a></main>;
}