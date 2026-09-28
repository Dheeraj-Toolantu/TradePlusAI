import type { AIModelDirection } from "../../../packages/domain-contracts/src/ai-trading";

export const AI_EVALUATION_SCHEMA_VERSION = "ai-trading-evaluation.v1" as const;

export type ModelEvaluationRequest = {
  schemaVersion: typeof AI_EVALUATION_SCHEMA_VERSION;
  correlationId: string;
  evaluationId: string;
  modelAlias: string;
  context: {
    snapshotId: string;
    symbol: string;
    underlying: string;
    timeframe: string;
    capturedAt: string;
    freshness: "FRESH";
    deterministicAnalysis: Record<string, unknown>;
    marketEvidence: Record<string, unknown>;
  };
  constraints: {
    allowedDirections: Exclude<AIModelDirection, "UNAVAILABLE">[];
    cannotChange: string[];
  };
};

export type ModelEvaluationResponse = {
  schemaVersion: typeof AI_EVALUATION_SCHEMA_VERSION;
  providerRequestId: string;
  modelAlias: string;
  direction: Exclude<AIModelDirection, "UNAVAILABLE">;
  confidence: number;
  evidence: Array<{ source: string; observation: string; supports: "BULLISH" | "BEARISH" | "NEUTRAL" | "RISK" }>;
  explanation: string;
  invalidation: string;
  warnings: string[];
  latencyMs: number;
  [key: string]: unknown;
};

export type ModelGatewayFailure = { code: "TIMEOUT" | "UNAVAILABLE" | "MALFORMED" | "REJECTED"; message: string; retryable: boolean };

export interface ModelGateway {
  evaluate(request: ModelEvaluationRequest, signal?: AbortSignal): Promise<ModelEvaluationResponse>;
  status(): { providerAlias: string; modelAlias: string; state: "READY" | "DEGRADED" | "UNAVAILABLE" | "MISCONFIGURED" };
}
