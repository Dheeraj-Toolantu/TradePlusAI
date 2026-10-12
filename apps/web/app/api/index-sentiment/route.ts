import { NextResponse } from "next/server";
import { getIndexSentiment } from "../../../lib/index-sentiment";
import { versionedJson } from "../../../lib/json-response";

// `?refresh=1` forces a re-scan (rate-limited in getIndexSentiment). `?meta=1` returns only the
// scan time, so the WebSocket server can detect a new scan without downloading the full payload.
// Full responses are gzipped and carry an ETag: an unchanged scan costs a 304.
export async function GET(request?: Request) {
  const params = request ? new URL(request.url).searchParams : new URLSearchParams();
  try {
    const sentiment = await getIndexSentiment({ force: params.get("refresh") === "1" });
    if (params.get("meta") === "1") return NextResponse.json({ generated_at: sentiment.generated_at });
    return versionedJson(request, sentiment, `is-${sentiment.generated_at}`);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Index sentiment scan failed" }, { status: 503 });
  }
}
