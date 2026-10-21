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

// GET ?limit=20: the latest snapshots and reversals.
export async function GET(request?: Request) {
  const count = Number(request ? new URL(request.url).searchParams.get("limit") : null) || 20;
  try {
    return NextResponse.json(await recentHistory(count), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Sentiment history unavailable" }, { status: 503 });
  }
}
