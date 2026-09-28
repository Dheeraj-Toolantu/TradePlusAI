import type { Decision, Freshness, Identifier, IsoTimestamp, Mode, Severity } from "./primitives";

export type AIModelDirection = "BULLISH" | "BEARISH" | "NEUTRAL" | "NO_TRADE" | "WAITING" | "UNAVAILABLE";
export type MonitoringState = "DISABLED" | "STARTING" | "ACTIVE" | "DEGRADED" | "STOPPING" | "STOPPED";
export type EvaluationState = "REQUESTED" | "COMPLETED" | "TIMEOUT" | "MALFORMED" | "UNAVAILABLE" | "REJECTED";
export type SuggestionStatus = "ADVISORY" | "WAITING" | "CONFIRMED" | "INVALIDATED" | "EXPIRED" | "BLOCKED";
export type AutomationDecisionType = "ALLOW_PAPER" | "REQUIRE_CONFIRMATION" | "BLOCK" | "CANCEL";
export type ProviderState = "READY" | "DEGRADED" | "UNAVAILABLE" | "MISCONFIGURED";

export type AITradingConfiguration = {
  id: Identifier;
  ownerId: Identifier;
  monitoringEnabled: boolean;
  automationEnabled: boolean;
  mode: Mode;
  instruments: string[];
  timeframes: string[];
  strategyVersion: string;
  confidenceThreshold: number;
  contextPolicy: Record<string, unknown>;
  riskAcknowledged: boolean;
  version: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
};

export type MonitoringSession = {
  id: Identifier;
  ownerId: Identifier;
  configurationId: Identifier;
  state: MonitoringState;
  startedAt?: IsoTimestamp;
  stoppedAt?: IsoTimestamp;
  stopReason?: string;
  lastEvaluationAt?: IsoTimestamp;
  health: Record<string, unknown>;
  correlationId: Identifier;
};

export type MarketContextSnapshot = {
  id: Identifier;
  instrumentId: Identifier;
  symbol: string;
  underlying: string;
  optionContract?: Record<string, unknown>;
  timeframe: string;
  candleRange: { first?: IsoTimestamp; last?: IsoTimestamp; count: number };
  analysisId?: Identifier;
  marketEvidence: Record<string, unknown>;
  freshness: Freshness;
  quality: "VALID" | "INSUFFICIENT_DATA" | "INVALID" | "STALE" | "DISCONTINUOUS";
  capturedAt: IsoTimestamp;
};

export type AIEvaluation = {
  id: Identifier;
  sessionId: Identifier;
  configurationId: Identifier;
  contextSnapshotId: Identifier;
  correlationId: Identifier;
  providerRequestId?: Identifier;
  state: EvaluationState;
  direction: AIModelDirection;
  confidence?: number;
  evidence: Array<{ source: string; observation: string; supports: "BULLISH" | "BEARISH" | "NEUTRAL" | "RISK" }>;
  explanation?: string;
  invalidation?: string;
  model: { providerAlias: string; modelAlias: string; version: string; schemaVersion: string };
  latencyMs?: number;
  failure?: { code: string; message: string; retryable: boolean };
  createdAt: IsoTimestamp;
  completedAt?: IsoTimestamp;
};

export type AISuggestion = {
  id: Identifier;
  evaluationId: Identifier;
  analysisId?: Identifier;
  direction: AIModelDirection;
  status: SuggestionStatus;
  confidence?: number;
  reasonSummary: string[];
  risks: string[];
  invalidation?: string;
  currentUntil?: IsoTimestamp;
  createdAt: IsoTimestamp;
};

export type GateResult = {
  name: string;
  passed: boolean;
  observed?: unknown;
  threshold?: unknown;
  reason: string;
};

export type AutomationDecision = {
  id: Identifier;
  suggestionId: Identifier;
  evaluationId: Identifier;
  analysisId: Identifier;
  mode: Mode;
  decision: AutomationDecisionType;
  gates: GateResult[];
  idempotencyKey: string;
  reason: string;
  correlationId: Identifier;
  createdAt: IsoTimestamp;
  instrument?: { symbol: string; side: "BUY" | "SELL"; quantity: number };
  protectiveLevels?: { entry?: number; stopLoss?: number; targets?: number[] };
};

export type AISuggestionLogEntry = {
  id: Identifier;
  eventType: string;
  subjectId: Identifier;
  correlationId: Identifier;
  summary: Record<string, unknown>;
  detailRefs: Record<string, Identifier>;
  actor: string;
  occurredAt: IsoTimestamp;
  severity?: Severity;
};

export type ModelProviderStatus = {
  providerAlias: string;
  modelAlias: string;
  schemaVersion: string;
  state: ProviderState;
  lastSuccessAt?: IsoTimestamp;
  lastFailureAt?: IsoTimestamp;
  latencyMs?: number;
  failureCode?: string;
};

export type AITradingLogFilter = {
  subjectId?: Identifier;
  symbol?: string;
  direction?: AIModelDirection;
  outcome?: SuggestionStatus | AutomationDecisionType;
  from?: IsoTimestamp;
  to?: IsoTimestamp;
  limit?: number;
};

export type AIActionDecision = Extract<Decision, "ALLOW" | "BLOCK" | "REQUIRE_CONFIRMATION">;
