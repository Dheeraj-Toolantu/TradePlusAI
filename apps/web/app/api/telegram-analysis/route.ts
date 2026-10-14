import { NextResponse } from "next/server";
import { MAX_ANALYSIS_CHANNELS, analyseTelegramChannels, normalizeChannel } from "../../../lib/telegram-analysis";

// POST { channels: string[], window_hours?: number }: put / call counts and the most asked
// option calls across the user's own list of public Telegram channels.
export async function POST(request: Request) {
  let body: { channels?: unknown; window_hours?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const raw = Array.isArray(body.channels) ? body.channels.filter((name): name is string => typeof name === "string") : [];
  const byKey = new Map<string, string>();
  for (const name of raw.map(normalizeChannel)) if (name && !byKey.has(name.toLowerCase())) byKey.set(name.toLowerCase(), name);
  const channels = [...byKey.values()];
  if (!channels.length) return NextResponse.json({ error: "Add at least one public Telegram channel username" }, { status: 400 });
  if (channels.length > MAX_ANALYSIS_CHANNELS) return NextResponse.json({ error: `At most ${MAX_ANALYSIS_CHANNELS} channels per analysis` }, { status: 400 });
  const hours = Number(body.window_hours ?? 12);
  const windowHours = Number.isFinite(hours) ? Math.max(1, Math.min(24, Math.round(hours))) : 12;
  try {
    return NextResponse.json(await analyseTelegramChannels(channels, windowHours), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Telegram analysis failed" }, { status: 503 });
  }
}
