import { NextResponse } from "next/server";
import { recentHistory, recorderStatus } from "../../../lib/sentiment-history";
import { recordLatestSentiment } from "../../../lib/sentiment-recorder";

// POST: store the latest index + commodity sentiment in Firestore if this 15-minute slot has no
// snapshot yet or a reversal appeared. The API server calls it every minute; a scheduler can too.
export async function POST() {
  try {
    return NextResponse.json(await recordLatestSentiment(), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ recorded: false, error: error instanceof Error ? error.message : "Sentiment history unavailable" }, { status: 503 });
  }
}

// GET ?limit=20: the latest snapshots and reversals. ?date=2026-10-21: every one from that IST day.
// `recorder` says what this server's recorder last did, so an empty history explains itself.
export async function GET(request?: Request) {
  const params = request ? new URL(request.url).searchParams : new URLSearchParams();
  const count = Number(params.get("limit")) || 20;
  const date = params.get("date") ?? undefined;
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  try {
    return NextResponse.json({ ...(await recentHistory(count, date)), recorder: recorderStatus() }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: `Couldn't read sentiment history from Firestore: ${error instanceof Error ? error.message : "unknown error"}`, recorder: recorderStatus() }, { status: 503 });
  }
}
