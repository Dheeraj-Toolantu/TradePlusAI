import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SentimentChart, seriesColor } from "../../apps/web/components/sentiment-chart";
import type { StoredSnapshot } from "../../apps/web/lib/sentiment-history";

const snap = (iso: string, nifty: number, bank: number | null, reversal = false) => ({
  id: iso, slot: "", recordedAt: iso, scanAt: iso, reasons: reversal ? ["SCHEDULED", "REVERSAL"] : ["SCHEDULED"],
  reversals: reversal ? [{ instrument: "NIFTY", type: "SENTIMENT", from: "BULLISH", to: "BEARISH" }] : [],
  indices: { NIFTY: { name: "NIFTY 50", score: nifty, label: "", price: 24000, change_pct: 0 }, ...(bank === null ? {} : { BANKNIFTY: { name: "BANK NIFTY", score: bank, label: "", price: 55000, change_pct: 0 } }) },
  commodities: {},
}) as unknown as StoredSnapshot;

const render = (snapshots: StoredSnapshot[], series = [{ id: "NIFTY", name: "NIFTY 50" }, { id: "BANKNIFTY", name: "BANK NIFTY" }]) =>
  renderToStaticMarkup(createElement(SentimentChart, { snapshots, series }));

describe("sentiment chart", () => {
  it("draws one line per series in its fixed color, oldest to newest, with reversal rings", () => {
    const html = render([snap("2026-10-21T04:15:00Z", -12, 5, true), snap("2026-10-21T03:45:00Z", 14, 6), snap("2026-10-21T04:00:00Z", 3, null)]);
    const paths = [...html.matchAll(/<path d="([^"]+)"[^>]*stroke="([^"]+)"/g)];
    expect(paths.map((match) => match[2])).toEqual([seriesColor("NIFTY"), seriesColor("BANKNIFTY")]);
    expect(paths[0][1].match(/[ML]/g)).toEqual(["M", "L", "L"]); // three NIFTY points in time order
    expect(paths[1][1].match(/[ML]/g)).toEqual(["M", "L"]); // BANK NIFTY missing at 09:30 is skipped
    expect(html.match(/class="smc-flip"/g)).toHaveLength(1);
    expect(html).toContain("NIFTY 50");
  });

  it("breaks a line across a long gap (overnight)", () => {
    const html = render([snap("2026-10-20T09:45:00Z", 5, 1), snap("2026-10-20T10:00:00Z", 6, 2), snap("2026-10-21T03:45:00Z", -4, 3)], [{ id: "NIFTY", name: "NIFTY 50" }]);
    const d = html.match(/<path d="([^"]+)"/)![1];
    expect(d.match(/[ML]/g)).toEqual(["M", "L", "M"]);
    expect(html).toContain("21 Oct");
  });

  it("renders nothing to plot without data", () => {
    expect(render([])).not.toContain("<svg");
  });
});
