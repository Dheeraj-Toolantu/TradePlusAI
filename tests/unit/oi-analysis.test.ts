import { describe, expect, it } from "vitest";
import { firestoreFake } from "../setup/firestore-fake";
import { analyzeOi, buildupLabel, changeOn, maxPain, type StrikeSample } from "../../apps/web/lib/oi-analysis";
import { sampleOi, resetSentimentHistoryCache, strikeCache } from "../../apps/web/lib/sentiment-history";
import type { StrikeOi } from "../../apps/web/lib/oi-history";

const chain = (spot: number, tweak: (strike: number) => Partial<StrikeOi> = () => ({})): StrikeOi[] =>
  Array.from({ length: 21 }, (_, i) => { const strike = 24_500 + i * 50; return { strike, ce_oi: strike >= spot ? 2_000_000 + (strike - spot) * 1000 : 400_000, pe_oi: strike <= spot ? 2_500_000 + (spot - strike) * 800 : 300_000, ce_ltp: 50, pe_ltp: 50, ...tweak(strike) }; });
const sample = (at: string, time: string, spot: number, strikes: StrikeOi[]): StrikeSample => ({ at, time, spot, expiry: "2026-11-10", strikes, call_oi: strikes.reduce((s, r) => s + r.ce_oi, 0), put_oi: strikes.reduce((s, r) => s + r.pe_oi, 0), pcr: null });

describe("OI analysis", () => {
  const base = sample("2026-11-06T03:45:00Z", "09:15", 25_000, chain(25_000));
  const later = sample("2026-11-06T09:00:00Z", "14:30", 25_080, chain(25_000, (strike) => (strike === 24_900 ? { pe_oi: 6_000_000 } : strike === 25_200 ? { ce_oi: 1_000_000 } : {})));

  it("works out each strike's OI at the base, now and the change", () => {
    const result = analyzeOi([later, base], { range: 4 })!;
    expect(result.base.time).toBe("09:15");
    expect(result.rows).toHaveLength(9); // ATM ± 4 strikes
    const row = result.rows.find((item) => item.strike === 24_900)!;
    expect(row).toMatchObject({ pe_base: 2_580_000, pe_now: 6_000_000, pe_chg: 3_420_000 });
    expect(result.totals.pe_chg).toBe(3_420_000);
    expect(result.totals.ce_chg).toBe(1_000_000 - 2_200_000);
    expect(result.put_buildup[0].strike).toBe(24_900);
    expect(result.call_unwinding[0].strike).toBe(25_200);
    expect(result.bias.label).toMatch(/bullish/i);
    expect(result.support?.strike).toBe(24_900);
    expect(result.spot_chg).toBe(80);
  });

  it("replays an earlier sample and ignores strikes the moving window added", () => {
    const shifted = sample("2026-11-06T05:00:00Z", "10:30", 25_000, [...chain(25_000), { strike: 25_550, ce_oi: 9_000_000, pe_oi: 10, ce_ltp: 1, pe_ltp: 1 }]);
    expect(changeOn(base, shifted).ce).toBe(0); // the new strike is not "fresh OI"
    const replay = analyzeOi([base, shifted, later], { at: 1 })!;
    expect(replay.current.time).toBe("10:30");
    expect(replay.totals.ce_chg).toBe(0);
    expect(replay.series).toHaveLength(2);
  });

  it("reads price against writer OI", () => {
    expect(buildupLabel(50, -10, 20)).toMatch(/^Bullish/);
    expect(buildupLabel(-50, 20, -10)).toMatch(/^Bearish/);
    expect(buildupLabel(50, 30, 10)).toMatch(/^Rally into call writing/);
    expect(buildupLabel(-50, 5, 30)).toMatch(/^Dip into put writing/);
  });

  it("finds max pain", () => {
    expect(maxPain([{ strike: 100, ce_oi: 0, pe_oi: 10, ce_ltp: null, pe_ltp: null }, { strike: 110, ce_oi: 10, pe_oi: 10, ce_ltp: null, pe_ltp: null }, { strike: 120, ce_oi: 10, pe_oi: 0, ce_ltp: null, pe_ltp: null }])).toBe(110);
  });
});

describe("OI analysis route", () => {
  it("serves the day's stored strike samples, new ones only with since, and a three-index summary", async () => {
    resetSentimentHistoryCache();
    strikeCache().clear();
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const now = Date.now();
    for (const [n, minutesAgo] of [[0, 6], [1, 3], [2, 0]] as const) {
      const at = new Date(now - minutesAgo * 60_000);
      await sampleOi(at, async () => ({ NIFTY: { expiry: "2026-11-10", call_oi: 1, put_oi: 1, pcr: 1, spot: 25_000 + n * 10, at: at.toISOString(), strikes: chain(25_000) } }));
    }
    const stored = firestoreFake.documents("oiStrikes") as Array<Record<string, any>>;
    expect(stored).toHaveLength(3);
    expect(stored[0].key).toBe(`NIFTY|${today}`);
    expect(firestoreFake.documents("oiSamples")[0]).not.toHaveProperty("strikes");
    const { GET } = await import("../../apps/web/app/api/oi-analysis/route");
    const body = await (await GET(new Request(`http://localhost/api/oi-analysis?symbol=NIFTY&date=${today}`))).json();
    expect(body.samples).toHaveLength(3);
    const since = body.samples[1].at;
    const fresh = await (await GET(new Request(`http://localhost/api/oi-analysis?symbol=NIFTY&date=${today}&since=${encodeURIComponent(since)}`))).json();
    expect(fresh.samples).toHaveLength(1);
    const summary = await (await GET(new Request(`http://localhost/api/oi-analysis?summary=1&date=${today}`))).json();
    expect(summary.indices.map((item: { symbol: string }) => item.symbol)).toEqual(["NIFTY", "BANKNIFTY", "SENSEX"]);
    expect(summary.indices[0].analysis.totals.pcr_now).toBeGreaterThan(0);
    expect(summary.indices[0].analysis.rows).toEqual([]);
    expect((await GET(new Request("http://localhost/api/oi-analysis?symbol=XYZ"))).status).toBe(400);
  });
});
