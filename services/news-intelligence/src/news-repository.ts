export type NewsEvent = { id: string; source: string; sourceTier: number; title: string; clusterId?: string; severity: "LOW" | "MEDIUM" | "HIGH" | "EXTREME"; sentiment: "BULLISH" | "NEUTRAL" | "BEARISH"; impact: number; confidence: number; horizon: string };

export class NewsRepository {
  private readonly events = new Map<string, NewsEvent>();
  save(event: NewsEvent) { this.events.set(event.id, event); return event; }
  all() { return [...this.events.values()]; }
}