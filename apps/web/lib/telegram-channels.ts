// Client-safe types and helpers for the Telegram channel analysis (no server imports).
import type { TelegramOptionCall } from "./index-sentiment";

export type TelegramAnalysis = {
  generated_at: string;
  window_hours: number;
  channels_requested: number;
  channels_read: number;
  posts_scanned: number;
  calls_parsed: number;
  totals: { calls: number; puts: number; call_buys: number; put_buys: number; call_sells: number; put_sells: number; put_call_ratio: number | null };
  bullish_pct: number | null;
  bias: "BULLISH" | "BEARISH" | "MIXED";
  top: TelegramOptionCall[];
  top_calls: TelegramOptionCall[];
  top_puts: TelegramOptionCall[];
  by_underlying: Array<{ underlying: string; calls: number; puts: number; ce_buys: number; pe_buys: number; ce_sells: number; pe_sells: number; bullish_pct: number | null; bias: string }>;
  channels: Array<{ channel: string; posts: number; calls: number; puts: number; buys: number; sells: number; ok: boolean; cached: boolean; error: string | null }>;
  notes: string[];
  method: string;
};

export const MAX_ANALYSIS_CHANNELS = 25;
const CHANNEL = /^[A-Za-z0-9_]{4,64}$/;

/** "@name", "t.me/name", "https://t.me/s/name" -> "name"; null when it is not a channel username. */
export function normalizeChannel(raw: string): string | null {
  const name = raw.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/^t\.me\/(s\/)?/i, "").replace(/^@+/, "").replace(/\/+$/, "");
  return CHANNEL.test(name) ? name : null;
}
