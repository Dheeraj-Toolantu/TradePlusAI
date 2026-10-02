import type { Bar } from "../../ai-monitoring/src/mtf-decision-engine";

/**
 * Deterministic synthetic NIFTY-like 1-minute session data for demos and tests ONLY. It is a seeded
 * random walk with intraday trend regimes; results on it say nothing about real-market performance.
 */
function rng(seed: number) {
  let state = seed >>> 0 || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}

const weekdays = (from: string, to: string) => {
  const days: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
};

export function syntheticSessions(from: string, to: string, options: { start?: number; seed?: number } = {}) {
  const random = rng(options.seed ?? 7);
  let price = options.start ?? 25_000;
  const minute: Bar[] = [];
  const daily: Bar[] = [];
  for (const day of weekdays(from, to)) {
    const open = price * (1 + (random() - 0.5) * 0.006);
    price = open;
    let drift = (random() - 0.5) * 1.2;
    const sessionStart = Date.parse(`${day}T09:15:00+05:30`) / 1000;
    let high = open; let low = open;
    for (let m = 0; m < 375; m += 1) {
      if (m % 45 === 0) drift = (random() - 0.5) * 1.6;
      const o = price;
      const c = o + drift + (random() - 0.5) * 9;
      const h = Math.max(o, c) + random() * 4;
      const l = Math.min(o, c) - random() * 4;
      minute.push({ time: sessionStart + m * 60, open: o, high: h, low: l, close: c, volume: Math.round(2000 + random() * 3000) });
      price = c; high = Math.max(high, h); low = Math.min(low, l);
    }
    daily.push({ time: sessionStart, open, high, low, close: price, volume: 0 });
  }
  return { minute, daily };
}
