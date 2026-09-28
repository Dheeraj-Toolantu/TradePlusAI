import { NextResponse } from "next/server";
import { liveService } from "../../../lib/live/default-deps";

// Real-money order endpoint (Groww). Two-step: action=preview returns every gate and a
// signed 30-second token; action=confirm needs that token plus the server-side trading PIN.
// Exits (manual) also need the PIN; automatic exits run in the server-side monitor.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await liveService().status());
  } catch (error) {
    return NextResponse.json({ enabled: false, disabledReasons: [error instanceof Error ? error.message : "Live status unavailable"], positions: [] }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const service = liveService();
  try {
    switch (body.action) {
      case "preview": {
        const result = await service.preview({ symbol: String(body.symbol ?? ""), lots: Number(body.lots), stopLoss: Number(body.stopLoss), target: Number(body.target), source: String(body.source ?? "MANUAL") });
        return NextResponse.json(result, { status: result.ok ? 200 : 422 });
      }
      case "confirm": {
        const result = await service.confirm(body.token, body.pin);
        return NextResponse.json(result, { status: result.status });
      }
      case "exit": {
        const result = await service.exit(String(body.orderId ?? ""), "MANUAL_EXIT", body.pin);
        return NextResponse.json(result, { status: result.status });
      }
      case "mark_closed": {
        const result = await service.markClosed(String(body.orderId ?? ""), Number(body.exitPrice), body.pin);
        return NextResponse.json(result, { status: result.status });
      }
      default:
        return NextResponse.json({ error: "action must be preview, confirm, exit or mark_closed" }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Live order request failed" }, { status: 500 });
  }
}
