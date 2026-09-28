import { AI_EVALUATION_SCHEMA_VERSION, type ModelEvaluationRequest, type ModelEvaluationResponse, type ModelGateway } from "./model-gateway";
import { validateModelEvaluationResponse } from "./model-gateway-validator";

export type LiteLLMGatewayConfig = {
  endpoint: string;
  apiKey?: string;
  providerAlias?: string;
  modelAlias?: string;
  timeoutMs?: number;
};

export class LiteLLMGateway implements ModelGateway {
  private readonly config: Required<Omit<LiteLLMGatewayConfig, "apiKey">> & Pick<LiteLLMGatewayConfig, "apiKey">;

  constructor(config: LiteLLMGatewayConfig) {
    this.config = { providerAlias: "litellm", modelAlias: "tradepulse-default", timeoutMs: 8_000, ...config };
  }

  async evaluate(request: ModelEvaluationRequest, signal?: AbortSignal): Promise<ModelEvaluationResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(this.config.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}) },
        body: JSON.stringify({ model: request.modelAlias, messages: [{ role: "system", content: "Return only valid JSON for the requested bounded market evaluation. Use the JSON object format with exactly these fields: schemaVersion, providerRequestId, modelAlias, direction, confidence, evidence, explanation, invalidation, warnings, latencyMs. direction must be BULLISH, BEARISH, NEUTRAL, NO_TRADE, or WAITING. Do not include orders, prices, quantities, risk limits, or execution commands." }, { role: "user", content: JSON.stringify(request) }], response_format: { type: "json_object" } }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Model provider returned ${response.status}`);
      const body = await response.json() as Record<string, unknown>;
      const content = body.choices && Array.isArray(body.choices) ? (body.choices[0] as Record<string, unknown>)?.message : body;
      const parsed = typeof content === "object" && content !== null && typeof (content as Record<string, unknown>).content === "string" ? JSON.parse(String((content as Record<string, unknown>).content)) : content;
      const candidate = parsed as Record<string, unknown>;
      const rawConfidence = Number(candidate.confidence);
      const direction = String(candidate.direction ?? "WAITING") as ModelEvaluationResponse["direction"];
      const evidence = Array.isArray(candidate.evidence)
        ? candidate.evidence
        : [{ source: "model", observation: String(candidate.evidence ?? ""), supports: ["BULLISH", "BEARISH"].includes(direction) ? direction : "NEUTRAL" }];
      return validateModelEvaluationResponse({
        ...candidate,
        schemaVersion: AI_EVALUATION_SCHEMA_VERSION,
        modelAlias: candidate.modelAlias ?? request.modelAlias,
        confidence: rawConfidence >= 0 && rawConfidence <= 1 ? rawConfidence * 100 : rawConfidence,
        evidence,
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  status() { return { providerAlias: this.config.providerAlias, modelAlias: this.config.modelAlias, state: this.config.endpoint ? "READY" as const : "MISCONFIGURED" as const }; }
}
