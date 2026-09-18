export type CorrelationContext = { correlationId: string; service: string };

export function createCorrelationContext(service: string): CorrelationContext {
  return { correlationId: crypto.randomUUID(), service };
}

export function recordMetric(name: string, value: number, context: CorrelationContext) {
  return { name, value, ...context, recordedAt: new Date().toISOString() };
}