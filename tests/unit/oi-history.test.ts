import { beforeEach, describe, expect, it } from "vitest";
import { firestoreFake } from "../setup/firestore-fake";
import { oiReading, readAllOi, writerSignal, type OiTotals } from "../../apps/web/lib/oi-history";
import { recordSentiment, resetSentimentHistoryCache } from "../../apps/web/lib/sentiment-history";
import { oiUnits } from "../../apps/web/components/sentiment-history";
import type { IndexSentiment } from "../../apps/web/lib/index-sentiment";

const totals = (call: number, put: number, at = "2026-11-06T04:00:00Z"): OiTotals => ({ expiry: "2026-11-10", call_oi: call, put_oi: put, pcr: Number((put / call).toFixed(3)), spot: 25_000, at });
const scan = (at: string): IndexSentiment => ({
  generated_at: at,
  indices: [{ id: "NIFTY", name: "NIFTY 50", score: 12, label: "BULLISH", zone: "Neutral", bias: "", quote: { price: 25_010, change_pct: 0.3 },
    breadth: { bullish_pct: 40, bearish_pct: 40, neutral_pct: 20, advances: 25, declines: 25, unchanged: 0 }, coverage: { stocks_scored: 50, stocks_total: 50, weight_scored_pct: 100 } }],
  commodities: { generated_at: at, notes: [], errors: [], method: "", commodities: ["CRUDEOIL", "GOLD", "SILVER"].map((id, n) => ({ id, name: id, symbol: id, unit: "$", score: 10 + n, label: "BULLISH", price: 80 + n, change_pct: 0.5, five_day_pct: 1, vs_20dma_pct: 1, lenses: {}, india_impact: -5, india_label: "BEARISH", why: "", headlines: [] })) },
} as unknown as IndexSentiment);

describe("option-writer OI for the sentiment history", () => {
  beforeEach(() => resetSentimentHistoryCache());

  it("works out % change since the last snapshot and since the day's first", () => {
    const first = oiReading(totals(1_000_000, 1_200_000), undefined, "2026-11-06");
    expect(first.reading).toMatchObject({ call_change_pct: null, put_change_pct: null, call_writers: "UNKNOWN" });
    const second = oiReading(totals(1_050_000, 1_150_000), first.next, "2026-11-06");
    expect(second.reading).toMatchObject({ call_change_pct: 5, put_change_pct: -4.17, call_writers: "ADDING", put_writers: "COVERING" });
    expect(second.reading.signal).toMatch(/^Bearish: call writers adding, put writers covering/);
    const third = oiReading(totals(1_071_000, 1_150_000), second.next, "2026-11-06");
    expect(third.reading.call_change_pct).toBe(2);
    expect(third.reading.call_change_day_pct).toBe(7.1); // vs the day's first reading
    // A new day starts a new baseline.
    expect(oiReading(totals(900_000, 900_000), third.next, "2026-11-07").reading.call_change_pct).toBeNull();
  });

  it("reads the writers' moves", () => {
    expect(writerSignal("COVERING", "ADDING")).toMatch(/^Bullish:/);
    expect(writerSignal("FLAT", "ADDING")).toMatch(/^Bullish lean/);
    expect(writerSignal("ADDING", "ADDING")).toMatch(/^Range/);
    expect(writerSignal("FLAT", "FLAT")).toMatch(/^Neutral/);
  });

  it("leaves out an index whose chain fails", async () => {
    const all = await readAllOi(async (id) => { if (id === "SENSEX") throw new Error("down"); return totals(1, 2); });
    expect(Object.keys(all)).toEqual(["NIFTY", "BANKNIFTY"]);
  });

  it("formats OI in lakh and crore", () => {
    expect(oiUnits(12_500_000)).toBe("1.25 Cr");
    expect(oiUnits(486_000)).toBe("4.86 L");
    expect(oiUnits(null)).toBe("--");
  });

  it("saves OI with each snapshot, next to crude oil, gold and silver", async () => {
    let call = 1_000_000;
    const reader = async () => ({ NIFTY: totals(call, 1_200_000) });
    await recordSentiment(scan("2026-11-06T03:45:00Z"), new Date("2026-11-06T03:46:00Z"), reader);
    call = 1_100_000;
    await recordSentiment(scan("2026-11-06T04:00:00Z"), new Date("2026-11-06T04:01:00Z"), reader);
    const saved = firestoreFake.documents("sentimentSnapshots") as Array<Record<string, any>>;
    const later = saved.find((doc) => doc.id === "20261106-0930")!;
    expect(later.indices.NIFTY.oi).toMatchObject({ call_oi: 1_100_000, put_oi: 1_200_000, call_change_pct: 10, put_change_pct: 0, call_writers: "ADDING" });
    expect(Object.keys(later.commodities)).toEqual(["CRUDEOIL", "GOLD", "SILVER"]);
    // A failing OI read never blocks the snapshot.
    const failed = await recordSentiment(scan("2026-11-06T04:15:00Z"), new Date("2026-11-06T04:16:00Z"), async () => { throw new Error("chain down"); });
    expect(failed.recorded).toBe(true);
  });
});
