import { createHash } from "node:crypto";
import type { BrokerAdapter, BrokerOrderRequest, BrokerOrderState, BrokerPosition, BrokerQuote, BrokerResult } from "../../../packages/broker-contracts/src/broker-adapter";
import { toGrowwOrder, validateReferenceId } from "./groww-request-policy";
import { RateLimitError, growwMarketDataLimiter, isMarketDataPath } from "./groww-rate-limiter";

/** `cacheTtlMs` overrides how long a GET body is reused (live tick pollers want ~1 s, not 5 s). */
export type GrowwTransport = { request(path: string, init: { method: string; body?: unknown; cacheTtlMs?: number }): Promise<unknown> };

type GrowwPayload = { status?: string; payload?: Record<string, unknown> };
type CachedGrowwToken = { key: string; token: string };

let cachedGrowwToken: CachedGrowwToken | undefined;
let growwTokenRequest: { key: string; promise: Promise<string> } | undefined;
let growwTokenCooldownUntil = 0;
let growwTokenCooldownMessage = "";
const growwResponseCache = new Map<string, { expiresAt: number; body: unknown }>();
const growwResponseRequests = new Map<string, Promise<unknown>>();
let growwApiCooldownUntil = 0;
let growwApiCooldownMessage = "";
const GET_CACHE_TTL_MS = 5_000;
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
    if (forceRefresh) cachedGrowwToken = undefined;
    if (cachedGrowwToken?.key === tokenCacheKey && !tokenExpired(cachedGrowwToken.token)) return cachedGrowwToken.token;
    if (!forceRefresh && token && !tokenExpired(token)) return token;
    if (!apiKey || !apiSecret) throw new Error("GROWW_ACCESS_TOKEN is not configured; set it or configure GROWW_API_KEY and GROWW_API_SECRET");
    if (growwTokenCooldownUntil > Date.now()) throw new Error(growwTokenCooldownMessage);
    if (growwTokenRequest?.key === tokenCacheKey) return growwTokenRequest.promise;
    const promise = (async () => {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const checksum = createHash("sha256").update(`${apiSecret}${timestamp}`, "utf8").digest("hex");
      const response = await fetch(`${baseUrl}/v1/token/api/access`, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "X-API-VERSION": environment.GROWW_API_VERSION ?? "1.0" }, body: JSON.stringify({ key_type: "approval", checksum, timestamp }), cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = `Groww token API ${response.status}: ${JSON.stringify(body).slice(0, 300)}`;
        if (response.status === 429) { growwTokenCooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS; growwTokenCooldownMessage = message; }
        throw new Error(message);
      }
      const generated = String((body as GrowwPayload)?.payload?.token ?? (body as { token?: string }).token ?? "");
      if (!generated) throw new Error("Groww token API returned no access token");
      cachedGrowwToken = { key: tokenCacheKey, token: generated };
      token = generated;
      return generated;
    })();
    growwTokenRequest = { key: tokenCacheKey, promise };
    try { return await promise; } finally { if (growwTokenRequest?.promise === promise) growwTokenRequest = undefined; }
  }
  const limiter = growwMarketDataLimiter(environment);
  return {
    async request(path, init) {
      const cacheKey = `${baseUrl}${path}`;
      const cacheable = init.method.toUpperCase() === "GET";
      const ttl = init.cacheTtlMs ?? GET_CACHE_TTL_MS;
      if (cacheable) {
        const cached = growwResponseCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) return cached.body;
        const pending = growwResponseRequests.get(cacheKey);
        if (pending) return pending;
      }
      if (growwApiCooldownUntil > Date.now()) {
        const cached = cacheable ? growwResponseCache.get(cacheKey) : undefined;
        if (cached && cached.expiresAt > Date.now()) return cached.body;
        throw new RateLimitError(growwApiCooldownMessage, growwApiCooldownUntil - Date.now());
      }
      const requestOptions = (bearer: string) => ({ method: init.method, headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${bearer}`, "X-API-VERSION": environment.GROWW_API_VERSION ?? "1.0" }, body: init.body === undefined ? undefined : JSON.stringify(init.body), cache: "no-store" as const });
      const requestPromise = (async () => {
        if (cacheable && isMarketDataPath(path)) await limiter.acquire();
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
          if (response.status === 429) {
            const cooldown = cooldownFor(response);
            growwApiCooldownUntil = Date.now() + cooldown;
            growwApiCooldownMessage = `Groww rate limit reached; pausing market-data calls for ${Math.round(cooldown / 1000)} s (${message})`;
            throw new RateLimitError(growwApiCooldownMessage, cooldown);
          }
          throw new Error(message);
        }
        if (cacheable && ttl > 0) growwResponseCache.set(cacheKey, { expiresAt: Date.now() + ttl, body });
        return body;
      })();
      if (cacheable) growwResponseRequests.set(cacheKey, requestPromise);
      try { return await requestPromise; }
      finally { if (cacheable && growwResponseRequests.get(cacheKey) === requestPromise) growwResponseRequests.delete(cacheKey); }
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