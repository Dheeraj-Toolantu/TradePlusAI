import type { NewsEvent } from "./news-repository";

export function normalizeNews(input: { id: string; source: string; title: string; severity?: NewsEvent["severity"] }): NewsEvent {
  return { id: input.id, source: input.source, sourceTier: 1, title: input.title.trim(), severity: input.severity ?? "LOW", sentiment: "NEUTRAL", impact: 0, confidence: 0, horizon: "1h" };
}

export function clusterKey(title: string): string { return title.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).slice(0, 5).join("-"); }