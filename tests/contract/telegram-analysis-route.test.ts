import { beforeEach, describe, expect, it, vi } from "vitest";

const runPythonModule = vi.fn();
vi.mock("../../apps/web/lib/python", () => ({ runPythonModule: (...args: unknown[]) => runPythonModule(...args) }));

import { POST } from "../../apps/web/app/api/telegram-analysis/route";
import { normalizeChannel } from "../../apps/web/lib/telegram-channels";

const store = globalThis as { __tradepulseTelegramAnalysis?: Map<string, unknown>; __tradepulseIndexSentiment?: { at: number; value: unknown } | null };
const post = (body: unknown) => POST(new Request("http://localhost/api/telegram-analysis", { method: "POST", body: JSON.stringify(body) }));
const result = { generated_at: "2026-10-12T10:00:00+00:00", window_hours: 12, totals: { calls: 3, puts: 2 }, top: [] };

describe("telegram analysis route", () => {
  beforeEach(() => {
    store.__tradepulseTelegramAnalysis = new Map();
    store.__tradepulseIndexSentiment = { at: Date.now(), value: { indices: [{ id: "NIFTY", quote: { price: 24500 }, constituents: [] }] } };
    runPythonModule.mockReset();
  });

  it("normalizes and de-duplicates channels, then runs the 12 h analysis once per minute", async () => {
    runPythonModule.mockResolvedValueOnce(result);
    const response = await post({ channels: ["@Chan_A", "https://t.me/s/chan_a/", "t.me/other_one", "bad name"] });
    expect((await response.json()).totals).toEqual({ calls: 3, puts: 2 });
    expect(runPythonModule).toHaveBeenCalledWith("tradepulse_quant.sentiment.telegram_analysis", { channels: ["Chan_A", "other_one"], window_hours: 12, spots: { NIFTY: 24500 } }, 45_000);
    await post({ channels: ["other_one", "chan_a"] });
    expect(runPythonModule).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty channel list and surfaces analysis errors", async () => {
    expect((await post({ channels: ["!!"] })).status).toBe(400);
    runPythonModule.mockResolvedValueOnce({ error: "Add at least one public Telegram channel username" });
    expect((await post({ channels: ["chan_x"], window_hours: 6 })).status).toBe(503);
  });

  it("parses channel names like Telegram links", () => {
    expect(normalizeChannel(" https://www.t.me/s/Nifty_Calls/ ")).toBe("Nifty_Calls");
    expect(normalizeChannel("@ab")).toBeNull();
  });
});
