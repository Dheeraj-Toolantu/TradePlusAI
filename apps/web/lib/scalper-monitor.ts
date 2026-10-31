import { createGrowwTransport } from "../../../adapters/groww/src/groww-adapter";
import type { ScalperBar, ScalperContract } from "../../../services/paper-trading/src/smart-scalper";
import { getScalper } from "./scalper-instance";

/**
 * Server-side exit monitor for the paper Smart Scalper.
 *
 * Exits (SL, target, the VWAP-EMA staged trail, the 9 EMA momentum exit, the time stop, max loss
 * and the 15:15 square-off) used to run only from the scalper desk's 10-second scan in the browser,
 * so a closed or sleeping tab left positions unmanaged. This monitor runs in the Node server
 * process every few seconds, fetches the live option quotes, the index spot and its 1-minute
 * candles itself, and calls SmartScalper.manage(). It starts at server boot (instrumentation.ts),
 * which also reloads persisted open positions after a restart. The desk's scan still runs; the
 * scalper serialises both, so a position is never closed twice.
 */

export type MonitorDeps = {
  optionQuote(symbol: string, exchange: "NSE" | "BSE"): Promise<number | null>;
  spot(underlying: string): Promise<number | null>;
  bars(underlying: string): Promise<ScalperBar[]>;
  now(): number;
};
type MonitorState = { timer: ReturnType<typeof setInterval> | null; busy: boolean; ticks: number; lastTickAt: string | null; lastError: string | null; managed: number; exits: number; origin: string; deps: MonitorDeps | null };

export const SCALPER_MONITOR_MS = 5_000;
const BARS_TTL_MS = 20_000;
const holder = globalThis as typeof globalThis & { __tradepulseScalperMonitor?: MonitorState };
const state = (holder.__tradepulseScalperMonitor ??= { timer: null, busy: false, ticks: 0, lastTickAt: null, lastError: null, managed: 0, exits: 0, origin: "", deps: null });
const barsCache = new Map<string, { at: number; bars: ScalperBar[] }>();

const payloadOf = (body: unknown) => ((body as { payload?: Record<string, unknown> })?.payload ?? {}) as Record<string, unknown>;
const priceOf = (body: unknown) => { const payload = payloadOf(body); const price = Number(payload.ltp ?? payload.last_price ?? payload.lastPrice); return Number.isFinite(price) && price > 0 ? price : null; };

function defaultDeps(): MonitorDeps {
  const transport = createGrowwTransport();
  return {
    optionQuote: async (symbol, exchange) => priceOf(await transport.request(`/v1/live-data/quote?exchange=${exchange}&segment=FNO&trading_symbol=${encodeURIComponent(symbol)}`, { method: "GET" }).catch(() => null)),
    spot: async (underlying) => priceOf(await transport.request(`/v1/live-data/quote?exchange=${underlying === "SENSEX" ? "BSE" : "NSE"}&segment=CASH&trading_symbol=${encodeURIComponent(underlying)}`, { method: "GET" }).catch(() => null)),
    bars: async (underlying) => {
      const cached = barsCache.get(underlying);
      if (cached && Date.now() - cached.at < BARS_TTL_MS) return cached.bars;
      const date = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
      const body = await fetch(`${state.origin}/api/market-data/history?provider=groww&symbol=${encodeURIComponent(underlying)}&timeframe=1m&period=day&date=${date}`, { cache: "no-store" }).then((response) => response.json()).catch(() => null) as { candles?: ScalperBar[] } | null;
      const bars = Array.isArray(body?.candles) ? body!.candles.map((bar) => ({ time: Number(bar.time), open: Number(bar.open), high: Number(bar.high), low: Number(bar.low), close: Number(bar.close), volume: Number(bar.volume ?? 0) })) : [];
      if (bars.length) barsCache.set(underlying, { at: Date.now(), bars });
      return bars.length ? bars : cached?.bars ?? [];
    },
    now: () => Date.now(),
  };
}

function quoteContract(symbol: string, premium: number): ScalperContract {
  return { symbol, contract: /PE$/.test(symbol.replace(/[^a-zA-Z0-9]/g, "").toUpperCase()) ? "PUT" : "CALL", expiry: "", strike: 0, premium, bid: premium, ask: premium, openInterest: 0, volume: 0, iv: 0, delta: 0, theta: 0, lotSize: 0, tickSize: 0.05 };
}

/** One pass over every underlying with open scalper positions. Public for tests. */
export async function scalperMonitorTick(deps: MonitorDeps = state.deps ?? defaultDeps()) {
  if (state.busy) return { skipped: true as const };
  state.busy = true;
  try {
    state.ticks += 1;
    state.lastTickAt = new Date(deps.now()).toISOString();
    const scalper = getScalper();
    const book = await scalper.openBook();
    state.managed = book.reduce((sum, item) => sum + item.symbols.length, 0);
    let exits = 0;
    for (const { underlying, symbols } of book) {
      const exchange = underlying === "SENSEX" ? "BSE" : "NSE";
      const [spot, bars, quotes] = await Promise.all([
        deps.spot(underlying).catch(() => null),
        deps.bars(underlying).catch(() => [] as ScalperBar[]),
        Promise.all(symbols.map(async (symbol) => [symbol, await deps.optionQuote(symbol, exchange).catch(() => null)] as const)),
      ]);
      const contracts = quotes.filter(([, price]) => price !== null && price > 0).map(([symbol, price]) => quoteContract(symbol, price!));
      // Without a fresh option quote nothing is marked; time-based exits (square-off, time stop) still run.
      const result = await scalper.manage({ symbol: underlying, spot: spot ?? 0, bars, contracts });
      exits += result.exited.length;
    }
    state.exits += exits;
    state.lastError = null;
    return { skipped: false as const, underlyings: book.length, exits };
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    return { skipped: false as const, error: state.lastError };
  } finally {
    state.busy = false;
  }
}

/** Start the monitor once per server process (idempotent). Routes pass their origin for the bars fetch. */
export function ensureScalperMonitor(origin?: string, deps?: MonitorDeps) {
  if (origin) state.origin = origin;
  if (!state.origin) state.origin = process.env.SCALPER_MONITOR_ORIGIN ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
  if (deps) state.deps = deps;
  if (state.timer || (process.env.VITEST && !deps)) return;
  state.timer = setInterval(() => { void scalperMonitorTick(); }, SCALPER_MONITOR_MS);
  state.timer.unref?.();
}

export function scalperMonitorStatus() {
  return { running: Boolean(state.timer), intervalMs: SCALPER_MONITOR_MS, ticks: state.ticks, lastTickAt: state.lastTickAt, lastError: state.lastError, managedLegs: state.managed, exits: state.exits };
}

/** Tests only. */
export function stopScalperMonitor() {
  if (state.timer) clearInterval(state.timer);
  Object.assign(state, { timer: null, busy: false, ticks: 0, lastTickAt: null, lastError: null, managed: 0, exits: 0, deps: null });
  barsCache.clear();
}
