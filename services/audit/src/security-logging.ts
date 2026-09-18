const secretKeys = /token|secret|password|totp|api[_-]?key|authorization/i;

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretKeys.test(key) ? "[REDACTED]" : redactSecrets(item)]));
}

export function securityEvent(action: string, actor: string, metadata: unknown) {
  return { action, actor, metadata: redactSecrets(metadata), occurredAt: new Date().toISOString() };
}