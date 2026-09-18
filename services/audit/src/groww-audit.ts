export type GrowwAuditEvent = { id: string; action: string; correlationId: string; subjectId: string; provider?: string; payload: unknown; occurredAt: string };

export class GrowwAuditLog {
  private readonly events: GrowwAuditEvent[] = [];
  append(event: Omit<GrowwAuditEvent, "id" | "occurredAt">) { const created = { ...event, id: crypto.randomUUID(), occurredAt: new Date().toISOString() }; this.events.push(created); return created; }
  list() { return [...this.events]; }
}