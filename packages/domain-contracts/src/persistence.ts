export type Transaction = { id: string; committed: boolean };

export function beginTransaction(): Transaction {
  return { id: crypto.randomUUID(), committed: false };
}

export function commitTransaction(transaction: Transaction): Transaction {
  return { ...transaction, committed: true };
}

export function appendAuditEvent<T extends { id: string }>(events: T[], event: T): T[] {
  if (events.some((existing) => existing.id === event.id)) throw new Error("Audit event IDs must be unique");
  return [...events, event];
}