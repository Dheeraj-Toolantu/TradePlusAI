import { beforeEach, describe, expect, it } from "vitest";
import { firestoreFake } from "../setup/firestore-fake";
import { GET } from "../../apps/web/app/api/sentiment-history/route";
import { resetSentimentHistoryCache } from "../../apps/web/lib/sentiment-history";

describe("sentiment history route", () => {
  beforeEach(() => resetSentimentHistoryCache());

  it("reads one day's snapshots and reversals", async () => {
    firestoreFake.seed("sentimentSnapshots", "20261021-0915", { date: "2026-10-21", time: "09:15", recordedAt: "2026-10-21T03:45:00Z", reasons: ["SCHEDULED"], indices: { NIFTY: { score: -11, price: 22811.35 } } });
    firestoreFake.seed("sentimentSnapshots", "20261020-1500", { date: "2026-10-20", time: "15:00", recordedAt: "2026-10-20T09:30:00Z", reasons: ["SCHEDULED"], indices: {} });
    firestoreFake.seed("sentimentReversals", "r1", { date: "2026-10-21", recordedAt: "2026-10-21T03:50:00Z", instrument: "NIFTY", type: "PRICE", from: "UP", to: "DOWN" });
    const body = await (await GET(new Request("http://localhost/api/sentiment-history?date=2026-10-21"))).json();
    expect(body.snapshots.map((item: { id: string }) => item.id)).toEqual(["20261021-0915"]);
    expect(body.snapshots[0].indices.NIFTY.price).toBe(22811.35);
    expect(body.reversals).toHaveLength(1);
  });

  it("rejects a malformed date", async () => {
    expect((await GET(new Request("http://localhost/api/sentiment-history?date=21-10-2026"))).status).toBe(400);
  });
});
