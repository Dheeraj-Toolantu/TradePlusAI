export type OutboxEvent = { id: string; category: string; mode: string; severity: "INFO" | "WARNING" | "HIGH" | "CRITICAL"; subjectId: string; message: string; correlationId: string; deliveryState: "PENDING" | "DELIVERED" | "RETRYABLE"; attempts: number; nextAttemptAt?: string };

export interface NotificationProvider { deliver(event: OutboxEvent): Promise<void>; }

export class LocalNotificationProvider implements NotificationProvider {
  readonly delivered: OutboxEvent[] = [];
  async deliver(event: OutboxEvent) { this.delivered.push(event); }
}

export class NotificationOutbox {
  private readonly events: OutboxEvent[] = [];
  constructor(private readonly provider: NotificationProvider = new LocalNotificationProvider()) {}
  enqueue(input: Omit<OutboxEvent, "id" | "deliveryState" | "attempts">) { const event = { ...input, id: crypto.randomUUID(), deliveryState: "PENDING" as const, attempts: 0 }; this.events.push(event); return event; }
  async deliver(id: string) { const event = this.events.find((item) => item.id === id); if (!event) throw new Error("Notification event not found"); try { await this.provider.deliver(event); event.deliveryState = "DELIVERED"; } catch { event.attempts += 1; event.deliveryState = "RETRYABLE"; event.nextAttemptAt = new Date(Date.now() + 30_000).toISOString(); } return event; }
  list() { return [...this.events]; }
}