import type { AIEvaluation, AISuggestion, AITradingConfiguration, MonitoringSession } from "../../../packages/domain-contracts/src/ai-trading";
import type { Mode } from "../../../packages/domain-contracts/src/primitives";
import { AITradingAuditStore } from "../../audit/src/ai-trading-audit";
import { buildMarketContextSnapshot, contextCanBeEvaluated } from "./market-context-service";
import type { ModelGateway } from "./model-gateway";
import { validateModelEvaluationResponse } from "./model-gateway-validator";
import { InMemorySuggestionLogRepository } from "./suggestion-log-repository";

const supportedSymbols = new Set(["NIFTY", "BANKNIFTY", "SENSEX"]);
const supportedModes = new Set<Mode>(["PAPER", "ASSISTED"]);

export type EnableMonitoringInput = {
  ownerId: string;
  symbols: string[];
  timeframes: string[];
  mode: Mode;
  strategyVersion?: string;
  confidenceThreshold?: number;
  automationEnabled?: boolean;
  riskAcknowledged: boolean;
};

export type EvaluationContextInput = {
  instrumentId: string;
  symbol: string;
  underlying?: string;
  timeframe: string;
  candles: Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number }>;
  analysisId?: string;
  analysis?: Record<string, unknown>;
  optionContract?: Record<string, unknown>;
  marketEvidence?: Record<string, unknown>;
  freshness?: "FRESH" | "STALE" | "UNKNOWN";
  quality?: "VALID" | "INSUFFICIENT_DATA" | "INVALID" | "STALE" | "DISCONTINUOUS";
};

export class MonitoringService {
  readonly audit = new AITradingAuditStore();
  readonly logs = new InMemorySuggestionLogRepository();
  private readonly configurations = new Map<string, AITradingConfiguration>();
  private readonly sessions = new Map<string, MonitoringSession>();
  private readonly latestSuggestions = new Map<string, AISuggestion>();

  enable(input: EnableMonitoringInput): MonitoringSession {
    const symbols = input.symbols.map((symbol) => symbol.toUpperCase());
    if (!symbols.length || symbols.some((symbol) => !supportedSymbols.has(symbol))) throw new Error("Unsupported monitoring symbol");
    if (!input.timeframes.length) throw new Error("At least one timeframe is required");
    if (!supportedModes.has(input.mode)) throw new Error("ALGO_LIVE is unavailable until release readiness is complete");
    if (!Number.isFinite(input.confidenceThreshold ?? 70) || (input.confidenceThreshold ?? 70) < 0 || (input.confidenceThreshold ?? 70) > 100) throw new Error("Confidence threshold must be between 0 and 100");
    if (input.automationEnabled && !input.riskAcknowledged) throw new Error("Risk acknowledgement is required for automation");
    const now = new Date().toISOString();
    const configuration: AITradingConfiguration = {
      id: crypto.randomUUID(), ownerId: input.ownerId, monitoringEnabled: true, automationEnabled: input.automationEnabled ?? false,
      mode: input.mode, instruments: symbols, timeframes: [...input.timeframes], strategyVersion: input.strategyVersion ?? "v5-paper",
      confidenceThreshold: input.confidenceThreshold ?? 70, contextPolicy: { maxAgeSeconds: 30 }, riskAcknowledged: input.riskAcknowledged,
      version: "1", createdAt: now, updatedAt: now,
    };
    const session: MonitoringSession = {
      id: crypto.randomUUID(), ownerId: input.ownerId, configurationId: configuration.id, state: "ACTIVE", startedAt: now,
      health: { dataFreshness: "UNKNOWN", provider: "NOT_CONFIGURED", broker: "UNKNOWN", safeMode: false, killSwitch: false, blockers: [] },
      correlationId: crypto.randomUUID(),
    };
    this.configurations.set(configuration.id, configuration);
    this.sessions.set(session.id, session);
    this.audit.append({ action: "AI_MONITORING_ENABLED", objectType: "MonitoringSession", objectId: session.id, actor: input.ownerId, mode: input.mode, correlationId: session.correlationId, payload: { configurationId: configuration.id, symbols, timeframes: input.timeframes } });
    return structuredClone(session);
  }

  disable(ownerId: string, sessionId: string, reason: string): MonitoringSession {
    const session = this.requireSession(ownerId, sessionId);
    const now = new Date().toISOString();
    session.state = "STOPPED";
    session.stoppedAt = now;
    session.stopReason = reason || "User stopped monitoring";
    const configuration = this.configurations.get(session.configurationId);
    if (configuration) { configuration.monitoringEnabled = false; configuration.automationEnabled = false; configuration.updatedAt = now; }
    this.audit.append({ action: "AI_MONITORING_DISABLED", objectType: "MonitoringSession", objectId: session.id, actor: ownerId, mode: configuration?.mode ?? "PAPER", correlationId: session.correlationId, reason: session.stopReason, payload: {} });
    return structuredClone(session);
  }

  setAutomation(ownerId: string, sessionId: string, enabled: boolean, mode: Mode): MonitoringSession {
    const session = this.requireSession(ownerId, sessionId);
    if (session.state !== "ACTIVE") throw new Error("Monitoring session is not active");
    if (!supportedModes.has(mode)) throw new Error("ALGO_LIVE is unavailable until release readiness is complete");
    const configuration = this.configurations.get(session.configurationId);
    if (!configuration) throw new Error("Monitoring configuration not found");
    configuration.automationEnabled = enabled;
    configuration.mode = mode;
    configuration.updatedAt = new Date().toISOString();
    this.audit.append({ action: enabled ? "AI_AUTOMATION_ENABLED" : "AI_AUTOMATION_DISABLED", objectType: "MonitoringSession", objectId: session.id, actor: ownerId, mode, correlationId: session.correlationId, payload: { enabled } });
    return structuredClone(session);
  }

  degrade(sessionId: string, reason: string): MonitoringSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Monitoring session not found");
    session.state = "DEGRADED";
    session.stopReason = reason;
    session.health = { ...session.health, provider: "UNAVAILABLE", blockers: [reason] };
    this.audit.append({ action: "AI_MONITORING_DEGRADED", objectType: "MonitoringSession", objectId: session.id, actor: "SYSTEM", mode: this.configurations.get(session.configurationId)?.mode ?? "PAPER", correlationId: session.correlationId, reason, payload: { health: session.health } });
    return structuredClone(session);
  }

  recover(sessionId: string): MonitoringSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Monitoring session not found");
    if (session.state !== "DEGRADED") throw new Error("Monitoring session is not degraded");
    session.state = "ACTIVE";
    session.stopReason = undefined;
    session.health = { ...session.health, provider: "READY", blockers: [] };
    this.audit.append({ action: "AI_MONITORING_RECOVERED", objectType: "MonitoringSession", objectId: session.id, actor: "SYSTEM", mode: this.configurations.get(session.configurationId)?.mode ?? "PAPER", correlationId: session.correlationId, payload: { health: session.health } });
    return structuredClone(session);
  }

  async evaluate(ownerId: string, sessionId: string, input: EvaluationContextInput, gateway: ModelGateway): Promise<{ evaluation: AIEvaluation; suggestion: AISuggestion; automationDecision?: never }> {
    const session = this.requireSession(ownerId, sessionId);
    const configuration = this.configurations.get(session.configurationId);
    if (!configuration || session.state !== "ACTIVE" || !configuration.monitoringEnabled) throw new Error("Monitoring session is not active");
    if (!configuration.instruments.includes(input.symbol.toUpperCase())) throw new Error("Evaluation symbol is outside the monitoring scope");
    const snapshot = buildMarketContextSnapshot(input);
    const evaluationId = crypto.randomUUID();
    const correlationId = session.correlationId;
    const now = new Date().toISOString();
    const baseModel = { providerAlias: gateway.status().providerAlias, modelAlias: gateway.status().modelAlias, version: "1", schemaVersion: "ai-trading-evaluation.v1" };
    if (!contextCanBeEvaluated(snapshot)) {
      const evaluation: AIEvaluation = { id: evaluationId, sessionId, configurationId: configuration.id, contextSnapshotId: snapshot.id, correlationId, state: "REJECTED", direction: "UNAVAILABLE", evidence: [], model: baseModel, failure: { code: "UNSAFE_CONTEXT", message: "Market context is stale or invalid", retryable: true }, createdAt: now, completedAt: now };
      const suggestion: AISuggestion = { id: crypto.randomUUID(), evaluationId, analysisId: input.analysisId, direction: "UNAVAILABLE", status: "BLOCKED", reasonSummary: [evaluation.failure.message], risks: [], createdAt: now };
      this.appendEvaluationLog(evaluation, suggestion, ownerId);
      return { evaluation, suggestion };
    }
    try {
      const started = Date.now();
      const response = validateModelEvaluationResponse(await gateway.evaluate({
        schemaVersion: "ai-trading-evaluation.v1", correlationId, evaluationId, modelAlias: baseModel.modelAlias,
        context: { snapshotId: snapshot.id, symbol: snapshot.symbol, underlying: snapshot.underlying, timeframe: snapshot.timeframe, capturedAt: snapshot.capturedAt, freshness: "FRESH", deterministicAnalysis: input.analysis ?? {}, marketEvidence: input.marketEvidence ?? {} },
        constraints: { allowedDirections: ["BULLISH", "BEARISH", "NEUTRAL", "NO_TRADE", "WAITING"], cannotChange: ["entry", "stopLoss", "targets", "quantity", "riskLimits", "mode", "killSwitch", "executionReadiness"] },
      }));
      const evaluation: AIEvaluation = { id: evaluationId, sessionId, configurationId: configuration.id, contextSnapshotId: snapshot.id, correlationId, providerRequestId: response.providerRequestId, state: "COMPLETED", direction: response.direction, confidence: response.confidence, evidence: response.evidence, explanation: response.explanation, invalidation: response.invalidation, model: { ...baseModel, modelAlias: response.modelAlias }, latencyMs: response.latencyMs || Date.now() - started, createdAt: now, completedAt: new Date().toISOString() };
      const confirmed = configuration.automationEnabled && ["BULLISH", "BEARISH"].includes(response.direction) && response.confidence >= configuration.confidenceThreshold && input.analysis?.status === "CONFIRMED";
      const suggestion: AISuggestion = { id: crypto.randomUUID(), evaluationId, analysisId: input.analysisId, direction: response.direction, status: confirmed ? "CONFIRMED" : "ADVISORY", confidence: response.confidence, reasonSummary: [response.explanation], risks: response.warnings, invalidation: response.invalidation, createdAt: evaluation.completedAt };
      this.appendEvaluationLog(evaluation, suggestion, ownerId);
      session.lastEvaluationAt = evaluation.completedAt;
      return { evaluation, suggestion };
    } catch (error) {
      const evaluation: AIEvaluation = { id: evaluationId, sessionId, configurationId: configuration.id, contextSnapshotId: snapshot.id, correlationId, state: error instanceof Error && error.message.includes("Model response") ? "MALFORMED" : "UNAVAILABLE", direction: "UNAVAILABLE", evidence: [], model: baseModel, failure: { code: "AI_EVALUATION_FAILED", message: error instanceof Error ? error.message : "AI evaluation failed", retryable: true }, createdAt: now, completedAt: new Date().toISOString() };
      const suggestion: AISuggestion = { id: crypto.randomUUID(), evaluationId, analysisId: input.analysisId, direction: "UNAVAILABLE", status: "BLOCKED", reasonSummary: [evaluation.failure.message], risks: [], createdAt: evaluation.completedAt! };
      this.appendEvaluationLog(evaluation, suggestion, ownerId);
      return { evaluation, suggestion };
    }
  }

  private appendEvaluationLog(evaluation: AIEvaluation, suggestion: AISuggestion, actor: string) {
    this.latestSuggestions.set(evaluation.sessionId, suggestion);
    this.logs.append({ id: crypto.randomUUID(), eventType: "EVALUATION_COMPLETED", subjectId: suggestion.id, correlationId: evaluation.correlationId, summary: { symbol: suggestion.analysisId ?? "UNKNOWN", direction: suggestion.direction, status: suggestion.status, confidence: suggestion.confidence ?? null }, detailRefs: { evaluationId: evaluation.id, suggestionId: suggestion.id }, actor, occurredAt: evaluation.completedAt ?? evaluation.createdAt });
    this.audit.append({ action: "AI_EVALUATION_COMPLETED", objectType: "AIEvaluation", objectId: evaluation.id, actor, mode: this.configurations.get(evaluation.configurationId)?.mode ?? "PAPER", correlationId: evaluation.correlationId, reason: evaluation.failure?.message, payload: { state: evaluation.state, direction: evaluation.direction, confidence: evaluation.confidence, model: evaluation.model } });
  }

  getSession(ownerId: string, sessionId?: string): MonitoringSession | undefined {
    const session = sessionId ? this.sessions.get(sessionId) : [...this.sessions.values()].reverse().find((candidate) => candidate.ownerId === ownerId);
    return session && session.ownerId === ownerId ? structuredClone(session) : undefined;
  }

  getConfiguration(configurationId: string): AITradingConfiguration | undefined {
    const configuration = this.configurations.get(configurationId);
    return configuration ? structuredClone(configuration) : undefined;
  }

  getLatestSuggestion(sessionId: string): AISuggestion | undefined {
    const suggestion = this.latestSuggestions.get(sessionId);
    return suggestion ? structuredClone(suggestion) : undefined;
  }

  private requireSession(ownerId: string, sessionId: string): MonitoringSession {
    const session = this.sessions.get(sessionId);
    if (!session || session.ownerId !== ownerId) throw new Error("Monitoring session not found");
    return session;
  }
}

const monitoringGlobal = globalThis as typeof globalThis & { __tradepulseMonitoringService?: MonitoringService };
let service = monitoringGlobal.__tradepulseMonitoringService ?? new MonitoringService();
monitoringGlobal.__tradepulseMonitoringService = service;
export function getMonitoringService(): MonitoringService { return service; }
export function resetMonitoringService(): MonitoringService { service = new MonitoringService(); monitoringGlobal.__tradepulseMonitoringService = service; return service; }
