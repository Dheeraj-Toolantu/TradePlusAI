import type { Mode } from "../../../packages/domain-contracts/src/primitives";

export type AITradingAuditRecord = {
  id: string;
  action: string;
  objectType: string;
  objectId: string;
  actor: string;
  mode: Mode | "SYSTEM";
  correlationId: string;
  reason?: string;
  payload: unknown;
  occurredAt: string;
};

export class AITradingAuditStore {
  private readonly records: AITradingAuditRecord[] = [];

  append(record: Omit<AITradingAuditRecord, "id" | "occurredAt">): AITradingAuditRecord {
    const created = { ...record, id: crypto.randomUUID(), occurredAt: new Date().toISOString() };
    this.records.push(structuredClone(created));
    return structuredClone(created);
  }

  list(correlationId?: string): AITradingAuditRecord[] {
    return this.records.filter((record) => !correlationId || record.correlationId === correlationId).map((record) => structuredClone(record));
  }
}
