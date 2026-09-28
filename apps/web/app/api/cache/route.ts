import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

export async function POST() {
  revalidatePath("/execution");
  revalidatePath("/api/algo-trading");
  revalidatePath("/api/market-data");
  revalidatePath("/api/market-data/history");
  revalidatePath("/api/option-chain");
  revalidatePath("/api/options-engine");
  revalidatePath("/api/ai-monitoring");
  return NextResponse.json({ cleared: true, clearedAt: new Date().toISOString() });
}
