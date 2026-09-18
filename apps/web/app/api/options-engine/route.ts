import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { createGrowwTransport } from "../../../../../adapters/groww/src/groww-adapter";
import { loadGrowwInstrumentCatalog } from "../../../../../adapters/groww/src/groww-instruments";

const symbols = ["NIFTY", "BANKNIFTY", "SENSEX"] as const;
type SymbolName = typeof symbols[number];
type RawRecord = Record<string, unknown>;

type EngineCandidate = {
  symbol: string;
  contract: "CALL" | "PUT";
  expiry: string;
  strike: number;
  premium: number;
  bid: number;
  ask: number;
  spread: number;
  openInterest: number;
  oiChange: number;
  volume: number;
  iv: number;
  delta: number;
  theta: number;
  lotSize: number;
  score: number;
  entry: number;
  stop: number;
  target: number;
  riskReward: number;
  quantity: number;
  support: number;
  resistance: number;
  confirmation: string;
  reason: string;
};

let instrumentCatalogPromise: ReturnType<typeof loadGrowwInstrumentCatalog> | undefined;

async function nearestExpiry(symbol: SymbolName): Promise<string> {
  instrumentCatalogPromise ??= loadGrowwInstrumentCatalog();
  const catalog = await instrumentCatalogPromise;
  const today = new Date().toISOString().slice(0, 10);
  const expiry = catalog.getAll()
    .filter((instrument) => instrument.segment === "FNO" && instrument.underlyingSymbol === symbol && (instrument.instrumentType === "CE" || instrument.instrumentType === "PE") && Boolean(instrument.expiryDate) && instrument.expiryDate! >= today)
    .map((instrument) => instrument.expiryDate as string)
    .sort()[0];
  if (!expiry) throw new Error(`No future Groww option expiry is available for ${symbol}.`);
  return expiry;
}

function payloadOf(value: unknown): RawRecord {
  const record = (value ?? {}) as RawRecord;
  return ((record.payload ?? value) as RawRecord) ?? {};
}

function numberOf(value: unknown): number | undefined {
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function rowsOf(value: unknown): RawRecord[] {
  const payload = payloadOf(value);
  const rows = payload.contracts ?? payload.options ?? payload.option_chain ?? payload.data ?? [];
  if (Array.isArray(rows)) return rows.filter((row): row is RawRecord => Boolean(row) && typeof row === "object" && !Array.isArray(row));
  if (!payload.strikes || typeof payload.strikes !== "object" || Array.isArray(payload.strikes)) return [];
  return Object.entries(payload.strikes as Record<string, unknown>).flatMap(([strike, sides]) => {
    if (!sides || typeof sides !== "object" || Array.isArray(sides)) return [];
    return Object.entries(sides as Record<string, unknown>).flatMap(([optionType, contract]) => {
      if (!contract || typeof contract !== "object" || Array.isArray(contract)) return [];
      const record = contract as RawRecord;
      const greeks = record.greeks && typeof record.greeks === "object" ? record.greeks as RawRecord : {};
      return [{ ...record, strike, option_type: optionType, iv: record.iv ?? greeks.iv, delta: record.delta ?? greeks.delta, theta: record.theta ?? greeks.theta }];
    });
  });
}

function normalizeContracts(value: unknown, symbol: SymbolName): RawRecord[] {
  return rowsOf(value).flatMap((row) => {
    const optionType = String(row.option_type ?? row.optionType ?? row.type ?? "").toUpperCase();
    const expiry = String(row.expiry ?? row.expiry_date ?? row.expiryDate ?? "");
    const strike = numberOf(row.strike ?? row.strike_price);
    const ltp = numberOf(row.ltp ?? row.last_price ?? row.lastPrice);
    const bid = numberOf(row.bid ?? row.bid_price);
    const ask = numberOf(row.ask ?? row.ask_price);
    const openInterest = numberOf(row.open_interest ?? row.openInterest ?? row.oi);
    const oiChange = numberOf(row.oi_change ?? row.oiChange ?? row.oi_change_absolute);
    const volume = numberOf(row.volume);
    const iv = numberOf(row.iv ?? row.implied_volatility ?? row.impliedVolatility);
    const delta = numberOf(row.delta);
    const theta = numberOf(row.theta);
    const lotSize = numberOf(row.lot_size ?? row.lotSize);
    if (!expiry || strike === undefined || ltp === undefined || bid === undefined || ask === undefined || openInterest === undefined || oiChange === undefined || volume === undefined || iv === undefined || delta === undefined || theta === undefined || lotSize === undefined) return [];
    if (!["CE", "PE", "CALL", "PUT"].includes(optionType)) return [];
    return [{ symbol, expiry, strike, option_type: optionType === "CALL" ? "CE" : optionType === "PUT" ? "PE" : optionType, ltp, bid, ask, open_interest: openInterest, oi_change: oiChange, volume, iv, delta, theta, lot_size: lotSize, timestamp_age_seconds: numberOf(row.timestamp_age_seconds ?? row.age_seconds) ?? 0, trading_symbol: String(row.trading_symbol ?? row.tradingSymbol ?? row.symbol ?? "") }];
  });
}

async function fetchRealChain(symbol: SymbolName, spot: number, provider: string, origin: string) {
  if (provider !== "groww") throw new Error("A real options-chain provider is required; select Groww and configure its chain endpoint.");
  const chainPath = process.env.GROWW_OPTIONS_CHAIN_PATH;
  const transport = createGrowwTransport();
  const expiry = process.env.GROWW_OPTIONS_EXPIRY_DATE ?? await nearestExpiry(symbol);
  const pathTemplate = chainPath ?? "/v1/option-chain/exchange/{exchange}/underlying/{underlying}?expiry_date={expiry_date}";
  const chainUrl = pathTemplate
    .replaceAll("{exchange}", symbol === "SENSEX" ? "BSE" : "NSE")
    .replaceAll("{underlying}", encodeURIComponent(symbol))
    .replaceAll("{expiry_date}", encodeURIComponent(expiry));
  const requestPath = chainPath && !chainPath.includes("{") ? `${chainUrl}${chainUrl.includes("?") ? "&" : "?"}symbol=${encodeURIComponent(symbol)}` : chainUrl;
  const rawChain = await transport.request(requestPath, { method: "GET" });
  const historyResponse = await fetch(`${origin}/api/market-data/history?provider=groww&symbol=${symbol}&timeframe=5m&period=day&date=${new Date().toISOString().slice(0, 10)}`, { cache: "no-store" });
  const history = await historyResponse.json();
  const contracts = normalizeContracts(rawChain, symbol);
  if (!contracts.length) throw new Error(`No actionable option-chain data available for ${symbol}; decision is NO_TRADE / WAIT.`);
  if (!Array.isArray(history.candles)) throw new Error(`No actionable 5-minute history available for ${symbol}; decision is NO_TRADE / WAIT.`);
  return { symbol, spot, contracts, candles: history.candles.map((candle: RawRecord) => ({ open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume })) };
}

async function runPython(payload: RawRecord): Promise<{ symbol: string; spot: number; candidates: EngineCandidate[] }> {
  const root = existsSync(path.resolve(process.cwd(), "quant")) ? process.cwd() : path.resolve(process.cwd(), "../..");
  const quantSource = path.join(root, "quant", "src");
  const executable = process.env.PYTHON_EXECUTABLE ?? "python";
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["-m", "tradepulse_quant.signals.option_engine"], { cwd: root, env: { ...process.env, PYTHONPATH: quantSource }, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 2 * 1024 * 1024) child.kill(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) { reject(new Error(stderr.trim() || `Python option engine exited with code ${code}`)); return; }
      try { resolve(JSON.parse(stdout) as { symbol: string; spot: number; candidates: EngineCandidate[] }); }
      catch { reject(new Error("Python option engine returned invalid JSON.")); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const provider = url.searchParams.get("provider") ?? "groww";
  const selected = symbols.filter((symbol) => (url.searchParams.get("symbols") ?? symbols.join(",")).split(",").map((value) => value.toUpperCase()).includes(symbol));
  try {
    const quoteResponse = await fetch(`${url.origin}/api/market-data?provider=${encodeURIComponent(provider)}&symbols=${selected.join(",")}`, { cache: "no-store" });
    const quoteData = await quoteResponse.json();
    const results = await Promise.all(selected.map(async (symbol) => {
      const quote = (quoteData.quotes ?? []).find((item: RawRecord) => item.symbol === symbol);
      const spot = numberOf(quote?.price);
      if (spot === undefined) throw new Error(`${symbol} spot price is unavailable.`);
      return runPython(await fetchRealChain(symbol, spot, provider, url.origin));
    }));
    return NextResponse.json({ candidates: results.flatMap((result) => result.candidates), source: "Python option engine + real Groww option chain", delayed: false, updatedAt: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Option engine unavailable";
    return NextResponse.json({
      candidates: [],
      blocked: true,
      decision: "NO_TRADE",
      status: "WAIT",
      message: `No trade recommendation generated. ${message}`,
      source: "No actionable option candidates",
      error: message,
      updatedAt: new Date().toISOString(),
    }, { status: 503 });
  }
}
