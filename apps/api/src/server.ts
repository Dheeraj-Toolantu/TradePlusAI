import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { createGrowwTransport } from "../../../adapters/groww/src/groww-adapter";
import { readGrowwConfig } from "../../../services/execution/src/groww-config";

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

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ service: "tradepulse-api", status: "ready" }));
});

server.listen(port, () => {
  console.log(`TradePulse API listening on http://localhost:${port}`);
});

const sockets = new WebSocketServer({ server, path: "/ws/quotes" });

async function quote(symbol: string, segment: "CASH" | "FNO") {
  const marketSymbol = segment === "CASH" && symbol === "INDIA VIX" ? "INDIAVIX" : symbol;
  const exchange = segment === "CASH" && symbol === "SENSEX" ? "BSE" : "NSE";
  const body = await createGrowwTransport().request(`/v1/live-data/quote?exchange=${exchange}&segment=${segment}&trading_symbol=${encodeURIComponent(marketSymbol)}`, { method: "GET" });
  const payload = ((body as { payload?: Record<string, unknown> }).payload ?? {});
  const price = Number(payload.ltp ?? payload.last_price ?? payload.lastPrice);
  if (!Number.isFinite(price) || price <= 0) throw new Error("Quote unavailable");
  return { symbol, price, timestamp: new Date().toISOString(), source: `Groww real-time ${segment === "CASH" ? "market" : "F&O"} quote` };
}

sockets.on("connection", (socket) => {
  let underlying = "NIFTY";
  let marketSymbols: string[] = [underlying];
  let optionSymbols: string[] = [];
  let tradeSymbols: string[] = [];
  const timer = setInterval(async () => {
    if (socket.readyState !== WebSocket.OPEN) return;
    const market = await Promise.all(marketSymbols.map(async (symbol) => { try { return await quote(symbol, "CASH"); } catch { return { symbol, price: null, timestamp: new Date().toISOString(), source: "Groww market quote unavailable" }; } }));
    const optionQuotes = await Promise.all([...new Set([...optionSymbols, ...tradeSymbols])].map(async (symbol) => { try { return await quote(symbol, "FNO"); } catch { return { symbol, price: null, timestamp: new Date().toISOString(), source: "Groww option quote unavailable" }; } }));
    socket.send(JSON.stringify({ type: "markets", quotes: market }));
    socket.send(JSON.stringify({ type: "market", underlying, quote: market.find((item) => item.symbol === underlying) ?? market[0] }));
    socket.send(JSON.stringify({ type: "chain", underlying, quotes: optionQuotes.filter((item) => optionSymbols.includes(item.symbol)) }));
    socket.send(JSON.stringify({ type: "quotes", quotes: optionQuotes.filter((item) => tradeSymbols.includes(item.symbol)) }));
  }, 2000);
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString()) as { underlying?: unknown; marketSymbols?: unknown; optionSymbols?: unknown; tradeSymbols?: unknown; symbols?: unknown };
      underlying = typeof message.underlying === "string" ? message.underlying.trim().toUpperCase() : underlying;
      marketSymbols = (Array.isArray(message.marketSymbols) ? message.marketSymbols : [underlying]).filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim().toUpperCase()).slice(0, 20);
      optionSymbols = (Array.isArray(message.optionSymbols) ? message.optionSymbols : []).filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim().toUpperCase()).slice(0, 40);
      const requestedTrades: unknown[] = Array.isArray(message.tradeSymbols) ? message.tradeSymbols : Array.isArray(message.symbols) ? message.symbols : [];
      tradeSymbols = requestedTrades.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value: string) => value.trim().toUpperCase()).slice(0, 40);
    } catch { socket.send(JSON.stringify({ type: "error", message: "Invalid quote subscription." })); }
  });
  socket.on("close", () => clearInterval(timer));
});