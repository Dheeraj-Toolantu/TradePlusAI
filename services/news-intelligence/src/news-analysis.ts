import type { NewsEvent } from "./news-repository";

export function analyzeNews(event: NewsEvent, sentiment: NewsEvent["sentiment"], impact: number, confidence: number): NewsEvent {
  return { ...event, sentiment, impact: Math.max(0, Math.min(100, impact)), confidence: Math.max(0, Math.min(100, confidence)) };
}

export function requiresCorroboration(event: NewsEvent): boolean { return event.severity === "HIGH" || event.severity === "EXTREME"; }