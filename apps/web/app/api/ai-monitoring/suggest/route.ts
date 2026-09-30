import { NextResponse } from "next/server";
import { getMonitoringService } from "../../../../../../services/ai-monitoring/src/monitoring-service";
import { adviceFromModel, buildAdvisorMessages, deterministicAdvice, type ChatMessage, type OptionAdvice } from "../../../../../../services/ai-monitoring/src/option-advisor";
import { getMarketIntel, isIntelSymbol } from "../../../../lib/market-intel";

// One model call per symbol per 45 s, shared across tabs: the free Groq tier rate-limits hard.
const ADVICE_TTL_MS = 45_000;
const adviceGlobal = globalThis as typeof globalThis & { __tradepulseAdvice?: Map<string, { at: number; advice: OptionAdvice }> };
const adviceCache = (adviceGlobal.__tradepulseAdvice ??= new Map());

async function complete(messages: ChatMessage[]): Promise<{ content: string; model: string }> {
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

/**
 * POST { symbol, sessionId }: the AI monitor's best CE / PE / WAIT suggestion. Requires an
 * active monitoring session. Advisory only: no order is created here.
 */
export async function POST(request: Request) {
  const actor = request.headers.get("x-user-id");
  if (!actor) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const symbol = String(body.symbol ?? "NIFTY").toUpperCase();
  const sessionId = String(body.sessionId ?? "");
  if (!isIntelSymbol(symbol)) return NextResponse.json({ error: "Unsupported symbol" }, { status: 400 });
  const service = getMonitoringService();
  const session = service.getSession(actor, sessionId);
  if (!session || session.state !== "ACTIVE") return NextResponse.json({ error: "Enable AI monitoring first." }, { status: 409 });

  const cached = adviceCache.get(symbol);
  if (cached && Date.now() - cached.at < ADVICE_TTL_MS) return NextResponse.json({ advice: cached.advice, cached: true });

  let intel: Record<string, unknown>;
  try {
    intel = await getMarketIntel(symbol, { origin: new URL(request.url).origin }) as Record<string, unknown>;
  } catch (error) {
    return NextResponse.json({ error: `Market intelligence unavailable: ${error instanceof Error ? error.message : "unknown error"}` }, { status: 503 });
  }
  if (!intel.available) return NextResponse.json({ error: String(intel.reason ?? "Market intelligence unavailable") }, { status: 503 });

  let advice: OptionAdvice;
  try {
    const { content, model } = await complete(buildAdvisorMessages(intel));
    advice = adviceFromModel(intel, content, model) ?? deterministicAdvice(intel, "The AI reply was not valid JSON; showing the rule-based suggestion.");
  } catch (error) {
    advice = deterministicAdvice(intel, `AI model unavailable (${error instanceof Error ? error.message : "provider error"}); showing the rule-based suggestion.`);
  }
  adviceCache.set(symbol, { at: Date.now(), advice });
  try {
    service.recordAdvice(actor, session.id, { ...advice, source: advice.source });
  } catch { /* the session may have stopped while the model was thinking */ }
  return NextResponse.json({ advice, cached: false });
}
