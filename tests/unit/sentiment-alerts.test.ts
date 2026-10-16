import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, diffScan, diffTelegram, emptyBaseline } from "../../apps/web/lib/sentiment-alerts";
import type { IndexSentiment, IndexSentimentReading } from "../../apps/web/lib/index-sentiment";
import type { TelegramLive } from "../../apps/web/lib/telegram-live";

type Post = TelegramLive["feed"][number];
const post = (link: string, extra: Partial<Post> = {}): Post => ({ channel: "nifty_calls", text: `post ${link}`, link, published: "2026-10-16T09:30:00Z", age_hours: 0.1, views: 100, stocks: [], options: [], ...extra });
const live = (feed: Post[], topPick: TelegramLive["options"]["top_pick"] = null): TelegramLive => ({
  generated_at: "2026-10-16T09:30:00Z", signature: feed.map((row) => row.link).join(","), window_hours: 8, stocks: {}, channels: [], feed,
  options: { window_hours: 8, posts_scanned: 0, calls_parsed: 0, consensus: [], top_pick: topPick, by_underlying: [], channels: [], notes: [], method: "" },
});
const pick = (contract: string) => ({
  underlying: "NIFTY", strike: 25000, type: "CE" as const, side: "BUY" as const, contract, mentions: 4, channels: ["a", "b"], channel_count: 2, consensus_score: 70,
  entry: 120, target: 160, stop: 95, plan_odds: null, reward_risk: null, spot: null, moneyness_pct: null, otm: null, far_otm: false, latest_age_hours: 0.2, views: 0,
  posts: [{ channel: "a", text: "buy", link: "https://t.me/a/1", age_hours: 0.2 }],
});

type Headline = IndexSentimentReading["constituents"][number]["headlines"][number];
const headline = (link: string, score: number, extra: Partial<Headline> = {}): Headline => ({ title: `Headline ${link}`, link, source: "Moneycontrol", tier: "PREMIUM", score, age_hours: 0.5, ...extra });
const scan = (score: number, zone: string, headlines: Headline[] = []): IndexSentiment => ({
  generated_at: new Date().toISOString(), market_context: null, feeds: [], sources: [], freshness: { max_age_hours: 8, fresh_window_hours: 4 }, method: "",
  indices: [{ id: "NIFTY", name: "NIFTY 50", score, zone, label: zone, bias: "Buy dips", quote: { price: 25000, change_pct: 0.4 }, constituents: [{ symbol: "RELIANCE", name: "Reliance", weight: 9.5, headlines }] } as unknown as IndexSentimentReading],
});

describe("diffTelegram", () => {
  it("seeds on the first reading, then alerts only on new posts", () => {
    const base = emptyBaseline();
    expect(diffTelegram(base, live([post("1"), post("2")]), DEFAULT_PREFS)).toEqual([]);
    const alerts = diffTelegram(base, live([post("3", { options: ["NIFTY 25000 CE"] }), post("1"), post("2")]), DEFAULT_PREFS);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "telegram", tone: "up", link: "3" });
    expect(diffTelegram(base, live([post("3"), post("1")]), DEFAULT_PREFS)).toEqual([]);
  });

  it("groups a burst into one alert and can filter to index option calls", () => {
    const base = emptyBaseline();
    diffTelegram(base, live([post("0")]), DEFAULT_PREFS);
    const burst = diffTelegram(base, live(["a", "b", "c", "d", "e"].map((link) => post(link))), DEFAULT_PREFS);
    expect(burst).toHaveLength(1);
    expect(burst[0].title).toBe("5 new Telegram posts");

    const filtered = diffTelegram(base, live([post("f", { stocks: ["TCS"] }), post("g", { options: ["BANKNIFTY 52000 PE"] })]), { ...DEFAULT_PREFS, telegramIndexOnly: true });
    expect(filtered.map((alert) => [alert.link, alert.tone])).toEqual([["g", "down"]]);
  });

  it("alerts when the option-call consensus changes", () => {
    const base = emptyBaseline();
    diffTelegram(base, live([], pick("NIFTY 25000 CE")), DEFAULT_PREFS);
    expect(diffTelegram(base, live([], pick("NIFTY 25000 CE")), DEFAULT_PREFS)).toEqual([]);
    const alerts = diffTelegram(base, live([], pick("NIFTY 25100 CE")), DEFAULT_PREFS);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "option", tone: "up", title: "New Telegram consensus: BUY NIFTY 25100 CE" });
  });
});

describe("diffScan", () => {
  it("alerts on zone changes and score moves past the step, anchoring on the last alert", () => {
    const base = emptyBaseline();
    expect(diffScan(base, scan(10, "NEUTRAL"), DEFAULT_PREFS)).toEqual([]);
    expect(diffScan(base, scan(15, "NEUTRAL"), DEFAULT_PREFS)).toEqual([]); // +5 < step
    const drift = diffScan(base, scan(19, "NEUTRAL"), DEFAULT_PREFS); // +9 from the anchor
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ kind: "sentiment", tone: "up" });
    const zone = diffScan(base, scan(16, "BULLISH"), DEFAULT_PREFS);
    expect(zone[0].title).toBe("NIFTY 50 turned BULLISH (+16)");
  });

  it("alerts on fresh, strong headlines only after the first scan", () => {
    const base = emptyBaseline();
    expect(diffScan(base, scan(0, "NEUTRAL", [headline("old", 40)]), DEFAULT_PREFS)).toEqual([]);
    const alerts = diffScan(base, scan(0, "NEUTRAL", [headline("old", 40), headline("weak", 5), headline("stale", -50, { age_hours: 5 }), headline("big", -45)]), DEFAULT_PREFS);
    expect(alerts.map((alert) => [alert.link, alert.tone])).toEqual([["big", "down"]]);
  });
});
