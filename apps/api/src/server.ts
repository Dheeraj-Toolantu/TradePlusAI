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
const aiMonitoringUrl = process.env.AI_MONITORING_STATUS_URL ?? `${process.env.WEB_APP_URL ?? "http://localhost:3000"}/api/ai-monitoring`;
const MAX_BUFFERED_BYTES = 1_000_000;

type Client = { socket: WebSocket; alive: boolean; underlying: string; market: Set<string>; options: Set<string>; trades: Set<string>; ai: boolean; lastStatus: string };
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

const symbolList = (value: unknown, limit: number): string[] | null => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().toUpperCase()).slice(0, limit)
  : null;

sockets.on("connection", (socket) => {
  const id = randomUUID();
  const client: Client = { socket, alive: true, underlying: "NIFTY", market: new Set(), options: new Set(), trades: new Set(), ai: false, lastStatus: "" };
  clients.set(id, client);
  socket.on("pong", () => { client.alive = true; });

  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString()) as { underlying?: unknown; marketSymbols?: unknown; optionSymbols?: unknown; tradeSymbols?: unknown; symbols?: unknown; channels?: unknown };
      client.ai = Array.isArray(message.channels) && message.channels.some((channel) => channel === "ai-monitoring");
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
