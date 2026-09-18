import type { Signal } from "../../../packages/domain-contracts/src/entities";
import type { EventEnvelope } from "../../../packages/event-schemas/src/events";

export function signalEvent(signal: Signal): EventEnvelope<Signal> { return { eventId: crypto.randomUUID(), eventType: "signal.updated", schemaVersion: "1.0", occurredAt: new Date().toISOString(), receivedAt: new Date().toISOString(), mode: "PAPER", subjectType: "Signal", subjectId: signal.id, freshness: "FRESH", severity: "INFO", payload: signal }; }