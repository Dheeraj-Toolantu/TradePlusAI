import { beforeEach, describe, expect, it } from "vitest";
import { firestoreFake } from "../setup/firestore-fake";
import { detectReversals, priceDirection, recordSentiment, resetSentimentHistoryCache, sentimentDirection, slotId, type HistoryState } from "../../apps/web/lib/sentiment-history";
import type { IndexSentiment } from "../../apps/web/lib/index-sentiment";

const index = (id: string, score: number | null, change: number) => ({
  id, name: id, score, label: "X", zone: "Neutral", bias: "", quote: { price: 24000, change_pct: change },
  breadth: { bullish_pct: 40, bearish_pct: 40, neutral_pct: 20, advances: 25, declines: 25, unchanged: 0 }, coverage: { stocks_scored: 50, stocks_total: 50, weight_scored_pct: 100 },
});
const scan = (at: string, nifty: number | null, niftyChange: number, crude: number | null = 20): IndexSentiment => ({
  generated_at: at,
  indices: [index("NIFTY", nifty, niftyChange), index("SENSEX", -9, -0.19)],
  commodities: { generated_at: at, notes: [], errors: [], method: "", commodities: [{ id: "CRUDEOIL", name: "Crude oil (Brent)", symbol: "BZ=F", unit: "$/bbl", score: crude, label: "BULLISH", price: 82.5,
    change_pct: 1.2, five_day_pct: 3, vs_20dma_pct: 2, lenses: { price: 60, trend: 30, news: 10 }, india_impact: crude === null ? null : -crude, india_label: "BEARISH", why: "", headlines: [] }] },
} as unknown as IndexSentiment);

describe("sentiment history", () => {
  beforeEach(() => resetSentimentHistoryCache());

  it("slots time into 15-minute IST buckets", () => {
    expect(slotId(new Date("2026-10-21T03:52:00Z"))).toBe("20261021-0915");
    expect(slotId(new Date("2026-10-21T03:52:00Z"), 1)).toBe("20261021-0922");
    expect(slotId(new Date("2026-10-21T18:40:00Z"))).toBe("20261022-0000");
  });

  it("uses a band so a score wobbling around zero is not a flip", () => {
    expect(sentimentDirection(12)).toBe("BULLISH");
    expect(sentimentDirection(-3, "BULLISH")).toBe("BULLISH");
    expect(sentimentDirection(-11, "BULLISH")).toBe("BEARISH");
    expect(priceDirection(0.1, "DOWN")).toBe("DOWN");
    expect(priceDirection(0.25, "DOWN")).toBe("UP");
  });

  it("detects sentiment and price reversals against the stored state", () => {
    const state: HistoryState = { lastSlot: null, lastScanAt: "a", instruments: { NIFTY: { sentiment: "BULLISH", price: "UP", score: 15, change_pct: 0.4, at: "a" } } };
    const { reversals, next } = detectReversals([{ id: "NIFTY", kind: "INDEX", name: "NIFTY 50", score: -11, label: "", price: 1, change_pct: -0.34, extra: {} }], state, "b");
    expect(reversals.map((item) => `${item.type}:${item.from}->${item.to}`)).toEqual(["SENTIMENT:BULLISH->BEARISH", "PRICE:UP->DOWN"]);
    expect(next.NIFTY).toMatchObject({ sentiment: "BEARISH", price: "DOWN", score: -11 });
  });

  it("stores one snapshot per 15-minute slot and another on a reversal", async () => {
    const first = await recordSentiment(scan("2026-10-21T03:45:00Z", 15, 0.3), new Date("2026-10-21T03:46:00Z")); // 09:16 IST
    expect(first).toMatchObject({ recorded: true, snapshotId: "20261021-0915", reasons: ["SCHEDULED"] });
    const saved = firestoreFake.documents("sentimentSnapshots")[0] as Record<string, any>;
    expect(saved.indices.NIFTY).toMatchObject({ score: 15, change_pct: 0.3, advances: 25 });
    expect(saved.commodities.CRUDEOIL).toMatchObject({ score: 20, india_impact: -20, unit: "$/bbl" });

    // Same slot, same scan: nothing to do.
    expect((await recordSentiment(scan("2026-10-21T03:45:00Z", 15, 0.3), new Date("2026-10-21T03:50:00Z"))).recorded).toBe(false);
    // Same slot, new scan, no reversal: nothing either.
    expect((await recordSentiment(scan("2026-10-21T03:51:00Z", 4, 0.1), new Date("2026-10-21T03:52:00Z"))).recorded).toBe(false);

    // NIFTY turns bearish and red within the slot: an immediate reversal snapshot.
    const flipped = await recordSentiment(scan("2026-10-21T03:55:00Z", -11, -0.34), new Date("2026-10-21T03:56:00Z")); // 09:26 IST
    expect(flipped.reasons).toEqual(["REVERSAL"]);
    expect(flipped.snapshotId).toBe("20261021-0926-reversal");
    expect(firestoreFake.documents("sentimentReversals").map((item: Record<string, any>) => `${item.instrument}:${item.type}:${item.from}->${item.to}`).sort())
      .toEqual(["NIFTY:PRICE:UP->DOWN", "NIFTY:SENTIMENT:BULLISH->BEARISH"]);

    // Next slot: scheduled snapshot again. A restart reads the state back from Firestore.
    resetSentimentHistoryCache();
    const next = await recordSentiment(scan("2026-10-21T03:55:00Z", -11, -0.34), new Date("2026-10-21T04:01:00Z")); // 09:31 IST
    expect(next).toMatchObject({ recorded: true, snapshotId: "20261021-0930", reasons: ["SCHEDULED"], reversals: [] });
    expect(firestoreFake.documents("sentimentSnapshots").map((item) => item.id).sort()).toEqual(["20261021-0915", "20261021-0926-reversal", "20261021-0930"]);
  });

  it("detects a commodity reversal too", async () => {
    await recordSentiment(scan("2026-10-21T03:45:00Z", 15, 0.3, 30), new Date("2026-10-21T03:46:00Z"));
    const result = await recordSentiment(scan("2026-10-21T03:55:00Z", 15, 0.3, -25), new Date("2026-10-21T03:56:00Z"));
    expect(result.reversals.map((item) => `${item.instrument}:${item.from}->${item.to}`)).toEqual(["CRUDEOIL:BULLISH->BEARISH"]);
  });
});
