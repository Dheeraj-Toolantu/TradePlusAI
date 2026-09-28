export type MonitoringAction =
  | { action: "ENABLE_MONITORING"; symbols: string[]; timeframes: string[]; mode: "PAPER" | "ASSISTED"; strategyVersion?: string; confidenceThreshold?: number; automationEnabled?: boolean; riskAcknowledged: boolean }
  | { action: "DISABLE_MONITORING"; sessionId: string; reason?: string }
  | { action: "SET_AUTOMATION"; sessionId: string; enabled: boolean; mode: "PAPER" | "ASSISTED" };

export async function updateAIMonitoring(action: MonitoringAction): Promise<Record<string, unknown>> {
  const response = await fetch("/api/ai-monitoring", { method: "POST", headers: { "content-type": "application/json", "x-user-id": "local-user" }, body: JSON.stringify(action) });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body.error ?? "AI monitoring request failed"));
  return body;
}

export async function getAIMonitoring(sessionId?: string): Promise<Record<string, unknown>> {
  const response = await fetch(`/api/ai-monitoring${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, { cache: "no-store", headers: { "x-user-id": "local-user" } });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body.error ?? "AI monitoring status unavailable"));
  return body;
}

export type AISuggestionLogQuery = { symbol?: string; direction?: string; outcome?: string; from?: string; to?: string; limit?: number };

export async function getAISuggestionLog(query: AISuggestionLogQuery = {}): Promise<Record<string, unknown>> {
  const params = new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined).map(([key, value]) => [key, String(value)]));
  const response = await fetch(`/api/ai-monitoring?${params.toString()}`, { cache: "no-store", headers: { "x-user-id": "local-user" } });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body.error ?? "AI suggestion log unavailable"));
  return body;
}

export async function getAISuggestionLogDetail(id: string): Promise<Record<string, unknown>> {
  const response = await fetch(`/api/ai-monitoring/log/${encodeURIComponent(id)}`, { cache: "no-store", headers: { "x-user-id": "local-user" } });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body.error ?? "AI suggestion detail unavailable"));
  return body;
}
