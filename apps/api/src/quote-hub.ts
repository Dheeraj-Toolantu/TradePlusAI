import type { GrowwSegment } from "../../../adapters/groww/src/groww-ltp";
import { isRateLimitError } from "../../../adapters/groww/src/groww-rate-limiter";

export type QuoteTick = { symbol: string; price: number; timestamp: string; source: string };
export type FeedState = "connecting" | "live" | "rate-limited" | "unavailable";
export type FeedStatus = { state: FeedState; detail?: string; retryAt?: string; updatedAt: string | null };
export type Subscription = { cash: string[]; fno: string[] };
export type LtpFetcher = (symbols: string[], segment: GrowwSegment) => Promise<Map<string, number>>;
/** `changed` holds only ticks whose price moved (or first seen) during this poll. */
export type HubListener = (changed: { cash: Map<string, QuoteTick>; fno: Map<string, QuoteTick> }, status: FeedStatus) => void;

type Options = { intervalMs?: number; maxBackoffMs?: number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout };

const SOURCE: Record<GrowwSegment, string> = { CASH: "Groww real-time market quote", FNO: "Groww real-time F&O quote" };

/**
 * One Groww poller shared by every socket. Each tick fetches the union of all subscriptions in
 * batched LTP calls, so ten open tabs cost the same broker budget as one, and only prices that
 * changed are pushed. Throttling backs the loop off instead of hammering a 429.
 */
export class QuoteHub {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly listeners = new Set<HubListener>();
  private readonly prices: Record<GrowwSegment, Map<string, QuoteTick>> = { CASH: new Map(), FNO: new Map() };
  private status: FeedStatus = { state: "connecting", updatedAt: null };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private failures = 0;
  private readonly intervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  constructor(private readonly fetchLtp: LtpFetcher, options: Options = {}) {
    this.intervalMs = options.intervalMs ?? 1500;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  subscribe(listener: HubListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  setSubscription(id: string, subscription: Subscription) {
    const next = { cash: subscription.cash.map(clean).filter(Boolean), fno: subscription.fno.map(clean).filter(Boolean) };
    this.subscriptions.set(id, next);
    const idle = !this.timer && !this.running;
    const unseen = next.cash.some((symbol) => !this.prices.CASH.has(symbol)) || next.fno.some((symbol) => !this.prices.FNO.has(symbol));
    // Poll now when idle or when new symbols appear; never cut a rate-limit backoff short.
    if (idle || (unseen && this.status.state !== "rate-limited")) this.schedule(0);
  }

  removeSubscription(id: string) {
    this.subscriptions.delete(id);
    if (!this.subscriptions.size) this.stop();
  }

  /** Latest known ticks for a subscription, sent right away so a new tab never starts blank. */
  snapshot(subscription: Subscription) {
    const pick = (segment: GrowwSegment, symbols: string[]) => symbols.map(clean).map((symbol) => this.prices[segment].get(symbol)).filter((tick): tick is QuoteTick => Boolean(tick));
    return { cash: pick("CASH", subscription.cash), fno: pick("FNO", subscription.fno), status: this.status };
  }

  currentStatus() { return this.status; }

  stop() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule(delay: number) {
    if (this.running) return; // the in-flight poll reschedules itself
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => { this.timer = null; void this.poll(); }, delay);
  }

  private union(segment: "cash" | "fno") {
    const symbols = new Set<string>();
    for (const subscription of this.subscriptions.values()) for (const symbol of subscription[segment]) symbols.add(symbol);
    return [...symbols];
  }

  async poll() {
    if (this.running || !this.subscriptions.size) return;
    this.running = true;
    let delay = this.intervalMs;
    try {
      const cashSymbols = this.union("cash");
      const fnoSymbols = this.union("fno");
      const [cash, fno] = await Promise.all([
        cashSymbols.length ? this.fetchLtp(cashSymbols, "CASH") : Promise.resolve(new Map<string, number>()),
        fnoSymbols.length ? this.fetchLtp(fnoSymbols, "FNO") : Promise.resolve(new Map<string, number>()),
      ]);
      const now = new Date().toISOString();
      const changed = { cash: this.apply("CASH", cash, now), fno: this.apply("FNO", fno, now) };
      this.failures = 0;
      const gotAny = cash.size + fno.size > 0;
      this.status = gotAny ? { state: "live", updatedAt: now } : { state: "unavailable", detail: "Groww returned no prices for the subscribed symbols", updatedAt: this.status.updatedAt };
      this.emit(changed);
    } catch (error) {
      this.failures += 1;
      const limited = isRateLimitError(error);
      const hinted = Number((error as { retryAfterMs?: number })?.retryAfterMs);
      const backoff = Math.min(this.maxBackoffMs, this.intervalMs * 2 ** Math.min(this.failures, 6));
      delay = limited && Number.isFinite(hinted) && hinted > 0 ? Math.min(this.maxBackoffMs, Math.max(hinted, this.intervalMs)) : backoff;
      this.status = {
        state: limited ? "rate-limited" : "unavailable",
        detail: error instanceof Error ? error.message.slice(0, 240) : "Groww quotes unavailable",
        retryAt: new Date(Date.now() + delay).toISOString(),
        updatedAt: this.status.updatedAt,
      };
      this.emit({ cash: new Map(), fno: new Map() });
    } finally {
      this.running = false;
      if (this.subscriptions.size) this.schedule(delay);
    }
  }

  private apply(segment: GrowwSegment, prices: Map<string, number>, timestamp: string) {
    const changed = new Map<string, QuoteTick>();
    for (const [symbol, price] of prices) {
      const previous = this.prices[segment].get(symbol);
      const tick = { symbol, price, timestamp, source: SOURCE[segment] };
      this.prices[segment].set(symbol, tick);
      if (!previous || previous.price !== price) changed.set(symbol, tick);
    }
    return changed;
  }

  private emit(changed: { cash: Map<string, QuoteTick>; fno: Map<string, QuoteTick> }) {
    for (const listener of this.listeners) {
      try { listener(changed, this.status); } catch { /* one bad socket must not stop the feed */ }
    }
  }
}

function clean(symbol: string) { return String(symbol ?? "").trim().toUpperCase(); }
