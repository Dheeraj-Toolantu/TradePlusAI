import type { AITradingConfiguration, AISuggestion, AITradingLogFilter, MonitoringSession } from "../../../packages/domain-contracts/src/ai-trading";
import type { MonitoringService } from "./monitoring-service";

export type MonitoringReadModel = {
  monitoring: MonitoringSession & { monitoringEnabled: boolean; automationEnabled: boolean; mode: AITradingConfiguration["mode"]; scope: { symbols: string[]; timeframes: string[] } };
  health: Record<string, unknown>;
  latest: AISuggestion | null;
  log: { items: unknown[]; nextCursor: null; total: number };
};

export function monitoringReadModel(service: MonitoringService, ownerId: string, sessionId?: string, filter: AITradingLogFilter = {}): MonitoringReadModel {
  const session = service.getSession(ownerId, sessionId);
  if (!session) throw new Error("Monitoring session not found");
  const configuration = service.getConfiguration(session.configurationId);
  if (!configuration) throw new Error("Monitoring configuration not found");
  const log = service.logs.list({ ...filter, limit: Math.min(filter.limit ?? 50, 200) });
  return {
    monitoring: { ...session, monitoringEnabled: configuration.monitoringEnabled, automationEnabled: configuration.automationEnabled, mode: configuration.mode, scope: { symbols: configuration.instruments, timeframes: configuration.timeframes } },
    health: session.health,
    latest: service.getLatestSuggestion(session.id) ?? null,
    log: { items: log, nextCursor: null, total: log.length },
  };
}
