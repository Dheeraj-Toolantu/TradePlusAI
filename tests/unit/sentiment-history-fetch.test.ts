import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { firestoreFake } from "../setup/firestore-fake";
import { FIRESTORE_TIMEOUT_MS, firestoreSafe, recentHistory, recordSentiment, recorderStatus, resetSentimentHistoryCache } from "../../apps/web/lib/sentiment-history";
import { fetchHistory } from "../../apps/web/components/sentiment-history";
import { GET } from "../../apps/web/app/api/sentiment-history/route";
import type { IndexSentiment } from "../../apps/web/lib/index-sentiment";

const scan = (at: string, score: number, extra: Record<string, unknown> = {}): IndexSentiment => ({
  generated_at: at,
  indices: [{ id: "NIFTY", name: "NIFTY 50", score, label: "X", zone: undefined, bias: "", quote: { price: 24000, change_pct: 0.3 },
    breadth: { bullish_pct: 40, bearish_pct: 40, neutral_pct: 20, advances: 25, declines: undefined, unchanged: 0 }, coverage: { stocks_scored: 50, stocks_total: 50, weight_scored_pct: 100 },
    constituents: [{ symbol: "TCS", name: undefined, weight: 4, score: Number.NaN, label: "X", price: 4100, change_pct: 0.1 }], ...extra }],
  commodities: { generated_at: at, notes: [], errors: [], method: "", commodities: [] },
} as unknown as IndexSentiment);

describe("sentiment history: recording never wedges and never writes undefined", () => {
  beforeEach(() => resetSentimentHistoryCache());
  afterEach(() => vi.useRealTimers());

  it("drops undefined fields and non-finite numbers before writing", async () => {
    expect(firestoreSafe({ a: 1, b: undefined, c: [1, undefined, { d: undefined, e: Number.NaN }], f: null })).toEqual({ a: 1, c: [1, { e: null }], f: null });
    let wrote: unknown = null;
    firestoreFake.onWrite(() => undefined);
    const result = await recordSentiment(scan("2026-10-21T03:45:00Z", 15), new Date("2026-10-21T03:46:00Z"));
    expect(result.recorded).toBe(true);
    wrote = firestoreFake.documents("sentimentSnapshots")[0];
    const json = JSON.stringify(wrote, (_key, value) => (value === undefined ? "UNDEFINED" : value));
    expect(json).not.toContain("UNDEFINED");
    expect(recorderStatus()).toMatchObject({ attempts: 1, failures: 0, lastSnapshotId: "20261021-0915", lastError: null });
  });

  it("a hung Firestore write times out, is reported, and the next minute records again", async () => {
    vi.useFakeTimers();
    firestoreFake.onWrite(() => new Promise<void>(() => undefined)); // the client SDK retrying forever
    const hung = recordSentiment(scan("2026-10-21T03:45:00Z", 15), new Date("2026-10-21T03:46:00Z"));
    const caught = hung.catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(FIRESTORE_TIMEOUT_MS + 1);
    expect(((await caught) as Error).message).toMatch(/timed out/);
    expect(recorderStatus()).toMatchObject({ attempts: 1, failures: 1 });
    expect(recorderStatus().lastError).toMatch(/write of snapshot 20261021-0915 timed out/);

    vi.useRealTimers();
    firestoreFake.onWrite(undefined); // Firestore is back
    const next = await recordSentiment(scan("2026-10-21T03:46:00Z", 15), new Date("2026-10-21T03:47:00Z"));
    expect(next).toMatchObject({ recorded: true, snapshotId: "20261021-0915" });
    expect(recorderStatus()).toMatchObject({ attempts: 2, failures: 1, lastError: null });
  });
});

describe("sentiment history: reading", () => {
  beforeEach(() => resetSentimentHistoryCache());

  it("a day's view also finds snapshots saved without a date field, by recordedAt in that IST day", async () => {
    firestoreFake.seed("sentimentSnapshots", "a", { recordedAt: "2026-10-20T18:45:00.000Z", reasons: ["SCHEDULED"], indices: {} }); // 21 Oct 00:15 IST
    firestoreFake.seed("sentimentSnapshots", "b", { date: "2026-10-21", recordedAt: "2026-10-21T04:00:00.000Z", reasons: ["SCHEDULED"], indices: {} });
    firestoreFake.seed("sentimentSnapshots", "c", { recordedAt: "2026-10-21T18:31:00.000Z", reasons: ["SCHEDULED"], indices: {} }); // 22 Oct IST
    expect((await recentHistory(20, "2026-10-21")).snapshots.map((item) => item.id)).toEqual(["b", "a"]);
  });

  it("a failed reversals read does not hide the snapshots", async () => {
    firestoreFake.seed("sentimentSnapshots", "b", { date: "2026-10-21", recordedAt: "2026-10-21T04:00:00.000Z", reasons: ["SCHEDULED"], indices: {} });
    firestoreFake.onRead((path) => { if (path === "sentimentReversals") throw new Error("permission-denied"); });
    const body = await (await GET(new Request("http://localhost/api/sentiment-history?limit=48"))).json();
    expect(body.snapshots).toHaveLength(1);
    expect(body.reversals).toEqual([]);
    expect(body.warnings[0]).toMatch(/Reversals unavailable: permission-denied/);
    expect(body.recorder).toMatchObject({ attempts: 0 });
  });

  it("a failed snapshots read is a 503 that names Firestore", async () => {
    firestoreFake.onRead(() => { throw new Error("unavailable"); });
    const response = await GET(new Request("http://localhost/api/sentiment-history?limit=48"));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/Couldn't read sentiment history from Firestore: unavailable/);
  });
});

describe("sentiment history panel fetch", () => {
  const reply = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;

  it("turns an HTML error page into a readable error instead of a JSON parse crash", async () => {
    await expect(fetchHistory("", reply(500, "<!DOCTYPE html><html>Internal Server Error</html>"))).rejects.toThrow("Sentiment history unavailable (HTTP 500).");
  });
  it("passes the server's error through", async () => {
    await expect(fetchHistory("", reply(503, JSON.stringify({ error: "Couldn't read sentiment history from Firestore: x" })))).rejects.toThrow(/Firestore: x/);
  });
  it("tolerates a reply without reversals", async () => {
    expect(await fetchHistory("2026-10-21", reply(200, JSON.stringify({ snapshots: [] })))).toMatchObject({ snapshots: [], reversals: [] });
  });
  it("names a network failure", async () => {
    await expect(fetchHistory("", (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch)).rejects.toThrow(/Couldn't reach the server/);
  });
});
