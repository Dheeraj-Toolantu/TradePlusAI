import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

// In-process caches added for page speed; clearing them forces fresh Groww/feeds data.
const CACHE_KEYS = ["__tradepulseGrowwCatalog", "__tradepulseHistoryCache", "__tradepulseIntelCache", "__tradepulseSentiment"] as const;

export async function POST() {
  const store = globalThis as unknown as Record<string, unknown>;
  for (const key of CACHE_KEYS) {
    const value = store[key];
    if (value instanceof Map) value.clear();
    else store[key] = undefined;
  }
  revalidatePath("/execution");
  revalidatePath("/api/algo-trading");
  revalidatePath("/api/market-data");
  revalidatePath("/api/market-data/history");
  revalidatePath("/api/option-chain");
  revalidatePath("/api/options-engine");
  revalidatePath("/api/ai-monitoring");
  return NextResponse.json({ cleared: true, clearedAt: new Date().toISOString() });
}
