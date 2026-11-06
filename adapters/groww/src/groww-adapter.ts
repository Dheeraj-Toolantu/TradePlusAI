import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrokerAdapter, BrokerOrderRequest, BrokerOrderState, BrokerPosition, BrokerQuote, BrokerResult } from "../../../packages/broker-contracts/src/broker-adapter";
import { toGrowwOrder, validateReferenceId } from "./groww-request-policy";
import { RateLimitError, growwMarketDataLimiter, isMarketDataPath } from "./groww-rate-limiter";

/** `cacheTtlMs` overrides how long a GET body is reused (live tick pollers want ~1 s, not 5 s). */
export type GrowwTransport = { request(path: string, init: { method: string; body?: unknown; cacheTtlMs?: number }): Promise<unknown> };

type GrowwPayload = { status?: string; payload?: Record<string, unknown> };
type CachedGrowwToken = { key: string; token: string };

/**
 * Transport state, one per process. Next.js bundles every API route separately, so module-level
 * variables gave each route its own access token, response cache and 429 cooldown: every route
 * generated a fresh token and spent the shared Groww budget on its own. globalThis is shared.
 */
type TransportState = {
  token: CachedGrowwToken | undefined; tokenRequest: { key: string; promise: Promise<string> } | undefined;
  tokenCooldownUntil: number; tokenCooldownMessage: string;
  cache: Map<string, { expiresAt: number; body: unknown }>; inflight: Map<string, Promise<unknown>>;
  apiCooldownUntil: number; apiCooldownMessage: string; stale: Map<string, { at: number; body: unknown }>;
};
const G = ((globalThis as typeof globalThis & { __tradepulseGrowwTransport?: TransportState }).__tradepulseGrowwTransport ??= {
  token: undefined, tokenRequest: undefined, tokenCooldownUntil: 0, tokenCooldownMessage: "",
  cache: new Map(), inflight: new Map(), apiCooldownUntil: 0, apiCooldownMessage: "", stale: new Map(),
});

/**
 * The generated access token is also kept in a small file (owner-only permissions, in the OS temp
 * folder) so the web app, the quote socket server and dev restarts reuse one token instead of each
 * asking Groww's token API for a new one, which that API throttles. A token-API 429 cooldown is
 * shared the same way. GROWW_TOKEN_CACHE_FILE overrides the path; "off" disables it.
 */
type TokenFile = { key: string; token?: string; cooldownUntil?: number; message?: string };
function tokenFilePath(key: string, environment: NodeJS.ProcessEnv) {
  const configured = environment.GROWW_TOKEN_CACHE_FILE ?? process.env.GROWW_TOKEN_CACHE_FILE;
  if (configured === "off" || (!configured && process.env.VITEST)) return null;
  return configured || path.join(tmpdir(), `tradepulse-groww-${createHash("sha256").update(key).digest("hex").slice(0, 16)}.json`);
}
function readTokenFile(file: string | null, key: string): TokenFile | null {
  if (!file) return null;
  try { const data = JSON.parse(readFileSync(file, "utf8")) as TokenFile; return data.key === createHash("sha256").update(key).digest("hex") ? data : null; } catch { return null; }
}
function writeTokenFile(file: string | null, key: string, patch: Omit<TokenFile, "key">) {
  if (!file) return;
  try {
    const hashed = createHash("sha256").update(key).digest("hex");
    const current = readTokenFile(file, key) ?? { key: hashed };
    writeFileSync(file, JSON.stringify({ ...current, ...patch, key: hashed }), { mode: 0o600 });
  } catch { /* the file is an optimisation only */ }
}
const GET_CACHE_TTL_MS = 5_000;
/** While the market is shut nothing moves: reuse market-data bodies for 5 minutes. */
const CLOSED_MARKET_TTL_MS = 5 * 60_000;
/** Candle history only changes once a minute; option chains every few seconds at most. */
const HISTORY_TTL_MS = 20_000;
const CHAIN_TTL_MS = 10_000;
/** A rate-limited call answers with the last good body for up to this long instead of failing. */
const STALE_FALLBACK_MS = 15 * 60_000;
/** The last good body per market-data path, kept for STALE_FALLBACK_MS. */

/** NSE / BSE trade 09:15–15:30 IST on weekdays; a 15-minute margin each side for pre-open and closing data. */
export function marketOpenIst(ms = Date.now()) {
  const d = new Date(ms + 330 * 60_000);
  const day = d.getUTCDay();
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  return day >= 1 && day <= 5 && minute >= 9 * 60 && minute <= 15 * 60 + 45;
}

/** How long a GET body is reused: longer for candles and chains, much longer while the market is shut. */
export function marketDataTtl(path: string, requested: number | undefined, ms = Date.now()) {
  if (!isMarketDataPath(path)) return requested ?? GET_CACHE_TTL_MS;
  if (!marketOpenIst(ms)) return Math.max(requested ?? 0, CLOSED_MARKET_TTL_MS);
  if (path.startsWith("/v1/historical/")) return Math.max(requested ?? 0, HISTORY_TTL_MS);
  if (path.startsWith("/v1/option-chain/")) return Math.max(requested ?? 0, CHAIN_TTL_MS);
  return requested ?? GET_CACHE_TTL_MS;
}
const RATE_LIMIT_COOLDOWN_MS = 30_000;
const MAX_RATE_LIMIT_COOLDOWN_MS = 120_000;

/** Honour Groww's Retry-After when present, otherwise back off for the default cooldown. */
function cooldownFor(response: Response): number {
  const header = Number(response.headers.get("retry-after"));
  return Number.isFinite(header) && header > 0 ? Math.min(header * 1000, MAX_RATE_LIMIT_COOLDOWN_MS) : RATE_LIMIT_COOLDOWN_MS;
}

export function createGrowwTransport(environment: NodeJS.ProcessEnv = process.env): GrowwTransport {
  let token = environment.GROWW_ACCESS_TOKEN;
  const apiKey = environment.GROWW_API_KEY;
  const apiSecret = environment.GROWW_API_SECRET;
  const baseUrl = environment.GROWW_API_BASE_URL ?? "https://api.groww.in";
  const tokenCacheKey = `${baseUrl}:${apiKey ?? ""}`;
  const tokenFile = tokenFilePath(tokenCacheKey, environment);
  function tokenExpired(value: string): boolean {
    try {
      const encodedPayload = value.split(".")[1];
      if (!encodedPayload) return false;
      const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as { exp?: number };
      return typeof payload.exp === "number" && payload.exp <= Math.floor(Date.now() / 1000) + 30;
    } catch {
      return false;
    }
  }
  async function accessToken(forceRefresh = false): Promise<string> {
    if (forceRefresh) G.token = undefined;
    if (G.token?.key === tokenCacheKey && !tokenExpired(G.token.token)) return G.token.token;
    if (!forceRefresh && token && !tokenExpired(token)) return token;
    if (!apiKey || !apiSecret) throw new Error("GROWW_ACCESS_TOKEN is not configured; set it or configure GROWW_API_KEY and GROWW_API_SECRET");
    const shared = readTokenFile(tokenFile, tokenCacheKey);
    // Another process (or an earlier run) already has a valid token: use it rather than asking again.
    if (!forceRefresh && shared?.token && !tokenExpired(shared.token)) { G.token = { key: tokenCacheKey, token: shared.token }; return shared.token; }
    if (shared?.cooldownUntil && shared.cooldownUntil > G.tokenCooldownUntil) { G.tokenCooldownUntil = shared.cooldownUntil; G.tokenCooldownMessage = shared.message ?? "Groww token API rate limit"; }
    if (G.tokenCooldownUntil > Date.now()) throw new RateLimitError(`${G.tokenCooldownMessage} (retrying in ${Math.ceil((G.tokenCooldownUntil - Date.now()) / 1000)} s)`, G.tokenCooldownUntil - Date.now());
    if (G.tokenRequest?.key === tokenCacheKey) return G.tokenRequest.promise;
    const promise = (async () => {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const checksum = createHash("sha256").update(`${apiSecret}${timestamp}`, "utf8").digest("hex");
      const response = await fetch(`${baseUrl}/v1/token/api/access`, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "X-API-VERSION": environment.GROWW_API_VERSION ?? "1.0" }, body: JSON.stringify({ key_type: "approval", checksum, timestamp }), cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = `Groww token API ${response.status}: ${JSON.stringify(body).slice(0, 300)}`;
        if (response.status === 429) {
          const cooldown = cooldownFor(response);
          G.tokenCooldownUntil = Date.now() + cooldown; G.tokenCooldownMessage = `Groww token API rate limit: ${message}`;
          writeTokenFile(tokenFile, tokenCacheKey, { cooldownUntil: G.tokenCooldownUntil, message: G.tokenCooldownMessage });
          throw new RateLimitError(G.tokenCooldownMessage, cooldown);
        }
        throw new Error(message);
      }
      const generated = String((body as GrowwPayload)?.payload?.token ?? (body as { token?: string }).token ?? "");
      if (!generated) throw new Error("Groww token API returned no access token");
      G.token = { key: tokenCacheKey, token: generated };
      token = generated;
      writeTokenFile(tokenFile, tokenCacheKey, { token: generated, cooldownUntil: 0, message: "" });
      return generated;
    })();
    G.tokenRequest = { key: tokenCacheKey, promise };
    try { return await promise; } finally { if (G.tokenRequest?.promise === promise) G.tokenRequest = undefined; }
  }
  const limiter = growwMarketDataLimiter(environment);
  return {
    async request(path, init) {
      const cacheKey = `${baseUrl}${path}`;
      const cacheable = init.method.toUpperCase() === "GET";
      const ttl = marketDataTtl(path, init.cacheTtlMs);
      const stale = () => { const item = cacheable ? G.stale.get(cacheKey) : undefined; return item && Date.now() - item.at < STALE_FALLBACK_MS ? item : undefined; };
      if (cacheable) {
        const cached = G.cache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) return cached.body;
        const pending = G.inflight.get(cacheKey);
        if (pending) return pending;
      }
      // The cooldown covers market data only: Groww limits orders and portfolio calls separately.
      const marketData = isMarketDataPath(path);
      if (marketData && G.apiCooldownUntil > Date.now()) {
        // Rate-limited: answer with the last good body rather than blanking every panel.
        const fallback = stale();
        if (fallback) return fallback.body;
        throw new RateLimitError(G.apiCooldownMessage, G.apiCooldownUntil - Date.now());
      }
      const requestOptions = (bearer: string) => ({ method: init.method, headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${bearer}`, "X-API-VERSION": environment.GROWW_API_VERSION ?? "1.0" }, body: init.body === undefined ? undefined : JSON.stringify(init.body), cache: "no-store" as const });
      const requestPromise = (async () => {
        if (cacheable && isMarketDataPath(path)) {
          try { await limiter.acquire(); } catch (error) { const fallback = stale(); if (fallback) return fallback.body; throw error; }
        }
        let bearer = await accessToken();
        let response = await fetch(`${baseUrl}${path}`, requestOptions(bearer));
        if (response.status === 401 && apiKey && apiSecret) {
          token = undefined;
          bearer = await accessToken(true);
          response = await fetch(`${baseUrl}${path}`, requestOptions(bearer));
        }
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          const message = `Groww API ${response.status}: ${JSON.stringify(body).slice(0, 300)}`;
          if (response.status === 429 && !marketData) throw new RateLimitError(`Groww rate limit reached (${message})`, cooldownFor(response));
          if (response.status === 429) {
            const cooldown = cooldownFor(response);
            G.apiCooldownUntil = Date.now() + cooldown;
            G.apiCooldownMessage = `Groww rate limit reached; pausing market-data calls for ${Math.round(cooldown / 1000)} s (${message})`;
            const fallback = stale();
            if (fallback) return fallback.body;
            throw new RateLimitError(G.apiCooldownMessage, cooldown);
          }
          throw new Error(message);
        }
        if (cacheable && ttl > 0) G.cache.set(cacheKey, { expiresAt: Date.now() + ttl, body });
        if (cacheable && isMarketDataPath(path)) {
          G.stale.set(cacheKey, { at: Date.now(), body });
          if (G.stale.size > 2000) G.stale.delete(G.stale.keys().next().value as string);
        }
        return body;
      })();
      if (cacheable) G.inflight.set(cacheKey, requestPromise);
      try { return await requestPromise; }
      finally { if (cacheable && G.inflight.get(cacheKey) === requestPromise) G.inflight.delete(cacheKey); }
    },
  };
}

function payloadOf(value: unknown): Record<string, unknown> { return ((value as GrowwPayload)?.payload ?? {}) as Record<string, unknown>; }
function orderState(value: unknown, fallbackId: string, fallbackQuantity = 0): BrokerOrderState { const payload = payloadOf(value); return { brokerOrderId: String(payload.groww_order_id ?? payload.order_reference_id ?? fallbackId), status: String(payload.order_status ?? "UNKNOWN"), filledQuantity: Number(payload.filled_quantity ?? 0), remainingQuantity: Number(payload.remaining_quantity ?? fallbackQuantity), averageFillPrice: payload.average_fill_price === undefined ? undefined : Number(payload.average_fill_price) }; }

export class GrowwAdapter implements BrokerAdapter {
  constructor(private readonly transport: GrowwTransport) {}
  async healthCheck(): Promise<BrokerResult<{ connected: boolean; authenticated: boolean; permissions: string[]; checkedAt: string }>> { try { await this.transport.request("/v1/user/profile", { method: "GET" }); return { ok: true, value: { connected: true, authenticated: true, permissions: ["quotes", "orders", "positions", "trades"], checkedAt: new Date().toISOString() } }; } catch (error) { return { ok: false, error: { code: "GROWW_HEALTH_FAILED", message: error instanceof Error ? error.message : "Groww health check failed", retryable: true, safeStateImpact: "BLOCK_NEW_ENTRIES" } }; } }
  async getQuotes(symbols: string[]): Promise<BrokerResult<BrokerQuote[]>> { try { const values = await Promise.all(symbols.map(async (symbol) => { const market = symbol === "SENSEX" ? { exchange: "BSE", tradingSymbol: "SENSEX" } : { exchange: "NSE", tradingSymbol: symbol === "INDIA VIX" ? "INDIAVIX" : symbol }; const path = `/v1/live-data/quote?exchange=${market.exchange}&segment=CASH&trading_symbol=${encodeURIComponent(market.tradingSymbol)}`; const body = await this.transport.request(path, { method: "GET" }); const payload = payloadOf(body); const ohlc = (payload.ohlc ?? {}) as Record<string, unknown>; return { symbol, price: Number(payload.ltp ?? payload.last_price ?? 0), change: Number(payload.day_change ?? payload.change ?? 0), percent: Number(payload.day_change_perc ?? payload.change_percent ?? 0), timestamp: payload.last_trade_time ? new Date(Number(payload.last_trade_time)).toISOString() : new Date().toISOString(), open: Number(ohlc.open ?? payload.open ?? payload.last_price ?? 0), high: Number(ohlc.high ?? payload.high ?? payload.last_price ?? 0), low: Number(ohlc.low ?? payload.low ?? payload.last_price ?? 0), volume: Number(payload.volume ?? 0) }; })); return { ok: true, value: values }; } catch (error) { return { ok: false, error: { code: "GROWW_QUOTES_FAILED", message: error instanceof Error ? error.message : "Groww quote request failed", retryable: true, safeStateImpact: "BLOCK_NEW_ENTRIES" } }; } }
  async getPositions(): Promise<BrokerResult<BrokerPosition[]>> { try { const body = await this.transport.request("/v1/portfolio/positions", { method: "GET" }); const positions = ((payloadOf(body).positions ?? []) as Record<string, unknown>[]).map((position) => ({ symbol: String(position.trading_symbol ?? position.symbol), quantity: Number(position.quantity ?? position.net_quantity ?? 0), averagePrice: Number(position.average_price ?? position.avg_price ?? 0) })); return { ok: true, value: positions }; } catch (error) { return { ok: false, error: { code: "GROWW_POSITIONS_FAILED", message: error instanceof Error ? error.message : "Groww positions request failed", retryable: true, safeStateImpact: "BLOCK_NEW_ENTRIES" } }; } }
  async placeOrder(request: BrokerOrderRequest): Promise<BrokerResult<BrokerOrderState>> { try { validateReferenceId(request.referenceId); const body = await this.transport.request("/v1/order/create", { method: "POST", body: toGrowwOrder(request) }); return { ok: true, value: orderState(body, request.referenceId, request.quantity) }; } catch (error) { return { ok: false, error: { code: "GROWW_ORDER_FAILED", message: error instanceof Error ? error.message : "Groww order failed", retryable: false, safeStateImpact: "BLOCK_NEW_ENTRIES" } }; } }
  async getOrderStatus(referenceId: string): Promise<BrokerResult<BrokerOrderState>> { try { validateReferenceId(referenceId); const body = await this.transport.request(`/v1/order/status/reference/${referenceId}?segment=FNO`, { method: "GET" }); return { ok: true, value: orderState(body, referenceId) }; } catch (error) { return { ok: false, error: { code: "GROWW_STATUS_FAILED", message: error instanceof Error ? error.message : "Groww order status failed", retryable: true, safeStateImpact: "BLOCK_NEW_ENTRIES" } }; } }
  async cancelOrder(orderId: string): Promise<BrokerResult<BrokerOrderState>> { try { const body = await this.transport.request("/v1/order/cancel", { method: "POST", body: { segment: "FNO", groww_order_id: orderId } }); return { ok: true, value: orderState(body, orderId) }; } catch (error) { return { ok: false, error: { code: "GROWW_CANCEL_FAILED", message: error instanceof Error ? error.message : "Groww cancellation failed", retryable: true, safeStateImpact: "BLOCK_NEW_ENTRIES" } }; } }
  async reconcile(): Promise<BrokerResult<{ unexpectedPositions: BrokerPosition[] }>> { const result = await this.getPositions(); if ("error" in result) return { ok: false, error: result.error }; return { ok: true, value: { unexpectedPositions: result.value.filter((position) => position.quantity !== 0) } }; }
}