import { describe, expect, it } from "vitest";
import { analyzeNews, requiresCorroboration } from "../../services/news-intelligence/src/news-analysis";
import { clusterKey, normalizeNews } from "../../services/news-intelligence/src/news-ingestion";

describe("news intelligence", () => {
  it("normalizes and clusters source events", () => { const event = normalizeNews({ id: "n1", source: "Reuters", title: "  Central bank signals pause!  ", severity: "HIGH" }); expect(clusterKey(event.title)).toBe("central-bank-signals-pause"); expect(requiresCorroboration(event)).toBe(true); expect(analyzeNews(event, "BEARISH", 91, 88).impact).toBe(91); });
});