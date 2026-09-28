import { NextResponse } from "next/server";
import type { AIModelDirection, SuggestionStatus } from "../../../../../packages/domain-contracts/src/ai-trading";
import type { Mode } from "../../../../../packages/domain-contracts/src/primitives";
import { getMonitoringService } from "../../../../../services/ai-monitoring/src/monitoring-service";
import { monitoringReadModel } from "../../../../../services/ai-monitoring/src/monitoring-read-model";
import { LiteLLMGateway } from "../../../../../services/ai-monitoring/src/litellm-gateway";

type Body = Record<string, unknown>;

function actorOf(request: Request): string | null { return request.headers.get("x-user-id"); }
function jsonError(message: string, status: number) { return NextResponse.json({ error: message }, { status }); }

export async function GET(request: Request) {
  const actor = actorOf(request);
  if (!actor) return jsonError("UNAUTHORIZED", 401);
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const direction = url.searchParams.get("direction") as AIModelDirection | null;
  const outcome = url.searchParams.get("outcome") as SuggestionStatus | null;
  try { return NextResponse.json(monitoringReadModel(getMonitoringService(), actor, sessionId, { symbol: url.searchParams.get("symbol") ?? undefined, direction: direction ?? undefined, outcome: outcome ?? undefined, from: url.searchParams.get("from") ?? undefined, to: url.searchParams.get("to") ?? undefined, limit: Number.isFinite(limit) ? limit : 50 })); }
  catch (error) {
    if (error instanceof Error && error.message === "Monitoring session not found") {
      return NextResponse.json({ monitoring: { state: "DISABLED", monitoringEnabled: false, automationEnabled: false, mode: "PAPER" }, health: { blockers: [] }, latest: {}, log: { items: [] } });
    }
    return jsonError(error instanceof Error ? error.message : "Monitoring status unavailable", 404);
  }
}

export async function POST(request: Request) {
  const actor = actorOf(request);
  if (!actor) return jsonError("UNAUTHORIZED", 401);
  const body = await request.json().catch(() => ({})) as Body;
  const service = getMonitoringService();
  try {
    switch (body.action) {
      case "ENABLE_MONITORING": {
        const session = service.enable({ ownerId: actor, symbols: Array.isArray(body.symbols) ? body.symbols.map(String) : [], timeframes: Array.isArray(body.timeframes) ? body.timeframes.map(String) : [], mode: String(body.mode ?? "PAPER").toUpperCase() as Mode, strategyVersion: typeof body.strategyVersion === "string" ? body.strategyVersion : undefined, confidenceThreshold: Number(body.confidenceThreshold ?? 70), automationEnabled: body.automationEnabled === true, riskAcknowledged: body.riskAcknowledged === true });
        const configuration = service.getConfiguration(session.configurationId)!;
        return NextResponse.json({ ...session, sessionId: session.id, state: session.state, monitoringEnabled: configuration.monitoringEnabled, automationEnabled: configuration.automationEnabled, mode: configuration.mode }, { status: 201 });
      }
      case "DISABLE_MONITORING": {
        const session = service.disable(actor, String(body.sessionId ?? ""), String(body.reason ?? "User stopped monitoring"));
        return NextResponse.json({ sessionId: session.id, state: session.state, reason: session.stopReason, occurredAt: session.stoppedAt });
      }
      case "SET_AUTOMATION": {
        const session = service.setAutomation(actor, String(body.sessionId ?? ""), body.enabled === true, String(body.mode ?? "PAPER").toUpperCase() as Mode);
        const configuration = service.getConfiguration(session.configurationId)!;
        return NextResponse.json({ sessionId: session.id, state: session.state, monitoringEnabled: configuration.monitoringEnabled, automationEnabled: configuration.automationEnabled, mode: configuration.mode });
      }
      case "EVALUATE": {
        const sessionId = String(body.sessionId ?? "");
        const gateway = new LiteLLMGateway({ endpoint: process.env.LITELLM_ENDPOINT ?? "", apiKey: process.env.LITELLM_API_KEY, modelAlias: process.env.LITELLM_MODEL ?? "tradepulse-default" });
        const result = await service.evaluate(actor, sessionId, {
          instrumentId: String(body.instrumentId ?? body.symbol ?? ""), symbol: String(body.symbol ?? "").toUpperCase(), underlying: String(body.underlying ?? body.symbol ?? "").toUpperCase(), timeframe: String(body.timeframe ?? "5m"),
          candles: Array.isArray(body.candles) ? body.candles.map((candle: Record<string, unknown>) => ({ timestamp: String(candle.timestamp ?? ""), open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close), volume: Number.isFinite(Number(candle.volume)) ? Number(candle.volume) : 0 })) : [],
          analysisId: typeof body.analysisId === "string" ? body.analysisId : undefined, analysis: typeof body.analysis === "object" && body.analysis !== null ? body.analysis as Record<string, unknown> : {}, marketEvidence: typeof body.marketEvidence === "object" && body.marketEvidence !== null ? body.marketEvidence as Record<string, unknown> : {}, freshness: body.freshness === "STALE" ? "STALE" : "FRESH",
        }, gateway);
        if (result.evaluation.state === "UNAVAILABLE") return NextResponse.json(result, { status: 503 });
        if (result.evaluation.state === "MALFORMED" || result.evaluation.state === "REJECTED") return NextResponse.json(result, { status: 422 });
        return NextResponse.json(result);
      }
      default: return jsonError("INVALID_REQUEST: unsupported monitoring action", 400);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Monitoring action failed";
    return jsonError(message, message.includes("ALGO_LIVE") ? 403 : 400);
  }
}
