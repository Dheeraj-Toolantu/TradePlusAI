import { gunzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runPythonModule = vi.fn();
vi.mock("../../apps/web/lib/python", () => ({ runPythonModule: (...args: unknown[]) => runPythonModule(...args) }));

import { GET as telegramGet } from "../../apps/web/app/api/telegram-live/route";
import { GET as sentimentGet } from "../../apps/web/app/api/index-sentiment/route";
import { mergeTelegram } from "../../apps/web/lib/telegram-merge";
import type { IndexSentiment } from "../../apps/web/lib/index-sentiment";
import type { TelegramLive } from "../../apps/web/lib/telegram-live";

const store = globalThis as { __tradepulseTelegramLive?: { at: number } | null; __tradepulseIndexSentiment?: { at: number; value: unknown } | null; __tradepulseSentiment?: unknown };
const live = (signature: string, posts = 1): TelegramLive => ({
  generated_at: "2026-10-12T10:00:00+00:00", signature, window_hours: 8,
  options: { window_hours: 8, posts_scanned: posts, calls_parsed: 1, consensus: [], top_pick: null, by_underlying: [], channels: [], notes: [], method: "" },
  stocks: { TATASTEEL: { posts, buy_calls: 3, sell_calls: 0, hype_posts: 2, channels: 2, views: 1000, mood: 60 } },
  feed: [], channels: [],
});
const stock = (symbol: string) => ({ symbol, retail: { posts: 0, bullish: 0, bearish: 0, telegram: { posts: 0, buy_calls: 0, sell_calls: 0, hype_posts: 0, channels: 0, views: 0 } } });
const scan = { generated_at: "2026-10-12T09:55:00+00:00", indices: [{ id: "NIFTY", quote: { price: 24500 }, retail: { telegram: { posts: 0, buy_calls: 0, sell_calls: 0, hype_posts: 0, most_tipped: [] } }, constituents: [stock("TATASTEEL"), stock("ITC")] }], filler: "x".repeat(5000) };

describe("telegram live route", () => {
  beforeEach(() => {
    store.__tradepulseTelegramLive = null;
    store.__tradepulseIndexSentiment = { at: Date.now(), value: scan };
    runPythonModule.mockReset();
  });

  it("runs the fast scan with spots from the cached index scan and caches it", async () => {
    runPythonModule.mockResolvedValueOnce(live("a"));
    const response = await telegramGet(new Request("http://localhost/api/telegram-live"));
    expect((await response.json()).signature).toBe("a");
    expect(runPythonModule).toHaveBeenCalledWith("tradepulse_quant.sentiment.telegram_scan", { spots: { NIFTY: 24500 } }, 40_000);
    await telegramGet(new Request("http://localhost/api/telegram-live"));
    expect(runPythonModule).toHaveBeenCalledTimes(1);
  });

  it("answers 304 when the client already has this version", async () => {
    runPythonModule.mockResolvedValueOnce(live("b"));
    const first = await telegramGet(new Request("http://localhost/api/telegram-live"));
    const etag = first.headers.get("etag")!;
    const again = await telegramGet(new Request("http://localhost/api/telegram-live", { headers: { "if-none-match": etag } }));
    expect(again.status).toBe(304);
  });
});

describe("index sentiment route", () => {
  beforeEach(() => { store.__tradepulseIndexSentiment = { at: Date.now(), value: scan }; });

  it("gzips full responses and serves a tiny meta response for change detection", async () => {
    const full = await sentimentGet(new Request("http://localhost/api/index-sentiment", { headers: { "accept-encoding": "gzip, br" } }));
    expect(full.headers.get("content-encoding")).toBe("gzip");
    const body = JSON.parse(gunzipSync(Buffer.from(await full.arrayBuffer())).toString());
    expect(body.generated_at).toBe(scan.generated_at);
    const meta = await (await sentimentGet(new Request("http://localhost/api/index-sentiment?meta=1"))).json();
    expect(meta).toEqual({ generated_at: scan.generated_at });
  });
});

describe("mergeTelegram", () => {
  it("overlays live Telegram calls on the last full scan", () => {
    const merged = mergeTelegram(scan as unknown as IndexSentiment, live("c", 4))!;
    const nifty = merged.indices[0];
    expect(nifty.constituents[0].retail.telegram.buy_calls).toBe(3);
    expect(nifty.constituents[1].retail.telegram.posts).toBe(0);
    expect(nifty.retail.telegram.most_tipped[0]).toEqual({ symbol: "TATASTEEL", buy_calls: 3, sell_calls: 0, hype_posts: 2 });
    expect(merged.telegram_options?.posts_scanned).toBe(4);
    expect(mergeTelegram(null, live("d"))).toBeNull();
  });
});
