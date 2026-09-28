# Contract: Server-Side Model Gateway

This is an internal contract between the monitoring service and the approved model provider adapter. LiteLLM-compatible routing is an implementation/configuration option behind this interface; no trading-domain contract depends on LiteLLM types.

## Request

```ts
type ModelEvaluationRequest = {
  schemaVersion: "ai-trading-evaluation.v1";
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
    deterministicAnalysis: {
      analysisId: string;
      status: string;
      quality: string;
      trend: string | null;
      confirmation: unknown;
      blockers: unknown[];
      setupSummary: unknown | null;
    };
    marketEvidence: unknown;
  };
  constraints: {
    allowedDirections: ["BULLISH", "BEARISH", "NEUTRAL", "NO_TRADE", "WAITING"];
    cannotChange: ["entry", "stopLoss", "targets", "quantity", "riskLimits", "mode", "killSwitch", "executionReadiness"];
  };
};
```

The gateway adapter MUST construct provider-specific prompts/messages from this bounded request and MUST exclude credentials, broker tokens, raw account data, and uncontrolled client text.

## Response

```ts
type ModelEvaluationResponse = {
  schemaVersion: "ai-trading-evaluation.v1";
  providerRequestId: string;
  modelAlias: string;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL" | "NO_TRADE" | "WAITING";
  confidence: number;
  evidence: Array<{
    source: string;
    observation: string;
    supports: "BULLISH" | "BEARISH" | "NEUTRAL" | "RISK";
  }>;
  explanation: string;
  invalidation: string;
  warnings: string[];
  latencyMs: number;
};
```

## Response Validation

- `schemaVersion`, direction, and all required fields must be present.
- `confidence` must be finite and in the range 0-100.
- Evidence must refer to supplied context; unsupported claims are rejected or downgraded to unavailable.
- Explanation and warnings must pass prohibited-claim and secret-redaction checks.
- The response must contain no order commands, broker identifiers, credentials, risk-limit changes, or authoritative price/quantity fields.
- Unknown fields are ignored for display but cannot influence trading decisions.
- Validation failure becomes `MALFORMED` or `REJECTED`, creates a log entry, and cannot create an automation decision.

## Operational Requirements

- Timeout and cancellation are mandatory; the monitoring service uses a bounded per-evaluation timeout.
- Request and response size are bounded.
- Provider/model alias, schema version, latency, and safe failure code are recorded.
- Provider failures return a safe unavailable result; they never produce a guessed direction.
- Retry behavior is limited and cannot duplicate an automation decision; retries reuse the evaluation id and idempotency key.
- Provider credentials remain server-side and are never written to user-visible records.
