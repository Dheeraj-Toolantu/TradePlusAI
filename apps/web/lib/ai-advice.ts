import { analyzeMultiTimeframe, type MtfCandidate } from "../../../services/ai-monitoring/src/mtf-decision-engine";
import { adviceFromModel, buildAdvisorMessages, candidatesOf, deterministicAdvice, type ChatMessage, type OptionAdvice } from "../../../services/ai-monitoring/src/option-advisor";
import { getMarketIntel, type IntelSymbol } from "./market-intel";
import { fetchMtfCandles } from "./mtf-candles";

// One model call per symbol per 45 s, shared across tabs and the auto-trade loop: the free Groq
// tier rate-limits hard.
export const ADVICE_TTL_MS = 45_000;
type CachedAdvice = { at: number; advice: OptionAdvice; spot: number };
const adviceGlobal = globalThis as typeof globalThis & { __tradepulseAdvice?: Map<string, CachedAdvice>; __tradepulseAdviceInflight?: Map<string, Promise<CachedAdvice>> };
const adviceCache = (adviceGlobal.__tradepulseAdvice ??= new Map());
const inflight = (adviceGlobal.__tradepulseAdviceInflight ??= new Map());

export async function completeWithModel(messages: ChatMessage[]): Promise<{ content: string; model: string }> {
  const timeoutMs = Number(process.env.AI_ADVISOR_TIMEOUT_MS ?? 30_000);
  const attempt = async (endpoint: string, apiKey: string | undefined, model: string) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 1200 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Model provider returned ${response.status}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }>; model?: string };
    const content = body.choices?.[0]?.message?.content ?? "";
    if (!content) throw new Error("Model returned an empty response");
    return { content, model: body.model ?? model };
  };
  try {
    if (!process.env.LITELLM_ENDPOINT) throw new Error("LiteLLM endpoint is not configured");
    return await attempt(process.env.LITELLM_ENDPOINT, process.env.LITELLM_API_KEY, process.env.LITELLM_MODEL ?? "openai/gpt-oss-20b");
  } catch (error) {
    if (!process.env.GROQ_API_KEY) throw error;
    return attempt("https://api.groq.com/openai/v1/chat/completions", process.env.GROQ_API_KEY, "openai/gpt-oss-20b");
  }
}

const numberOr = (value: unknown, fallback: number | null = null) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; };

/** Market intel enriched with the 1D/15m/5m/1m decision (attached as `mtf_decision`). */
export async function intelWithMtf(symbol: IntelSymbol, origin: string): Promise<Record<string, unknown>> {
  const [intel, mtfCandles] = await Promise.all([
    getMarketIntel(symbol, { origin }) as Promise<Record<string, unknown>>,
    fetchMtfCandles(symbol, origin).catch(() => ({ candles: {}, issues: ["multi-timeframe candles unavailable"] })),
  ]);
  if (!intel.available) return intel;
  const flow = (intel.options_flow ?? {}) as Record<string, unknown>;
  const candidates = candidatesOf(intel);
  const toMtf = (side: "CE" | "PE"): MtfCandidate | null => { const c = candidates[side]; return c ? { side, trading_symbol: c.trading_symbol, strike: c.strike, premium: c.premium, delta: c.delta } : null; };
  const decision = analyzeMultiTimeframe({
    symbol,
    spot: numberOr(intel.spot, 0)!,
    candles: mtfCandles.candles,
    candidates: { CE: toMtf("CE"), PE: toMtf("PE") },
    atmIv: numberOr(flow.atm_iv),
    expiry: typeof intel.expiry === "string" ? intel.expiry : null,
  });
  if (mtfCandles.issues.length) decision.risks.push(`Data: ${mtfCandles.issues.join("; ")}`);
  return { ...intel, mtf_decision: decision };
}

/** Latest advice for a symbol if it is younger than `maxAgeMs`. */
export function cachedAdvice(symbol: string, maxAgeMs = ADVICE_TTL_MS): CachedAdvice | null {
  const cached = adviceCache.get(symbol);
  return cached && Date.now() - cached.at < maxAgeMs ? cached : null;
}

/**
 * The AI monitor's best CE / PE / WAIT suggestion: LLM over the deterministic brief (now including
 * the multi-timeframe read), validated in code, with a rule-based fallback. Cached per symbol.
 */
export async function getAdvice(symbol: IntelSymbol, origin: string): Promise<{ advice: OptionAdvice; cached: boolean; spot: number }> {
  const cached = cachedAdvice(symbol);
  if (cached) return { advice: cached.advice, cached: true, spot: cached.spot };
  const pending = inflight.get(symbol);
  if (pending) return pending.then((value) => ({ advice: value.advice, cached: true, spot: value.spot }));
  const job = (async (): Promise<CachedAdvice> => {
    const intel = await intelWithMtf(symbol, origin);
    if (!intel.available) throw Object.assign(new Error(String(intel.reason ?? "Market intelligence unavailable")), { status: 503 });
    let advice: OptionAdvice;
    try {
      const { content, model } = await completeWithModel(buildAdvisorMessages(intel));
      advice = adviceFromModel(intel, content, model) ?? deterministicAdvice(intel, "The AI reply was not valid JSON; showing the rule-based suggestion.");
    } catch (error) {
      advice = deterministicAdvice(intel, `AI model unavailable (${error instanceof Error ? error.message : "provider error"}); showing the rule-based suggestion.`);
    }
    const entry = { at: Date.now(), advice, spot: numberOr(intel.spot, 0)! };
    adviceCache.set(symbol, entry);
    return entry;
  })().finally(() => inflight.delete(symbol));
  inflight.set(symbol, job);
  const value = await job;
  return { advice: value.advice, cached: false, spot: value.spot };
}
