export type Notification = { id: string; category: string; severity: "INFO" | "WARNING" | "HIGH" | "CRITICAL"; mode: string; subjectId: string; message: string; deliveryState: "PENDING" | "DELIVERED" | "FAILED" };

export class NotificationService {
  private readonly notifications: Notification[] = [];
  create(notification: Omit<Notification, "id" | "deliveryState">) { const created = { ...notification, id: crypto.randomUUID(), deliveryState: "PENDING" as const }; this.notifications.push(created); return created; }
  list() { return [...this.notifications]; }
  markDelivered(id: string) { const item = this.notifications.find((notification) => notification.id === id); if (!item) throw new Error("Notification not found"); item.deliveryState = "DELIVERED"; return item; }
}