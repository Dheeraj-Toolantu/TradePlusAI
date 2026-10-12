import { NextResponse } from "next/server";
import { getIndexSentiment } from "../../../lib/index-sentiment";

// `?refresh=1` forces a re-scan (rate-limited in getIndexSentiment).
export async function GET(request?: Request) {
  const force = request ? new URL(request.url).searchParams.get("refresh") === "1" : false;
  try {
    return NextResponse.json(await getIndexSentiment({ force }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Index sentiment scan failed" }, { status: 503 });
  }
}
