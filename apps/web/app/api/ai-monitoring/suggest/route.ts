import { NextResponse } from "next/server";
import { getMonitoringService } from "../../../../../../services/ai-monitoring/src/monitoring-service";
import { getAdvice } from "../../../../lib/ai-advice";
import { isIntelSymbol } from "../../../../lib/market-intel";

/**
 * POST { symbol, sessionId }: the AI monitor's best CE / PE / WAIT suggestion, built from the
 * market-intel brief plus the 1D/15m/5m/1m multi-timeframe engine (candle psychology, key levels,
 * option intrinsic/fair value). Requires an active monitoring session. Advisory only: orders are
 * placed by /api/ai-monitoring/autotrade when the trader has enabled AI auto-trade.
 */
export async function POST(request: Request) {
  const actor = request.headers.get("x-user-id");
  if (!actor) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const symbol = String(body.symbol ?? "NIFTY").toUpperCase();
  const sessionId = String(body.sessionId ?? "");
  if (!isIntelSymbol(symbol)) return NextResponse.json({ error: "Unsupported symbol" }, { status: 400 });
  const service = getMonitoringService();
  const session = service.getSession(actor, sessionId);
  if (!session || session.state !== "ACTIVE") return NextResponse.json({ error: "Enable AI monitoring first." }, { status: 409 });

  let result: Awaited<ReturnType<typeof getAdvice>>;
  try {
    result = await getAdvice(symbol, new URL(request.url).origin);
  } catch (error) {
    return NextResponse.json({ error: `Market intelligence unavailable: ${error instanceof Error ? error.message : "unknown error"}` }, { status: 503 });
  }
  if (!result.cached) {
    try { service.recordAdvice(actor, session.id, { ...result.advice, source: result.advice.source }); } catch { /* the session may have stopped while the model was thinking */ }
  }
  return NextResponse.json({ advice: result.advice, cached: result.cached });
}
