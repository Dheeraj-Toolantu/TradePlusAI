import { NextResponse } from "next/server";
import { versionedJson } from "../../../lib/json-response";
import { getTelegramLive } from "../../../lib/telegram-live";

// Polled by the WebSocket server (one poll for every open tab) and by pages as a fallback.
// `?refresh=1` re-reads the channels (at most every 20 s).
export async function GET(request?: Request) {
  const force = request ? new URL(request.url).searchParams.get("refresh") === "1" : false;
  try {
    const live = await getTelegramLive({ force });
    return versionedJson(request, live, `tg-${live.signature}-${live.generated_at}`);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Telegram scan failed" }, { status: 503 });
  }
}
