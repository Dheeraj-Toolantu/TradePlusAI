import { NextResponse } from "next/server";
import { getSentiment } from "../../../lib/sentiment";

export async function GET() {
  try {
    const sentiment = await getSentiment({ wait: true });
    return NextResponse.json(sentiment ?? { error: "Sentiment scan unavailable" }, { status: sentiment ? 200 : 503 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Sentiment scan failed" }, { status: 503 });
  }
}
