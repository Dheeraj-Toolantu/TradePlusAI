import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "./firebase";
import { OI_STRIKES, strikeCache, strikeKey } from "./sentiment-history";
import type { StrikeSample } from "./oi-analysis";

const READ_TIMEOUT_MS = 20_000;
const withTimeout = <T,>(work: Promise<T>, ms = READ_TIMEOUT_MS) => Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms))]);

/**
 * The day's stored 3-minute strike OI samples for one index, oldest first. Read from Firestore once
 * per process and cached; the server's sampler appends each new sample to the cache from then on.
 */
export async function storedStrikeSamples(symbol: string, date: string, notes: string[] = []): Promise<StrikeSample[]> {
  const key = strikeKey(symbol, date);
  const cache = strikeCache();
  let cached = cache.get(key) as StrikeSample[] | undefined;
  if (!cached) {
    const read = await withTimeout(getDocs(query(collection(db, OI_STRIKES), where("key", "==", key))))
      .then((result) => result.docs.map((item) => item.data() as StrikeSample & { recordedAt?: string }).map((row) => ({ ...row, at: row.at ?? row.recordedAt ?? "" })))
      .catch((error: unknown) => { notes.push(`Stored OI unavailable for ${symbol}: ${error instanceof Error ? error.message : "read failed"}`); return null; });
    if (read) { read.sort((a, b) => a.at.localeCompare(b.at)); cache.set(key, read as never); cached = read; }
  }
  return [...(cached ?? [])].sort((a, b) => a.at.localeCompare(b.at));
}
