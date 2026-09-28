import type { ModelEvaluationResponse } from "./model-gateway";
import { AI_EVALUATION_SCHEMA_VERSION } from "./model-gateway";

const forbiddenKeys = ["quantity", "price", "entry", "stopLoss", "targets", "riskLimits", "mode", "killSwitch", "executionReadiness", "order"];
const prohibitedClaims = [/guaranteed?\s+(profit|returns|accuracy)/i, /risk[- ]free/i, /100%\s+(accuracy|win)/i];

export function validateModelEvaluationResponse(value: unknown): ModelEvaluationResponse {
  if (!value || typeof value !== "object") throw new Error("Model response must be an object");
  const response = value as Record<string, unknown>;
  if (response.schemaVersion !== AI_EVALUATION_SCHEMA_VERSION) throw new Error("Unsupported model schema");
  if (typeof response.providerRequestId !== "string" || typeof response.modelAlias !== "string") throw new Error("Missing model identity");
  const directions = ["BULLISH", "BEARISH", "NEUTRAL", "NO_TRADE", "WAITING"];
  if (!directions.includes(String(response.direction))) throw new Error("Invalid model direction");
  if (typeof response.confidence !== "number" || !Number.isFinite(response.confidence) || response.confidence < 0 || response.confidence > 100) throw new Error("Invalid model confidence");
  if (!Array.isArray(response.evidence) || typeof response.explanation !== "string" || typeof response.invalidation !== "string" || !Array.isArray(response.warnings)) throw new Error("Malformed model response");
  if (JSON.stringify(response).length > 32_000) throw new Error("Model response is too large");
  if (Object.keys(response).some((key) => forbiddenKeys.includes(key))) throw new Error("Model response contains an execution field");
  if ([response.explanation, response.invalidation, ...response.warnings].some((text) => typeof text === "string" && prohibitedClaims.some((pattern) => pattern.test(text)))) throw new Error("Model response contains a prohibited claim");
  return {
    schemaVersion: AI_EVALUATION_SCHEMA_VERSION,
    providerRequestId: response.providerRequestId,
    modelAlias: response.modelAlias,
    direction: response.direction as ModelEvaluationResponse["direction"],
    confidence: response.confidence,
    evidence: response.evidence as ModelEvaluationResponse["evidence"],
    explanation: response.explanation,
    invalidation: response.invalidation,
    warnings: response.warnings.filter((warning): warning is string => typeof warning === "string").slice(0, 20),
    latencyMs: typeof response.latencyMs === "number" && Number.isFinite(response.latencyMs) ? response.latencyMs : 0,
  };
}
