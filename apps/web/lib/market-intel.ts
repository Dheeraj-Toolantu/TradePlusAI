import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { GrowwAdapter, createGrowwTransport } from "../../../adapters/groww/src/groww-adapter";
import { loadGrowwInstrumentCatalog } from "../../../adapters/groww/src/groww-instruments";
import { baselineSnapshot, recordSnapshot, snapshotHistorySeconds, type ChainLeg, type ChainRow } from "./oi-snapshot-store";

export const INTEL_SYMBOLS = ["NIFTY", "BANKNIFTY", "SENSEX"] as const;
export type IntelSymbol = (typeof INTEL_SYMBOLS)[number];
export type MarketIntel = Record<string, unknown> & {
  symbol: string;
  available: boolean;
  verdict?: { bias: "BULLISH" | "BEARISH" | "SIDEWAYS"; score: number; strength: number };
  trade_plan?: { status: string; direction: "CE" | "PE" | null };
  volatility?: { regime: string | null };
  v5_option_evidence?: Record<string, unknown>;
};

type Raw = Record<string, unknown>;
const CACHE_TTL_MS = 20_000;
const CHAIN_WINDOW = 0.06; // keep strikes within ±6% of spot: covers the OI that matters for PCR and walls
const globalCache = globalThis as typeof globalThis & { __tradepulseIntelCache?: Map<string, { at: number; value: MarketIntel }>; __tradepulseIntelInflight?: Map<string, Promise<MarketIntel>> };
const cache = (globalCache.__tradepulseIntelCache ??= new Map());
const inflight = (globalCache.__tradepulseIntelInflight ??= new Map());

export const isIntelSymbol = (value: string): value is IntelSymbol => (INTEL_SYMBOLS as readonly string[]).includes(value);

/** IST calendar date (YYYY-MM-DD). `toISOString()` is UTC and rolls over at 05:30 IST. */
export function istDate(now = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

const num = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function payloadOf(value: unknown): Raw {
  return ((value as { payload?: Raw })?.payload ?? {}) as Raw;
}

function legOf(raw: unknown): ChainLeg | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const side = raw as Raw;
  const greeks = (side.greeks ?? {}) as Raw;
  const ltp = num(side.ltp);
  const oi = num(side.open_interest ?? side.oi);
  if (ltp === null || oi === null) return undefined;
  return { ltp, oi, volume: num(side.volume) ?? 0, iv: num(greeks.iv ?? side.iv), delta: num(greeks.delta ?? side.delta), trading_symbol: String(side.trading_symbol ?? "") };
}

async function contractMeta(symbol: IntelSymbol) {
  const catalog = await loadGrowwInstrumentCatalog();
  const today = istDate();
  const options = catalog.getAll().filter((instrument) => instrument.segment === "FNO" && instrument.underlyingSymbol === symbol && (instrument.instrumentType === "CE" || instrument.instrumentType === "PE") && Boolean(instrument.expiryDate) && instrument.expiryDate! >= today);
  const expiry = options.map((instrument) => instrument.expiryDate as string).sort()[0];
  if (!expiry) throw new Error(`No future option expiry is available for ${symbol}.`);
  const lotSize = Number(options.find((instrument) => instrument.expiryDate === expiry && Number(instrument.lotSize) > 0)?.lotSize ?? 0);
  return { expiry, lotSize };
}

async function fetchChain(symbol: IntelSymbol, expiry: string) {
  const exchange = symbol === "SENSEX" ? "BSE" : "NSE";
  const body = await createGrowwTransport().request(`/v1/option-chain/exchange/${exchange}/underlying/${encodeURIComponent(symbol)}?expiry_date=${encodeURIComponent(expiry)}`, { method: "GET" });
  const payload = payloadOf(body);
  const spot = num(payload.underlying_ltp ?? payload.underlyingLtp) ?? 0;
  const strikes = (payload.strikes ?? {}) as Record<string, { CE?: unknown; PE?: unknown }>;
  const rows: ChainRow[] = [];
  for (const [key, sides] of Object.entries(strikes)) {
    const strike = num(key);
    if (strike === null || (spot > 0 && Math.abs(strike - spot) / spot > CHAIN_WINDOW)) continue;
    const ce = legOf(sides?.CE);
    const pe = legOf(sides?.PE);
    if (ce || pe) rows.push({ strike, ce, pe });
  }
  rows.sort((left, right) => left.strike - right.strike);
  return { spot, rows };
}

async function fetchCandles(symbol: IntelSymbol, origin: string) {
  const response = await fetch(`${origin}/api/market-data/history?provider=groww&symbol=${symbol}&timeframe=5m&period=week&date=${istDate()}`, { cache: "no-store" });
  const history = await response.json();
  if (!response.ok || !Array.isArray(history.candles)) throw new Error(String(history.error ?? "5-minute history unavailable"));
  // Smart-money structure must only use completed candles; drop the one still forming.
  const cutoff = Date.now() / 1000 - 300;
  return (history.candles as Raw[]).filter((candle) => Number(candle.time) <= cutoff);
}

async function fetchQuotes(symbol: IntelSymbol) {
  const result = await new GrowwAdapter(createGrowwTransport()).getQuotes(["INDIA VIX", symbol]);
  if ("error" in result) return { vix: null, spot: null };
  const vix = result.value.find((quote) => quote.symbol === "INDIA VIX");
  const underlying = result.value.find((quote) => quote.symbol === symbol);
  return {
    vix: vix && vix.price > 0 ? { value: vix.price, change: vix.change ?? null, percent: vix.percent ?? null } : null,
    spot: underlying && underlying.price > 0 ? underlying.price : null,
  };
}

function runPython(payload: Raw): Promise<MarketIntel> {
  const root = existsSync(path.resolve(process.cwd(), "quant")) ? process.cwd() : path.resolve(process.cwd(), "../..");
  const executable = process.env.PYTHON_EXECUTABLE ?? "python";
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["-m", "tradepulse_quant.market_intel.engine"], { cwd: root, env: { ...process.env, PYTHONPATH: path.join(root, "quant", "src") }, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(stderr.trim() || `Market-intel engine exited with code ${code}`)); return; }
      try { resolve(JSON.parse(stdout) as MarketIntel); } catch { reject(new Error("Market-intel engine returned invalid JSON")); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export type IntelOptions = { origin: string; capital?: number; riskPct?: number; force?: boolean };

async function compute(symbol: IntelSymbol, options: IntelOptions): Promise<MarketIntel> {
  const { expiry, lotSize } = await contractMeta(symbol);
  const [chain, candles, quotes] = await Promise.all([fetchChain(symbol, expiry), fetchCandles(symbol, options.origin), fetchQuotes(symbol)]);
  const spot = chain.spot || quotes.spot || Number(candles.at(-1)?.close ?? 0);
  const now = Date.now();
  const baseline = baselineSnapshot(symbol, expiry, now);
  if (chain.rows.length) recordSnapshot(symbol, { takenAt: now, spot, expiry, rows: chain.rows });
  const result = await runPython({
    symbol,
    spot,
    expiry,
    lot_size: lotSize,
    candles,
    chain: chain.rows,
    baseline_chain: baseline?.rows ?? null,
    baseline_spot: baseline?.spot ?? null,
    baseline_age_seconds: baseline ? Math.round((now - baseline.takenAt) / 1000) : null,
    vix: quotes.vix,
    capital: options.capital,
    risk_pct: options.riskPct,
  });
  return { ...result, baseline_history_seconds: snapshotHistorySeconds(symbol, expiry, now), source: "Groww option chain + 5m candles + India VIX", fetched_at: new Date(now).toISOString() };
}

/**
 * Cached market intelligence. Concurrent callers share one in-flight computation, and a
 * result is reused for 20 s so the auto-trade loop and the page poll never hammer Groww.
 * Capital/risk only change position sizing, so they are part of the cache key.
 */
export async function getMarketIntel(symbol: IntelSymbol, options: IntelOptions): Promise<MarketIntel> {
  const key = `${symbol}|${options.capital ?? ""}|${options.riskPct ?? ""}`;
  const cached = cache.get(key);
  if (!options.force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = compute(symbol, options)
    .then((value) => { cache.set(key, { at: Date.now(), value }); return value; })
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** Most recent cached intel for a symbol regardless of sizing inputs (direction/VIX gates only). */
export function latestCachedIntel(symbol: string, maxAgeMs = 90_000): MarketIntel | null {
  let best: { at: number; value: MarketIntel } | null = null;
  for (const [key, entry] of cache) {
    if (key.startsWith(`${symbol.toUpperCase()}|`) && (!best || entry.at > best.at)) best = entry;
  }
  return best && Date.now() - best.at <= maxAgeMs ? best.value : null;
}
