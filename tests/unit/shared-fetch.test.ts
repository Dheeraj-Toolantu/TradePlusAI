import { beforeEach, describe, expect, it } from "vitest";
import { clearSharedFetch, fetchJsonShared } from "../../apps/web/lib/shared-fetch";

describe("fetchJsonShared", () => {
  beforeEach(() => clearSharedFetch());
  const counting = (status = 200) => {
    const calls: string[] = [];
    const fetcher = (async (url: string) => { calls.push(url); return new Response(JSON.stringify({ n: calls.length }), { status }); }) as unknown as typeof fetch;
    return { calls, fetcher };
  };

  it("shares one request between panels asking at the same time", async () => {
    const { calls, fetcher } = counting();
    const [a, b] = await Promise.all([fetchJsonShared("/api/option-chain?symbol=NIFTY&full=1", 20_000, fetcher), fetchJsonShared("/api/option-chain?symbol=NIFTY&full=1", 20_000, fetcher)]);
    expect(calls).toHaveLength(1);
    expect(a).toEqual(b);
  });

  it("reuses a fresh body and refetches once it is older than maxAge", async () => {
    const { calls, fetcher } = counting();
    let t = 1_000;
    await fetchJsonShared("/x", 20_000, fetcher, () => t);
    t += 19_000;
    await fetchJsonShared("/x", 20_000, fetcher, () => t);
    expect(calls).toHaveLength(1);
    t += 2_000;
    expect(await fetchJsonShared("/x", 20_000, fetcher, () => t)).toEqual({ n: 2 });
  });

  it("never caches an error reply", async () => {
    const { calls, fetcher } = counting(503);
    await fetchJsonShared("/y", 20_000, fetcher);
    await fetchJsonShared("/y", 20_000, fetcher);
    expect(calls).toHaveLength(2);
  });
});
