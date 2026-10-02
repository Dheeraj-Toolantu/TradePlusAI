import { describe, expect, it } from "vitest";
import type { GrowwTransport } from "../../adapters/groww/src/groww-adapter";
import { compactDays, loadBacktestData, validateSourceRange } from "../../apps/web/lib/backtest-data";
import { parseBacktestCandles, parseCandleTime, weekChunks } from "../../apps/web/lib/groww-backtest-history";

const IST_S = 330 * 60;
const at = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00Z`) / 1000 - IST_S;

/** A fake Groww backtesting API: 1-minute candles with IST wall-clock timestamps for each weekday. */
function fakeGroww(options: { fail?: boolean } = {}) {
  const paths: string[] = [];
  const transport: GrowwTransport = {
    async request(path) {
      paths.push(path);
      if (options.fail) throw new Error("Groww API 403");
      const query = new URLSearchParams(path.split("?")[1]);
      const from = query.get("start_time")!.slice(0, 10);
      const to = query.get("end_time")!.slice(0, 10);
      const candles: unknown[] = [];
      for (let day = from; day <= to; day = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
        const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
        if (dow === 0 || dow === 6) continue;
        for (let m = 0; m < 375; m += 1) {
          const minutes = 9 * 60 + 15 + m;
          const clock = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
          candles.push([`${day}T${clock}:00`, 25_000 + m, 25_002 + m, 24_999 + m, 25_001 + m, 0, null]);
        }
      }
      return { status: "SUCCESS", payload: { candles, interval_in_minutes: 1 } };
    },
  };
  return { transport, paths };
}

describe("Groww backtesting history", () => {
  it("parses IST wall-clock, epoch-second and epoch-millisecond timestamps", () => {
    expect(parseCandleTime("2026-04-06T09:15:00")).toBe(at("2026-04-06", "09:15"));
    expect(parseCandleTime("2026-04-06 09:15:00")).toBe(at("2026-04-06", "09:15"));
    expect(parseCandleTime("2026-04-06T03:45:00Z")).toBe(at("2026-04-06", "09:15"));
    expect(parseCandleTime(at("2026-04-06", "09:15"))).toBe(at("2026-04-06", "09:15"));
    expect(parseCandleTime(at("2026-04-06", "09:15") * 1000)).toBe(at("2026-04-06", "09:15"));
    expect(parseCandleTime("not a date")).toBeNull();
  });

  it("parses array and object candles and drops malformed rows", () => {
    const bars = parseBacktestCandles({ payload: { candles: [["2026-04-06T09:15:00", 1, 2, 0.5, 1.5, 100, null], { timestamp: "2026-04-06T09:16:00", open: 1.5, high: 2, low: 1, close: 1.8, volume: 0 }, ["bad", 1, 2, 3, 4], [1]] } });
    expect(bars).toEqual([
      { time: at("2026-04-06", "09:15"), open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
      { time: at("2026-04-06", "09:16"), open: 1.5, high: 2, low: 1, close: 1.8, volume: null },
    ]);
  });

  it("splits a range into 7-day request windows", () => {
    expect(weekChunks("2026-04-01", "2026-04-20")).toEqual([{ from: "2026-04-01", to: "2026-04-07" }, { from: "2026-04-08", to: "2026-04-14" }, { from: "2026-04-15", to: "2026-04-20" }]);
  });

  it("loads six months of 1-minute candles from the backtesting API (beyond the 3-month window)", async () => {
    const { transport, paths } = fakeGroww();
    const data = await loadBacktestData({ symbol: "NIFTY", from: "2026-03-02", to: "2026-08-31", source: "groww", origin: "http://local", growwTransport: transport, fetcher: (async () => new Response(JSON.stringify({ candles: [] }))) as typeof fetch });
    expect(paths[0]).toContain("/v1/historical/candles?");
    expect(paths[0]).toContain("groww_symbol=NSE-NIFTY");
    expect(paths[0]).toContain("candle_interval=1minute");
    expect(paths.length).toBe(weekChunks("2026-02-25", "2026-08-31").length);
    expect(data.provider).toBe("groww");
    expect(data.sessions).toBe(131); // weekdays 2026-03-02 → 2026-08-31
    expect(data.minute[0].time).toBe(at("2026-02-25", "09:15"));
    expect(new Set(data.minute.map((bar) => bar.time)).size).toBe(data.minute.length);
    expect(data.issues.filter((issue) => issue.startsWith("No 1-minute"))).toEqual([]);
  });

  it("falls back to the per-day route and says why when the backtesting API is unavailable", async () => {
    const { transport } = fakeGroww({ fail: true });
    const days: string[] = [];
    const fetcher = (async (url: string) => {
      const date = new URL(url).searchParams.get("date")!;
      const timeframe = new URL(url).searchParams.get("timeframe");
      if (timeframe === "1m") days.push(date);
      // The old route only has the last few days; older days come back empty.
      const candles = timeframe === "1m" && date >= "2026-09-24" ? [{ time: at(date, "09:15"), open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 }] : [];
      return new Response(JSON.stringify({ candles, delayed: false }));
    }) as unknown as typeof fetch;
    const data = await loadBacktestData({ symbol: "NIFTY", from: "2026-09-21", to: "2026-09-25", source: "groww", origin: "http://local", growwTransport: transport, fetcher });
    expect(days).toContain("2026-09-21");
    expect(data.sessions).toBe(2);
    expect(data.provider).toMatch(/per-day/);
    expect(data.issues.join(" ")).toMatch(/backtesting API unavailable \(Groww API 403\)/);
    expect(data.issues[0]).toBe("No 1-minute candles for 3 weekdays (exchange holidays, or outside the provider's history): 2026-09-21 → 2026-09-23");
  });

  it("rejects Yahoo ranges older than its 1-minute window", () => {
    expect(validateSourceRange("yahoo", "2020-01-01")).toMatch(/Yahoo only keeps/);
    expect(validateSourceRange("groww", "2020-01-01")).toBeNull();
  });

  it("compacts consecutive weekdays across weekends", () => {
    expect(compactDays(["2026-06-03", "2026-06-04", "2026-06-05", "2026-06-08", "2026-06-10"])).toBe("2026-06-03 → 2026-06-08, 2026-06-10");
  });
});
