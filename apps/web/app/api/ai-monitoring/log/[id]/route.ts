import { NextResponse } from "next/server";
import { getMonitoringService } from "../../../../../../../services/ai-monitoring/src/monitoring-service";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = request.headers.get("x-user-id");
  if (!actor) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const { id } = await context.params;
  const entry = getMonitoringService().logs.get(id);
  if (!entry) return NextResponse.json({ error: "Suggestion log entry not found" }, { status: 404 });
  if (entry.actor !== actor && entry.actor !== "SYSTEM") return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  return NextResponse.json(entry);
}
