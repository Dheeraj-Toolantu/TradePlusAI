import type { Freshness, IsoTimestamp, Mode, Severity } from "../../domain-contracts/src/primitives";

export type EventEnvelope<T = unknown> = {
  eventId: string;
  eventType: string;
  schemaVersion: "1.0";
  occurredAt: IsoTimestamp;
  receivedAt: IsoTimestamp;
  mode: Mode | "SYSTEM";
  subjectType: string;
  subjectId: string;
  correlationId?: string;
  freshness: Freshness;
  severity: Severity;
  payload: T;
};

export type SetupStateEvent = {
  eventType: "analysis.setup-state.v1";
  setupId: string;
  from: string;
  to: string;
  reason: string;
  strategyVersion: string;
  calculationVersion: string;
  occurredAt: IsoTimestamp;
};

export function isUnsafeEvent(event: EventEnvelope): boolean {
  return event.freshness === "STALE" || event.freshness === "UNKNOWN" || event.eventType === "safe_state.entered";
}