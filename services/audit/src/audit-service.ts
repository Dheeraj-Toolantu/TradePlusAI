export type AuditRecord = { id: string; actor: string; action: string; objectType: string; objectId: string; reason?: string; occurredAt: string };

export class AuditService {
  private readonly records: AuditRecord[] = [];
  append(record: Omit<AuditRecord, "id" | "occurredAt">) { const created = { ...record, id: crypto.randomUUID(), occurredAt: new Date().toISOString() }; this.records.push(created); return created; }
  list() { return [...this.records]; }
}