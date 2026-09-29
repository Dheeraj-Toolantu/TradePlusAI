/**
 * Client-side budget for Groww market-data calls (live-data, option-chain, historical).
 *
 * Groww throttles the whole account (roughly 10 req/s and 300 req/min for live data), and the
 * web app and the quote socket server run as two processes on the same key. Each process queues
 * its own calls under a per-process share of that budget so a burst never trips the broker's 429
 * cooldown, which would otherwise blank every panel for 30 s at a time.
 */
export class RateLimitError extends Error {
  constructor(message: string, readonly retryAfterMs: number) {
    super(message);
    this.name = "RateLimitError";
  }
}

export type RateLimiter = { acquire(): Promise<void>; reset(): void };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createRateLimiter(perSecond: number, perMinute: number, maxWaitMs = 10_000, now: () => number = Date.now): RateLimiter {
  let stamps: number[] = [];
  let queue: Promise<void> = Promise.resolve();
  const slot = async () => {
    for (;;) {
      const current = now();
      stamps = stamps.filter((stamp) => current - stamp < 60_000);
      const inLastSecond = stamps.filter((stamp) => current - stamp < 1000);
      if (stamps.length < perMinute && inLastSecond.length < perSecond) { stamps.push(current); return; }
      const minuteWait = stamps.length >= perMinute ? stamps[stamps.length - perMinute] + 60_000 - current : 0;
      const secondWait = inLastSecond.length >= perSecond ? inLastSecond[inLastSecond.length - perSecond] + 1000 - current : 0;
      const wait = Math.max(minuteWait, secondWait, 1);
      if (wait > maxWaitMs) throw new RateLimitError(`Groww market-data budget is used up for this minute; retrying in ${Math.ceil(wait / 1000)} s`, wait);
      await sleep(wait);
    }
  };
  return {
    acquire() {
      const next = queue.then(slot);
      queue = next.catch(() => undefined);
      return next;
    },
    reset() { stamps = []; },
  };
}

const positive = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const store = globalThis as typeof globalThis & { __tradepulseGrowwMarketLimiter?: RateLimiter };

/** Shared limiter for this process. Defaults leave room for the second process on the same key. */
export function growwMarketDataLimiter(environment: NodeJS.ProcessEnv = process.env): RateLimiter {
  return (store.__tradepulseGrowwMarketLimiter ??= createRateLimiter(positive(environment.GROWW_MARKET_DATA_PER_SECOND, 4), positive(environment.GROWW_MARKET_DATA_PER_MINUTE, 140)));
}

export const isMarketDataPath = (path: string) => /^\/v1\/(live-data|option-chain|historical)\//.test(path);

export function isRateLimitError(error: unknown): boolean {
  if (error instanceof RateLimitError) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /\b429\b|rate.?limit|too many requests|budget is used up/i.test(message);
}
