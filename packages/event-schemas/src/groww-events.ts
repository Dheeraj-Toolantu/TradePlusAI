import type { EventEnvelope } from "./events";

export type GrowwEventType = "algo.gate_updated" | "broker.health_changed" | "order.updated" | "protection.updated" | "reconciliation.required" | "news.outcome_recorded";
export function createGrowwEvent(type: GrowwEventType, subjectId: string, payload: unknown): EventEnvelope { return { eventId: crypto.randomUUID(), eventType: type, schemaVersion: "1.0", occurredAt: new Date().toISOString(), receivedAt: new Date().toISOString(), mode: "SYSTEM", subjectType: type, subjectId, freshness: "FRESH", severity: "INFO", payload }; }