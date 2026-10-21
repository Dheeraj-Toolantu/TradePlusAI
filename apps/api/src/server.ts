import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { createGrowwTransport } from "../../../adapters/groww/src/groww-adapter";
import { createLtpFetcher } from "../../../adapters/groww/src/groww-ltp";
import { QuoteHub, type FeedStatus, type QuoteTick } from "./quote-hub";

for (const filename of [path.resolve(process.cwd(), ".env.local"), path.resolve(process.cwd(), "../web/.env.local"), path.resolve(process.cwd(), "../../apps/web/.env.local")]) {
  if (!existsSync(filename)) continue;
  for (const line of readFileSync(filename, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  break;
}

const port = Number(process.env.API_PORT ?? 4000);
const quotePollMs = Math.max(1000, Number(process.env.QUOTE_POLL_MS) || 1500);
const hub = new QuoteHub(createLtpFetcher(createGrowwTransport()), { intervalMs: quotePollMs });

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
  response.end(JSON.stringify({ service: "tradepulse-api", status: "ready", quotes: hub.currentStatus(), sockets: sockets.clients.size }));
});

server.listen(port, () => {
  console.log(`TradePulse API listening on http://localhost:${port} (quote poll ${quotePollMs} ms)`);
});

const sockets = new WebSocketServer({ server, path: "/ws/quotes", perMessageDeflate: false });
const webAppUrl = process.env.WEB_APP_URL ?? "http://localhost:3000";
const aiMonitoringUrl = process.env.AI_MONITORING_STATUS_URL ?? `${webAppUrl}/api/ai-monitoring`;
const MAX_BUFFERED_BYTES = 1_000_000;

type Client = { socket: WebSocket; alive: boolean; underlying: string; market: Set<string>; options: Set<string>; trades: Set<string>; ai: boolean; channels: Set<string>; lastStatus: string };
const clients = new Map<string, Client>();

function send(socket: WebSocket, message: unknown) {
  // A slow tab gets skipped rather than letting frames pile up in server memory.
  if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < MAX_BUFFERED_BYTES) socket.send(JSON.stringify(message));
}

function sendStatus(client: Client, status: FeedStatus) {
  const key = `${status.state}|${status.detail ?? ""}`;
  if (key === client.lastStatus) return;
  client.lastStatus = key;
  send(client.socket, { type: "status", ...status });
}

function sendTicks(client: Client, cash: QuoteTick[], fno: QuoteTick[]) {
  const markets = cash.filter((tick) => client.market.has(tick.symbol));
  if (markets.length) send(client.socket, { type: "markets", quotes: markets });
  const underlying = cash.find((tick) => tick.symbol === client.underlying);
  if (underlying) send(client.socket, { type: "market", underlying: client.underlying, quote: underlying });
  const chain = fno.filter((tick) => client.options.has(tick.symbol));
  if (chain.length) send(client.socket, { type: "chain", underlying: client.underlying, quotes: chain });
  const trades = fno.filter((tick) => client.trades.has(tick.symbol));
  if (trades.length) send(client.socket, { type: "quotes", quotes: trades });
}

hub.subscribe((changed, status) => {
  const cash = [...changed.cash.values()];
  const fno = [...changed.fno.values()];
  for (const client of clients.values()) {
    sendStatus(client, status);
    if (cash.length || fno.length) sendTicks(client, cash, fno);
  }
});

// ---- AI monitoring: one shared poll for every subscribed socket -----------------------
let aiTimer: ReturnType<typeof setInterval> | null = null;
let aiBusy = false;
async function publishAiMonitoring() {
  const targets = [...clients.values()].filter((client) => client.ai);
  if (!targets.length) { if (aiTimer) clearInterval(aiTimer); aiTimer = null; return; }
  if (aiBusy) return;
  aiBusy = true;
  let message: unknown;
  try {
    const response = await fetch(aiMonitoringUrl, { headers: { "x-user-id": "local-user" }, cache: "no-store", signal: AbortSignal.timeout(4000) });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    const monitoring = (data.monitoring ?? {}) as Record<string, unknown>;
    const health = (data.health ?? {}) as Record<string, unknown>;
    const latest = (data.latest ?? {}) as Record<string, unknown>;
    const log = (data.log ?? {}) as Record<string, unknown>;
    message = {
      type: "ai-monitoring",
      monitoring: { sessionId: monitoring.sessionId, state: monitoring.state, monitoringEnabled: monitoring.monitoringEnabled, automationEnabled: monitoring.automationEnabled, mode: monitoring.mode },
      health: { blockers: Array.isArray(health.blockers) ? health.blockers.slice(0, 12) : [] },
      latest: { direction: latest.direction, status: latest.status, confidence: latest.confidence, invalidation: latest.invalidation },
      log: { items: Array.isArray(log.items) ? log.items.slice(-20) : [] },
    };
  } catch {
    message = { type: "ai-monitoring", error: "AI monitoring status unavailable" };
  } finally {
    aiBusy = false;
  }
  for (const client of clients.values()) if (client.ai) send(client.socket, message);
}
function ensureAiPoller() {
  if (!aiTimer) aiTimer = setInterval(() => { void publishAiMonitoring(); }, 5000);
  void publishAiMonitoring();
}

// ---- Sentiment channels: one shared poll per channel, pushed only when the content changes ----
// "telegram": the fast Telegram scan (channels, option-call consensus, live feed), ~every minute.
// "index-sentiment": a small notice when a new full scan exists; pages then fetch it over HTTP
// (gzip + ETag), so the 100+ KB payload never goes out to every socket.
type Feed = { url: string; intervalMs: number; build: (body: Record<string, unknown>) => { version: string; message: Record<string, unknown> } | null };
const FEEDS: Record<string, Feed> = {
  telegram: {
    url: `${webAppUrl}/api/telegram-live`,
    intervalMs: Math.max(30_000, Number(process.env.TELEGRAM_POLL_MS) || 60_000),
    build: (body) => typeof body.signature === "string" ? { version: `${body.signature}`, message: { type: "telegram", data: body } } : null,
  },
  "index-sentiment": {
    url: `${webAppUrl}/api/index-sentiment?meta=1`,
    intervalMs: Math.max(30_000, Number(process.env.INDEX_SENTIMENT_POLL_MS) || 60_000),
    build: (body) => typeof body.generated_at === "string" ? { version: body.generated_at, message: { type: "index-sentiment", generated_at: body.generated_at } } : null,
  },
};
const feedState = new Map<string, { timer: ReturnType<typeof setInterval> | null; busy: boolean; version: string | null; last: Record<string, unknown> | null }>();

async function pollFeed(name: string) {
  const feed = FEEDS[name];
  const state = feedState.get(name)!;
  const targets = [...clients.values()].filter((client) => client.channels.has(name));
  if (!targets.length) { if (state.timer) clearInterval(state.timer); state.timer = null; return; }
  if (state.busy) return;
  state.busy = true;
  try {
    // Telegram scans take a few seconds and the first full sentiment scan up to a minute.
    const response = await fetch(feed.url, { cache: "no-store", headers: { "accept-encoding": "gzip" }, signal: AbortSignal.timeout(name === "telegram" ? 45_000 : 100_000) });
    const built = response.ok ? feed.build(await response.json() as Record<string, unknown>) : null;
    if (!built) throw new Error(`HTTP ${response.status}`);
    if (built.version === state.version) return;
    state.version = built.version;
    state.last = built.message;
    for (const client of clients.values()) if (client.channels.has(name)) send(client.socket, built.message);
  } catch {
    for (const client of targets) send(client.socket, { type: name, error: `${name} update unavailable` });
  } finally {
    state.busy = false;
  }
}

function ensureFeed(name: string, client: Client) {
  const feed = FEEDS[name];
  if (!feed) return;
  if (!feedState.has(name)) feedState.set(name, { timer: null, busy: false, version: null, last: null });
  const state = feedState.get(name)!;
  if (state.last) send(client.socket, state.last); // a new tab gets the latest state at once
  if (!state.timer) {
    state.timer = setInterval(() => { void pollFeed(name); }, feed.intervalMs);
    void pollFeed(name);
  }
}

const symbolList = (value: unknown, limit: number): string[] | null => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().toUpperCase()).slice(0, limit)
  : null;

sockets.on("connection", (socket) => {
  const id = randomUUID();
  const client: Client = { socket, alive: true, underlying: "NIFTY", market: new Set(), options: new Set(), trades: new Set(), ai: false, channels: new Set(), lastStatus: "" };
  clients.set(id, client);
  socket.on("pong", () => { client.alive = true; });

  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString()) as { underlying?: unknown; marketSymbols?: unknown; optionSymbols?: unknown; tradeSymbols?: unknown; symbols?: unknown; channels?: unknown };
      const channels = Array.isArray(message.channels) ? message.channels.filter((channel): channel is string => typeof channel === "string") : [];
      client.ai = channels.includes("ai-monitoring");
      // Only a message that lists channels changes the sentiment subscriptions (quote messages don't).
      const added = Array.isArray(message.channels) ? channels.filter((channel) => FEEDS[channel] && !client.channels.has(channel)) : [];
      if (Array.isArray(message.channels)) client.channels = new Set(channels.filter((channel) => FEEDS[channel]));
      const quotesRequested = message.underlying !== undefined || message.marketSymbols !== undefined || message.optionSymbols !== undefined || message.tradeSymbols !== undefined || message.symbols !== undefined;
      if (quotesRequested) {
        if (typeof message.underlying === "string" && message.underlying.trim()) client.underlying = message.underlying.trim().toUpperCase();
        client.market = new Set([...(symbolList(message.marketSymbols, 20) ?? []), client.underlying]);
        client.options = new Set(symbolList(message.optionSymbols, 60) ?? []);
        client.trades = new Set(symbolList(message.tradeSymbols, 40) ?? symbolList(message.symbols, 40) ?? []);
        const subscription = { cash: [...client.market], fno: [...new Set([...client.options, ...client.trades])] };
        hub.setSubscription(id, subscription);
        const snapshot = hub.snapshot(subscription);
        client.lastStatus = "";
        sendStatus(client, snapshot.status);
        sendTicks(client, snapshot.cash, snapshot.fno);
      }
      if (client.ai) ensureAiPoller();
      for (const channel of added) ensureFeed(channel, client);
    } catch { send(socket, { type: "error", message: "Invalid quote subscription." }); }
  });

  socket.on("close", () => {
    clients.delete(id);
    hub.removeSubscription(id);
  });
});

// Drop sockets whose tab went away without a close frame so they stop costing poll budget.
const heartbeat = setInterval(() => {
  for (const [id, client] of clients) {
    if (!client.alive) { client.socket.terminate(); clients.delete(id); hub.removeSubscription(id); continue; }
    client.alive = false;
    client.socket.ping();
  }
}, 30_000);
sockets.on("close", () => clearInterval(heartbeat));

// ---- Sentiment history: index + commodity sentiment into Firestore ----
// Every minute (whether or not a tab is open) ask the web app to record; it stores one snapshot
// per 15-minute slot and another as soon as an index or commodity reverses. SENTIMENT_RECORDER=off
// disables it (e.g. when an external scheduler calls POST /api/sentiment-history instead).
const recorderMs = Math.max(30_000, Number(process.env.SENTIMENT_RECORD_MS) || 60_000);
let recording = false;
async function recordSentimentHistory() {
  if (recording) return;
  recording = true;
  try {
    const response = await fetch(`${webAppUrl}/api/sentiment-history`, { method: "POST", cache: "no-store", signal: AbortSignal.timeout(120_000) });
    const body = await response.json() as { recorded?: boolean; snapshotId?: string; reasons?: string[]; reversals?: Array<{ name: string; type: string; from: string; to: string }>; error?: string };
    if (!response.ok) console.warn(`Sentiment history: ${body.error ?? `HTTP ${response.status}`}`);
    else if (body.recorded) console.log(`Sentiment history: saved ${body.snapshotId} (${body.reasons?.join(", ")})${body.reversals?.length ? ` · ${body.reversals.map((item) => `${item.name} ${item.type.toLowerCase()} ${item.from}→${item.to}`).join("; ")}` : ""}`);
  } catch (error) {
    console.warn(`Sentiment history: ${error instanceof Error ? error.message : "request failed"}`);
  } finally {
    recording = false;
  }
}
if (process.env.SENTIMENT_RECORDER !== "off") {
  const recorder = setInterval(() => { void recordSentimentHistory(); }, recorderMs);
  setTimeout(() => { void recordSentimentHistory(); }, 15_000); // give the web app a moment to start
  sockets.on("close", () => clearInterval(recorder));
}
