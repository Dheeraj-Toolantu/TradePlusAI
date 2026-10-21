import { NextResponse } from "next/server";
import { getIndexSentiment } from "../../../lib/index-sentiment";
import { recentHistory, recordSentiment } from "../../../lib/sentiment-history";

// POST: store the latest index + commodity sentiment in Firestore if this 15-minute slot has no
// snapshot yet or a reversal appeared. The API server calls it every minute; a scheduler can too.
export async function POST() {
  try {
    const scan = await getIndexSentiment();
    return NextResponse.json(await recordSentiment(scan), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ recorded: false, error: error instanceof Error ? error.message : "Sentiment history unavailable" }, { status: 503 });
  }
}

// GET ?limit=20: the latest snapshots and reversals. ?date=2026-10-21: every one from that IST day.
export async function GET(request?: Request) {
  const params = request ? new URL(request.url).searchParams : new URLSearchParams();
  const count = Number(params.get("limit")) || 20;
  const date = params.get("date") ?? undefined;
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  try {
    return NextResponse.json(await recentHistory(count, date), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Sentiment history unavailable" }, { status: 503 });
  }
}
